/**
 * อัตราค่าน้ำ/ไฟของหอ (ค่าเริ่มต้นระดับหอ + override รายห้อง) และการคำนวณ
 * บิลที่ยังไม่จ่ายและยังไม่ได้ส่งใหม่เมื่ออัตราที่ใช้จริงของห้องเปลี่ยน
 *
 * บิลปกติเป็น snapshot ที่ไม่เปลี่ยนตามค่าตั้งต้นที่แก้ทีหลัง (เจตนาเดิมของระบบ)
 * แต่เจ้าของต้องการให้บิลที่ "ยังไม่ได้ส่งให้ผู้เช่าเห็น" ตามอัตราใหม่ทันที ส่วนบิล
 * ที่ส่งไปแล้วต้องคงยอดเดิมไว้เสมอ เพราะผู้เช่าอาจเห็นยอด/QR เดิมไปแล้ว และระบบ
 * ปิดบิลอัตโนมัติเทียบยอดสลิปตรงเป๊ะกับยอดบิล (ADR 0001) — เปลี่ยนยอดบิลหลังส่ง
 * จะทำให้สลิปที่ผู้เช่าจ่ายตามยอดเดิมไม่ตรงยอดใหม่แล้วเข้าคิวรอตรวจโดยไม่จำเป็น
 */

import { chargeFromUnits } from "../../shared/billing";

// เจ้าของเดิม: settings.ts ก่อนย้ายมาที่นี่ (ไฟล์นี้ต้องเป็นเจ้าของแทน มิฉะนั้น
// settings.ts เรียก recalcRoomsUsingDormDefaults ในไฟล์นี้ไม่ได้ — import วน)
export const defaultWaterRate = 18;
export const defaultElectricRate = 7;

function parseRate(
  key: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  console.error(
    JSON.stringify({ message: "invalid stored setting", key, value }),
  );
  return fallback;
}

export async function loadEffectiveRates(
  env: Env,
  family: string,
): Promise<{ water: number; electric: number }> {
  const result = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE family_id = ? AND key IN ('default_water_rate', 'default_electric_rate')",
  )
    .bind(family)
    .all<{ key: string; value: string }>();
  const stored = new Map(result.results.map((row) => [row.key, row.value]));

  return {
    water: parseRate(
      "default_water_rate",
      stored.get("default_water_rate"),
      defaultWaterRate,
    ),
    electric: parseRate(
      "default_electric_rate",
      stored.get("default_electric_rate"),
      defaultElectricRate,
    ),
  };
}

interface RecalcBillRow {
  id: string;
  rent: number;
  water_units: number;
  water_amount: number;
  electric_mode: string;
  electric_units: number | null;
  electric_amount: number;
  total: number;
}

const recalcSelectSql =
  "SELECT id, rent, water_units, water_amount, electric_mode, electric_units, electric_amount, total FROM bills WHERE family_id = ? AND room_id = ? AND status = 'unpaid' AND sent_at IS NULL";

const recalcUpdateSql =
  "UPDATE bills SET water_rate = ?, water_amount = ?, electric_rate = ?, electric_amount = ?, total = ? WHERE id = ? AND family_id = ?";

/**
 * คำสั่ง UPDATE ที่คำนวณค่าน้ำ/ไฟใหม่ให้บิล "ยังไม่จ่ายและยังไม่ได้ส่ง" ทุกใบของห้อง
 * หนึ่งด้วยอัตราที่ให้มา — คืนเป็นคำสั่งเพื่อให้ผู้เรียกรวมลง batch เดียวกับการ
 * เปลี่ยนอัตรา (ถ้าแยกกัน อัตราอาจบันทึกแล้วแต่บิลยังค้างอัตราเดิม)
 *
 * คิดจากหน่วยที่บันทึกไว้เดิมเท่านั้น ไม่แตะ electric_mode หรือหน่วย — ห้อง
 * เหมาจ่ายไฟจึงไม่ถูกแตะเพราะยอดของห้องนั้นไม่ขึ้นกับอัตราอยู่แล้ว · เรียกซ้ำได้
 * เสมอ (idempotent): ถ้าอัตราไม่ได้เปลี่ยนจริง ค่าที่เขียนกลับจะเท่าของเดิม
 */
export async function recalcRoomUnsentBillStatements(
  env: Env,
  family: string,
  roomId: string,
  waterRate: number,
  electricRate: number,
): Promise<D1PreparedStatement[]> {
  const result = await env.DB.prepare(recalcSelectSql)
    .bind(family, roomId)
    .all<RecalcBillRow>();

  return result.results.map((bill) => {
    const waterAmount = chargeFromUnits(bill.water_units, waterRate);
    const isMeter = bill.electric_mode === "meter" && bill.electric_units !== null;
    const electricAmount = isMeter
      ? chargeFromUnits(bill.electric_units as number, electricRate)
      : bill.electric_amount;
    // ค่าใช้จ่ายเพิ่มเติมไม่เปลี่ยนตามอัตราน้ำ/ไฟ — ถอดออกมาจากยอดรวมเดิมแทน
    // การ JOIN bill_charges อีกรอบ เพราะผลรวมเดิมมีอยู่แล้วในคอลัมน์ total
    const chargesTotal = bill.total - bill.rent - bill.water_amount - bill.electric_amount;
    const total = bill.rent + waterAmount + electricAmount + chargesTotal;

    return env.DB.prepare(recalcUpdateSql).bind(
      waterRate,
      waterAmount,
      isMeter ? electricRate : null,
      electricAmount,
      total,
      bill.id,
      family,
    );
  });
}

/** คำนวณบิลที่ยังไม่จ่ายและยังไม่ได้ส่งของห้องหนึ่งใหม่ทันที (ดู recalcRoomUnsentBillStatements) */
export async function recalcRoomUnsentBills(
  env: Env,
  family: string,
  roomId: string,
  waterRate: number,
  electricRate: number,
): Promise<void> {
  const statements = await recalcRoomUnsentBillStatements(env, family, roomId, waterRate, electricRate);

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

/**
 * เรียก recalcRoomUnsentBills ให้ทุกห้องที่ "ใช้ค่าเริ่มต้นของหอ" (ไม่ได้ตั้ง
 * อัตราของตัวเองไว้) เมื่ออัตราเริ่มต้นของหอเปลี่ยน — เรียกเฉพาะมิติที่เปลี่ยนจริง
 * เพื่อไม่ต้องแตะห้องที่ตั้งอัตราของตัวเองไว้แล้วและไม่เกี่ยวกับค่าเริ่มต้นเลย
 */
export async function recalcRoomsUsingDormDefaults(
  env: Env,
  family: string,
  changed: { water: boolean; electric: boolean },
  newDefaults: { water: number; electric: number },
): Promise<void> {
  if (!changed.water && !changed.electric) return;

  const conditions: string[] = [];
  if (changed.water) conditions.push("water_rate IS NULL");
  if (changed.electric) conditions.push("electric_rate IS NULL");

  const rooms = await env.DB.prepare(
    `SELECT id, water_rate, electric_rate FROM rooms WHERE family_id = ? AND (${conditions.join(" OR ")})`,
  )
    .bind(family)
    .all<{ id: string; water_rate: number | null; electric_rate: number | null }>();

  for (const room of rooms.results) {
    await recalcRoomUnsentBills(
      env,
      family,
      room.id,
      room.water_rate ?? newDefaults.water,
      room.electric_rate ?? newDefaults.electric,
    );
  }
}
