import { failureDetail, fetchMessageContent, logLineFailure, pushMessage, replyMessage } from "../line/api";
import { type ReceiverVerdict, type SlipOkResult, type SlipPayee, compareReceiver, verifySlip } from "../line/slipok";
import {
  ownerSlipPendingMessage,
  slipDownloadFailedMessage,
  slipDuplicateMessage,
  slipDuplicateReviewMessage,
  slipMatchedMessage,
  slipNotLinkedMessage,
  slipPendingReviewMessage,
} from "../line/messages";
import { asRecord } from "../routes/shared";
import { type BillPaidEvent, broadcastBillPaid, pushOwnerBillPaid } from "./paid-notify";

export type SlipReason = "mismatch" | "not_verified" | "no_unpaid_bill" | "duplicate_slip" | "verify_failed";

export interface StoredSlipResult {
  verified: boolean;
  amount: number | null;
  transRef: string | null;
  date: string | null;
  reason: SlipReason | null;
  /** รหัสจากผู้ให้บริการ (เช่น 1007 = รูปไม่มี QR) — null เมื่อระบบตรวจไม่ได้เลย */
  code: number | null;
  /** ข้อความจากผู้ให้บริการ อ่านแล้วรู้ว่าสลิปมีปัญหาอะไร */
  message: string | null;
  /** เหตุผลทางเทคนิคเมื่อ "ตรวจไม่ได้" (คีย์หาย ผู้ให้บริการล่ม) */
  detail: string | null;
  /** สลิปที่ปิดบิลไปแล้วด้วยเลขอ้างอิงเดียวกัน (เฉพาะกรณีสลิปซ้ำของจริง) */
  usedSlipId: string | null;
  raw: unknown;
}

const slipReasons: readonly SlipReason[] = [
  "mismatch",
  "not_verified",
  "no_unpaid_bill",
  "duplicate_slip",
  "verify_failed",
];

const emptySlipResult: StoredSlipResult = {
  verified: false,
  amount: null,
  transRef: null,
  date: null,
  reason: null,
  code: null,
  message: null,
  detail: null,
  usedSlipId: null,
  raw: null,
};

const insertSlipSql =
  "INSERT INTO slips (id, family_id, line_user_id, image_key, status) VALUES (?, ?, ?, ?, 'pending_review')";

const updateSlipSql =
  "UPDATE slips SET status = ?, bill_id = ?, bill_total = ?, amount = ?, trans_ref = ?, verify_result = ? WHERE id = ? AND family_id = ? AND status = 'pending_review'";

/**
 * ปิดบิลและผูกสลิปต้องเกิดใน transaction เดียวกัน (DB.batch)
 *
 * คำสั่งแรกผูกสลิปได้เฉพาะเมื่อบิลยังไม่ถูกปิด คำสั่งที่สองปิดบิลได้เฉพาะเมื่อ
 * สลิปถูกผูกกับบิลใบนั้นจริง ๆ สองเงื่อนไขนี้ตัดกันเอง จึงไม่มีทางที่สลิปจะถูก
 * ทำเครื่องหมายว่าปิดบิลทั้งที่บิลยังเปิดอยู่ แม้ Worker จะล้มกลางทาง
 */
const matchSlipSql =
  "UPDATE slips SET status = 'matched', bill_id = ?, bill_total = ?, amount = ?, trans_ref = ?, verify_result = ? WHERE id = ? AND family_id = ? AND status = 'pending_review' AND EXISTS (SELECT 1 FROM bills WHERE id = ? AND family_id = ? AND status = 'unpaid') AND NOT EXISTS (SELECT 1 FROM slips WHERE family_id = ? AND trans_ref = ? AND status = 'matched' AND id <> ?)";

const closeBillSql =
  "UPDATE bills SET status = 'paid', paid_at = ?, paid_method = 'transfer' WHERE id = ? AND family_id = ? AND status = 'unpaid' AND EXISTS (SELECT 1 FROM slips WHERE id = ? AND family_id = ? AND bill_id = bills.id AND status = 'matched')";

interface SlipSenderRow {
  id: string;
  room_id: string;
  full_name: string;
  room_number: string;
}

interface UnpaidBillRow {
  id: string;
  period: string;
  total: number;
  payee_promptpay_type: string;
  payee_promptpay_id: string;
  payee_bank_account_number: string;
}

interface SlipOwnerAlert {
  roomNumber: string;
  tenantName: string;
  slipAmount: number | null;
  billTotal: number | null;
  reasonNote: string | null;
}

const slipReasonNotes: Record<SlipReason, string> = {
  mismatch: "ยอดในสลิปไม่ตรงกับยอดบิล",
  not_verified: "ผู้ให้บริการตรวจสลิปไม่ผ่าน",
  no_unpaid_bill: "ตอนรับสลิปห้องนี้ไม่มีบิลค้างให้เทียบ",
  duplicate_slip: "ผู้ให้บริการแจ้งว่าสลิปนี้เคยถูกส่งเข้ามาแล้ว แต่ยังไม่มีบิลที่ปิดด้วยสลิปนี้",
  verify_failed: "ระบบตรวจสลิปกับผู้ให้บริการไม่สำเร็จ ต้องตรวจด้วยมือ",
};

/** ข้อความถึงผู้เช่าเมื่อสลิปโอนเข้าบัญชีที่ไม่ใช่บัญชีรับเงินของหอ */
const slipReceiverMismatchMessage =
  "สลิปนี้โอนเข้าบัญชีอื่น ไม่ใช่บัญชีรับเงินของหอ จึงยังปิดบิลให้ไม่ได้ กรุณาส่งสลิปที่โอนเข้าบัญชีของหอ หรือรอเจ้าของหอตรวจสอบ";

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseSlipResult(value: string | null): StoredSlipResult {
  if (value === null || value.trim() === "") {
    return emptySlipResult;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return emptySlipResult;
  }

  const record = asRecord(parsed);

  if (record === null) {
    return emptySlipResult;
  }

  const reason = typeof record.reason === "string" && (slipReasons as readonly string[]).includes(record.reason)
    ? (record.reason as SlipReason)
    : null;

  return {
    verified: record.verified === true,
    amount: readNumber(record.amount),
    transRef: readText(record.transRef),
    date: readText(record.date),
    reason,
    code: readNumber(record.code),
    message: readText(record.message),
    detail: readText(record.detail),
    usedSlipId: readText(record.usedSlipId),
    raw: record.raw ?? null,
  };
}

export function rejectedSlipResultJson(value: string | null, decidedAt: string): string {
  const stored = parseSlipResult(value);
  const payload: Record<string, unknown> = {
    verified: stored.verified,
    amount: stored.amount,
    transRef: stored.transRef,
    date: stored.date,
    code: stored.code,
    message: stored.message,
    detail: stored.detail,
    usedSlipId: stored.usedSlipId,
    raw: stored.raw,
  };

  if (stored.reason !== null) {
    payload.reason = stored.reason;
  }

  payload.decision = "rejected";
  payload.decidedAt = decidedAt;

  return JSON.stringify(payload);
}

export function isUniqueViolation(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes("UNIQUE");
}

/**
 * สัญญาณว่าแถวนี้ยังมีแถวอื่นอ้างถึงอยู่ (foreign key)
 *
 * ใช้แยก "ลบไม่ได้เพราะยังมีคนอ้างถึง" ออกจาก "ลบไม่สำเร็จเพราะระบบพัง"
 * สองอย่างนี้ต้องตอบผู้ใช้ต่างกัน (409 พร้อมทางออก vs 500)
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes("FOREIGN KEY") || detail.includes("SQLITE_CONSTRAINT_FOREIGNKEY");
}

export function canonicalPaidAt(date: string | null): string {
  if (date !== null) {
    const parsed = new Date(date);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function randomImageKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}.png`;
}

function toSatang(amount: number): number {
  return Math.round(amount * 100);
}

function slipResultJson(
  result: SlipOkResult,
  reason: SlipReason | null,
  detail: string | null = null,
  usedSlipId: string | null = null,
): string {
  const payload: Record<string, unknown> = {
    verified: result.verified,
    amount: result.amount,
    transRef: result.transRef,
    date: result.date,
    code: result.code,
    message: result.message,
    raw: result.raw,
  };

  if (reason !== null) {
    payload.reason = reason;
  }

  if (detail !== null) {
    payload.detail = detail;
  }

  if (usedSlipId !== null) {
    payload.usedSlipId = usedSlipId;
  }

  return JSON.stringify(payload);
}

async function notifyOwnerOfSlipInReview(env: Env, familyId: string, slipId: string, alert: SlipOwnerAlert): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE family_id = ? AND key = 'owner_line_user_id'")
      .bind(familyId)
      .first<{ value: string }>();
    const ownerId = (row?.value ?? "").trim();

    if (ownerId === "") {
      console.log(JSON.stringify({ message: "slip owner alert skipped", slipId, reason: "owner line is not linked" }));
      return;
    }

    const delivered = await pushMessage(env, ownerId, [
      ownerSlipPendingMessage(alert.roomNumber, alert.tenantName, alert.slipAmount, alert.billTotal, alert.reasonNote),
    ]);

    console.log(JSON.stringify({ message: "slip owner alerted", slipId, delivered: delivered === true }));
  } catch (error) {
    logLineFailure("slip owner alert failed", failureDetail(error));
  }
}

async function keepSlipForReview(
  env: Env,
  familyId: string,
  slipId: string,
  result: SlipOkResult,
  lineUserId: string,
  reason: SlipReason,
  bill: UnpaidBillRow | null,
  sender: SlipSenderRow,
  options: { receiverMismatch?: boolean; detail?: string | null; duplicateNotice?: boolean } = {},
): Promise<void> {
  const receiverMismatch = options.receiverMismatch === true;

  await env.DB.prepare(updateSlipSql)
    .bind(
      "pending_review",
      bill?.id ?? null,
      bill?.total ?? null,
      result.amount,
      result.transRef,
      slipResultJson(result, reason, options.detail ?? null),
      slipId,
      familyId,
    )
    .run();

  console.log(JSON.stringify({ message: "slip kept for review", slipId, lineUserId, verified: result.verified, reason, receiverMismatch }));

  const tenantMessage = receiverMismatch
    ? { type: "text" as const, text: slipReceiverMismatchMessage }
    : options.duplicateNotice === true
      ? slipDuplicateReviewMessage()
      : slipPendingReviewMessage();

  await pushMessage(env, lineUserId, [tenantMessage]);
  await notifyOwnerOfSlipInReview(env, familyId, slipId, {
    roomNumber: sender.room_number,
    tenantName: sender.full_name,
    slipAmount: result.amount,
    billTotal: bill?.total ?? null,
    reasonNote:
      reason === "verify_failed" && options.detail != null
        ? `${slipReasonNotes[reason]} (${options.detail})`
        : slipReasonNotes[reason],
  });
}

async function rejectDuplicateSlip(
  env: Env,
  familyId: string,
  slipId: string,
  result: SlipOkResult,
  lineUserId: string,
  usedSlipId: string | null,
): Promise<void> {
  await env.DB.prepare(updateSlipSql)
    .bind(
      "rejected",
      null,
      null,
      result.amount,
      result.transRef,
      slipResultJson(result, "duplicate_slip", null, usedSlipId),
      slipId,
      familyId,
    )
    .run();

  console.log(JSON.stringify({ message: "slip rejected as a duplicate transfer reference", slipId, lineUserId, usedSlipId }));
  await pushMessage(env, lineUserId, [slipDuplicateMessage()]);
}

/**
 * บัญชีรับเงินที่ต้องใช้เทียบกับสลิปนี้ — มาจาก snapshot ในบิลที่กำลังจะปิด
 * ไม่ใช่ตั้งค่าปัจจุบันของหอ
 *
 * ถ้าเจ้าของหอเปลี่ยนพร้อมเพย์หรือบัญชีธนาคารหลังจากออกบิลไปแล้ว ผู้เช่าที่
 * โอนเข้าบัญชีเดิมตามที่ระบุในบิลของตัวเองต้องไม่ถูกตีว่าโอนผิดบัญชี และ
 * สลิปที่โอนเข้าบัญชีใหม่ (ที่ยังไม่มีในบิลเก่าใบนี้) ก็ต้องไม่ปิดบิลเก่าได้
 * เช่นกัน — ไม่มีบิลให้เทียบ (bill เป็น null) ถือว่ายังไม่รู้ ปล่อยผ่านไปให้
 * ขั้นถัดไปตัดสินด้วยเหตุผลอื่น (ไม่มีบิลค้างชำระ)
 */
function payeeFromBill(bill: UnpaidBillRow | null): SlipPayee | null {
  if (bill === null) {
    return null;
  }

  const proxyId = bill.payee_promptpay_id.trim();
  const accountNumber = bill.payee_bank_account_number.trim();

  if (proxyId === "" && accountNumber === "") {
    return null;
  }

  return {
    proxyType: bill.payee_promptpay_type === "citizen-id" ? "NATID" : "MSISDN",
    proxyId,
    accountNumber,
  };
}

/**
 * บัญชีที่เจ้าของหอยอมรับเพิ่มเฉพาะบิลของรอบหนึ่ง — ใช้ตอนช่องทางรับเงินเปลี่ยนกลางรอบ
 * แล้วผู้เช่าบางคนยังโอนเข้าบัญชีเดิมตามใบแจ้งหนี้/QR ที่เคยได้ไป
 *
 * เก็บใน settings (ไม่ใช่คอลัมน์ในบิล) ด้วย 3 คีย์ และยังไม่มีหน้าตั้งค่า ต้องแก้ที่ฐานข้อมูล:
 *   - `extra_payee_period`  รอบบิลที่ใช้ได้ เช่น `2026-09` (รอบอื่นไม่ได้รับผล)
 *   - `extra_payee_promptpay_id`  เบอร์พร้อมเพย์ (ว่างได้)
 *   - `extra_payee_bank_account_number`  เลขบัญชี (ว่างได้)
 * ข้ามรอบแล้วหยุดมีผลเองโดยไม่ต้องลบ การจะปิดบิลต้องยอดสลิปตรงบิลเป๊ะเหมือนเดิม
 */
async function loadExtraPayee(env: Env, family: string, period: string): Promise<SlipPayee | null> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE family_id = ? AND key IN ('extra_payee_period', 'extra_payee_promptpay_id', 'extra_payee_bank_account_number')",
  )
    .bind(family)
    .all<{ key: string; value: string }>();
  const stored = new Map(rows.results.map((row) => [row.key, row.value.trim()]));

  if (stored.get("extra_payee_period") !== period) {
    return null;
  }

  const proxyId = stored.get("extra_payee_promptpay_id") ?? "";
  const accountNumber = stored.get("extra_payee_bank_account_number") ?? "";

  return proxyId === "" && accountNumber === "" ? null : { proxyType: "MSISDN", proxyId, accountNumber };
}

export async function handleSlipImage(
  env: Env,
  familyId: string,
  origin: string,
  userId: string,
  replyToken: string,
  messageId: string,
): Promise<void> {
  const sender = await env.DB.prepare(
    "SELECT t.id, t.room_id, t.full_name, r.room_number FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.family_id = ? AND r.family_id = ? AND t.line_user_id = ?",
  )
    .bind(familyId, familyId, userId)
    .first<SlipSenderRow>();

  if (sender === null) {
    await replyMessage(env, replyToken, slipNotLinkedMessage());
    return;
  }

  const content = await fetchMessageContent(env, messageId);

  if (content === null) {
    await replyMessage(env, replyToken, slipDownloadFailedMessage());
    return;
  }

  const imageKey = randomImageKey();
  const slipId = crypto.randomUUID();

  await env.SLIPS.put(imageKey, content.bytes, { httpMetadata: { contentType: content.contentType } });
  await env.DB.prepare(insertSlipSql).bind(slipId, familyId, userId, imageKey).run();

  const bill = await env.DB.prepare(
    "SELECT id, period, total, payee_promptpay_type, payee_promptpay_id, payee_bank_account_number FROM bills WHERE family_id = ? AND room_id = ? AND tenant_id = ? AND status = 'unpaid' ORDER BY period DESC LIMIT 1",
  )
    .bind(familyId, sender.room_id, sender.id)
    .first<UnpaidBillRow>();

  const outcome = await verifySlip(env, content.bytes, content.contentType, bill?.total ?? null);
  const result = outcome.result;
  const amount = result.amount;
  const transRef = result.transRef;

  /**
   * provider บอก "สลิปซ้ำ" ยังไม่พอที่จะปฏิเสธ
   *
   * เขาจำได้แค่ว่าเคยเห็นรูปนี้ ส่วนเรารู้ว่าบิลถูกปิดจริงหรือยัง — สลิปซ้ำของ
   * จริงคือ "ปิดบิลไปแล้ว + provider ยืนยันซ้ำ" ทั้งสองเงื่อนไข ถ้าเรายังไม่มี
   * ใบที่ matched แปลว่าเงินก้อนนั้นยังไม่ถูกใช้ปิดบิล จึงต้องเข้าคิวรอตรวจ
   * พร้อมเลขอ้างอิง/ยอดที่อ่านได้ ไม่ใช่ปฏิเสธทิ้ง (ไม่งั้นเงินที่โอนมาจริง
   * จะหายไปจากสายตาเจ้าของหอ) — และไม่ปิดบิลอัตโนมัติเพราะ provider ยังไม่
   * ยืนยันว่าสลิปใบนี้ผ่าน
   */
  if (result.duplicate) {
    const used = transRef === null
      ? null
      : await env.DB.prepare("SELECT id FROM slips WHERE family_id = ? AND trans_ref = ? AND status = 'matched' LIMIT 1")
          .bind(familyId, transRef)
          .first<{ id: string }>();

    if (used !== null) {
      await rejectDuplicateSlip(env, familyId, slipId, result, userId, used.id);
      return;
    }

    console.log(
      JSON.stringify({
        message: "provider reported a duplicate but no bill was closed with this reference",
        slipId,
        lineUserId: userId,
        transRef,
      }),
    );
    await keepSlipForReview(env, familyId, slipId, result, userId, "duplicate_slip", bill, sender, { duplicateNotice: true });
    return;
  }

  const payee = payeeFromBill(bill);
  let receiverVerdict: ReceiverVerdict = result.receiverMismatch
    ? "mismatch"
    : payee === null
      ? "unknown"
      : compareReceiver(result.receiver, payee);

  // ผู้ให้บริการบอกเองว่าผิดบัญชี (1014) ไม่ใช่เรื่องที่เจ้าของหอยกเว้นได้ที่ฝั่งเรา
  // ส่วนที่เราเทียบเองแล้วไม่ตรงบัญชีในบิล ค่อยลองกับบัญชีที่เจ้าของหอยอมรับเพิ่มสำหรับรอบนี้
  if (receiverVerdict === "mismatch" && !result.receiverMismatch && bill !== null) {
    const extra = await loadExtraPayee(env, familyId, bill.period);

    if (extra !== null && compareReceiver(result.receiver, extra) === "match") {
      receiverVerdict = "match";
    }
  }

  if (receiverVerdict === "mismatch") {
    console.log(
      JSON.stringify({
        message: "slip receiver does not match the dorm payee",
        slipId,
        lineUserId: userId,
        providerReported: result.receiverMismatch,
      }),
    );
    await keepSlipForReview(env, familyId, slipId, result, userId, "not_verified", bill, sender, { receiverMismatch: true });
    return;
  }

  /**
   * "ตรวจไม่ได้" ต้องแยกจาก "ตรวจแล้วไม่ผ่าน" ให้เจ้าของหอเห็นชัด
   *
   * สลิปที่โอนผิดบัญชีหรือยอดไม่ตรง คือคำตอบที่ผู้ให้บริการยืนยันแล้วว่ารู้เรื่อง
   * ส่วนคีย์หาย ผู้ให้บริการล่ม หรือรูปอ่านไม่ออก คือระบบเรายังไม่ได้คำตอบ —
   * ต้องเล่าให้ต่างกัน ไม่งั้นเจ้าของหอจะเห็นแค่ "ตรวจไม่ผ่าน" เหมือนกันหมด
   * แล้วไม่รู้ว่าต้องไปแก้ที่ไหน (นี่คือเหตุผลที่กรณีนี้เคยหายไปกับ log)
   */
  if (outcome.failed) {
    await keepSlipForReview(env, familyId, slipId, result, userId, "verify_failed", bill, sender, {
      detail: outcome.failure,
    });
    return;
  }

  if (!result.verified || amount === null || bill === null || toSatang(amount) !== toSatang(bill.total)) {
    const reason: SlipReason = bill === null ? "no_unpaid_bill" : !result.verified || amount === null ? "not_verified" : "mismatch";
    await keepSlipForReview(env, familyId, slipId, result, userId, reason, bill, sender);
    return;
  }

  /**
   * ปิดบิลไปแล้วเท่านั้นจึงเรียกว่าสลิปซ้ำ
   *
   * เงื่อนไขเดิม (`status <> 'rejected'`) นับสลิปที่แค่ "เคยเก็บเลขอ้างอิงไว้"
   * ด้วย ทำให้สลิปที่ provider อ่านไม่ได้รอบแรกแต่เราอ่านได้ (หรือยอดไม่ตรงแล้ว
   * เข้าคิว) พอโอนมาอีกรอบถูกกล่าวหาว่าซ้ำทั้งที่ยังไม่มีบิลใบไหนถูกปิด —
   * ผู้เช่าจึงถูกปฏิเสธทั้งที่เงินยังไม่ถูกใช้ปิดบิล
   */
  if (transRef !== null) {
    const used = await env.DB.prepare(
      "SELECT id FROM slips WHERE family_id = ? AND trans_ref = ? AND status = 'matched' LIMIT 1",
    )
      .bind(familyId, transRef)
      .first<{ id: string }>();

    if (used !== null) {
      await rejectDuplicateSlip(env, familyId, slipId, result, userId, used.id);
      return;
    }
  }

  let results: D1Result[];

  try {
    results = await env.DB.batch([
      env.DB.prepare(matchSlipSql).bind(
        bill.id,
        bill.total,
        amount,
        transRef,
        slipResultJson(result, null),
        slipId,
        familyId,
        bill.id,
        familyId,
        familyId,
        transRef,
        slipId,
      ),
      env.DB.prepare(closeBillSql).bind(canonicalPaidAt(result.date), bill.id, familyId, slipId, familyId),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // ด่าน unique index ยิงเพราะมีใบ matched ด้วยเลขอ้างอิงเดียวกันอยู่จริง
      // ดึง id มาให้ครบเพื่อให้บันทึกได้ว่าไปซ้ำกับใบไหน ไม่ใช่ปล่อยเป็น null
      const used = transRef === null
        ? null
        : await env.DB.prepare("SELECT id FROM slips WHERE family_id = ? AND trans_ref = ? AND status = 'matched' LIMIT 1")
            .bind(familyId, transRef)
            .first<{ id: string }>();

      await rejectDuplicateSlip(env, familyId, slipId, result, userId, used?.id ?? null);
      return;
    }

    throw error;
  }

  if ((results[0]?.meta.changes ?? 0) === 0 || (results[1]?.meta.changes ?? 0) === 0) {
    // ไม่มีอะไรถูกเขียนเลย: หรือบิลถูกปิดไปก่อนแล้ว หรือเลขอ้างอิงนี้ถูกใช้ปิดบิลไปแล้ว
    const used = transRef === null
      ? null
      : await env.DB.prepare(
          "SELECT id FROM slips WHERE family_id = ? AND trans_ref = ? AND status = 'matched' AND id <> ? LIMIT 1",
        )
          .bind(familyId, transRef, slipId)
          .first<{ id: string }>();

    if (used !== null) {
      await rejectDuplicateSlip(env, familyId, slipId, result, userId, used.id);
      return;
    }

    /**
     * บิลที่เทียบไว้ถูกปิดไปก่อนระหว่างที่สลิปกำลังถูกตรวจ (เจ้าของกดปิดเอง
     * หรือสลิปอีกใบปิดไปก่อน) — ต้องเก็บ bill ไว้ ไม่ใช่ทิ้งเป็น null
     *
     * เราเทียบสลิปกับใบนี้จริงและรู้ว่ามันคือใบไหน การทิ้งข้อมูลทำให้เจ้าของหอ
     * เห็น "ไม่มีบิลให้เทียบ" แล้วไม่รู้ว่าสลิปนี้ตั้งใจจะปิดบิลใบใด ทั้งที่รู้อยู่
     * (reason ยังเป็น `no_unpaid_bill` เพราะตอนตัดสินไม่มีบิลค้างเหลือแล้ว
     * แต่ `bill_id` ไม่ null คือสัญญาณว่ามีใบที่ถูกปิดไปก่อน)
     */
    await keepSlipForReview(env, familyId, slipId, result, userId, "no_unpaid_bill", bill, sender);
    return;
  }

  console.log(JSON.stringify({ message: "slip closed a bill", slipId, lineUserId: userId, billId: bill.id }));
  await pushMessage(env, userId, [slipMatchedMessage(bill.total, bill.period)]);

  const event: BillPaidEvent = {
    billId: bill.id,
    roomNumber: sender.room_number,
    tenantName: sender.full_name,
    period: bill.period,
    total: bill.total,
    method: "transfer",
    source: "auto-slip",
    paidAt: canonicalPaidAt(result.date),
    slipImageKey: imageKey,
  };

  // ต้นทางเป็น LINE ไม่ใช่แท็บเว็บ จึงไม่มี connectionId ที่ต้องยกเว้น
  await broadcastBillPaid(env, familyId, event, null);
  await pushOwnerBillPaid(env, familyId, origin, event);
}
