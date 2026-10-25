import { Hono } from "hono";
import { familyId, type AppEnv } from "../lib/auth";
import { errorBody, isIsoDate, readJsonObject } from "./shared";

const tenants = new Hono<AppEnv>();

type TenantStatus = "current" | "moved-out";

interface TenantRow {
  id: string;
  full_name: string;
  phone: string;
  room_id: string;
  check_in_date: string;
  check_out_date: string | null;
  line_user_id: string | null;
  status: string;
  room_number: string;
}

interface TenantPayload {
  id: string;
  fullName: string;
  phone: string;
  roomId: string;
  roomNumber: string;
  checkInDate: string;
  checkOutDate: string | null;
  lineUserId: string | null;
  status: TenantStatus;
}

const tenantColumns =
  "t.id, t.full_name, t.phone, t.room_id, t.check_in_date, t.check_out_date, t.line_user_id, t.status, r.room_number";

const tenantFrom = "FROM tenants t JOIN rooms r ON r.id = t.room_id AND r.family_id = t.family_id";

const tenantOrder =
  "ORDER BY CASE t.status WHEN 'current' THEN 0 ELSE 1 END ASC, LENGTH(CASE WHEN t.status = 'current' THEN r.room_number END) ASC, CASE WHEN t.status = 'current' THEN r.room_number END ASC, CASE WHEN t.status = 'moved-out' THEN t.check_out_date END DESC";

function toTenant(row: TenantRow): TenantPayload {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    roomId: row.room_id,
    roomNumber: row.room_number,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    lineUserId: row.line_user_id,
    status: row.status === "moved-out" ? "moved-out" : "current",
  };
}

function parseText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * เบอร์มือถือไทย: ตัดช่องว่างและขีดออกแล้วต้องเหลือ 9-10 หลัก (มี + นำหน้าได้)
 *
 * ฝั่งเซิร์ฟเวอร์เป็นผู้ตัดสินเสมอ ไคลเอนต์เป็นเพียงตัวช่วยกรอก
 * จึงต้องคืน error.field = "phone" ให้หน้าเว็บแสดงข้อความตรงช่องได้
 */
function isPhone(value: string): boolean {
  const compact = value.replace(/[\s-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;

  return /^\d{9,10}$/.test(digits);
}

tenants.get("/", async (c) => {
  const family = familyId(c);

  try {
    const result = await c.env.DB.prepare(`SELECT ${tenantColumns} ${tenantFrom} WHERE t.family_id = ? ${tenantOrder}`)
      .bind(family)
      .all<TenantRow>();
    return c.json({ ok: true, tenants: result.results.map(toTenant) }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "list tenants failed", error: detail }));
    return c.json(errorBody("INTERNAL", "โหลดข้อมูลผู้เช่าไม่สำเร็จ"), 500);
  }
});

tenants.post("/", async (c) => {
  const family = familyId(c);
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const fullName = parseText(body.fullName);

  if (fullName === "") {
    return c.json(errorBody("VALIDATION", "กรุณากรอกชื่อ-นามสกุล", "fullName"), 400);
  }

  const phone = parseText(body.phone);

  if (phone === "" || !isPhone(phone)) {
    return c.json(errorBody("VALIDATION", "กรุณากรอกเบอร์โทรให้ถูกต้อง", "phone"), 400);
  }

  const roomId = parseText(body.roomId);

  if (roomId === "") {
    return c.json(errorBody("VALIDATION", "กรุณาเลือกห้อง", "roomId"), 400);
  }

  const checkInRaw = body.checkInDate;

  if (!isIsoDate(checkInRaw)) {
    return c.json(errorBody("VALIDATION", "กรุณาเลือกวันเข้า", "checkInDate"), 400);
  }

  const id = crypto.randomUUID();

  try {
    const room = await c.env.DB.prepare("SELECT id FROM rooms WHERE id = ? AND family_id = ?")
      .bind(roomId, family)
      .first<{ id: string }>();

    if (room === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบห้องที่เลือก", "roomId"), 404);
    }

    const occupant = await c.env.DB.prepare("SELECT id FROM tenants WHERE family_id = ? AND room_id = ? AND status = 'current'")
      .bind(family, roomId)
      .first<{ id: string }>();

    if (occupant !== null) {
      return c.json(errorBody("CONFLICT", "ห้องนี้มีผู้เช่าอยู่แล้ว", "roomId"), 409);
    }

    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO tenants (id, family_id, full_name, phone, room_id, check_in_date, status) VALUES (?, ?, ?, ?, ?, ?, 'current')",
      ).bind(id, family, fullName, phone, roomId, checkInRaw),
      c.env.DB.prepare("UPDATE rooms SET status = 'occupied' WHERE id = ? AND family_id = ?").bind(roomId, family),
    ]);

    const row = await c.env.DB.prepare(`SELECT ${tenantColumns} ${tenantFrom} WHERE t.id = ? AND t.family_id = ?`)
      .bind(id, family)
      .first<TenantRow>();

    if (row === null) {
      console.error(JSON.stringify({ message: "create tenant readback failed", tenantId: id }));
      return c.json(errorBody("INTERNAL", "เพิ่มผู้เช่าไม่สำเร็จ"), 500);
    }

    return c.json({ ok: true, tenant: toTenant(row) }, 201);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "create tenant failed", error: detail }));

    if (detail.includes("UNIQUE")) {
      return c.json(errorBody("CONFLICT", "ห้องนี้มีผู้เช่าอยู่แล้ว", "roomId"), 409);
    }

    return c.json(errorBody("INTERNAL", "เพิ่มผู้เช่าไม่สำเร็จ"), 500);
  }
});

tenants.patch("/:id", async (c) => {
  const family = familyId(c);
  const id = c.req.param("id");
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  if (body.roomId !== undefined) {
    return c.json(errorBody("VALIDATION", "ย้ายห้องไม่ได้ ต้องเช็คเอาท์ก่อนเพิ่มผู้เช่าใหม่", "roomId"), 400);
  }

  try {
    const existing = await c.env.DB.prepare("SELECT id, full_name, phone, check_in_date, check_out_date, status FROM tenants WHERE id = ? AND family_id = ?")
      .bind(id, family)
      .first<{ id: string; full_name: string; phone: string; check_in_date: string; check_out_date: string | null; status: string }>();

    if (existing === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบผู้เช่าที่ต้องการแก้ไข"), 404);
    }

    let fullName = existing.full_name;

    if (body.fullName !== undefined) {
      const parsed = parseText(body.fullName);

      if (parsed === "") {
        return c.json(errorBody("VALIDATION", "กรุณากรอกชื่อ-นามสกุล", "fullName"), 400);
      }

      fullName = parsed;
    }

    let phone = existing.phone;

    if (body.phone !== undefined) {
      const parsed = parseText(body.phone);

      if (parsed === "" || !isPhone(parsed)) {
        return c.json(errorBody("VALIDATION", "กรุณากรอกเบอร์โทรให้ถูกต้อง", "phone"), 400);
      }

      phone = parsed;
    }

    let checkInDate = existing.check_in_date;

    if (body.checkInDate !== undefined) {
      const parsed = body.checkInDate;

      if (!isIsoDate(parsed)) {
        return c.json(errorBody("VALIDATION", "กรุณาเลือกวันเข้า", "checkInDate"), 400);
      }

      checkInDate = parsed;
    }

    if (existing.status === "moved-out" && existing.check_out_date !== null && checkInDate > existing.check_out_date) {
      return c.json(errorBody("VALIDATION", "วันเข้าต้องไม่หลังวันออก", "checkInDate"), 400);
    }

    await c.env.DB.prepare("UPDATE tenants SET full_name = ?, phone = ?, check_in_date = ? WHERE id = ? AND family_id = ?")
      .bind(fullName, phone, checkInDate, id, family)
      .run();

    const row = await c.env.DB.prepare(`SELECT ${tenantColumns} ${tenantFrom} WHERE t.id = ? AND t.family_id = ?`)
      .bind(id, family)
      .first<TenantRow>();

    if (row === null) {
      console.error(JSON.stringify({ message: "update tenant readback failed", tenantId: id }));
      return c.json(errorBody("INTERNAL", "บันทึกข้อมูลผู้เช่าไม่สำเร็จ"), 500);
    }

    return c.json({ ok: true, tenant: toTenant(row) }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "update tenant failed", tenantId: id, error: detail }));

    return c.json(errorBody("INTERNAL", "บันทึกข้อมูลผู้เช่าไม่สำเร็จ"), 500);
  }
});

tenants.post("/:id/checkout", async (c) => {
  const family = familyId(c);
  const id = c.req.param("id");
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const checkOutRaw = body.checkOutDate;

  if (!isIsoDate(checkOutRaw)) {
    return c.json(errorBody("VALIDATION", "กรุณาเลือกวันออก", "checkOutDate"), 400);
  }

  try {
    const existing = await c.env.DB.prepare("SELECT id, room_id, check_in_date, status FROM tenants WHERE id = ? AND family_id = ?")
      .bind(id, family)
      .first<{ id: string; room_id: string; check_in_date: string; status: string }>();

    if (existing === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบผู้เช่าที่ต้องการเช็คเอาท์"), 404);
    }

    if (existing.status !== "current") {
      return c.json(errorBody("CONFLICT", "ผู้เช่ารายนี้ย้ายออกแล้ว"), 409);
    }

    if (checkOutRaw < existing.check_in_date) {
      return c.json(errorBody("VALIDATION", "วันออกต้องไม่ก่อนวันเข้า", "checkOutDate"), 400);
    }

    await c.env.DB.batch([
      // เคลียร์ line_user_id ตอนออก — เก็บไว้แค่ชื่อกับเบอร์โทรพอ ไม่จำเป็นต้อง
      // ผูก LINE ของคนที่ย้ายออกแล้วต่อ และ line_user_id เป็น UNIQUE ถ้าคนเดิม
      // ย้ายเข้าห้องใหม่ทีหลังด้วย LINE เดิม แถวเก่าที่ยังจองไอดีไว้จะผูกไม่ได้
      c.env.DB.prepare("UPDATE tenants SET status = 'moved-out', check_out_date = ?, line_user_id = NULL WHERE id = ? AND family_id = ?").bind(checkOutRaw, id, family),
      c.env.DB.prepare("UPDATE rooms SET status = 'vacant' WHERE id = ? AND family_id = ?").bind(existing.room_id, family),
    ]);

    const row = await c.env.DB.prepare(`SELECT ${tenantColumns} ${tenantFrom} WHERE t.id = ? AND t.family_id = ?`)
      .bind(id, family)
      .first<TenantRow>();

    if (row === null) {
      console.error(JSON.stringify({ message: "checkout tenant readback failed", tenantId: id }));
      return c.json(errorBody("INTERNAL", "เช็คเอาท์ผู้เช่าไม่สำเร็จ"), 500);
    }

    return c.json({ ok: true, tenant: toTenant(row) }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "checkout tenant failed", tenantId: id, error: detail }));
    return c.json(errorBody("INTERNAL", "เช็คเอาท์ผู้เช่าไม่สำเร็จ"), 500);
  }
});

export default tenants;
