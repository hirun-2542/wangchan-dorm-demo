import type { Context } from "hono";
import { Hono } from "hono";
import { type AppEnv, familyId } from "../lib/auth";
import {
  canonicalPaidAt,
  isUniqueViolation,
  parseSlipResult,
  rejectedSlipResultJson,
  type SlipReason,
} from "../lib/slips";
import { pushMessage } from "../line/api";
import { integrationEnv } from "../lib/credentials";
import { slipMatchedMessage } from "../line/messages";
import { type BillPaidEvent, broadcastBillPaid, pushOwnerBillPaid } from "../lib/paid-notify";
import { errorBody, readJsonObject } from "./shared";

const slipsAdmin = new Hono<AppEnv>();

type SlipStatus = "pending_review" | "matched" | "rejected";

const slipStatuses: readonly SlipStatus[] = ["pending_review", "matched", "rejected"];

const defaultSlipStatus: SlipStatus = "pending_review";

const slipColumns =
  "s.id, s.created_at, s.image_key, s.status, s.verify_result, s.amount, s.bill_id, s.bill_total, s.trans_ref, s.line_user_id, b.period AS bill_period, b.total AS bill_row_total, r.room_number AS bill_room_number, t.full_name AS bill_tenant_name";

const slipFrom =
  "FROM slips s LEFT JOIN bills b ON b.id = s.bill_id AND b.family_id = s.family_id LEFT JOIN rooms r ON r.id = b.room_id AND r.family_id = s.family_id LEFT JOIN tenants t ON t.id = b.tenant_id AND t.family_id = s.family_id";

const targetBillSql =
  "SELECT b.id, b.status, b.period, b.total, r.room_number, t.full_name AS tenant_name FROM bills b JOIN rooms r ON r.id = b.room_id JOIN tenants t ON t.id = b.tenant_id WHERE b.id = ? AND b.family_id = ?";

const matchedTransRefSql = "SELECT id FROM slips WHERE family_id = ? AND trans_ref = ? AND status = 'matched' LIMIT 1";

/**
 * ผูกสลิปและปิดบิลใน transaction เดียว (DB.batch)
 *
 * คำสั่งแรกผูกสลิปได้เมื่อบิลยังไม่ถูกปิด คำสั่งที่สองปิดบิลได้เมื่อสลิปถูกผูก
 * กับบิลใบนั้นแล้วเท่านั้น เงื่อนไขสองทางนี้ทำให้ไม่มีช่วงที่สลิปถูกทำเครื่องหมาย
 * ว่าปิดบิลทั้งที่บิลยังเปิด และไม่ต้องมีคำสั่งชดเชยหลัง transaction อีก
 */
const matchSlipSql =
  "UPDATE slips SET status = 'matched', bill_id = ?, bill_total = ? WHERE id = ? AND family_id = ? AND status = 'pending_review' AND EXISTS (SELECT 1 FROM bills WHERE id = ? AND family_id = ? AND status = 'unpaid')";

const closeBillSql =
  "UPDATE bills SET status = 'paid', paid_at = ?, paid_method = 'transfer' WHERE id = ? AND family_id = ? AND status = 'unpaid' AND EXISTS (SELECT 1 FROM slips WHERE id = ? AND family_id = ? AND bill_id = bills.id AND status = 'matched')";

const rejectSlipSql =
  "UPDATE slips SET status = 'rejected', verify_result = ? WHERE id = ? AND family_id = ? AND status = 'pending_review'";

interface SlipRow {
  id: string;
  created_at: string;
  image_key: string;
  status: string;
  verify_result: string | null;
  amount: number | null;
  bill_id: string | null;
  bill_total: number | null;
  trans_ref: string | null;
  line_user_id: string;
  bill_period: string | null;
  bill_row_total: number | null;
  bill_room_number: string | null;
  bill_tenant_name: string | null;
}

interface TargetBillRow {
  id: string;
  status: string;
  period: string;
  total: number;
  room_number: string;
  tenant_name: string;
}

interface BillPayload {
  id: string;
  roomNumber: string;
  tenantName: string;
  period: string;
  total: number;
}

interface SlipPayload {
  id: string;
  createdAt: string;
  imageKey: string;
  imageUrl: string;
  status: string;
  reason: SlipReason | null;
  slipAmount: number | null;
  bill: BillPayload | null;
  verified: boolean;
  /**
   * ผลตรวจจากผู้ให้บริการพร้อมเหตุผล — หน้า รอตรวจ ใช้ `code`/`message`
   * บอกว่า "ตรวจไม่ผ่านจากอะไร" และ `detail` บอกเมื่อระบบตรวจไม่ได้เลย
   */
  verify: {
    verified: boolean;
    transRef: string | null;
    date: string | null;
    code: number | null;
    message: string | null;
    detail: string | null;
    usedSlipId: string | null;
  };
  transferAt: string | null;
}

function isSlipStatus(value: string): value is SlipStatus {
  return (slipStatuses as readonly string[]).includes(value);
}

function toBillPayload(row: SlipRow): BillPayload | null {
  if (row.bill_id === null || row.bill_room_number === null) {
    return null;
  }

  return {
    id: row.bill_id,
    roomNumber: row.bill_room_number,
    tenantName: row.bill_tenant_name ?? "",
    period: row.bill_period ?? "",
    total: row.bill_total ?? row.bill_row_total ?? 0,
  };
}

function toSlipPayload(row: SlipRow): SlipPayload {
  const stored = parseSlipResult(row.verify_result);

  return {
    id: row.id,
    createdAt: row.created_at,
    imageKey: row.image_key,
    imageUrl: `/slips/${row.image_key}`,
    status: row.status,
    reason: stored.reason,
    slipAmount: row.amount,
    bill: toBillPayload(row),
    verified: stored.verified,
    verify: {
      verified: stored.verified,
      transRef: row.trans_ref ?? stored.transRef,
      date: stored.date,
      code: stored.code,
      message: stored.message,
      detail: stored.detail,
      usedSlipId: stored.usedSlipId,
    },
    transferAt: stored.date,
  };
}

async function loadSlip(env: Env, family: string, id: string): Promise<SlipRow | null> {
  return env.DB.prepare(`SELECT ${slipColumns} ${slipFrom} WHERE s.id = ? AND s.family_id = ?`)
    .bind(id, family)
    .first<SlipRow>();
}

async function resolvedSlipResponse(c: Context<AppEnv>, id: string): Promise<Response> {
  const refreshed = await loadSlip(c.env, familyId(c), id);

  if (refreshed === null) {
    console.error(JSON.stringify({ message: "resolve slip readback failed", slipId: id }));
    return c.json(errorBody("INTERNAL", "บันทึกผลการตัดสินสลิปไม่สำเร็จ"), 500);
  }

  return c.json({ ok: true, slip: toSlipPayload(refreshed) }, 200);
}

async function settleSlip(c: Context<AppEnv>, slip: SlipRow, rawBillId: unknown): Promise<Response> {
  const family = familyId(c);
  const override = typeof rawBillId === "string" ? rawBillId.trim() : "";
  const billId = override === "" ? slip.bill_id : override;

  if (billId === null || billId === "") {
    return c.json(errorBody("VALIDATION", "กรุณาเลือกบิลที่จะปิดด้วยสลิปนี้", "billId"), 400);
  }

  const bill = await c.env.DB.prepare(targetBillSql).bind(billId, family).first<TargetBillRow>();

  if (bill === null) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบบิลที่ต้องการปิด", "billId"), 404);
  }

  if (bill.status !== "unpaid") {
    return c.json(errorBody("CONFLICT", "บิลนี้ปิดไปแล้ว เลือกบิลอื่นหรือกดยอดอีกครั้ง", "billId"), 409);
  }

  const transRef = slip.trans_ref;

  if (transRef !== null) {
    const used = await c.env.DB.prepare(matchedTransRefSql).bind(family, transRef).first<{ id: string }>();

    if (used !== null) {
      return c.json(errorBody("CONFLICT", "เลขอ้างอิงการโอนของสลิปนี้ปิดบิลไปแล้ว"), 409);
    }
  }

  const paidAt = canonicalPaidAt(parseSlipResult(slip.verify_result).date);

  let results: D1Result[];

  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(matchSlipSql).bind(bill.id, bill.total, slip.id, family, bill.id, family),
      c.env.DB.prepare(closeBillSql).bind(paidAt, bill.id, family, slip.id, family),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.json(errorBody("CONFLICT", "เลขอ้างอิงการโอนของสลิปนี้ปิดบิลไปแล้ว"), 409);
    }

    throw error;
  }

  if ((results[0]?.meta.changes ?? 0) === 0 || (results[1]?.meta.changes ?? 0) === 0) {
    console.log(JSON.stringify({ message: "slip settle conflicts with a bill closed by someone else", slipId: slip.id, billId: bill.id }));
    return c.json(errorBody("CONFLICT", "บิลนี้เพิ่งถูกปิดไป เลือกบิลอื่นหรือกดยอดอีกครั้ง", "billId"), 409);
  }

  console.log(JSON.stringify({ message: "slip settled by owner", slipId: slip.id, billId: bill.id }));

  // ค่าที่เจ้าของกรอกในหน้าตั้งค่าชนะ env — push/แจ้งเตือนต้องใช้ token ตัวที่ใช้จริง
  const env = await integrationEnv(c.env, family);
  await pushMessage(env, slip.line_user_id, [slipMatchedMessage(bill.total, bill.period)]);

  const event: BillPaidEvent = {
    billId: bill.id,
    roomNumber: bill.room_number,
    tenantName: bill.tenant_name,
    period: bill.period,
    total: bill.total,
    method: "transfer",
    source: "owner-settle",
    paidAt,
    slipImageKey: slip.image_key,
  };

  await broadcastBillPaid(env, family, event, c.req.header("x-realtime-id") ?? null, c.get("session").userId);
  c.executionCtx.waitUntil(pushOwnerBillPaid(env, family, new URL(c.req.url).origin, event));

  return resolvedSlipResponse(c, slip.id);
}

async function rejectSlip(c: Context<AppEnv>, slip: SlipRow): Promise<Response> {
  const decidedAt = new Date().toISOString();
  const updated = await c.env.DB.prepare(rejectSlipSql)
    .bind(rejectedSlipResultJson(slip.verify_result, decidedAt), slip.id, familyId(c))
    .run();

  if ((updated.meta.changes ?? 0) === 0) {
    return c.json(errorBody("CONFLICT", "สลิปนี้ถูกตัดสินไปแล้ว"), 409);
  }

  console.log(JSON.stringify({ message: "slip rejected by owner", slipId: slip.id }));

  return resolvedSlipResponse(c, slip.id);
}

slipsAdmin.get("/", async (c) => {
  const family = familyId(c);
  const rawStatus = c.req.query("status");
  const billId = (c.req.query("billId") ?? "").trim();
  const filters: string[] = ["s.family_id = ?"];
  const binds: string[] = [family];

  if (rawStatus !== undefined) {
    if (!isSlipStatus(rawStatus)) {
      return c.json(errorBody("VALIDATION", "สถานะสลิปต้องเป็น pending_review, matched หรือ rejected", "status"), 400);
    }

    filters.push("s.status = ?");
    binds.push(rawStatus);
  } else if (billId === "") {
    filters.push("s.status = ?");
    binds.push(defaultSlipStatus);
  }

  if (billId !== "") {
    filters.push("s.bill_id = ?");
    binds.push(billId);
  }

  const where = ` WHERE ${filters.join(" AND ")}`;

  try {
    // เพดานกันคิวโตไม่จำกัด: 500 ใบเกินกว่าที่หอ ≤20 ห้องจะสะสมถึงในทางปฏิบัติ
    // และเกินกว่าที่เจ้าของจะไล่ตรวจด้วยมืออยู่แล้ว — ถ้าถึงเพดานจริงต้องมีเครื่องมือเก็บกวาดมากกว่านี้
    const result = await c.env.DB.prepare(`SELECT ${slipColumns} ${slipFrom}${where} ORDER BY s.created_at DESC, s.id DESC LIMIT 500`)
      .bind(...binds)
      .all<SlipRow>();

    return c.json({ ok: true, slips: result.results.map((row) => toSlipPayload(row)) }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "list slips failed", status: rawStatus ?? defaultSlipStatus, billId, error: detail }));
    return c.json(errorBody("INTERNAL", "โหลดคิวสลิปไม่สำเร็จ"), 500);
  }
});

slipsAdmin.post("/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const action = body.action;

  if (action !== "settle" && action !== "reject") {
    return c.json(errorBody("VALIDATION", "การตัดสินสลิปต้องเป็น settle หรือ reject", "action"), 400);
  }

  try {
    const slip = await loadSlip(c.env, familyId(c), id);

    if (slip === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบสลิปที่ต้องการตัดสิน"), 404);
    }

    if (slip.status !== "pending_review") {
      return c.json(errorBody("CONFLICT", "สลิปนี้ถูกตัดสินไปแล้ว"), 409);
    }

    if (action === "reject") {
      return await rejectSlip(c, slip);
    }

    return await settleSlip(c, slip, body.billId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "resolve slip failed", slipId: id, action, error: detail }));
    return c.json(errorBody("INTERNAL", "บันทึกผลการตัดสินสลิปไม่สำเร็จ"), 500);
  }
});

export default slipsAdmin;
