import { Hono } from "hono";
import { familyId, type AppEnv } from "../lib/auth";
import {
  PeaLookupError,
  fetchLatestPeaBill,
  normalizePeaCredential,
  parseStoredPeaAccount,
  peaAccountSettingKey,
  peaAccountSettingPrefix,
  peaSharedTarget,
  peaUpstreamMessage,
  type PeaAccount,
} from "../lib/pea";
import { errorBody, readJsonObject, upsertSettingSql } from "./shared";
import { demoModeOn } from "../line/api";

/**
 * ดึงบิลล่าสุดจากการไฟฟ้าส่วนภูมิภาค (PEA) แทนการพิมพ์ยอดเอง
 *
 * เส้นทางนี้ไม่เก็บบิลลงฐานข้อมูล — เรียก PEA สดทุกครั้งแล้วคืนบิลล่าสุดใบเดียวให้หน้าเว็บ
 * (path ยังชื่อ /history ตามที่หน้าเว็บกับเทสต์เรียกอยู่) สิ่งที่จำไว้มีอย่างเดียวคือคู่
 * CA/รหัสเครื่องวัดต่อปลายทาง (ห้องหรือกล่องไฟรวม) เพื่อไม่ต้องกรอกซ้ำ
 * และคำขอที่ส่ง `verifyOnly` จะไม่จำอะไรเลย
 */
const pea = new Hono<AppEnv>();

// เดโมเป็นสาธารณะ: ห้ามให้ผู้ชมใช้ Worker เป็นตัวกลางยิง PEA ด้วยเลขที่ตัวเองพิมพ์
pea.use("*", async (c, next) => {
  if (demoModeOn(c.env)) {
    return c.json(errorBody("NOT_FOUND", "เดโมไม่เชื่อมต่อ PEA จริง"), 404);
  }

  await next();
});

/** ข้อมูลผู้ใช้ไฟฟ้าเป็นข้อมูลเฉพาะครอบครัว — ห้าม cache ที่ใด ๆ */
const noStore: Record<string, string> = { "Cache-Control": "private, no-store" };

interface PeaAccountRow {
  key: string;
  value: string;
}

/**
 * ปลายทางต้องเป็น "shared" หรือ id ห้องของครอบครัวนี้เท่านั้น
 *
 * รับ id จากผู้เรียกแล้วถามฐานข้อมูลทุกครั้ง (ไม่เชื่อรูปแบบของ id) เพราะ id ของ
 * ห้องครอบครัวอื่นก็หน้าตาเหมือนกัน — ถ้าไม่กรอง family_id การจำคู่ CA/มิเตอร์
 * จะข้ามครอบครัวได้
 */
async function ownsTarget(env: Env, family: string, target: string): Promise<boolean> {
  if (target === peaSharedTarget) {
    return true;
  }

  const row = await env.DB.prepare("SELECT id FROM rooms WHERE id = ? AND family_id = ?")
    .bind(target, family)
    .first<{ id: string }>();

  return row !== null;
}

/**
 * คู่ที่จำไว้ของครอบครัว ซึ่งยังชี้ปลายทางที่มีอยู่จริง
 *
 * ปลายทางที่ถูกลบไปแล้ว (ลบห้อง/ย้ายหอ) ถูกข้ามไปเงียบ ๆ ไม่คืนให้หน้าเว็บ
 * และถ้าค่าใน settings เสียหายก็ข้ามเช่นกัน — ไม่เดาค่าแทน
 */
async function loadAccounts(env: Env, family: string): Promise<PeaAccount[]> {
  const rows = await env.DB.prepare(
    // ใช้ substr ไม่ใช่ LIKE เพราะ "_" ในชื่อคีย์เป็นไวลด์การ์ดของ LIKE
    "SELECT key, value FROM settings WHERE family_id = ? AND substr(key, 1, ?) = ?",
  )
    .bind(family, peaAccountSettingPrefix.length, peaAccountSettingPrefix)
    .all<PeaAccountRow>();

  if (rows.results.length === 0) {
    return [];
  }

  const roomRows = await env.DB.prepare("SELECT id FROM rooms WHERE family_id = ?")
    .bind(family)
    .all<{ id: string }>();
  const owned = new Set(roomRows.results.map((row) => row.id));
  owned.add(peaSharedTarget);

  const accounts: PeaAccount[] = [];

  for (const row of rows.results) {
    const target = row.key.slice(peaAccountSettingPrefix.length);

    if (target === "" || !owned.has(target)) {
      continue;
    }

    const stored = parseStoredPeaAccount(row.value);

    if (stored === null) {
      continue;
    }

    accounts.push({ target, ca: stored.ca, peano: stored.peano });
  }

  // ลำดับคงที่: กล่องไฟรวมก่อน แล้วตามด้วยห้องเรียงตาม id (settings ไม่มี ORDER BY)
  return accounts.sort((a, b) => {
    if (a.target === peaSharedTarget) {
      return -1;
    }

    if (b.target === peaSharedTarget) {
      return 1;
    }

    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });
}

pea.get("/accounts", async (c) => {
  try {
    const accounts = await loadAccounts(c.env, familyId(c));

    return c.json({ ok: true, accounts }, 200, noStore);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "load pea accounts failed", error: detail }));

    return c.json(errorBody("INTERNAL", "โหลดข้อมูลผู้ใช้ไฟฟ้าที่จำไว้ไม่สำเร็จ"), 500, noStore);
  }
});

pea.post("/history", async (c) => {
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400, noStore);
  }

  const target = typeof body.target === "string" ? body.target.trim() : "";

  if (target === "") {
    return c.json(errorBody("VALIDATION", "ไม่ระบุปลายทางที่ต้องการนำยอดไปใช้", "target"), 400, noStore);
  }

  const ca = normalizePeaCredential(body.ca);

  if (ca === null) {
    return c.json(
      errorBody("VALIDATION", "หมายเลขผู้ใช้ไฟฟ้า (CA) ต้องเป็นตัวเลข 1–12 หลัก", "ca"),
      400,
      noStore,
    );
  }

  const peano = normalizePeaCredential(body.peano);

  if (peano === null) {
    return c.json(
      errorBody("VALIDATION", "รหัสเครื่องวัดต้องเป็นตัวเลข 1–12 หลัก", "peano"),
      400,
      noStore,
    );
  }

  const family = familyId(c);

  try {
    if (!(await ownsTarget(c.env, family, target))) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบห้องนี้ในหอของคุณ", "target"), 404, noStore);
    }

    const bill = await fetchLatestPeaBill(ca, peano);

    // `verifyOnly: true` = ลองเชื่อมต่อโดยยังไม่บันทึก (ปุ่ม "ตรวจสอบการเชื่อมต่อ"
    // ในกล่องจัดการค่าไฟ) — คำขอตรวจสอบต้องไม่เปลี่ยนสถานะที่จำไว้
    const verifyOnly = body.verifyOnly === true;

    // จำคู่ก็ต่อเมื่อ PEA ตอบสำเร็จ (รวมกรณียังไม่มีบิลซึ่ง bill เป็น null) — คำขอที่ถูกปฏิเสธ
    // หรือคำตอบผิดรูปโยน error ออกไปก่อนถึงบรรทัดนี้ จึงไม่ทับคู่เดิมที่เคยใช้ได้
    if (!verifyOnly) {
      try {
        await c.env.DB.prepare(upsertSettingSql)
          .bind(family, peaAccountSettingKey(target), JSON.stringify({ ca, peano }))
          .run();
      } catch (error) {
        // จำไม่ได้ก็ไม่ควรทำให้การนำยอดที่ดึงมาได้แล้วล้มทั้งคำขอ — แค่ต้องกรอก
        // คู่นี้ใหม่ครั้งหน้า
        const detail = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ message: "remember pea account failed", error: detail }));
      }
    }

    return c.json({ ok: true, account: { target, ca, peano }, bill }, 200, noStore);
  } catch (error) {
    if (error instanceof PeaLookupError) {
      // PEA ปฏิเสธคำขอ = ผู้ใช้แก้เองได้ (400 พร้อมข้อความไทยของ PEA)
      // คำตอบผิดรูป/ช้า/ใหญ่เกิน = ผู้ใช้แก้ไม่ได้ (502) ไม่ส่งรายละเอียดออกไป
      if (error.kind === "rejected") {
        return c.json(errorBody("VALIDATION", error.message), 400, noStore);
      }

      return c.json(errorBody("UPSTREAM", peaUpstreamMessage), 502, noStore);
    }

    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "pea bill history failed", error: detail }));

    return c.json(errorBody("INTERNAL", "ดึงประวัติบิลจากการไฟฟ้าไม่สำเร็จ"), 500, noStore);
  }
});

/**
 * ยกเลิกการเชื่อมต่อ = ลบคู่ CA/รหัสเครื่องวัดของปลายทางนั้นออกจาก settings
 * ไม่แตะ rooms/tenants/bills หรือเลขมิเตอร์ที่บันทึกไว้แล้ว — ประวัติยังอยู่ครบ
 */
pea.delete("/accounts/:target", async (c) => {
  const target = c.req.param("target").trim();
  const family = familyId(c);

  if (target === "") {
    return c.json(errorBody("VALIDATION", "ไม่ระบุห้องที่ต้องการยกเลิกการเชื่อมต่อ", "target"), 400, noStore);
  }

  try {
    if (!(await ownsTarget(c.env, family, target))) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบห้องนี้ในหอของคุณ", "target"), 404, noStore);
    }

    const result = await c.env.DB.prepare("DELETE FROM settings WHERE family_id = ? AND key = ?")
      .bind(family, peaAccountSettingKey(target))
      .run();

    if (result.meta.changes === 0) {
      return c.json(errorBody("NOT_FOUND", "ห้องนี้ยังไม่ได้เชื่อมต่อ PEA"), 404, noStore);
    }

    return c.json({ ok: true, target }, 200, noStore);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "delete pea account failed", error: detail }));

    return c.json(errorBody("INTERNAL", "ยกเลิกการเชื่อมต่อไม่สำเร็จ"), 500, noStore);
  }
});

export default pea;
