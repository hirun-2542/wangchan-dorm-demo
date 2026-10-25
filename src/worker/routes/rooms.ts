import { Hono } from "hono";
import { familyId, type AppEnv } from "../lib/auth";
import { loadEffectiveRates, recalcRoomUnsentBillStatements, recalcRoomUnsentBills } from "../lib/bill-rates";
import {
  loadDormCharges,
  maxRoomCharges,
  parseChargeList,
  parseIdList,
  resolveAllRoomCharges,
  resolveRoomChargesById,
  type ChargePayload,
  type ResolvedRoomCharges,
} from "../lib/charges";
import { rateFromBill } from "../../shared/billing";
import { errorBody, readJsonObject, roomNumberOrder, sharedElectricRoomIdsKey, upsertSettingSql } from "./shared";

const rooms = new Hono<AppEnv>();

type ElectricMode = "meter" | "flat";
type RoomStatus = "vacant" | "occupied";

interface RoomRow {
  id: string;
  room_number: string;
  rent: number;
  water_rate: number | null;
  electric_mode: string;
  electric_rate: number | null;
  water_meter_init: number;
  electric_meter_init: number;
  status: string;
  created_at: string;
  occupied_by: string | null;
  last_electric_amount: number | null;
  last_electric_period: string | null;
}

interface RoomPayload {
  id: string;
  roomNumber: string;
  rent: number;
  waterRate: number | null;
  electricMode: ElectricMode;
  electricRate: number | null;
  waterMeterInit: number;
  electricMeterInit: number;
  status: RoomStatus;
  occupiedBy: string | null;
  lastElectricAmount: number | null;
  lastElectricPeriod: string | null;
  charges: ChargePayload[];
  excludedDormChargeIds: string[];
  ownCharges: ChargePayload[];
}

const lastElectricAmountSql =
  "(SELECT b.electric_amount FROM bills b WHERE b.room_id = r.id AND b.family_id = r.family_id ORDER BY b.period DESC LIMIT 1)";

const lastElectricPeriodSql =
  "(SELECT b.period FROM bills b WHERE b.room_id = r.id AND b.family_id = r.family_id ORDER BY b.period DESC LIMIT 1)";

const roomColumns = `r.id, r.room_number, r.rent, r.water_rate, r.electric_mode, r.electric_rate, r.water_meter_init, r.electric_meter_init, r.status, r.created_at, t.full_name AS occupied_by, ${lastElectricAmountSql} AS last_electric_amount, ${lastElectricPeriodSql} AS last_electric_period`;

const roomFrom = "FROM rooms r LEFT JOIN tenants t ON t.room_id = r.id AND t.family_id = r.family_id AND t.status = 'current'";

function toRoom(row: RoomRow, resolved: ResolvedRoomCharges): RoomPayload {
  return {
    id: row.id,
    roomNumber: row.room_number,
    rent: row.rent,
    waterRate: row.water_rate,
    electricMode: row.electric_mode === "flat" ? "flat" : "meter",
    electricRate: row.electric_rate,
    waterMeterInit: row.water_meter_init,
    electricMeterInit: row.electric_meter_init,
    status: row.status === "occupied" ? "occupied" : "vacant",
    occupiedBy: row.occupied_by,
    lastElectricAmount: row.last_electric_amount,
    lastElectricPeriod: row.last_electric_period,
    charges: resolved.charges,
    excludedDormChargeIds: resolved.excludedDormChargeIds,
    ownCharges: resolved.ownCharges,
  };
}

function parseNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseOptionalPositive(value: unknown): { valid: boolean; value: number | null } {
  if (value === undefined || value === null) {
    return { valid: true, value: null };
  }

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return { valid: true, value };
  }

  return { valid: false, value: null };
}

function parseElectricMode(value: unknown): ElectricMode | null {
  return value === "meter" || value === "flat" ? value : null;
}

/**
 * ตรวจซ้ำหลังคำสั่งชุดหนึ่งล้มเหลว เพราะรายการที่ผ่านการตรวจตอนอ่านอาจถูกลบไปก่อนถึงบรรทัด insert
 * ถ้ามี id ที่หายไปจริง แปลว่าคำขออ้างถึงค่าใช้จ่ายของหอที่ไม่มีอยู่แล้ว ไม่ใช่ข้อผิดพลาดของระบบ
 */
async function hasMissingDormCharge(env: Env, family: string, dormChargeIds: string[]): Promise<boolean> {
  if (dormChargeIds.length === 0) {
    return false;
  }

  const known = new Set((await loadDormCharges(env, family)).map((charge) => charge.id));

  return dormChargeIds.some((dormChargeId) => !known.has(dormChargeId));
}

rooms.get("/", async (c) => {
  const family = familyId(c);

  try {
    // สองก้อนนี้ไม่พึ่งกัน — ยิงพร้อมกันเพื่อไม่ต้องรอ D1 ไป-กลับต่อกันอีกรอบ
    const [result, resolved] = await Promise.all([
      c.env.DB.prepare(`SELECT ${roomColumns} ${roomFrom} WHERE r.family_id = ? ORDER BY ${roomNumberOrder("r.room_number")}`)
        .bind(family)
        .all<RoomRow>(),
      resolveAllRoomCharges(c.env, family),
    ]);
    return c.json({ ok: true, rooms: result.results.map((row) => toRoom(row, resolved.get(row.id) ?? { charges: [], excludedDormChargeIds: [], ownCharges: [] })) }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "list rooms failed", error: detail }));
    return c.json(errorBody("INTERNAL", "โหลดข้อมูลห้องไม่สำเร็จ"), 500);
  }
});

rooms.post("/", async (c) => {
  const family = familyId(c);
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const roomNumber = typeof body.roomNumber === "string" ? body.roomNumber.trim().toUpperCase() : "";

  if (roomNumber === "") {
    return c.json(errorBody("VALIDATION", "กรุณากรอกเลขห้อง", "roomNumber"), 400);
  }

  const rent = parseNonNegativeInt(body.rent);

  if (rent === null) {
    return c.json(errorBody("VALIDATION", "ค่าเช่าต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป", "rent"), 400);
  }

  const waterRate = parseOptionalPositive(body.waterRate);

  if (!waterRate.valid) {
    return c.json(errorBody("VALIDATION", "อัตราค่าน้ำต้องเป็นตัวเลขมากกว่า 0", "waterRate"), 400);
  }

  const electricMode = body.electricMode === undefined ? "meter" : parseElectricMode(body.electricMode);

  if (electricMode === null) {
    return c.json(errorBody("VALIDATION", "โหมดค่าไฟต้องเป็น meter หรือ flat", "electricMode"), 400);
  }

  const electricRate = parseOptionalPositive(body.electricRate);

  if (!electricRate.valid) {
    return c.json(errorBody("VALIDATION", "อัตราค่าไฟต้องเป็นตัวเลขมากกว่า 0", "electricRate"), 400);
  }

  const waterMeterInit = body.waterMeterInit === undefined ? 0 : parseNonNegative(body.waterMeterInit);

  if (waterMeterInit === null) {
    return c.json(errorBody("VALIDATION", "มิเตอร์น้ำเริ่มต้นต้องเป็นตัวเลขไม่ติดลบ", "waterMeterInit"), 400);
  }

  const electricMeterInit = body.electricMeterInit === undefined ? 0 : parseNonNegative(body.electricMeterInit);

  if (electricMeterInit === null) {
    return c.json(errorBody("VALIDATION", "มิเตอร์ไฟเริ่มต้นต้องเป็นตัวเลขไม่ติดลบ", "electricMeterInit"), 400);
  }

  const storedElectricRate = electricMode === "flat" ? null : electricRate.value;

  const dormCharges = await loadDormCharges(c.env, family);
  const knownDormIds = new Set(dormCharges.map((charge) => charge.id));
  const excludedDormChargeIds = body.excludedDormChargeIds === undefined ? [] : parseIdList(body.excludedDormChargeIds, knownDormIds);

  if (excludedDormChargeIds === null) {
    return c.json(errorBody("VALIDATION", "รายการค่าใช้จ่ายของหอที่จะปิดไม่ถูกต้อง", "excludedDormChargeIds"), 400);
  }

  const ownCharges = body.ownCharges === undefined ? [] : parseChargeList(body.ownCharges, maxRoomCharges);

  if (ownCharges === null) {
    return c.json(errorBody("VALIDATION", "ค่าใช้จ่ายเฉพาะห้องต้องมีชื่อและจำนวนเงินเป็นจำนวนเต็มไม่ติดลบ ไม่เกิน 10 รายการ", "ownCharges"), 400);
  }

  const id = crypto.randomUUID();

  try {
    const existing = await c.env.DB.prepare("SELECT id FROM rooms WHERE family_id = ? AND room_number = ?")
      .bind(family, roomNumber)
      .first<{ id: string }>();

    if (existing !== null) {
      return c.json(errorBody("DUPLICATE", "เลขห้องนี้ถูกใช้แล้ว", "roomNumber"), 409);
    }

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        "INSERT INTO rooms (id, family_id, room_number, rent, water_rate, electric_mode, electric_rate, water_meter_init, electric_meter_init, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'vacant')",
      ).bind(id, family, roomNumber, rent, waterRate.value, electricMode, storedElectricRate, waterMeterInit, electricMeterInit),
    ];

    ownCharges.forEach((charge, index) => {
      statements.push(
        c.env.DB.prepare("INSERT INTO room_charges (id, family_id, room_id, name, amount, position) VALUES (?, ?, ?, ?, ?, ?)").bind(
          crypto.randomUUID(),
          family,
          id,
          charge.name,
          charge.amount,
          index,
        ),
      );
    });

    for (const dormChargeId of excludedDormChargeIds) {
      statements.push(
        c.env.DB.prepare("INSERT INTO room_charge_excludes (family_id, room_id, dorm_charge_id) VALUES (?, ?, ?)").bind(family, id, dormChargeId),
      );
    }

    await c.env.DB.batch(statements);

    const row = await c.env.DB.prepare(`SELECT ${roomColumns} ${roomFrom} WHERE r.id = ? AND r.family_id = ?`)
      .bind(id, family)
      .first<RoomRow>();

    if (row === null) {
      console.error(JSON.stringify({ message: "create room readback failed", roomId: id }));
      return c.json(errorBody("INTERNAL", "สร้างห้องไม่สำเร็จ"), 500);
    }

    return c.json({ ok: true, room: toRoom(row, await resolveRoomChargesById(c.env, family, id)) }, 201);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "create room failed", error: detail }));

    if (detail.includes("UNIQUE")) {
      return c.json(errorBody("DUPLICATE", "เลขห้องนี้ถูกใช้แล้ว", "roomNumber"), 409);
    }

    if (await hasMissingDormCharge(c.env, family, excludedDormChargeIds)) {
      return c.json(errorBody("VALIDATION", "รายการค่าใช้จ่ายของหอที่จะปิดไม่ถูกต้อง", "excludedDormChargeIds"), 400);
    }

    return c.json(errorBody("INTERNAL", "สร้างห้องไม่สำเร็จ"), 500);
  }
});

/**
 * ตั้งค่าไฟต่อหน่วยจากบิลการไฟฟ้ารวม (หลายห้องใช้มิเตอร์การไฟฟ้าลูกเดียว)
 *
 * worker คิดอัตราเองจากยอดเงินกับหน่วยในบิล แทนการรับอัตราจากหน้าเว็บ เพื่อให้กฎ
 * การปัดมีที่เดียว แล้วตั้งให้ทุกห้องที่เลือกพร้อมจำรายการห้องไว้ และคำนวณบิลที่ยัง
 * ไม่จ่ายและยังไม่ได้ส่งของห้องเหล่านั้นใหม่ใน batch เดียวกัน
 */
rooms.post("/shared-electric", async (c) => {
  const family = familyId(c);
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const amount = body.billAmount;

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return c.json(errorBody("VALIDATION", "ยอดเงินในบิลต้องมากกว่า 0", "billAmount"), 400);
  }

  const units = body.billUnits;

  if (typeof units !== "number" || !Number.isInteger(units) || units <= 0) {
    return c.json(errorBody("VALIDATION", "จำนวนหน่วยในบิลต้องเป็นจำนวนเต็มมากกว่า 0", "billUnits"), 400);
  }

  try {
    const meterRooms = await c.env.DB.prepare(
      "SELECT id, water_rate FROM rooms WHERE family_id = ? AND electric_mode = 'meter'",
    )
      .bind(family)
      .all<{ id: string; water_rate: number | null }>();
    const byId = new Map(meterRooms.results.map((room) => [room.id, room]));
    const roomIds = parseIdList(body.roomIds, new Set(byId.keys()));

    if (roomIds === null || roomIds.length === 0) {
      return c.json(errorBody("VALIDATION", "เลือกห้องที่คิดค่าไฟตามมิเตอร์อย่างน้อย 1 ห้อง", "roomIds"), 400);
    }

    const rate = rateFromBill(amount, units);
    const dormRates = await loadEffectiveRates(c.env, family);
    // คิดบิลใหม่ทุกห้องที่เลือก (ไม่ใช่เฉพาะห้องที่อัตราเปลี่ยน) และเขียนลง batch
    // เดียวกับอัตรา — ทั้งชุดสำเร็จหรือไม่สำเร็จพร้อมกัน กดซ้ำก็ซ่อมบิลที่ค้างได้เสมอ
    const billUpdates = await Promise.all(
      roomIds.map((id) =>
        recalcRoomUnsentBillStatements(c.env, family, id, byId.get(id)?.water_rate ?? dormRates.water, rate),
      ),
    );

    await c.env.DB.batch([
      ...roomIds.map((id) =>
        c.env.DB.prepare("UPDATE rooms SET electric_rate = ? WHERE id = ? AND family_id = ?").bind(rate, id, family),
      ),
      c.env.DB.prepare(upsertSettingSql).bind(family, sharedElectricRoomIdsKey, JSON.stringify(roomIds)),
      ...billUpdates.flat(),
    ]);

    return c.json({ ok: true, rate, roomIds }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "shared electric rate failed", error: detail }));
    return c.json(errorBody("INTERNAL", "ตั้งค่าไฟจากบิลรวมไม่สำเร็จ"), 500);
  }
});

rooms.patch("/:id", async (c) => {
  const family = familyId(c);
  const id = c.req.param("id");
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  let excludedDormChargeIds: string[] | null = null;

  try {
    const existing = await c.env.DB.prepare(`SELECT ${roomColumns} ${roomFrom} WHERE r.id = ? AND r.family_id = ?`)
      .bind(id, family)
      .first<RoomRow>();

    if (existing === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบห้องที่ต้องการแก้ไข"), 404);
    }

    let roomNumber = existing.room_number;

    if (body.roomNumber !== undefined) {
      const parsed = typeof body.roomNumber === "string" ? body.roomNumber.trim().toUpperCase() : "";

      if (parsed === "") {
        return c.json(errorBody("VALIDATION", "กรุณากรอกเลขห้อง", "roomNumber"), 400);
      }

      roomNumber = parsed;
    }

    let rent = existing.rent;

    if (body.rent !== undefined) {
      const parsed = parseNonNegativeInt(body.rent);

      if (parsed === null) {
        return c.json(errorBody("VALIDATION", "ค่าเช่าต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป", "rent"), 400);
      }

      rent = parsed;
    }

    let waterRate = existing.water_rate;

    if (body.waterRate !== undefined) {
      const parsed = parseOptionalPositive(body.waterRate);

      if (!parsed.valid) {
        return c.json(errorBody("VALIDATION", "อัตราค่าน้ำต้องเป็นตัวเลขมากกว่า 0", "waterRate"), 400);
      }

      waterRate = parsed.value;
    }

    let electricMode: ElectricMode = existing.electric_mode === "flat" ? "flat" : "meter";

    if (body.electricMode !== undefined) {
      const parsed = parseElectricMode(body.electricMode);

      if (parsed === null) {
        return c.json(errorBody("VALIDATION", "โหมดค่าไฟต้องเป็น meter หรือ flat", "electricMode"), 400);
      }

      electricMode = parsed;
    }

    let electricRate = existing.electric_rate;

    if (body.electricRate !== undefined) {
      const parsed = parseOptionalPositive(body.electricRate);

      if (!parsed.valid) {
        return c.json(errorBody("VALIDATION", "อัตราค่าไฟต้องเป็นตัวเลขมากกว่า 0", "electricRate"), 400);
      }

      electricRate = parsed.value;
    }

    let waterMeterInit = existing.water_meter_init;

    if (body.waterMeterInit !== undefined) {
      const parsed = parseNonNegative(body.waterMeterInit);

      if (parsed === null) {
        return c.json(errorBody("VALIDATION", "มิเตอร์น้ำเริ่มต้นต้องเป็นตัวเลขไม่ติดลบ", "waterMeterInit"), 400);
      }

      waterMeterInit = parsed;
    }

    let electricMeterInit = existing.electric_meter_init;

    if (body.electricMeterInit !== undefined) {
      const parsed = parseNonNegative(body.electricMeterInit);

      if (parsed === null) {
        return c.json(errorBody("VALIDATION", "มิเตอร์ไฟเริ่มต้นต้องเป็นตัวเลขไม่ติดลบ", "electricMeterInit"), 400);
      }

      electricMeterInit = parsed;
    }

    if (body.excludedDormChargeIds !== undefined) {
      const dormCharges = await loadDormCharges(c.env, family);
      const parsed = parseIdList(body.excludedDormChargeIds, new Set(dormCharges.map((charge) => charge.id)));

      if (parsed === null) {
        return c.json(errorBody("VALIDATION", "รายการค่าใช้จ่ายของหอที่จะปิดไม่ถูกต้อง", "excludedDormChargeIds"), 400);
      }

      excludedDormChargeIds = parsed;
    }

    let ownCharges: ChargePayload[] | null = null;

    if (body.ownCharges !== undefined) {
      const parsed = parseChargeList(body.ownCharges, maxRoomCharges);

      if (parsed === null) {
        return c.json(errorBody("VALIDATION", "ค่าใช้จ่ายเฉพาะห้องต้องมีชื่อและจำนวนเงินเป็นจำนวนเต็มไม่ติดลบ ไม่เกิน 10 รายการ", "ownCharges"), 400);
      }

      ownCharges = parsed;
    }

    const storedElectricRate = electricMode === "flat" ? null : electricRate;

    const clash = await c.env.DB.prepare("SELECT id FROM rooms WHERE family_id = ? AND room_number = ? AND id != ?")
      .bind(family, roomNumber, id)
      .first<{ id: string }>();

    if (clash !== null) {
      return c.json(errorBody("DUPLICATE", "เลขห้องนี้ถูกใช้แล้ว", "roomNumber"), 409);
    }

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        "UPDATE rooms SET room_number = ?, rent = ?, water_rate = ?, electric_mode = ?, electric_rate = ?, water_meter_init = ?, electric_meter_init = ? WHERE id = ? AND family_id = ?",
      ).bind(roomNumber, rent, waterRate, electricMode, storedElectricRate, waterMeterInit, electricMeterInit, id, family),
    ];

    if (ownCharges !== null) {
      statements.push(c.env.DB.prepare("DELETE FROM room_charges WHERE room_id = ? AND family_id = ?").bind(id, family));

      ownCharges.forEach((charge, index) => {
        statements.push(
          c.env.DB.prepare("INSERT INTO room_charges (id, family_id, room_id, name, amount, position) VALUES (?, ?, ?, ?, ?, ?)").bind(
            crypto.randomUUID(),
            family,
            id,
            charge.name,
            charge.amount,
            index,
          ),
        );
      });
    }

    if (excludedDormChargeIds !== null) {
      statements.push(c.env.DB.prepare("DELETE FROM room_charge_excludes WHERE room_id = ? AND family_id = ?").bind(id, family));

      for (const dormChargeId of excludedDormChargeIds) {
        statements.push(
          c.env.DB.prepare("INSERT INTO room_charge_excludes (family_id, room_id, dorm_charge_id) VALUES (?, ?, ?)").bind(family, id, dormChargeId),
        );
      }
    }

    await c.env.DB.batch(statements);

    // อัตราที่ใช้จริงของห้องเปลี่ยน (ตั้งเอง/เคลียร์กลับไปใช้ค่าเริ่มต้น) — คำนวณ
    // บิลที่ยังไม่จ่ายและยังไม่ได้ส่งของห้องนี้ใหม่ บิลที่ส่งไปแล้วคงยอดเดิมไว้
    // เสมอ (ดู src/worker/lib/bill-rates.ts) ฝั่งไฟเช็คเฉพาะตอนที่ยังเป็นโหมด
    // มิเตอร์ทั้งก่อนและหลัง — สลับโหมด (มิเตอร์↔เหมาจ่าย) ไม่มีอัตราให้เทียบ
    // อีกต่อไปในฝั่งที่เปลี่ยนไป จึงไม่ถือเป็นการ "เปลี่ยนอัตรา" ที่ต้องคำนวณใหม่
    const waterRateChanged = existing.water_rate !== waterRate;
    const electricRateChanged =
      electricMode === "meter" &&
      existing.electric_mode === "meter" &&
      existing.electric_rate !== storedElectricRate;

    if (waterRateChanged || electricRateChanged) {
      const dormRates = await loadEffectiveRates(c.env, family);
      await recalcRoomUnsentBills(
        c.env,
        family,
        id,
        waterRate ?? dormRates.water,
        storedElectricRate ?? dormRates.electric,
      );
    }

    const row = await c.env.DB.prepare(`SELECT ${roomColumns} ${roomFrom} WHERE r.id = ? AND r.family_id = ?`)
      .bind(id, family)
      .first<RoomRow>();

    if (row === null) {
      console.error(JSON.stringify({ message: "update room readback failed", roomId: id }));
      return c.json(errorBody("INTERNAL", "บันทึกห้องไม่สำเร็จ"), 500);
    }

    return c.json({ ok: true, room: toRoom(row, await resolveRoomChargesById(c.env, family, id)) }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "update room failed", roomId: id, error: detail }));

    if (detail.includes("UNIQUE")) {
      return c.json(errorBody("DUPLICATE", "เลขห้องนี้ถูกใช้แล้ว", "roomNumber"), 409);
    }

    if (excludedDormChargeIds !== null && (await hasMissingDormCharge(c.env, family, excludedDormChargeIds))) {
      return c.json(errorBody("VALIDATION", "รายการค่าใช้จ่ายของหอที่จะปิดไม่ถูกต้อง", "excludedDormChargeIds"), 400);
    }

    return c.json(errorBody("INTERNAL", "บันทึกห้องไม่สำเร็จ"), 500);
  }
});

export default rooms;
