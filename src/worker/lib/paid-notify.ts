import { logLineFailure, failureDetail, pushMessage } from "../line/api";
import { ownerBillPaidMessage } from "../line/messages";
import type { RealtimeBillPaid, RealtimeTenantJoined } from "../realtime";
import { billDetailUrl } from "./line-link";
import { signedSlipUrl } from "./slip-link";

export type BillPaidSource = "auto-slip" | "owner-settle" | "mark-paid";

/**
 * ทางที่ผู้เช่าใหม่เข้าระบบ
 *
 * `self` = ลงทะเบียนเองผ่านฟอร์ม LIFF (เจ้าของยังไม่รู้จัก)
 * `owner` = เจ้าของกดเชื่อม LINE ให้ผู้เช่าที่มีอยู่แล้วในระบบ
 */
export type TenantJoinedSource = "self" | "owner";

export interface TenantJoinedEvent {
  tenantId: string;
  roomNumber: string;
  tenantName: string;
  source: TenantJoinedSource;
  /** ISO string */
  joinedAt: string;
}

export interface BillPaidEvent {
  billId: string;
  roomNumber: string;
  tenantName: string;
  period: string;
  total: number;
  method: "transfer" | "cash";
  source: BillPaidSource;
  /** ISO string */
  paidAt: string;
  /** คีย์รูปใน R2 — null เมื่อปิดบิลโดยไม่มีสลิป */
  slipImageKey: string | null;
}

/** แปลงเวลาชำระเป็นข้อความไทยตามเวลาไทย */
export function paidAtLabel(paidAt: string): string {
  const parsed = Date.parse(paidAt);

  if (Number.isNaN(parsed)) {
    return "-";
  }

  return new Date(parsed).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** ข้อความช่องทางที่ใช้ทั้งในการ์ด LINE และ toast บนเว็บ */
export function methodLabel(event: BillPaidEvent): string {
  if (event.source === "auto-slip") {
    return "สลิปอัตโนมัติ";
  }

  if (event.source === "owner-settle") {
    return "ยืนยันจากคิวรอตรวจ";
  }

  return event.method === "cash" ? "เงินสด" : "โอน (บันทึกเอง)";
}

/** ประวัติแจ้งเตือนเก่ากว่านี้ถูกลบตอนมีรายการใหม่เข้า — ไม่ต้องมีงานตั้งเวลา (ระบบไม่มี cron) */
const notificationRetentionDays = 90;

/**
 * เก็บเหตุการณ์ลงประวัติแจ้งเตือน (ตาราง notifications) — ไม่ throw
 *
 * เรียกจากจุดกระจายเหตุการณ์ทั้งสองจุดนี้เท่านั้น จึงเป็นทางเดียวที่เหตุการณ์เข้าประวัติ ไม่ว่าจะ
 * มาจากสลิปอัตโนมัติ เจ้าของกดเอง หรือผู้เช่าลงทะเบียน ความล้มเหลวเป็นแค่ log เพราะงานจริง
 * (ปิดบิล/ลงทะเบียน) สำเร็จไปใน D1 แล้ว และต้องไม่ทำให้การกระจายสดข้างหลังไม่ถูกเรียก
 *
 * INSERT OR IGNORE: เหตุการณ์เดียวกันถูกส่งซ้ำ (LINE ส่ง webhook ซ้ำ) ได้แถวเดียว
 */
async function recordNotification(
  env: Env,
  familyId: string,
  kind: "bill-paid" | "tenant-joined",
  ref: string,
  payload: Record<string, unknown>,
  actorUserId: string | null,
): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO notifications (family_id, kind, ref, payload, actor_user_id) VALUES (?, ?, ?, ?, ?)",
      ).bind(familyId, kind, ref, JSON.stringify(payload), actorUserId),
      env.DB.prepare("DELETE FROM notifications WHERE family_id = ? AND created_at < datetime('now', ?)").bind(
        familyId,
        `-${String(notificationRetentionDays)} days`,
      ),
    ]);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "notification record failed",
        kind,
        ref,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * ส่งเข้า WebSocket ของครอบครัวนี้ — await ก่อนตอบ HTTP
 *
 * ห้ามให้ขั้นนี้ทำให้คำขอปิดบิลล้มเหลว: บิลถูกปิดใน D1 ไปแล้ว ความผิดพลาด
 * ของการกระจายข้อความต้องเป็นแค่ log ไม่ใช่ 500 ที่ทำให้ผู้ใช้เข้าใจว่าปิด
 * ไม่สำเร็จแล้วกดซ้ำ (ซึ่งจะได้ 409)
 */
export async function broadcastBillPaid(
  env: Env,
  familyId: string,
  event: BillPaidEvent,
  excludeConnectionId: string | null,
  actorUserId: string | null = null,
): Promise<void> {
  const payload: RealtimeBillPaid = {
    v: 1,
    type: "bill-paid",
    billId: event.billId,
    roomNumber: event.roomNumber,
    tenantName: event.tenantName,
    period: event.period,
    total: event.total,
    methodLabel: methodLabel(event),
    paidAt: event.paidAt,
  };

  // เก็บก่อนกระจาย: ประวัติต้องมีแม้ไม่มีแท็บไหนเปิดอยู่ให้รับ WebSocket
  await recordNotification(
    env,
    familyId,
    "bill-paid",
    event.billId,
    {
      billId: event.billId,
      roomNumber: event.roomNumber,
      tenantName: event.tenantName,
      period: event.period,
      total: event.total,
      methodLabel: payload.methodLabel,
      paidAt: event.paidAt,
    },
    actorUserId,
  );

  try {
    await env.REALTIME.get(env.REALTIME.idFromName(familyId)).broadcast(
      JSON.stringify(payload),
      excludeConnectionId,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "bill paid broadcast failed",
        billId: event.billId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * บอกทุกแท็บเว็บว่ามีผู้เช่าใหม่ — ผู้เรียกใช้ waitUntil ได้
 *
 * แยกจาก `broadcastBillPaid` เพราะไม่มี "ต้นทางที่เป็นแท็บ" ให้ยกเว้น: การ
 * ลงทะเบียนเกิดจาก LINE (คนละอุปกรณ์) และการเชื่อม LINE เป็นการกระทำของเจ้าของ
 * ที่ควรเห็นผลในทุกแท็บรวมทั้งแท็บที่กด จึงไม่รับ `excludeConnectionId` เลย
 *
 * ห้ามให้ขั้นนี้ทำให้คำขอที่ทำงานสำเร็จแล้วล้มเหลว (การลงทะเบียนเขียน D1 ไปแล้ว)
 * ความผิดพลาดจึงเป็นแค่ log
 */
export async function broadcastTenantJoined(
  env: Env,
  familyId: string,
  event: TenantJoinedEvent,
  actorUserId: string | null = null,
): Promise<void> {
  const payload: RealtimeTenantJoined = {
    v: 1,
    type: "tenant-joined",
    tenantId: event.tenantId,
    roomNumber: event.roomNumber,
    tenantName: event.tenantName,
    source: event.source,
    joinedAt: event.joinedAt,
  };

  await recordNotification(
    env,
    familyId,
    "tenant-joined",
    `${event.tenantId}:${event.joinedAt}`,
    {
      tenantId: event.tenantId,
      roomNumber: event.roomNumber,
      tenantName: event.tenantName,
      source: event.source,
      joinedAt: event.joinedAt,
    },
    actorUserId,
  );

  try {
    await env.REALTIME.get(env.REALTIME.idFromName(familyId)).broadcast(
      JSON.stringify(payload),
      null,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "tenant joined broadcast failed",
        tenantId: event.tenantId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * push LINE หาเจ้าของ — ผู้เรียกใช้ waitUntil ได้
 *
 * ถ้าเจ้าของยังไม่เชื่อม LINE ไว้ก็ไม่ใช่ความผิดพลาด แค่ข้ามพร้อม log
 * (เทียบ notifyOwnerOfSlipInReview ใน lib/slips.ts ที่ทำแบบเดียวกัน)
 */
export async function pushOwnerBillPaid(
  env: Env,
  familyId: string,
  origin: string,
  event: BillPaidEvent,
): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE family_id = ? AND key = 'owner_line_user_id'")
      .bind(familyId)
      .first<{ value: string }>();
    const ownerId = (row?.value ?? "").trim();

    if (ownerId === "") {
      console.log(
        JSON.stringify({
          message: "bill paid owner alert skipped",
          billId: event.billId,
          reason: "owner line is not linked",
        }),
      );
      return;
    }

    const slipUrl =
      event.slipImageKey === null ? null : await signedSlipUrl(env, origin, event.slipImageKey);
    const delivered = await pushMessage(env, ownerId, [
      ownerBillPaidMessage({
        roomNumber: event.roomNumber,
        tenantName: event.tenantName,
        period: event.period,
        total: event.total,
        methodLabel: methodLabel(event),
        paidAtLabel: paidAtLabel(event.paidAt),
        billUrl: billDetailUrl(origin, event.billId, event.period),
        slipUrl,
      }),
    ]);

    console.log(
      JSON.stringify({
        message: "bill paid owner alerted",
        billId: event.billId,
        delivered: delivered === true,
      }),
    );
  } catch (error) {
    logLineFailure("bill paid owner alert failed", failureDetail(error));
  }
}
