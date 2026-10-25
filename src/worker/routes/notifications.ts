import { Hono } from "hono";
import type { AppEnv } from "../lib/auth";
import { familyId } from "../lib/auth";
import { errorBody, readJsonObject } from "./shared";

/**
 * ประวัติแจ้งเตือนของกระดิ่ง (ตาราง notifications, ดู migration 0014)
 *
 * เหตุการณ์ถูกเก็บตอนที่มันเกิดใน lib/paid-notify.ts ไม่ว่าจะมีแท็บเปิดอยู่หรือไม่ route นี้มีหน้าที่
 * อ่านรายการ กับบันทึกว่าผู้ใช้คนนี้อ่าน/ล้างถึงลำดับไหนแล้ว — ทั้งหมดเป็นรายผู้ใช้ ไม่ใช่รายครอบครัว
 * เพื่อให้เจ้าของกับผู้ช่วยต่างคนต่างกดอ่าน/ล้างของตัวเองได้
 */
const notifications = new Hono<AppEnv>();

/** จำนวนรายการที่ส่งให้หน้าเว็บ — เท่าเพดานที่หน้าเว็บแสดงอยู่เดิม */
const listLimit = 50;

interface NotificationRow {
  id: number;
  kind: string;
  payload: string;
  actor_user_id: string | null;
}

interface StateRow {
  read_through: number;
  cleared_through: number;
}

export interface NotificationItem {
  /** ลำดับในตาราง — หน้าเว็บส่งกลับมาตอนกดอ่าน/ล้างเพื่อบอกว่า "ถึงรายการที่ฉันเห็นแล้ว" */
  seq: number;
  kind: "bill-paid" | "tenant-joined";
  read: boolean;
  notice: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function stateOf(db: D1Database, family: string, userId: string): Promise<StateRow> {
  const row = await db
    .prepare("SELECT read_through, cleared_through FROM notification_state WHERE family_id = ? AND user_id = ?")
    .bind(family, userId)
    .first<StateRow>();

  return row ?? { read_through: 0, cleared_through: 0 };
}

notifications.get("/", async (c) => {
  const family = familyId(c);
  const userId = c.get("session").userId;
  const state = await stateOf(c.env.DB, family, userId);

  const rows = await c.env.DB.prepare(
    "SELECT id, kind, payload, actor_user_id FROM notifications WHERE family_id = ? AND id > ? ORDER BY id DESC LIMIT ?",
  )
    .bind(family, state.cleared_through, listLimit)
    .all<NotificationRow>();

  const items: NotificationItem[] = [];

  for (const row of rows.results) {
    let notice: Record<string, unknown> | null;

    try {
      notice = asRecord(JSON.parse(row.payload));
    } catch {
      notice = null;
    }

    if (notice === null || (row.kind !== "bill-paid" && row.kind !== "tenant-joined")) {
      continue;
    }

    items.push({
      seq: row.id,
      kind: row.kind,
      // คนที่กดให้เกิดเหตุการณ์เองรู้อยู่แล้ว — ไม่นับเป็นยังไม่อ่านของเขา
      read: row.id <= state.read_through || row.actor_user_id === userId,
      notice,
    });
  }

  return c.json({ ok: true, notifications: items });
});

/**
 * ค่า "ถึงลำดับที่" จากหน้าเว็บ ต้องเป็นจำนวนเต็มไม่ติดลบ และถูกตัดไม่ให้เกินลำดับล่าสุดจริง
 *
 * ไม่ตัด = ค่าใหญ่เกินจริงครั้งเดียวจะทำให้เหตุการณ์ในอนาคตทุกอันถูกนับว่าอ่าน/ล้างไปแล้วเงียบ ๆ
 */
async function readThrough(c: { env: Env; req: { raw: Request } }, family: string): Promise<number | null> {
  const body = await readJsonObject(c.req.raw);
  const raw = body?.through;

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return null;
  }

  const newest = await c.env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS newest FROM notifications WHERE family_id = ?")
    .bind(family)
    .first<{ newest: number }>();

  return Math.min(raw, newest?.newest ?? 0);
}

const throughError = errorBody("VALIDATION", "ลำดับแจ้งเตือนไม่ถูกต้อง", "through");

/** ทำเครื่องหมายว่าอ่านถึงลำดับนี้แล้ว (ตอนเปิดแผง) — ไม่ถอยหลัง เรียกซ้ำได้ */
notifications.post("/read", async (c) => {
  const family = familyId(c);
  const through = await readThrough(c, family);

  if (through === null) {
    return c.json(throughError, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO notification_state (family_id, user_id, read_through) VALUES (?, ?, ?)
     ON CONFLICT(family_id, user_id) DO UPDATE SET read_through = MAX(read_through, excluded.read_through)`,
  )
    .bind(family, c.get("session").userId, through)
    .run();

  return c.json({ ok: true });
});

/** ล้างประวัติของผู้ใช้คนนี้ถึงลำดับนี้ (ของอีกคนในครอบครัวไม่กระทบ) — ล้างแล้วถือว่าอ่านแล้วด้วย */
notifications.post("/clear", async (c) => {
  const family = familyId(c);
  const through = await readThrough(c, family);

  if (through === null) {
    return c.json(throughError, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO notification_state (family_id, user_id, read_through, cleared_through) VALUES (?, ?, ?, ?)
     ON CONFLICT(family_id, user_id) DO UPDATE SET
       read_through = MAX(read_through, excluded.read_through),
       cleared_through = MAX(cleared_through, excluded.cleared_through)`,
  )
    .bind(family, c.get("session").userId, through, through)
    .run();

  return c.json({ ok: true });
});

export default notifications;
