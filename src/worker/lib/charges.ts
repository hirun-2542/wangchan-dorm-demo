/**
 * ค่าใช้จ่ายเพิ่มเติม: ระดับหอ (dorm_charges) + ของเฉพาะห้อง (room_charges)
 *
 * ค่าเริ่มต้นของค่าใช้จ่ายระดับหอคือ "ถึงทุกห้อง" จึงเก็บเป็นรายการปิด
 * (room_charge_excludes) แล้วคำนวณชุดที่มีผลจริงต่อห้องจาก
 *   dorm_charges − ที่ปิดไว้ + ของห้องเอง
 *
 * ประวัติบิลไม่ขึ้นกับไฟล์นี้: บิลอ่านจาก bill_charges ซึ่งเป็น snapshot
 * ที่เขียนตอนสร้างบิลเท่านั้น
 */

export interface ChargePayload {
  name: string;
  amount: number;
}

export interface DormCharge {
  id: string;
  name: string;
  amount: number;
}

export const maxDormCharges = 20;
export const maxRoomCharges = 10;

interface DormChargeRow {
  id: string;
  name: string;
  amount: number;
}

export async function loadDormCharges(env: Env, familyId: string): Promise<DormCharge[]> {
  const result = await env.DB.prepare("SELECT id, name, amount FROM dorm_charges WHERE family_id = ? ORDER BY position ASC, rowid ASC")
    .bind(familyId)
    .all<DormChargeRow>();

  return result.results;
}

export async function loadRoomOwnCharges(env: Env, familyId: string, roomId: string): Promise<ChargePayload[]> {
  const result = await env.DB.prepare("SELECT name, amount FROM room_charges WHERE family_id = ? AND room_id = ? ORDER BY position ASC")
    .bind(familyId, roomId)
    .all<ChargePayload>();

  return result.results;
}

async function loadAllOwnCharges(env: Env, familyId: string): Promise<Map<string, ChargePayload[]>> {
  const result = await env.DB.prepare("SELECT room_id, name, amount FROM room_charges WHERE family_id = ? ORDER BY room_id ASC, position ASC")
    .bind(familyId)
    .all<{ room_id: string; name: string; amount: number }>();

  const grouped = new Map<string, ChargePayload[]>();

  for (const row of result.results) {
    const list = grouped.get(row.room_id) ?? [];
    list.push({ name: row.name, amount: row.amount });
    grouped.set(row.room_id, list);
  }

  return grouped;
}

async function loadAllExcludes(env: Env, familyId: string): Promise<Map<string, Set<string>>> {
  const result = await env.DB.prepare("SELECT room_id, dorm_charge_id FROM room_charge_excludes WHERE family_id = ?")
    .bind(familyId)
    .all<{
      room_id: string;
      dorm_charge_id: string;
    }>();

  const grouped = new Map<string, Set<string>>();

  for (const row of result.results) {
    const set = grouped.get(row.room_id) ?? new Set<string>();
    set.add(row.dorm_charge_id);
    grouped.set(row.room_id, set);
  }

  return grouped;
}

/** dorm − ที่ปิดไว้ + ของห้องเอง เรียงตามลำดับของหอก่อนแล้วต่อด้วยของห้อง */
export function resolveRoomCharges(
  dorm: DormCharge[],
  excludedIds: Set<string> | undefined,
  own: ChargePayload[] | undefined,
): ChargePayload[] {
  const inherited = dorm
    .filter((charge) => excludedIds === undefined || !excludedIds.has(charge.id))
    .map((charge) => ({ name: charge.name, amount: charge.amount }));

  return [...inherited, ...(own ?? [])];
}

/**
 * บันทึกรายการค่าใช้จ่ายของหอแบบเทียบส่วนต่าง เพื่อให้ id ของรายการเดิมคงอยู่
 * ถ้าลบแล้วใส่ใหม่ทั้งหมด การปิดรายห้องที่ผูกกับ id เดิมจะหายไปเงียบ ๆ
 * คืน null เมื่อมี id ที่ไม่รู้จักหรือซ้ำ
 */
export async function replaceDormCharges(env: Env, familyId: string, inputs: ChargeInput[]): Promise<DormCharge[] | null> {
  const existing = await loadDormCharges(env, familyId);
  const existingIds = new Set(existing.map((charge) => charge.id));
  const kept = new Set<string>();

  for (const input of inputs) {
    if (input.id === null) {
      continue;
    }

    if (!existingIds.has(input.id) || kept.has(input.id)) {
      return null;
    }

    kept.add(input.id);
  }

  const statements: D1PreparedStatement[] = [];

  for (const charge of existing) {
    if (!kept.has(charge.id)) {
      statements.push(env.DB.prepare("DELETE FROM room_charge_excludes WHERE family_id = ? AND dorm_charge_id = ?").bind(familyId, charge.id));
      statements.push(env.DB.prepare("DELETE FROM dorm_charges WHERE family_id = ? AND id = ?").bind(familyId, charge.id));
    }
  }

  inputs.forEach((input, index) => {
    if (input.id === null) {
      statements.push(
        env.DB.prepare("INSERT INTO dorm_charges (id, family_id, name, amount, position) VALUES (?, ?, ?, ?, ?)").bind(
          crypto.randomUUID(),
          familyId,
          input.name,
          input.amount,
          index,
        ),
      );
      return;
    }

    statements.push(
      env.DB.prepare("UPDATE dorm_charges SET name = ?, amount = ?, position = ? WHERE family_id = ? AND id = ?").bind(
        input.name,
        input.amount,
        index,
        familyId,
        input.id,
      ),
    );
  });

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  return loadDormCharges(env, familyId);
}

export interface ResolvedRoomCharges {
  charges: ChargePayload[];
  excludedDormChargeIds: string[];
  ownCharges: ChargePayload[];
}

/**
 * ชุดที่มีผลจริงของทุกห้อง พร้อมข้อมูลสำหรับแก้ไข (รายการที่ปิด + ของห้องเอง)
 * ใช้ร่วมกันระหว่างหน้าห้องพักและ prefill ของการสร้างบิล เพื่อไม่ให้สองที่ตอบไม่ตรงกัน
 *
 * ยึดรายการห้องจากฐานข้อมูล เพื่อให้ห้องที่ยังไม่มีแถวของตัวเองก็ได้รับค่าใช้จ่ายของหอ
 */
export async function resolveAllRoomCharges(env: Env, familyId: string): Promise<Map<string, ResolvedRoomCharges>> {
  const [dorm, own, excludes, roomRows] = await Promise.all([
    loadDormCharges(env, familyId),
    loadAllOwnCharges(env, familyId),
    loadAllExcludes(env, familyId),
    env.DB.prepare("SELECT id FROM rooms WHERE family_id = ?").bind(familyId).all<{ id: string }>(),
  ]);

  const resolved = new Map<string, ResolvedRoomCharges>();

  for (const room of roomRows.results) {
    const excludedIds = excludes.get(room.id);
    const ownCharges = own.get(room.id) ?? [];

    resolved.set(room.id, {
      charges: resolveRoomCharges(dorm, excludedIds, ownCharges),
      excludedDormChargeIds: excludedIds === undefined ? [] : [...excludedIds],
      ownCharges,
    });
  }

  return resolved;
}

/** ชุดที่มีผลจริงของห้องเดียว — ใช้ตอนอ่านกลับหลังบันทึก เพื่อให้ตรงกับที่หน้าห้องพักเห็น */
export async function resolveRoomChargesById(env: Env, familyId: string, roomId: string): Promise<ResolvedRoomCharges> {
  const [dorm, own, excluded] = await Promise.all([
    loadDormCharges(env, familyId),
    loadRoomOwnCharges(env, familyId, roomId),
    env.DB.prepare("SELECT dorm_charge_id FROM room_charge_excludes WHERE family_id = ? AND room_id = ?")
      .bind(familyId, roomId)
      .all<{ dorm_charge_id: string }>(),
  ]);

  const excludedIds = new Set(excluded.results.map((row) => row.dorm_charge_id));

  return {
    charges: resolveRoomCharges(dorm, excludedIds, own),
    excludedDormChargeIds: [...excludedIds],
    ownCharges: own,
  };
}

export interface ChargeInput {
  id: string | null;
  name: string;
  amount: number;
}

export function parseChargeList(value: unknown, max: number): ChargeInput[] | null {
  if (!Array.isArray(value) || value.length > max) {
    return null;
  }

  const charges: ChargeInput[] = [];
  const seenNames = new Set<string>();

  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return null;
    }

    const record = item as Record<string, unknown>;
    const rawId = record.id;
    const id = rawId === undefined ? null : typeof rawId === "string" && rawId !== "" ? rawId : undefined;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const amount = record.amount;

    if (id === undefined || name === "" || typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
      return null;
    }

    // ชื่อซ้ำจะกลายเป็นสองบรรทัดในบิลที่แยกออกจากกันไม่ได้ จึงไม่รับตั้งแต่ต้น
    const nameKey = name.toLowerCase();

    if (seenNames.has(nameKey)) {
      return null;
    }

    seenNames.add(nameKey);
    charges.push({ id, name, amount });
  }

  return charges;
}

/** id ของค่าใช้จ่ายระดับหอที่ปิดไว้สำหรับห้อง — ต้องเป็น id ที่มีอยู่จริงทั้งหมด */
export function parseIdList(value: unknown, known: Set<string>): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string" || !known.has(item) || seen.has(item)) {
      return null;
    }

    seen.add(item);
  }

  return [...seen];
}
