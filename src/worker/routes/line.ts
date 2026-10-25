import { Hono } from "hono";
import { type AppEnv, familyId } from "../lib/auth";
import { billDetailUrl } from "../lib/line-link";
import { integrationEnv } from "../lib/credentials";
import { broadcastTenantJoined } from "../lib/paid-notify";
import { handleSlipImage } from "../lib/slips";
import { bankThaiName } from "../lib/banks";
import { failureDetail, fetchProfile, lineFamilyId, replyMessage } from "../line/api";
import {
  buildBillFlexMessage,
  type BillFlexMessage,
  type BillMessageBill,
} from "../line/bill-message";
import {
  billStatusMessage,
  contactOwnerMessage,
  linkedMessage,
  notMatchedMessage,
  ownerBillPaidMessage,
  ownerLinkedMessage,
  ownerSendSummaryMessage,
  ownerSlipPendingMessage,
  registerLinkMessage,
  registerRequiredMessage,
  slipDuplicateMessage,
  slipInstructionMessage,
  slipMatchedMessage,
  slipPendingReviewMessage,
  type LineFlexMessage,
  type OwnerSendSkip,
  type OwnerSendSummary,
  type TenantBillSummary,
  welcomeMessage,
} from "../line/messages";
import { verifyLineSignature } from "../line/signature";
import { paidAtLabel } from "../lib/paid-notify";
import {
  asRecord,
  errorBody,
  readJsonObject,
  roomNumberOrder,
} from "./shared";

const lineWebhook = new Hono<{ Bindings: Env }>();
export const lineAdmin = new Hono<AppEnv>();

const defaultDormName = "หอพักวังจันทร์";

const upsertPendingSql =
  "INSERT INTO line_pending (line_user_id, family_id, display_name, last_message, last_seen_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(line_user_id) DO UPDATE SET display_name = COALESCE(excluded.display_name, line_pending.display_name), last_message = excluded.last_message, last_seen_at = excluded.last_seen_at";

/** กัน LINE ส่งเหตุการณ์เดิมซ้ำ */
const claimEventSql = "INSERT INTO line_events (id) VALUES (?) ON CONFLICT(id) DO NOTHING";

const pruneEventsSql = "DELETE FROM line_events WHERE received_at < datetime('now', '-1 day')";

interface PendingRow {
  line_user_id: string;
  display_name: string | null;
  last_message: string | null;
  last_seen_at: string;
}

interface TenantRow {
  id: string;
  full_name: string;
  room_number: string;
  phone: string;
  line_user_id: string | null;
}

interface LinkedTenantRow {
  id: string;
  room_number: string;
}

const slipKeyword = "ส่งสลิป";
const myBillsKeyword = "บิลของฉัน";
const contactOwnerKeyword = "ติดต่อเจ้าของ";
const registerKeyword = "ลงทะเบียน";

/** ขอเลขท้าย 4 ตัวของเบอร์ที่ลงทะเบียนไว้ก่อนเชื่อม LINE */
const linkNeedsPhoneMessage =
  "กรุณายืนยันตัวตนก่อนเชื่อม LINE พิมพ์เลขห้องตามด้วยเลขท้าย 4 ตัวของเบอร์ที่ลงทะเบียนไว้กับหอ เช่น 302 1234";

const linkPhoneMismatchMessage =
  "เลขท้าย 4 ตัวไม่ตรงกับเบอร์ที่ลงทะเบียนไว้กับห้องนี้ กรุณาตรวจสอบแล้วลองใหม่ หรือติดต่อเจ้าของหอ";

const linkRoomTakenMessage = "ห้องนี้เชื่อม LINE ไว้แล้ว หากต้องการเปลี่ยนบัญชี กรุณาติดต่อเจ้าของหอ";

interface PendingPayload {
  lineUserId: string;
  displayName: string;
  lastMessage: string | null;
  lastSeenAt: string;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function parseEvents(rawBody: string): unknown[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const record = asRecord(parsed);

  if (record === null) {
    return null;
  }

  const events = record.events;

  if (!Array.isArray(events)) {
    return null;
  }

  return events.map((event) => event as unknown);
}

function toPending(row: PendingRow): PendingPayload {
  return {
    lineUserId: row.line_user_id,
    displayName: row.display_name ?? "",
    lastMessage: row.last_message,
    lastSeenAt: row.last_seen_at,
  };
}

async function readSetting(env: Env, family: string, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE family_id = ? AND key = ?")
    .bind(family, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

function registrationUrl(env: Env, origin: string): string {
  const liffId = typeof env.LIFF_ID === "string" ? env.LIFF_ID.trim() : "";
  return liffId === ""
    ? `${origin}/register`
    : `https://liff.line.me/${liffId}`;
}

async function upsertPending(
  env: Env,
  family: string,
  lineUserId: string,
  displayName: string | null,
  lastMessage: string | null,
): Promise<void> {
  await env.DB.prepare(upsertPendingSql)
    .bind(lineUserId, family, displayName, lastMessage)
    .run();
}

async function handleFollow(
  env: Env,
  family: string,
  userId: string,
  replyToken: string,
): Promise<void> {
  const profile = await fetchProfile(env, userId);
  const dormName = (await readSetting(env, family, "dorm_name")) ?? defaultDormName;

  await upsertPending(env, family, userId, profile === null ? null : profile.displayName, null);
  await replyMessage(env, replyToken, welcomeMessage(dormName));
}

async function linkTenant(
  env: Env,
  family: string,
  userId: string,
  target: TenantRow,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE tenants SET line_user_id = ? WHERE id = ? AND family_id = ?").bind(
      userId,
      target.id,
      family,
    ),
    env.DB.prepare("DELETE FROM line_pending WHERE line_user_id = ? AND family_id = ?").bind(
      userId,
      family,
    ),
  ]);
}

/** เลขท้าย 4 ตัวของเบอร์ที่ลงทะเบียนไว้ เป็นปัจจัยที่สองที่คนนอกเดาไม่ได้ */
function phoneTailMatches(registeredPhone: string, typed: string): boolean {
  const registered = registeredPhone.replace(/\D/g, "");
  const given = typed.replace(/\D/g, "");

  if (registered.length < 4 || given.length < 4) {
    return false;
  }

  return registered.slice(-4) === given.slice(-4);
}

/**
 * เชื่อม LINE กับผู้เช่าด้วยเลขห้อง ต้องมีเลขท้าย 4 ตัวของเบอร์ที่ลงทะเบียนไว้
 * ด้วยเสมอ ไม่งั้นใครก็เดาเลขห้องแล้วสวมสิทธิ์ผู้เช่ารายนั้นได้
 */
async function handleRoomLink(
  env: Env,
  family: string,
  userId: string,
  replyToken: string,
  roomNumber: string,
  phoneDigits: string,
): Promise<boolean> {
  const target = await env.DB.prepare(
    "SELECT t.id, t.full_name, t.phone, t.line_user_id, r.room_number FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.family_id = ? AND r.family_id = ? AND r.room_number = ? AND t.status = 'current'",
  )
    .bind(family, family, roomNumber)
    .first<TenantRow>();

  if (target === null) {
    return false;
  }

  if (target.line_user_id !== null && target.line_user_id !== userId) {
    await replyMessage(env, replyToken, { type: "text", text: linkRoomTakenMessage });
    return true;
  }

  if (!phoneTailMatches(target.phone, phoneDigits)) {
    await upsertPending(env, family, userId, null, `${roomNumber} ${phoneDigits}`.trim());
    await replyMessage(env, replyToken, {
      type: "text",
      text: phoneDigits === "" ? linkNeedsPhoneMessage : linkPhoneMismatchMessage,
    });
    return true;
  }

  await linkTenant(env, family, userId, target);
  await replyMessage(env, replyToken, linkedMessage(target.full_name, target.room_number));
  return true;
}

async function handleTextMessage(
  env: Env,
  family: string,
  origin: string,
  userId: string,
  replyToken: string,
  text: string,
): Promise<void> {
  const sender = await env.DB.prepare(
    "SELECT t.id, r.room_number FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.family_id = ? AND r.family_id = ? AND t.line_user_id = ?",
  )
    .bind(family, family, userId)
    .first<LinkedTenantRow>();

  const trimmed = text.trim();

  if (trimmed === slipKeyword) {
    await replyMessage(env, replyToken, slipInstructionMessage());
    return;
  }

  if (trimmed === myBillsKeyword) {
    if (sender === null) {
      await replyMessage(
        env,
        replyToken,
        registerRequiredMessage(registrationUrl(env, origin)),
      );
    } else {
      const bills = await env.DB.prepare(
        "SELECT period, total, status FROM bills WHERE family_id = ? AND tenant_id = ? ORDER BY period DESC",
      )
        .bind(family, sender.id)
        .all<TenantBillSummary>();

      await replyMessage(
        env,
        replyToken,
        billStatusMessage(sender.room_number, bills.results),
      );
    }

    return;
  }

  if (trimmed === contactOwnerKeyword) {
    const ownerName = (await readSetting(env, family, "owner_name")) ?? "";
    const ownerPhone = (await readSetting(env, family, "owner_phone")) ?? "";
    const ownerLineId = (await readSetting(env, family, "owner_line_id")) ?? "";

    await replyMessage(
      env,
      replyToken,
      contactOwnerMessage(ownerName, ownerPhone, ownerLineId),
    );
    return;
  }

  if (trimmed === registerKeyword) {
    const url = registrationUrl(env, origin);

    await replyMessage(
      env,
      replyToken,
      sender === null ? registerRequiredMessage(url) : registerLinkMessage(url),
    );
    return;
  }

  if (sender !== null) {
    return;
  }

  const [roomToken = "", phoneToken = ""] = trimmed.split(/\s+/);
  const roomNumber = roomToken.toUpperCase();

  if (roomNumber !== "" && await handleRoomLink(env, family, userId, replyToken, roomNumber, phoneToken)) {
    return;
  }

  // เช็ครูปแบบก่อนเพื่อไม่ต้องแตะฐานข้อมูลทุกข้อความที่ไม่ใช่รหัส 6 หลัก
  if (/^\d{6}$/.test(trimmed)) {
    // ทุกคำสั่งต้องอยู่ใน batch เดียวกันและใช้เงื่อนไขเดียวกันทั้งหมด (ประเมิน
    // จากสถานะก่อน batch นี้เริ่ม) ไม่ใช่ "consume รหัสก่อน แล้วค่อยผูกทีหลัง
    // เป็นอีกก้อนหนึ่ง" เพราะถ้า worker ล้มกลางทางระหว่างสองก้อนนั้น รหัสจะถูก
    // ใช้ไปแล้วแต่ไม่มีใครถูกผูกเป็นเจ้าของเลย และช่วงว่างระหว่างสองก้อนยังเปิด
    // ให้ settings GET ที่มาคั่นกลางออกรหัสใหม่ซ้อนขึ้นมาได้ กลายเป็นมีรหัสที่
    // ใช้ได้สองใบพร้อมกันชั่วขณะ ให้คนที่สองมาแย่งผูกซ้ำจนใครชนะก็ได้
    //
    // คำสั่งที่ "ล้าง" ทั้งรหัสและวันหมดอายุต้องรวมเป็นคำสั่งเดียวและอยู่
    // ท้ายสุด — ถ้าแยกเป็นสองคำสั่ง คำสั่งแรกที่ล้างวันหมดอายุจะทำให้ guard
    // ของคำสั่งถัดไป (ที่เช็คว่าวันหมดอายุยังไม่ผ่าน) เห็นค่าว่างแล้วเข้าใจผิด
    // ว่าไม่ผ่านเงื่อนไข ทั้งที่จริงคำขอนี้เองเป็นคนกำลังจะใช้รหัสอยู่ — รวมเป็น
    // UPDATE เดียวด้วย key IN (...) จึงเห็น snapshot ก่อนคำสั่งนี้เริ่มเสมอ
    // (พิสูจน์แล้วว่า SQLite ประเมิน WHERE ของ UPDATE เดียวจาก pre-image
    // เดียวกันสำหรับทุกแถวที่ถูกแก้ ไม่ใช่ไล่เห็นผลของแถวก่อนหน้าในคำสั่งเดียวกัน)
    const guard = `EXISTS (
      SELECT 1 FROM settings WHERE family_id = ? AND key = 'owner_link_code' AND value = ? AND value <> ''
        AND EXISTS (SELECT 1 FROM settings WHERE family_id = ? AND key = 'owner_link_code_expires_at' AND value <> '' AND datetime(value) > datetime('now'))
    )`;
    const guardParams = [family, trimmed, family];

    const results = await env.DB.batch([
      // ผูก owner_line_user_id — ใช้ SELECT แทน VALUES เพื่อให้ WHERE คุมได้
      // แม้เป็นการ insert ครั้งแรก (ยังไม่เคยมีแถวนี้มาก่อนตอนยังไม่เคยเชื่อม)
      env.DB.prepare(
        `INSERT INTO settings (family_id, key, value, updated_at)
         SELECT ?, 'owner_line_user_id', ?, datetime('now') WHERE ${guard}
         ON CONFLICT(family_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE ${guard}`,
      ).bind(family, userId, ...guardParams, ...guardParams),
      env.DB.prepare(`DELETE FROM line_pending WHERE line_user_id = ? AND family_id = ? AND ${guard}`).bind(
        userId,
        family,
        ...guardParams,
      ),
      // ล้างรหัสและวันหมดอายุพร้อมกันในคำสั่งเดียว ต้องมาท้ายสุดตามเหตุผลข้างบน
      env.DB.prepare(
        `UPDATE settings SET value = '', updated_at = datetime('now')
         WHERE family_id = ? AND key IN ('owner_link_code', 'owner_link_code_expires_at') AND ${guard}`,
      ).bind(family, ...guardParams),
    ]);

    if ((results[0]?.meta.changes ?? 0) > 0) {
      await replyMessage(env, replyToken, ownerLinkedMessage());
      return;
    }
  }

  await upsertPending(env, family, userId, null, text);
  await replyMessage(env, replyToken, notMatchedMessage(text));
}

async function handleEvent(
  env: Env,
  family: string,
  origin: string,
  value: unknown,
): Promise<void> {
  const event = asRecord(value);

  if (event === null) {
    return;
  }

  const source = asRecord(event.source);
  const userId = source === null ? "" : readString(source, "userId");

  if (userId === "") {
    return;
  }

  const type = readString(event, "type");
  const replyToken = readString(event, "replyToken");

  if (type === "follow") {
    await handleFollow(env, family, userId, replyToken);
    return;
  }

  if (type !== "message") {
    return;
  }

  const message = asRecord(event.message);

  if (message === null) {
    return;
  }

  const messageType = readString(message, "type");

  if (messageType === "text") {
    await handleTextMessage(
      env,
      family,
      origin,
      userId,
      replyToken,
      readString(message, "text"),
    );
    return;
  }

  if (messageType === "image") {
    await handleSlipImage(
      env,
      family,
      origin,
      userId,
      replyToken,
      readString(message, "id"),
    );
  }
}

/**
 * จองสิทธิ์ประมวลผลเหตุการณ์ตาม webhookEventId
 *
 * INSERT ที่ชนกับแถวเดิมจะไม่เปลี่ยนอะไร (changes = 0) จึงรู้ได้ทันทีว่า
 * เหตุการณ์นี้เคยถูกประมวลผลไปแล้ว การจองเกิดก่อนตอบ 200 เพื่อให้ LINE
 * ส่งซ้ำเมื่อไรก็ไม่สร้างสลิปซ้ำหรือเรียก SlipOK อีก
 */
async function claimEvents(env: Env, events: readonly unknown[]): Promise<unknown[]> {
  const claimed = new Set<string>();
  const pending: Array<{ event: unknown; statement: number | null }> = [];
  const statements: D1PreparedStatement[] = [];

  for (const event of events) {
    const record = asRecord(event);
    const webhookEventId = record === null ? "" : readString(record, "webhookEventId");

    if (webhookEventId === "" || claimed.has(webhookEventId)) {
      pending.push({ event, statement: webhookEventId === "" ? null : -1 });
      continue;
    }

    claimed.add(webhookEventId);
    pending.push({ event, statement: statements.length });
    statements.push(env.DB.prepare(claimEventSql).bind(webhookEventId));
  }

  if (statements.length === 0) {
    return [...events];
  }

  const results = await env.DB.batch(statements);
  const fresh: unknown[] = [];

  for (const item of pending) {
    if (item.statement === null) {
      fresh.push(item.event);
      continue;
    }

    if (item.statement >= 0 && (results[item.statement]?.meta.changes ?? 0) > 0) {
      fresh.push(item.event);
    }
  }

  return fresh;
}

/**
 * ประมวลผลเหตุการณ์หนึ่งแบบเบื้องหลัง โดยไม่ปล่อยให้ความล้มเหลวหายไป
 *
 * เหตุการณ์ถูกจองสิทธิ์ไว้แล้วก่อนตอบ 200 จึงไม่มีทางที่ LINE จะส่งเหตุการณ์
 * เดิมกลับมาให้ลองใหม่ (redelivery ปิดอยู่โดยค่าเริ่มต้น) จึงต้อง log ให้ครบ
 * และปล่อยสิทธิ์คืน เพื่อให้กดส่งซ้ำด้วยมือหรือเปิด redelivery ในอนาคตทำงานได้
 * จริง งานที่ล้มกลางคันต้องไม่ถูกมองว่า "ทำไปแล้ว"
 */
async function runEvent(env: Env, family: string, origin: string, event: unknown): Promise<void> {
  const record = asRecord(event);
  const webhookEventId = record === null ? "" : readString(record, "webhookEventId");

  try {
    await handleEvent(env, family, origin, event);
  } catch (error) {
    const detail = failureDetail(error);
    console.error(
      JSON.stringify({ message: "line webhook failed", webhookEventId, error: detail }),
    );

    if (webhookEventId !== "") {
      try {
        await env.DB.prepare("DELETE FROM line_events WHERE id = ?").bind(webhookEventId).run();
      } catch (releaseError) {
        console.error(
          JSON.stringify({
            message: "line event release failed",
            webhookEventId,
            error: failureDetail(releaseError),
          }),
        );
      }
    }
  }
}

lineWebhook.post("/", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-line-signature") ?? "";

  /**
   * ต้องรู้ครอบครัวของช่องก่อนตรวจลายเซ็น เพราะ secret อาจเป็นค่าที่เจ้าของกรอกไว้
   * ในหน้าตั้งค่า (ค่าที่กรอกชนะ env) ส่วน meta.line_family_id เป็นค่าคงที่ของ
   * การติดตั้ง ไม่ได้มาจากคำขอ จึงอ่านก่อนได้ — ลายเซ็นที่ผิดยังถูกปฏิเสธเหมือนเดิม
   */
  const family = await lineFamilyId(c.env);
  const webhookEnv = family === null ? c.env : await integrationEnv(c.env, family);
  const verified = await verifyLineSignature(
    webhookEnv.LINE_CHANNEL_SECRET,
    rawBody,
    signature,
  );

  if (!verified) {
    console.error(
      JSON.stringify({
        message: "line webhook rejected",
        reason: signature === "" ? "missing signature" : "invalid signature",
      }),
    );
    return c.json(errorBody("VALIDATION", "ลายเซ็นของคำขอไม่ถูกต้อง"), 403);
  }

  const events = parseEvents(rawBody);

  if (events === null) {
    console.error(
      JSON.stringify({ message: "line webhook body is malformed" }),
    );
    return c.json({ ok: true }, 200);
  }

  const origin = new URL(c.req.url).origin;
  const fresh = await claimEvents(webhookEnv, events);

  try {
    await webhookEnv.DB.prepare(pruneEventsSql).run();
  } catch (error) {
    console.error(
      JSON.stringify({ message: "line event prune failed", error: failureDetail(error) }),
    );
  }

  if (family === null) {
    console.error(
      JSON.stringify({ message: "line webhook failed", error: "meta.line_family_id is not configured" }),
    );
    return c.json({ ok: true }, 200);
  }

  // ตอบ 200 ให้ LINE ทันทีแล้วทำงานเบื้องหลัง
  //
  // เดิมประมวลผล inline ก่อนตอบ ซึ่งกินเวลาหลายวินาที (ดาวน์โหลดรูป + R2 +
  // ตรวจสลิปกับ SlipOK) เกินเวลาที่ LINE รอ — invocation ถูกตัดกลางทางแล้ว
  // งานที่ทำค้างไว้หายไปครึ่งๆ กลางๆ โดยไม่มีใครรู้ (สลิป 2026-09-21 ถูกสร้าง
  // แถวแล้วแต่ verify_result เป็น NULL ตลอดกาล และ LINE ไม่ส่งซ้ำให้เพราะ
  // redelivery ปิดอยู่โดยค่าเริ่มต้น) ดังนั้น "ตอบให้ทัน" คือสิ่งที่ต้องมาก่อน
  // ผลลัพธ์ของงาน ส่วนความคืบหน้าของงานอาศัย claimEvents ที่จองสิทธิ์ไว้แล้ว
  // ตั้งแต่ก่อนตอบ และ waitUntil ที่การันตีว่า Worker จะไม่ถูกฆ่ากลางทาง
  for (const event of fresh) {
    c.executionCtx.waitUntil(runEvent(webhookEnv, family, origin, event));
  }

  return c.json({ ok: true }, 200);
});

lineAdmin.get("/pending", async (c) => {
  const family = familyId(c);

  try {
    const result = await c.env.DB.prepare(
      "SELECT line_user_id, display_name, last_message, last_seen_at FROM line_pending WHERE family_id = ? ORDER BY last_seen_at DESC, line_user_id ASC",
    )
      .bind(family)
      .all<PendingRow>();

    return c.json({ ok: true, pending: result.results.map(toPending) }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "list pending line users failed",
        error: detail,
      }),
    );
    return c.json(
      errorBody("INTERNAL", "โหลดรายการรอเชื่อม LINE ไม่สำเร็จ"),
      500,
    );
  }
});

lineAdmin.post("/pending/:lineUserId/link", async (c) => {
  const family = familyId(c);
  const lineUserId = c.req.param("lineUserId");
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const tenantId =
    typeof body.tenantId === "string" ? body.tenantId.trim() : "";

  if (tenantId === "") {
    return c.json(
      errorBody("VALIDATION", "กรุณาเลือกผู้เช่า", "tenantId"),
      400,
    );
  }

  try {
    const pending = await c.env.DB.prepare(
      "SELECT line_user_id FROM line_pending WHERE line_user_id = ? AND family_id = ?",
    )
      .bind(lineUserId, family)
      .first<{ line_user_id: string }>();

    if (pending === null) {
      return c.json(
        errorBody("NOT_FOUND", "ไม่พบผู้ใช้ LINE รายนี้ในรายการรอเชื่อม"),
        404,
      );
    }

    const tenant = await c.env.DB.prepare(
      "SELECT id, status, line_user_id FROM tenants WHERE id = ? AND family_id = ?",
    )
      .bind(tenantId, family)
      .first<{ id: string; status: string; line_user_id: string | null }>();

    if (tenant === null) {
      return c.json(
        errorBody("NOT_FOUND", "ไม่พบผู้เช่าที่เลือก", "tenantId"),
        404,
      );
    }

    if (tenant.status !== "current") {
      return c.json(
        errorBody(
          "CONFLICT",
          "ผู้เช่ารายนี้ย้ายออกแล้ว เชื่อม LINE ไม่ได้",
          "tenantId",
        ),
        409,
      );
    }

    if (tenant.line_user_id !== null) {
      return c.json(
        errorBody("CONFLICT", "ผู้เช่ารายนี้เชื่อม LINE แล้ว", "tenantId"),
        409,
      );
    }

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tenants SET line_user_id = ? WHERE id = ? AND family_id = ?").bind(
        lineUserId,
        tenantId,
        family,
      ),
      c.env.DB.prepare("DELETE FROM line_pending WHERE line_user_id = ? AND family_id = ?").bind(
        lineUserId,
        family,
      ),
    ]);

    /**
     * ต้องดึงชื่อ/ห้องเพิ่มเพราะ `tenant` ที่อ่านมาตรวจเงื่อนไขมีแค่ id/status/line_user_id
     * (ไม่ได้ select ชื่อมา) และแท็บอื่นต้องรู้ว่าใครเพิ่งถูกเชื่อม
     */
    const joined = await c.env.DB.prepare(
      "SELECT t.full_name, r.room_number FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.id = ? AND t.family_id = ?",
    )
      .bind(tenantId, family)
      .first<{ full_name: string; room_number: string }>();

    if (joined !== null) {
      await broadcastTenantJoined(
        // ค่าที่เจ้าของกรอกในหน้าตั้งค่าชนะ env — push ต้องใช้ token ตัวที่ใช้จริง
        await integrationEnv(c.env, family),
        family,
        {
          tenantId,
          roomNumber: joined.room_number,
          tenantName: joined.full_name,
          source: "owner",
          joinedAt: new Date().toISOString(),
        },
        c.get("session").userId,
      );
    }

    return c.json({ ok: true }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "link pending line user failed",
        lineUserId,
        tenantId,
        error: detail,
      }),
    );

    if (detail.includes("UNIQUE")) {
      return c.json(
        errorBody(
          "CONFLICT",
          "LINE นี้เชื่อมกับผู้เช่ารายอื่นแล้ว",
          "tenantId",
        ),
        409,
      );
    }

    return c.json(errorBody("INTERNAL", "เชื่อม LINE ไม่สำเร็จ"), 500);
  }
});

interface LineMessageKind {
  key: string;
  title: string;
  audience: "tenant" | "owner";
  trigger: string;
  message: LineFlexMessage | BillFlexMessage;
}

interface SampleBillRow {
  id: string;
  room_number: string;
  tenant_name: string;
  period: string;
  rent: number;
  water_previous: number;
  water_current: number;
  water_units: number;
  water_rate: number;
  water_amount: number;
  electric_mode: string;
  electric_previous: number;
  electric_current: number;
  electric_units: number | null;
  electric_rate: number | null;
  electric_amount: number;
  total: number;
  created_at: string;
}

async function loadSampleBill(
  env: Env,
  family: string,
): Promise<{ bill: BillMessageBill; period: string } | null> {
  const latest = await env.DB.prepare(
    "SELECT period FROM bills WHERE family_id = ? ORDER BY period DESC LIMIT 1",
  )
    .bind(family)
    .first<{ period: string }>();

  if (latest === null) {
    return null;
  }

  const row = await env.DB.prepare(
    `SELECT b.id, r.room_number, t.full_name AS tenant_name, b.period, b.rent, b.water_previous, b.water_current, b.water_units, b.water_rate, b.water_amount, b.electric_mode, b.electric_previous, b.electric_current, b.electric_units, b.electric_rate, b.electric_amount, b.total, b.created_at FROM bills b JOIN rooms r ON r.id = b.room_id JOIN tenants t ON t.id = b.tenant_id WHERE b.family_id = ? AND b.period = ? ORDER BY ${roomNumberOrder("r.room_number")} LIMIT 1`,
  )
    .bind(family, latest.period)
    .first<SampleBillRow>();

  if (row === null) {
    return null;
  }

  const charges = await env.DB.prepare(
    "SELECT name, amount FROM bill_charges WHERE family_id = ? AND bill_id = ? ORDER BY position ASC",
  )
    .bind(family, row.id)
    .all<{ name: string; amount: number }>();

  return {
    period: row.period,
    bill: {
      id: row.id,
      roomNumber: row.room_number,
      tenantName: row.tenant_name,
      period: row.period,
      rent: row.rent,
      waterPrevious: row.water_previous,
      waterCurrent: row.water_current,
      waterUnits: row.water_units,
      waterRate: row.water_rate,
      waterAmount: row.water_amount,
      electricMode: row.electric_mode === "flat" ? "flat" : "meter",
      electricPrevious: row.electric_previous,
      electricCurrent: row.electric_current,
      electricUnits: row.electric_units,
      electricRate: row.electric_rate,
      electricAmount: row.electric_amount,
      charges: charges.results,
      total: row.total,
      createdAt: row.created_at,
    },
  };
}

interface OwnerSendSummaryRow {
  room_number: string;
  tenant_name: string;
  line_user_id: string | null;
  total: number;
  sent_at: string | null;
}

async function loadOwnerSendSummary(
  env: Env,
  family: string,
  period: string,
): Promise<OwnerSendSummary> {
  const result = await env.DB.prepare(
    `SELECT r.room_number, t.full_name AS tenant_name, t.line_user_id, b.total, b.sent_at FROM bills b JOIN rooms r ON r.id = b.room_id JOIN tenants t ON t.id = b.tenant_id WHERE b.family_id = ? AND b.period = ? ORDER BY ${roomNumberOrder("r.room_number")}`,
  )
    .bind(family, period)
    .all<OwnerSendSummaryRow>();

  const skipped: OwnerSendSkip[] = [];
  let total = 0;
  let sent = 0;

  for (const row of result.results) {
    total += row.total;

    if (row.sent_at !== null) {
      sent += 1;
    }

    if (row.line_user_id === null || row.line_user_id.trim() === "") {
      skipped.push({
        roomNumber: row.room_number,
        tenantName: row.tenant_name,
      });
    }
  }

  return {
    period,
    count: result.results.length,
    total,
    sent,
    failed: 0,
    failedRooms: [],
    skipped,
  };
}

interface LastSentRow {
  sent_at: string;
  room_number: string;
  period: string;
}

/**
 * การส่งบิลครั้งล่าสุดของหอ — ใช้ตอบ "ส่งไปถึงหรือยัง" บนหน้าแคตตาล็อกข้อความ
 *
 * อ่านจาก bills.sent_at ซึ่งเป็นความจริงเดียวที่ระบบมีเกี่ยวกับ "ส่งแล้ว"
 * (ตาราง line_events เก็บแค่การจองสิทธิ์ประมวลผล webhook ขาเข้า ไม่ใช่ขาออก)
 */
async function loadLastBillSentAt(
  env: Env,
  family: string,
): Promise<{ sentAt: string; roomNumber: string; period: string } | null> {
  const row = await env.DB.prepare(
    `SELECT b.sent_at, r.room_number, b.period FROM bills b JOIN rooms r ON r.id = b.room_id WHERE b.family_id = ? AND b.sent_at IS NOT NULL ORDER BY b.sent_at DESC LIMIT 1`,
  )
    .bind(family)
    .first<LastSentRow>();

  if (row === null) {
    return null;
  }

  return { sentAt: row.sent_at, roomNumber: row.room_number, period: row.period };
}

lineAdmin.get("/messages", async (c) => {
  const family = familyId(c);

  try {
    const origin = new URL(c.req.url).origin;
    // เดิมอ่านทีละค่า (D1 ไป-กลับ 10 รอบต่อกัน) — ทุกค่าไม่พึ่งกัน ยิงพร้อมกันได้
    const [
      dormNameRaw,
      ownerNameRaw,
      ownerPhoneRaw,
      ownerLineIdRaw,
      promptpayIdRaw,
      promptpayNameRaw,
      bankNameRaw,
      bankAccountNumberRaw,
      bankAccountNameRaw,
      sample,
    ] = await Promise.all([
      readSetting(c.env, family, "dorm_name"),
      readSetting(c.env, family, "owner_name"),
      readSetting(c.env, family, "owner_phone"),
      readSetting(c.env, family, "owner_line_id"),
      readSetting(c.env, family, "promptpay_id"),
      readSetting(c.env, family, "promptpay_name"),
      readSetting(c.env, family, "bank_name"),
      readSetting(c.env, family, "bank_account_number"),
      readSetting(c.env, family, "bank_account_name"),
      loadSampleBill(c.env, family),
    ]);
    const dormName = dormNameRaw ?? defaultDormName;
    const ownerName = ownerNameRaw ?? "";
    const ownerPhone = ownerPhoneRaw ?? "";
    const ownerLineId = ownerLineIdRaw ?? "";
    const promptpayId = promptpayIdRaw ?? "";
    const promptpayName = promptpayNameRaw ?? "";
    const bankName = bankThaiName(bankNameRaw ?? "");
    const bankAccountNumber = bankAccountNumberRaw ?? "";
    const bankAccountName = bankAccountNameRaw ?? "";
    const messages: LineMessageKind[] = [];

    if (sample !== null) {
      messages.push({
        key: "bill",
        title: "บิลรายเดือน",
        audience: "tenant",
        trigger:
          "ส่งเมื่อเจ้าของกดส่งบิลให้ผู้เช่า บอทแนบการ์ดบิลพร้อมปุ่มเปิดใบแจ้งหนี้ PDF",
        message: buildBillFlexMessage(
          sample.bill,
          { promptpayId, promptpayName, bankName, bankAccountNumber, bankAccountName },
          origin,
        ),
      });
      messages.push({
        key: "payment",
        title: "ยืนยันการชำระ",
        audience: "tenant",
        trigger:
          "ส่งเมื่อสลิปยอดตรงปิดบิลอัตโนมัติ หรือเจ้าของกดปิดบิลจากคิวรอตรวจ",
        message: slipMatchedMessage(sample.bill.total, sample.bill.period),
      });
      messages.push({
        key: "owner_bill_paid",
        title: "แจ้งเจ้าของว่ามีการชำระ",
        audience: "owner",
        trigger:
          "ส่งเมื่อบิลถูกปิดทุกกรณี — สลิปปิดอัตโนมัติ ปิดจากคิวรอตรวจ หรือเจ้าของกดปิดเอง",
        message: ownerBillPaidMessage({
          roomNumber: sample.bill.roomNumber,
          tenantName: sample.bill.tenantName,
          period: sample.bill.period,
          total: sample.bill.total,
          methodLabel: "สลิปอัตโนมัติ",
          paidAtLabel: paidAtLabel(new Date().toISOString()),
          billUrl: billDetailUrl(origin, sample.bill.id, sample.bill.period),
          slipUrl: null,
        }),
      });
    }

    messages.push({
      key: "slip_review",
      title: "สลิปรอตรวจสอบ",
      audience: "tenant",
      trigger:
        "ส่งเมื่อบอทรับสลิปแล้วยังยืนยันไม่ได้ เช่น ยอดไม่ตรง ตรวจไม่ผ่าน หรือยังไม่มีบิลค้าง",
      message: slipPendingReviewMessage(),
    });
    messages.push({
      key: "slip_duplicate",
      title: "สลิปซ้ำ",
      audience: "tenant",
      trigger: "ส่งเมื่อสลิปหรือเลขอ้างอิงโอนถูกใช้ปิดบิลไปแล้ว",
      message: slipDuplicateMessage(),
    });
    messages.push({
      key: "welcome",
      title: "ยินดีต้อนรับ",
      audience: "tenant",
      trigger: "ส่งเมื่อผู้เช่าแอดบอทเป็นครั้งแรกและบอทยังไม่รู้จักห้อง",
      message: welcomeMessage(dormName),
    });

    if (sample !== null) {
      messages.push({
        key: "link",
        title: "เชื่อม LINE สำเร็จ",
        audience: "tenant",
        trigger: "ส่งเมื่อผู้เช่าพิมพ์เลขห้องแล้วจับคู่กับผู้เช่าในระบบได้",
        message: linkedMessage(sample.bill.tenantName, sample.bill.roomNumber),
      });
    }

    messages.push({
      key: "instructions",
      title: "ส่งสลิปได้เลย",
      audience: "tenant",
      trigger: "ส่งเมื่อผู้เช่าพิมพ์คำว่า ส่งสลิป เพื่อขอวิธีส่งสลิป",
      message: slipInstructionMessage(),
    });
    messages.push({
      key: "contact_owner",
      title: "ติดต่อเจ้าของหอ",
      audience: "tenant",
      trigger: "ส่งเมื่อผู้เช่าพิมพ์คำว่า ติดต่อเจ้าของ",
      message: contactOwnerMessage(ownerName, ownerPhone, ownerLineId),
    });

    if (sample !== null) {
      messages.push({
        key: "owner_slip",
        title: "มีสลิปใหม่รอตรวจ",
        audience: "owner",
        trigger: "ส่งถึงเจ้าของทุกครั้งที่มีสลิปถูกบันทึกเข้ารอตรวจ",
        message: ownerSlipPendingMessage(
          sample.bill.roomNumber,
          sample.bill.tenantName,
          null,
          sample.bill.total,
        ),
      });
      messages.push({
        key: "owner_send_summary",
        title: "สรุปการส่งบิลทั้งหอ",
        audience: "owner",
        trigger:
          "ส่งถึงเจ้าของหลังกดส่งบิลทั้งหอ สรุปว่าส่งสำเร็จกี่ใบ ไม่สำเร็จกี่ใบ และห้องใดยังไม่เชื่อม LINE",
        message: ownerSendSummaryMessage(
          await loadOwnerSendSummary(c.env, family, sample.period),
        ),
      });
    }

    return c.json(
      {
        ok: true,
        source:
          sample === null
            ? null
            : {
                period: sample.period,
                roomNumber: sample.bill.roomNumber,
                tenantName: sample.bill.tenantName,
              },
        /**
         * เวลาที่บอทส่งข้อความจริงครั้งล่าสุด — หน้าที่นี้ถูกใช้ตอบคำถาม
         * "ส่งไปถึงหรือยัง" ไม่ใช่แค่ "หน้าตาเป็นอย่างไร" จึงต้องมีของจริง
         * ไม่ใช่ให้ผู้ใช้เดาจากคำโปรย
         */
        lastSent: await loadLastBillSentAt(c.env, family),
        messages,
      },
      200,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "list line message kinds failed",
        error: detail,
      }),
    );
    return c.json(errorBody("INTERNAL", "โหลดข้อความ LINE ไม่สำเร็จ"), 500);
  }
});

export default lineWebhook;
