import { Hono } from "hono";
import { safeReturnPath } from "../../shared/return-path";
import type { AppEnv } from "../lib/auth";
import { isSecureRequest } from "../lib/auth";
import { demoModeOn } from "../line/api";
// วนกลับมา import app จาก index.ts (ซึ่ง import ไฟล์นี้กลับไปด้วย) โดยตั้งใจ —
// ปลอดภัยเพราะ app ถูกใช้เฉพาะข้างในฟังก์ชัน (ตอนมีคำขอเข้ามาแล้วเท่านั้น) ไม่ใช่
// ที่ module-level ห้ามอ้าง app ที่ module-level ของไฟล์นี้เด็ดขาด ไม่งั้นจะชน
// temporal-dead-zone ตอน Worker เริ่มทำงานแล้วทั้ง Worker ล่มไปด้วย ไม่ใช่แค่เส้นทางนี้
import app from "../index";
import { createSession, sessionCookie } from "../lib/session";
import { demoSlipImage } from "../lib/demo-slip-image";
import { errorBody } from "./shared";

const demo = new Hono<AppEnv>();

/**
 * ตัวตนคงที่ของเดโม ไม่เปลี่ยนทุกครั้งที่รีเซ็ต — สิ่งที่รีเซ็ตคือ "ข้อมูล"
 * (ห้อง/ผู้เช่า/บิล/สลิป) ไม่ใช่ครอบครัว/ผู้ใช้/เซสชัน เพราะการลบเซสชันจะ
 * เตะผู้ชมที่กำลังใช้งานอยู่ออกกลางคัน
 */
const demoFamilyId = "10000000-0000-4000-8000-000000000001";
const demoUserId = "10000000-0000-4000-8000-000000000002";
const demoUserEmail = "demo-visitor@example.invalid";
const demoOwnerLineUserId = "demo-slip-visitor";

/** ข้ามการรีเซ็ตถ้ามีคำขอเข้าเดโมภายในช่วงเวลานี้ — ประเมินว่าไม่น่ามีใครใช้อยู่ */
const idleThresholdMs = 5 * 60 * 1000;

const activityMetaKey = "demo_last_activity_at";

interface DemoRoomSeed {
  id: string;
  roomNumber: string;
  rent: number;
  waterRate: number | null;
  electricMode: "meter" | "flat";
  electricRate: number | null;
  waterMeterInit: number;
  electricMeterInit: number;
  status: "occupied" | "vacant";
}

// ชุดเดียวกับ seed/rooms.sql — ข้อมูลสังเคราะห์ล้วน ไม่ใช่ของหอจริง
const demoRooms: readonly DemoRoomSeed[] = [
  { id: "demo-room-a101", roomNumber: "A101", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 120, electricMeterInit: 320, status: "occupied" },
  { id: "demo-room-a102", roomNumber: "A102", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 98, electricMeterInit: 280, status: "occupied" },
  { id: "demo-room-a103", roomNumber: "A103", rent: 4200, waterRate: 20, electricMode: "meter", electricRate: null, waterMeterInit: 130, electricMeterInit: 310, status: "occupied" },
  { id: "demo-room-a104", roomNumber: "A104", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 190, electricMeterInit: 500, status: "vacant" },
  { id: "demo-room-a105", roomNumber: "A105", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 76, electricMeterInit: 245, status: "occupied" },
  { id: "demo-room-a106", roomNumber: "A106", rent: 3800, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 112, electricMeterInit: 300, status: "occupied" },
  { id: "demo-room-a107", roomNumber: "A107", rent: 4200, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 90, electricMeterInit: 250, status: "occupied" },
  { id: "demo-room-a108", roomNumber: "A108", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 88, electricMeterInit: 260, status: "occupied" },
  { id: "demo-room-a109", roomNumber: "A109", rent: 3800, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 145, electricMeterInit: 420, status: "vacant" },
  { id: "demo-room-a110", roomNumber: "A110", rent: 3800, waterRate: null, electricMode: "flat", electricRate: null, waterMeterInit: 130, electricMeterInit: 460, status: "occupied" },
  { id: "demo-room-a111", roomNumber: "A111", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 95, electricMeterInit: 330, status: "occupied" },
  { id: "demo-room-a112", roomNumber: "A112", rent: 1500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 62, electricMeterInit: 180, status: "occupied" },
  { id: "demo-room-a113", roomNumber: "A113", rent: 4200, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 118, electricMeterInit: 275, status: "occupied" },
  { id: "demo-room-a114", roomNumber: "A114", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 102, electricMeterInit: 210, status: "occupied" },
  { id: "demo-room-a115", roomNumber: "A115", rent: 3800, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 134, electricMeterInit: 388, status: "occupied" },
  { id: "demo-room-a116", roomNumber: "A116", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 79, electricMeterInit: 296, status: "occupied" },
  { id: "demo-room-a117", roomNumber: "A117", rent: 3500, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 160, electricMeterInit: 455, status: "vacant" },
  { id: "demo-room-a118", roomNumber: "A118", rent: 4200, waterRate: null, electricMode: "meter", electricRate: null, waterMeterInit: 121, electricMeterInit: 305, status: "occupied" },
];

interface DemoTenantSeed {
  id: string;
  roomId: string;
  fullName: string;
  phone: string;
  checkInDate: string;
  checkOutDate: string | null;
  status: "current" | "moved-out";
}

// ชุดเดียวกับ seed/tenants.sql
const demoTenants: readonly DemoTenantSeed[] = [
  { id: "demo-tenant-a101", roomId: "demo-room-a101", fullName: "สมชาย ใจดี", phone: "081-234-5678", checkInDate: "2025-03-01", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a102", roomId: "demo-room-a102", fullName: "มาลี ศรีสุข", phone: "082-345-6789", checkInDate: "2025-04-12", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a103", roomId: "demo-room-a103", fullName: "ธนา เจริญกิจ", phone: "085-456-7890", checkInDate: "2025-03-05", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a105", roomId: "demo-room-a105", fullName: "อรุณี แสงทอง", phone: "086-567-8901", checkInDate: "2025-05-20", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a106", roomId: "demo-room-a106", fullName: "ปริญญา สุวรรณโชติ", phone: "087-678-9012", checkInDate: "2025-06-01", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a107", roomId: "demo-room-a107", fullName: "วิภา สุขสันต์", phone: "090-111-2223", checkInDate: "2025-06-10", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a108", roomId: "demo-room-a108", fullName: "ศิริพร ทองคำ", phone: "088-789-0123", checkInDate: "2025-06-15", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a110", roomId: "demo-room-a110", fullName: "ณัฐพล กล้าหาญ", phone: "089-890-1234", checkInDate: "2025-07-01", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a111", roomId: "demo-room-a111", fullName: "วีระ คำมณี", phone: "091-123-4567", checkInDate: "2025-07-03", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a112", roomId: "demo-room-a112", fullName: "นพดล อินทร์แปลง", phone: "092-234-5678", checkInDate: "2025-07-10", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a113", roomId: "demo-room-a113", fullName: "จันทร์เพ็ญ อินทรีย์", phone: "093-345-6789", checkInDate: "2025-08-01", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a114", roomId: "demo-room-a114", fullName: "สมปอง ใจกล้า", phone: "094-456-7890", checkInDate: "2025-08-05", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a115", roomId: "demo-room-a115", fullName: "รัตนา แก้วมณี", phone: "095-567-8901", checkInDate: "2025-08-12", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a116", roomId: "demo-room-a116", fullName: "อนันต์ พูลสุข", phone: "096-678-9012", checkInDate: "2025-09-01", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a118", roomId: "demo-room-a118", fullName: "กิตติศักดิ์ บุญมา", phone: "097-789-0123", checkInDate: "2025-09-01", checkOutDate: null, status: "current" },
  { id: "demo-tenant-a104", roomId: "demo-room-a104", fullName: "ปกรณ์ วังทอง", phone: "098-890-1234", checkInDate: "2025-03-01", checkOutDate: "2025-08-30", status: "moved-out" },
];

// ชุดเดียวกับ seed/settings.sql
const demoSettings: ReadonlyArray<readonly [string, string]> = [
  ["dorm_name", "หอพักวังจันทร์"],
  ["owner_name", "สมหมาย ใจดี"],
  ["default_water_rate", "18"],
  ["default_electric_rate", "7"],
  ["promptpay_type", "phone"],
  ["promptpay_id", "089-111-2233"],
  ["promptpay_name", "สมหมาย ใจดี"],
];

// รูปสลิปตัวอย่างที่สังเคราะห์ขึ้นเองทั้งหมด ดู src/worker/lib/demo-slip-image.ts
// เดิมตรงนี้ใช้พิกเซลโปร่งใส 1x1 ซึ่งทำให้หน้าคิวรอตรวจแสดงกล่องเปล่าใหญ่ ๆ
// ผู้ชมเดโมจึงเห็นหน้าจอที่ดูเหมือนพังตั้งแต่แรกเข้า

function periodOf(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${String(year)}-${month}`;
}

function monthsBefore(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - count, 1));
}

/** ผู้ใช้/ครอบครัวของเดโมคงที่ตลอด สร้างครั้งเดียวแล้วไม่แตะอีก (idempotent) */
async function ensureDemoIdentity(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO families (id, name) VALUES (?, ?)").bind(demoFamilyId, "หอพักวังจันทร์ (เดโม)"),
    db.prepare("INSERT OR IGNORE INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, '')").bind(demoUserId, demoUserEmail, "ผู้เยี่ยมชมเดโม"),
    db.prepare("INSERT OR IGNORE INTO family_members (family_id, user_id, role) VALUES (?, ?, 'owner')").bind(demoFamilyId, demoUserId),
  ]);
}

async function clearDemoContent(env: Env): Promise<void> {
  // ลบไฟล์ภาพสลิปใน R2 ก่อนลบแถว slips — ไม่งั้นจะไม่มีทางรู้ key อีกเลยหลัง
  // ลบแถวไปแล้ว ไฟล์จะค้างอยู่ใน bucket ตลอดไปทุกครั้งที่รีเซ็ต
  const staleSlips = await env.DB.prepare("SELECT image_key FROM slips WHERE family_id = ?")
    .bind(demoFamilyId)
    .all<{ image_key: string }>();

  if (staleSlips.results.length > 0) {
    await env.SLIPS.delete(staleSlips.results.map((row) => row.image_key));
  }

  // ลบจากลูกไปหาแม่ตามลำดับ FK — ไม่แตะ families/users/family_members เพราะนั่นคือ
  // "ตัวตน" ไม่ใช่ "ข้อมูลตัวอย่าง" — sessions ลบเฉพาะที่ไม่มีการใช้งานมาเกินหนึ่งวัน
  // เพื่อไม่เตะผู้ชมที่กำลังใช้งานอยู่ออกกลางคัน แต่ก็ไม่ปล่อยให้พอกพูนไม่มีที่สิ้นสุด
  // จากผู้ชมที่กดเข้ามาแล้วไม่กลับมาอีก (เส้นทางนี้ไม่ต้องล็อกอินและไม่มี rate limit)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM slips WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM bill_charges WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM bills WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM room_charge_excludes WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM room_charges WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM dorm_charges WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM tenants WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM rooms WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM settings WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM line_pending WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM notification_state WHERE family_id = ?").bind(demoFamilyId),
    env.DB.prepare("DELETE FROM notifications WHERE family_id = ?").bind(demoFamilyId),
    env.DB
      .prepare("DELETE FROM sessions WHERE family_id = ? AND last_seen_at < datetime('now', '-1 day')")
      .bind(demoFamilyId),
  ]);
}

async function seedBaseContent(db: D1Database): Promise<void> {
  const statements = [
    ...demoRooms.map((room) =>
      db
        .prepare(
          "INSERT INTO rooms (id, family_id, room_number, rent, water_rate, electric_mode, electric_rate, water_meter_init, electric_meter_init, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          room.id,
          demoFamilyId,
          room.roomNumber,
          room.rent,
          room.waterRate,
          room.electricMode,
          room.electricRate,
          room.waterMeterInit,
          room.electricMeterInit,
          room.status,
        ),
    ),
    ...demoTenants.map((tenant) =>
      db
        .prepare(
          "INSERT INTO tenants (id, family_id, full_name, phone, room_id, check_in_date, check_out_date, line_user_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .bind(
          tenant.id,
          demoFamilyId,
          tenant.fullName,
          tenant.phone,
          tenant.roomId,
          tenant.checkInDate,
          tenant.checkOutDate,
          tenant.status,
        ),
    ),
    ...demoSettings.map(([key, value]) =>
      db.prepare("INSERT INTO settings (family_id, key, value) VALUES (?, ?, ?)").bind(demoFamilyId, key, value),
    ),
  ];

  await db.batch(statements);
}

/** เรียกตัวสร้างบิลเดิมของระบบตรง ๆ ในโปรเซส (แบบเดียวกับที่ชุดเทสทำ) แทนการ
 * คัดลอกตรรกะราคา/ค่าใช้จ่าย/ผู้รับเงินมาเขียนซ้ำที่นี่ */
// ดึงชนิดพารามิเตอร์ที่สามของ app.fetch() ตรง ๆ แทนที่จะเขียน `ExecutionContext`
// เองตรงนี้ — ชนิด ExecutionContext ที่มาจาก ambient ของ workers-types ไม่ตรงกับ
// ชนิดที่ Hono ประกาศไว้ใน fetch() (คอมไพล์ไม่ผ่านถ้าใช้ตรง ๆ) การดึงชนิดจาก
// app.fetch จึงตรงเสมอไม่ว่า Hono จะเปลี่ยนชนิดนี้ในเวอร์ชันถัดไปอย่างไร
type FetchExecutionContext = Parameters<typeof app.fetch>[2];

async function generateDemoBills(
  env: Env,
  ctx: FetchExecutionContext,
  origin: string,
  sessionToken: string,
  period: string,
  waterOffset: number,
  electricOffset: number,
): Promise<boolean> {
  const entries = demoRooms
    .filter((room) => room.status === "occupied")
    .map((room) => ({
      roomId: room.id,
      waterCurrent: room.waterMeterInit + waterOffset,
      electricCurrent: room.electricMeterInit + electricOffset,
      flatElectricAmount: room.electricMode === "flat" ? 1200 : null,
      charges: [],
    }));

  const request = new Request(`${origin}/api/bills/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `wangchan_session=${sessionToken}`,
    },
    body: JSON.stringify({ period, entries }),
  });

  const response = await app.fetch(request, env, ctx);

  if (response.status !== 201) {
    console.error(
      JSON.stringify({ message: "demo bill seed failed", period, status: response.status }),
    );
    return false;
  }

  return true;
}

async function markPaid(db: D1Database, period: string, roomIds: readonly string[]): Promise<void> {
  if (roomIds.length === 0) {
    return;
  }

  const placeholders = roomIds.map(() => "?").join(", ");
  await db
    .prepare(
      `UPDATE bills SET status = 'paid', paid_at = datetime('now'), paid_method = 'transfer' WHERE family_id = ? AND period = ? AND room_id IN (${placeholders})`,
    )
    .bind(demoFamilyId, period, ...roomIds)
    .run();
}

/** ทิ้งบิลหนึ่งใบของเดือนล่าสุดไว้มีสลิปรอตรวจ ให้ผู้ชมเห็นคิวรอตรวจตั้งแต่เข้ามา */
async function seedPendingSlip(env: Env, period: string, roomId: string): Promise<void> {
  const bill = await env.DB.prepare(
    "SELECT id, total FROM bills WHERE family_id = ? AND period = ? AND room_id = ?",
  )
    .bind(demoFamilyId, period, roomId)
    .first<{ id: string; total: number }>();

  if (bill === null) {
    return;
  }

  const imageKey = `${crypto.randomUUID()}.png`;
  await env.SLIPS.put(imageKey, demoSlipImage(), { httpMetadata: { contentType: "image/png" } });

  await env.DB.prepare(
    "INSERT INTO slips (id, family_id, bill_id, line_user_id, image_key, verify_result, amount, trans_ref, bill_total, status) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'pending_review')",
  )
    .bind(crypto.randomUUID(), demoFamilyId, bill.id, demoOwnerLineUserId, imageKey, bill.total)
    .run();
}

async function resetDemoData(env: Env, ctx: FetchExecutionContext, origin: string, sessionToken: string): Promise<void> {
  const now = new Date();
  const olderPeriod = periodOf(monthsBefore(now, 2));
  const recentPeriod = periodOf(monthsBefore(now, 1));

  await clearDemoContent(env);
  await seedBaseContent(env.DB);

  const olderOk = await generateDemoBills(env, ctx, origin, sessionToken, olderPeriod, 15, 45);
  const recentOk = olderOk
    ? await generateDemoBills(env, ctx, origin, sessionToken, recentPeriod, 29, 87)
    : false;

  if (!olderOk || !recentOk) {
    // ห้ามคืนแบบเงียบ ๆ — ถ้าปล่อยผ่าน ผู้ชมจะถูกพาเข้าเดโมที่มีห้อง/ผู้เช่าแต่ไม่มี
    // บิลเลย และสถานะครึ่ง ๆ กลาง ๆ นี้จะถูกล็อกไว้อีก 5 นาทีเพราะเวลาที่ประทับไว้
    // ดูเหมือนเพิ่งรีเซ็ตสำเร็จ โยน error ให้ตัวเรียกไม่บันทึกเวลาไว้แทน
    // เพื่อให้คำขอถัดไปลองรีเซ็ตใหม่ได้ทันที
    throw new Error(`demo bill seed incomplete: older=${String(olderOk)} recent=${String(recentOk)}`);
  }

  const occupiedRoomIds = demoRooms.filter((room) => room.status === "occupied").map((room) => room.id);
  await markPaid(env.DB, olderPeriod, occupiedRoomIds);

  // เดือนล่าสุด: ส่วนใหญ่จ่ายแล้ว เหลือไม่กี่ห้องยังไม่จ่าย และหนึ่งห้องมีสลิปรอตรวจ
  const pendingRoomId = "demo-room-a105";
  const stillUnpaidRoomIds = ["demo-room-a108", "demo-room-a111", "demo-room-a114"];
  const paidRecentRoomIds = occupiedRoomIds.filter(
    (id) => id !== pendingRoomId && !stillUnpaidRoomIds.includes(id),
  );

  await markPaid(env.DB, recentPeriod, paidRecentRoomIds);
  await seedPendingSlip(env, recentPeriod, pendingRoomId);
}

function toSqlDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * "จอง" สิทธิ์รีเซ็ตแบบอะตอมมิกก่อนจะลงมือ ไม่ใช่อ่านเวลาล่าสุดแล้วค่อยตัดสินใจ
 * แล้วค่อยบันทึกเวลาทีหลัง — ลำดับแบบนั้นมีช่วงเวลาที่คำขอสองอันที่มาพร้อมกัน
 * (เช่น เบราว์เซอร์ prefetch ลิงก์แล้วผู้ชมก็กดจริงตามมาติด ๆ) ต่างเห็นว่า "ว่าง"
 * พร้อมกันทั้งคู่ แล้วรีเซ็ตซ้อนกันสอง — ชนกันที่ primary key ของห้อง หรือฝั่งหนึ่ง
 * ลบข้อมูลที่อีกฝั่งเพิ่งสร้างไปกลางคัน เงื่อนไข `WHERE value <= ?` ทำให้มีคำขอ
 * เดียวเท่านั้นที่ UPDATE ติด (เห็นจาก changes = 1) จึงมีผู้ชนะจองสิทธิ์คนเดียวเสมอ
 *
 * ข้อแลกเปลี่ยน: เวลาที่ประทับไว้จะขยับเฉพาะตอนมีคนรีเซ็ตจริงเท่านั้น ไม่ใช่ทุกครั้ง
 * ที่มีคนกดเข้ามา ดังนั้นจังหวะรีเซ็ตจึงเป็น "ไม่ถี่กว่าทุก 5 นาที" ไม่ใช่ "ขยับ
 * ออกไปเรื่อย ๆ ตราบใดที่ยังมีคนเข้ามาเรื่อย ๆ" — เป็นการประเมินความเสี่ยง ไม่ใช่
 * การรับประกันว่าจะไม่ชนใครที่เพิ่งเข้ามาก่อนหน้า
 */
async function claimResetSlot(db: D1Database): Promise<boolean> {
  const now = toSqlDateTime(new Date());
  const idleCutoff = toSqlDateTime(new Date(Date.now() - idleThresholdMs));

  const claimed = await db
    .prepare("UPDATE meta SET value = ?, updated_at = datetime('now') WHERE key = ? AND value <= ?")
    .bind(now, activityMetaKey, idleCutoff)
    .run();

  if ((claimed.meta.changes ?? 0) > 0) {
    return true;
  }

  // ยังไม่เคยมีแถวนี้มาก่อนเลย (คำขอแรกสุดของเดโมนี้) — ไม่มีอะไรให้ "ว่าง" เทียบ
  // ต้องสร้างแถวขึ้นก่อน ใครสร้างสำเร็จคนนั้นคือผู้ชนะจองสิทธิ์เช่นกัน
  const created = await db
    .prepare("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO NOTHING")
    .bind(activityMetaKey, now)
    .run();

  return (created.meta.changes ?? 0) > 0;
}

/**
 * ฝั่งหน้าเว็บใช้บอกว่าควรแสดงตัวชี้โหมดตัวอย่างหรือไม่ — เปิดได้เสมอไม่ต้อง
 * fail closed แบบ /enter เพราะไม่มีผลข้างเคียงและไม่ใช่ข้อมูลลับ (คืนค่าเดียวกับ
 * demoModeOn ที่ทุกเส้นทางในระบบใช้ตัดสินอยู่แล้ว) เรียกได้โดยไม่ต้องล็อกอิน
 */
demo.get("/status", (c) => {
  return c.json({ ok: true, demoMode: demoModeOn(c.env) });
});

demo.get("/enter", async (c) => {
  // ปิดเป็นค่าเริ่มต้นเสมอ เปิดเฉพาะเมื่อ DEMO_MODE ตั้งค่าตรงตัวว่า "1" เท่านั้น
  // รูปแบบเดียวกับ SEAM_PROBE — ทำงานเฉพาะบน config ของ Worker เดโมเท่านั้น
  if (!demoModeOn(c.env)) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบเส้นทางนี้"), 404);
  }

  try {
    await ensureDemoIdentity(c.env.DB);

    const claimed = await claimResetSlot(c.env.DB);
    const token = await createSession(c.env.DB, demoUserId, demoFamilyId);

    if (claimed) {
      const origin = new URL(c.req.url).origin;

      try {
        await resetDemoData(c.env, c.executionCtx, origin, token);
      } catch (resetError) {
        // ปลดการจองคืนให้คำขอถัดไปลองรีเซ็ตใหม่ได้ทันที ไม่ต้องรออีก 5 นาที
        // เต็ม ๆ เพราะสถานะที่ค้างไว้ตอนนี้เป็นครึ่ง ๆ กลาง ๆ ไม่ใช่ของที่ใช้ต่อได้
        await c.env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(activityMetaKey).run();
        throw resetError;
      }
    }

    const secure = isSecureRequest(c);
    const target = new URL("/", c.req.url);

    /**
     * ที่หมายที่ฝากมา (เช่น `#bills/detail/…` จากปุ่มเปิดบิล) — ต้องพาไปให้ถึง
     * ไม่งั้นคนที่เปิดลิงก์บิลบน Worker เดโมจะตกไปที่แดชบอร์ดทุกครั้ง
     */
    const returnPath = safeReturnPath(c.req.query("next"));
    const location = returnPath === null ? target.toString() : `${target.toString()}${returnPath}`;
    const headers = new Headers({ location });
    headers.append("set-cookie", sessionCookie(token, secure));

    return new Response(null, { status: 302, headers });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "demo entry failed", error: detail }));
    return c.json(errorBody("INTERNAL", "เข้าเดโมไม่สำเร็จ กรุณาลองใหม่"), 500);
  }
});

export default demo;
