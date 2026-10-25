import { Hono } from "hono";
import type { AppEnv } from "../lib/auth";
import { familyId } from "../lib/auth";
import { demoModeOn, lineChannelConfigured, pushMessage } from "../line/api";
import { bankThaiName } from "../lib/banks";
import { integrationEnv } from "../lib/credentials";
import {
  buildBillFlexMessage,
  type BillMessagePayee,
} from "../line/bill-message";
import { ownerSendSummaryMessage } from "../line/messages";
import { thaiPeriodLabel } from "../lib/invoice";
import { resolveAllRoomCharges } from "../lib/charges";
import { chargeFromFlatAmount, chargeFromUnits } from "../../shared/billing";
import { isForeignKeyViolation } from "../lib/slips";
import { type BillPaidEvent, broadcastBillPaid, pushOwnerBillPaid } from "../lib/paid-notify";
import { loadEffectiveRates } from "../lib/bill-rates";
import { loadPayeeSnapshot } from "../lib/bill-payee";
import {
  asRecord,
  errorBody,
  isIsoDate,
  readJsonObject,
  roomNumberOrder,
} from "./shared";

const bills = new Hono<AppEnv>();

type ElectricMode = "meter" | "flat";
type BillStatus = "paid" | "unpaid";

const periodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * เลขห้องและชื่อผู้เช่าอ่านจากคอลัมน์ snapshot ในบิลเอง
 *
 * เดิมอ่านผ่าน JOIN rooms/tenants ทำให้แก้ชื่อห้องแล้วเลขที่ใบแจ้งหนี้ของบิล
 * ที่ออกไปแล้วเปลี่ยนตาม ซึ่งผิดหลัก "บิลที่ออกแล้วห้ามเปลี่ยน"
 */
const billColumns =
  "b.id, b.room_id, b.room_number, b.tenant_id, b.tenant_name, b.period, b.rent, b.water_previous, b.water_current, b.water_units, b.water_rate, b.water_amount, b.electric_mode, b.electric_previous, b.electric_current, b.electric_units, b.electric_rate, b.electric_amount, b.total, b.status, b.paid_at, b.paid_method, b.sent_at, b.created_at";

const billFrom = "FROM bills b";

const occupiedRoomColumns =
  "r.id AS room_id, r.room_number, r.rent, r.water_rate, r.electric_mode, r.electric_rate, r.water_meter_init, r.electric_meter_init, t.id AS tenant_id, t.full_name AS tenant_name";

const occupiedRoomFrom =
  "FROM rooms r JOIN tenants t ON t.room_id = r.id AND t.status = 'current'";

const insertBillSql =
  "INSERT INTO bills (id, family_id, room_id, tenant_id, period, room_number, tenant_name, rent, water_previous, water_current, water_units, water_rate, water_amount, electric_mode, electric_previous, electric_current, electric_units, electric_rate, electric_amount, total, payee_dorm_name, payee_owner_name, payee_promptpay_id, payee_promptpay_type, payee_promptpay_name, payee_bank_name, payee_bank_account_number, payee_bank_account_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const insertChargeSql =
  "INSERT INTO bill_charges (id, family_id, bill_id, name, amount, position) VALUES (?, ?, ?, ?, ?, ?)";

const updateBillSql =
  "UPDATE bills SET water_current = ?, water_units = ?, water_amount = ?, electric_current = ?, electric_units = ?, electric_rate = ?, electric_amount = ?, total = ? WHERE id = ? AND family_id = ?";

const deleteChargesSql =
  "DELETE FROM bill_charges WHERE bill_id = ? AND family_id = ?";

const deleteBillSql = "DELETE FROM bills WHERE id = ? AND family_id = ?";

/** บิลเดือนถัดไปของห้องเดียวกัน — ใช้กันไม่ให้แก้เลขมิเตอร์ซ้ำหน่วยกับเดือนถัดไป */
const nextReadingSql =
  "SELECT water_previous, electric_previous FROM bills WHERE family_id = ? AND room_id = ? AND period > ? ORDER BY period ASC LIMIT 1";

interface BillRow {
  id: string;
  room_id: string;
  room_number: string;
  tenant_id: string;
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
  status: string;
  paid_at: string | null;
  paid_method: string | null;
  sent_at: string | null;
  created_at: string;
}

interface ChargePayload {
  name: string;
  amount: number;
}

interface BillPayload {
  id: string;
  roomId: string;
  roomNumber: string;
  tenantId: string;
  tenantName: string;
  period: string;
  rent: number;
  waterPrevious: number;
  waterCurrent: number;
  waterUnits: number;
  waterRate: number;
  waterAmount: number;
  electricMode: ElectricMode;
  electricPrevious: number;
  electricCurrent: number;
  electricUnits: number | null;
  electricRate: number | null;
  electricAmount: number;
  charges: ChargePayload[];
  total: number;
  status: BillStatus;
  paidAt: string | null;
  paidMethod: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface MeterRowPayload {
  roomId: string;
  roomNumber: string;
  tenantId: string;
  tenantName: string;
  rent: number;
  waterRate: number;
  electricMode: ElectricMode;
  electricRate: number | null;
  waterPrevious: number;
  electricPrevious: number;
  /**
   * หน่วยไฟของบิลล่าสุดที่ออกให้ห้องนี้ก่อนงวดที่กำลังทำ (null = ยังไม่เคยออกบิล)
   * หน้าเว็บใช้เทียบเพื่อเตือนเลขที่สูงผิดปกติ — ไม่ใช่ค่าที่ใช้คำนวณเงิน
   */
  electricUnitsPrevious: number | null;
  existingBillId: string | null;
  charges: ChargePayload[];
}

interface OccupiedRoomRow {
  room_id: string;
  room_number: string;
  rent: number;
  water_rate: number | null;
  electric_mode: string;
  electric_rate: number | null;
  water_meter_init: number;
  electric_meter_init: number;
  tenant_id: string;
  tenant_name: string;
}

interface LatestReadingRow {
  room_id: string;
  water_current: number;
  electric_current: number;
  electric_units: number | null;
}

interface GenerateEntry {
  roomId: string;
  waterCurrent: number;
  electricCurrent: number;
  flatElectricAmount: number | null;
  charges: ChargePayload[];
}

type EntryParse =
  | { ok: true; entry: GenerateEntry }
  | { ok: false; field: string; message: string };

function isPeriod(value: unknown): value is string {
  return typeof value === "string" && periodPattern.test(value);
}

function toElectricMode(value: string): ElectricMode {
  return value === "flat" ? "flat" : "meter";
}

function parseReading(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parseCharges(value: unknown): ChargePayload[] | null {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const charges: ChargePayload[] = [];

  for (const item of value) {
    const record = asRecord(item);

    if (record === null) {
      return null;
    }

    const name = typeof record.name === "string" ? record.name.trim() : "";
    const amount = record.amount;

    if (
      name === "" ||
      typeof amount !== "number" ||
      !Number.isInteger(amount) ||
      amount < 0
    ) {
      return null;
    }

    charges.push({ name, amount });
  }

  return charges;
}

function parseEntry(raw: unknown): EntryParse {
  const record = asRecord(raw);

  if (record === null) {
    return { ok: false, field: "entries", message: "รายการห้องไม่ถูกต้อง" };
  }

  const roomId = typeof record.roomId === "string" ? record.roomId.trim() : "";

  if (roomId === "") {
    return { ok: false, field: "entries", message: "กรุณาระบุห้องในทุกรายการ" };
  }

  const waterCurrent = parseReading(record.waterCurrent);

  if (waterCurrent === null) {
    return {
      ok: false,
      field: "waterCurrent",
      message: "เลขมิเตอร์น้ำต้องเป็นตัวเลขไม่ติดลบ",
    };
  }

  const electricCurrent = parseReading(record.electricCurrent);

  if (electricCurrent === null) {
    return {
      ok: false,
      field: "electricCurrent",
      message: "เลขมิเตอร์ไฟต้องเป็นตัวเลขไม่ติดลบ",
    };
  }

  const charges = parseCharges(record.charges);

  if (charges === null) {
    return {
      ok: false,
      field: "charges",
      message: "ค่าใช้จ่ายเพิ่มเติมต้องมีชื่อและจำนวนเงินเป็นจำนวนเต็มไม่ติดลบ",
    };
  }

  const rawFlat = record.flatElectricAmount;
  let flatElectricAmount: number | null = null;

  if (rawFlat !== undefined && rawFlat !== null) {
    if (
      typeof rawFlat !== "number" ||
      !Number.isFinite(rawFlat) ||
      rawFlat < 0
    ) {
      return {
        ok: false,
        field: "flatElectricAmount",
        message: "ยอดค่าไฟเหมาจ่ายต้องเป็นตัวเลขไม่ติดลบ",
      };
    }

    flatElectricAmount = rawFlat;
  }

  return {
    ok: true,
    entry: {
      roomId,
      waterCurrent,
      electricCurrent,
      flatElectricAmount,
      charges,
    },
  };
}

async function loadOccupiedRooms(
  env: Env,
  family: string,
): Promise<OccupiedRoomRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${occupiedRoomColumns} ${occupiedRoomFrom} WHERE r.family_id = ? AND t.family_id = ? ORDER BY ${roomNumberOrder("r.room_number")}`,
  )
    .bind(family, family)
    .all<OccupiedRoomRow>();
  return result.results;
}

async function loadLatestReadings(
  env: Env,
  family: string,
  period: string,
): Promise<Map<string, LatestReadingRow>> {
  const result = await env.DB.prepare(
    `SELECT b.room_id, b.water_current, b.electric_current, b.electric_units FROM bills b JOIN (SELECT room_id, MAX(period) AS period FROM bills WHERE family_id = ? AND period < ? GROUP BY room_id) latest ON latest.room_id = b.room_id AND latest.period = b.period WHERE b.family_id = ?`,
  )
    .bind(family, period, family)
    .all<LatestReadingRow>();

  return new Map(result.results.map((row) => [row.room_id, row]));
}

/**
 * โหลดค่าใช้จ่ายเพิ่มเติมของบิลทุกเดือนในช่วง from..to ครบทั้งสองปลาย
 * from === to คือเดือนเดียว จึงใช้ตัวโหลดนี้ได้ทั้งรายการรายเดือนและรายช่วง
 */
async function loadCharges(
  env: Env,
  family: string,
  from: string,
  to: string,
): Promise<Map<string, ChargePayload[]>> {
  const result = await env.DB.prepare(
    "SELECT bc.bill_id, bc.name, bc.amount FROM bill_charges bc JOIN bills b ON b.id = bc.bill_id AND b.family_id = bc.family_id WHERE b.family_id = ? AND b.period >= ? AND b.period <= ? ORDER BY bc.bill_id ASC, bc.position ASC",
  )
    .bind(family, from, to)
    .all<{ bill_id: string; name: string; amount: number }>();

  const grouped = new Map<string, ChargePayload[]>();

  for (const row of result.results) {
    const list = grouped.get(row.bill_id) ?? [];
    list.push({ name: row.name, amount: row.amount });
    grouped.set(row.bill_id, list);
  }

  return grouped;
}

async function loadRoomChargeDefaults(
  env: Env,
  family: string,
): Promise<Map<string, ChargePayload[]>> {
  const resolved = await resolveAllRoomCharges(env, family);
  const defaults = new Map<string, ChargePayload[]>();

  for (const [roomId, room] of resolved) {
    defaults.set(roomId, room.charges);
  }

  return defaults;
}

function toBill(row: BillRow, charges: ChargePayload[]): BillPayload {
  return {
    id: row.id,
    roomId: row.room_id,
    roomNumber: row.room_number,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    period: row.period,
    rent: row.rent,
    waterPrevious: row.water_previous,
    waterCurrent: row.water_current,
    waterUnits: row.water_units,
    waterRate: row.water_rate,
    waterAmount: row.water_amount,
    electricMode: toElectricMode(row.electric_mode),
    electricPrevious: row.electric_previous,
    electricCurrent: row.electric_current,
    electricUnits: row.electric_units,
    electricRate: row.electric_rate,
    electricAmount: row.electric_amount,
    charges,
    total: row.total,
    status: row.status === "paid" ? "paid" : "unpaid",
    paidAt: row.paid_at,
    paidMethod: row.paid_method,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

/**
 * โหลดบิลทุกเดือนในช่วง from..to เรียงเดือนเก่าไปใหม่แล้วตามเลขห้อง
 * from === to ให้ผลเหมือนเดิมทุกประการกับการโหลดเดือนเดียว
 */
async function loadBills(
  env: Env,
  family: string,
  from: string,
  to: string,
): Promise<BillPayload[]> {
  const result = await env.DB.prepare(
    `SELECT ${billColumns} ${billFrom} WHERE b.family_id = ? AND b.period >= ? AND b.period <= ? ORDER BY b.period ASC, ${roomNumberOrder("b.room_number")}`,
  )
    .bind(family, from, to)
    .all<BillRow>();
  const charges = await loadCharges(env, family, from, to);

  return result.results.map((row) => toBill(row, charges.get(row.id) ?? []));
}

async function loadBill(
  env: Env,
  family: string,
  id: string,
): Promise<BillPayload | null> {
  const row = await env.DB.prepare(
    `SELECT ${billColumns} ${billFrom} WHERE b.family_id = ? AND b.id = ?`,
  )
    .bind(family, id)
    .first<BillRow>();

  if (row === null) {
    return null;
  }

  const charges = await env.DB.prepare(
    "SELECT name, amount FROM bill_charges WHERE family_id = ? AND bill_id = ? ORDER BY position ASC",
  )
    .bind(family, id)
    .all<ChargePayload>();

  return toBill(row, charges.results);
}

interface SkippedBill {
  roomNumber: string;
  tenantName: string;
}

interface SendSummary {
  period: string;
  count: number;
  total: number;
  sent: number;
  failed: number;
  failedRooms: string[];
  skipped: SkippedBill[];
}

function publicBaseUrl(requestUrl: string): string {
  const origin = new URL(requestUrl).origin;

  if (!origin.startsWith("https://")) {
    console.warn(
      JSON.stringify({ message: "bill link origin is not https", origin }),
    );
  }

  return origin;
}

interface BillPayeeRow {
  id: string;
  payee_promptpay_id: string;
  payee_promptpay_name: string;
  payee_bank_name: string;
  payee_bank_account_number: string;
  payee_bank_account_name: string;
}

function payeeFromRow(row: BillPayeeRow): BillMessagePayee {
  return {
    promptpayId: row.payee_promptpay_id,
    promptpayName: row.payee_promptpay_name,
    bankName: bankThaiName(row.payee_bank_name),
    bankAccountNumber: row.payee_bank_account_number,
    bankAccountName: row.payee_bank_account_name,
  };
}

/** ไม่ควรเกิดขึ้นจริง เพราะบิลมาจาก query ครอบครัวเดียวกันเสมอ แต่กันชนิดไว้ */
const emptyPayee: BillMessagePayee = {
  promptpayId: "",
  promptpayName: "",
  bankName: "",
  bankAccountNumber: "",
  bankAccountName: "",
};

const billPayeeColumns =
  "id, payee_promptpay_id, payee_promptpay_name, payee_bank_name, payee_bank_account_number, payee_bank_account_name";

/**
 * ผู้รับเงินที่ snapshot ไว้ในบิลนั้นเอง ณ ตอนออกบิล ไม่ใช่ค่าปัจจุบันของ
 * ตั้งค่า — แก้พร้อมเพย์หรือบัญชีธนาคารทีหลังจึงไม่ทำให้บิลที่ส่งไปแล้ว
 * เปลี่ยนช่องทางรับเงินย้อนหลัง (ดู migration 0011)
 */
async function loadBillPayee(env: Env, family: string, billId: string): Promise<BillMessagePayee | null> {
  const row = await env.DB.prepare(`SELECT ${billPayeeColumns} FROM bills WHERE family_id = ? AND id = ?`)
    .bind(family, billId)
    .first<BillPayeeRow>();

  return row === null ? null : payeeFromRow(row);
}

/** เวอร์ชันดึงหลายบิลพร้อมกัน ใช้ตอนส่งทั้งเดือนเพื่อเลี่ยง query ในลูป */
async function loadBillPayees(
  env: Env,
  family: string,
  billIds: string[],
): Promise<Map<string, BillMessagePayee>> {
  if (billIds.length === 0) {
    return new Map();
  }

  const placeholders = billIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT ${billPayeeColumns} FROM bills WHERE family_id = ? AND id IN (${placeholders})`,
  )
    .bind(family, ...billIds)
    .all<BillPayeeRow>();

  return new Map(result.results.map((row) => [row.id, payeeFromRow(row)]));
}

async function loadLinkedTenants(
  env: Env,
  family: string,
): Promise<Map<string, string>> {
  const result = await env.DB.prepare(
    "SELECT id, line_user_id FROM tenants WHERE family_id = ? AND line_user_id IS NOT NULL",
  )
    .bind(family)
    .all<{
      id: string;
      line_user_id: string;
    }>();

  return new Map(result.results.map((row) => [row.id, row.line_user_id]));
}

async function loadOwnerLineUserId(
  env: Env,
  family: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE family_id = ? AND key = 'owner_line_user_id'",
  )
    .bind(family)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function sendOwnerSummary(
  env: Env,
  family: string,
  summary: SendSummary,
): Promise<void> {
  const ownerId = await loadOwnerLineUserId(env, family);

  if (ownerId === null || ownerId.trim() === "") {
    return;
  }

  await pushMessage(env, ownerId, [ownerSendSummaryMessage(summary)]);
}

function parsePaidAt(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (isoTimestampPattern.test(trimmed)) {
    if (!isIsoDate(trimmed.slice(0, 10))) {
      return null;
    }

    return Number.isNaN(new Date(trimmed).getTime()) ? null : trimmed;
  }

  return isIsoDate(trimmed) ? trimmed : null;
}

function roomLabel(
  rooms: Map<string, OccupiedRoomRow>,
  roomId: string,
): string {
  return rooms.get(roomId)?.room_number ?? roomId;
}

bills.get("/", async (c) => {
  const family = familyId(c);
  const period = c.req.query("period") ?? "";

  if (!isPeriod(period)) {
    return c.json(
      errorBody("VALIDATION", "เดือนต้องอยู่ในรูปแบบ YYYY-MM", "period"),
      400,
    );
  }

  try {
    const list = await loadBills(c.env, family, period, period);
    return c.json({ ok: true, period, bills: list }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "list bills failed", period, error: detail }),
    );
    return c.json(errorBody("INTERNAL", "โหลดข้อมูลบิลไม่สำเร็จ"), 500);
  }
});

bills.get("/meter-sheet", async (c) => {
  const family = familyId(c);
  const period = c.req.query("period") ?? "";

  if (!isPeriod(period)) {
    return c.json(
      errorBody("VALIDATION", "เดือนต้องอยู่ในรูปแบบ YYYY-MM", "period"),
      400,
    );
  }

  try {
    const rates = await loadEffectiveRates(c.env, family);
    const occupied = await loadOccupiedRooms(c.env, family);
    const latest = await loadLatestReadings(c.env, family, period);
    const defaultCharges = await loadRoomChargeDefaults(c.env, family);
    const existing = await c.env.DB.prepare(
      "SELECT id, room_id FROM bills WHERE family_id = ? AND period = ?",
    )
      .bind(family, period)
      .all<{ id: string; room_id: string }>();
    const existingByRoom = new Map(
      existing.results.map((row) => [row.room_id, row.id]),
    );

    const rows: MeterRowPayload[] = occupied.map((room) => {
      const previous = latest.get(room.room_id);
      const mode = toElectricMode(room.electric_mode);

      return {
        roomId: room.room_id,
        roomNumber: room.room_number,
        tenantId: room.tenant_id,
        tenantName: room.tenant_name,
        rent: room.rent,
        waterRate: room.water_rate ?? rates.water,
        electricMode: mode,
        electricRate:
          mode === "flat" ? null : (room.electric_rate ?? rates.electric),
        waterPrevious: previous?.water_current ?? room.water_meter_init,
        electricPrevious:
          previous?.electric_current ?? room.electric_meter_init,
        electricUnitsPrevious: previous?.electric_units ?? null,
        existingBillId: existingByRoom.get(room.room_id) ?? null,
        charges: defaultCharges.get(room.room_id) ?? [],
      };
    });

    return c.json({ ok: true, period, rows }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "load meter sheet failed",
        period,
        error: detail,
      }),
    );
    return c.json(errorBody("INTERNAL", "โหลดข้อมูลมิเตอร์ไม่สำเร็จ"), 500);
  }
});

bills.get("/periods", async (c) => {
  const family = familyId(c);

  try {
    const result = await c.env.DB.prepare(
      "SELECT DISTINCT period FROM bills WHERE family_id = ? ORDER BY period DESC",
    )
      .bind(family)
      .all<{ period: string }>();
    return c.json(
      { ok: true, periods: result.results.map((row) => row.period) },
      200,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "list bill periods failed", error: detail }),
    );
    return c.json(errorBody("INTERNAL", "โหลดรายการเดือนของบิลไม่สำเร็จ"), 500);
  }
});

// อ่านอย่างเดียว ครอบทุกบิลในช่วง from..to ครบทั้งสองปลาย ไม่จำกัดความยาวช่วง
// เพราะหอหนึ่งมีบิลไม่เกินหลักร้อยต่อปี และไม่ผูกกับตัวกรองบนจอ
bills.get("/export", async (c) => {
  const family = familyId(c);
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";

  if (!isPeriod(from)) {
    return c.json(
      errorBody("VALIDATION", "เดือนต้องอยู่ในรูปแบบ YYYY-MM", "from"),
      400,
    );
  }

  if (!isPeriod(to)) {
    return c.json(
      errorBody("VALIDATION", "เดือนต้องอยู่ในรูปแบบ YYYY-MM", "to"),
      400,
    );
  }

  // รูปแบบ YYYY-MM เทียบสตริงตรง ๆ ได้ เพราะเติมศูนย์หน้าจนความยาวเท่ากันเสมอ
  if (from > to) {
    return c.json(
      errorBody("VALIDATION", "เดือนเริ่มต้องไม่เกินเดือนสุดท้าย", "from"),
      400,
    );
  }

  try {
    const list = await loadBills(c.env, family, from, to);
    return c.json({ ok: true, from, to, bills: list }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "export bills failed", from, to, error: detail }),
    );
    return c.json(errorBody("INTERNAL", "โหลดข้อมูลบิลไม่สำเร็จ"), 500);
  }
});

bills.post("/generate", async (c) => {
  const family = familyId(c);
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const period = body.period;

  if (!isPeriod(period)) {
    return c.json(
      errorBody("VALIDATION", "เดือนต้องอยู่ในรูปแบบ YYYY-MM", "period"),
      400,
    );
  }

  const rawEntries = body.entries;

  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    return c.json(
      errorBody("VALIDATION", "กรุณาส่งรายการห้องที่จะออกบิล", "entries"),
      400,
    );
  }

  const entries: GenerateEntry[] = [];

  for (const raw of rawEntries) {
    const parsed = parseEntry(raw);

    if (!parsed.ok) {
      return c.json(errorBody("VALIDATION", parsed.message, parsed.field), 400);
    }

    entries.push(parsed.entry);
  }

  try {
    const rates = await loadEffectiveRates(c.env, family);
    const payee = await loadPayeeSnapshot(c.env, family);

    // ห้ามออกบิลที่ผู้เช่าจ่ายไม่ได้เลย — ต้องมีอย่างน้อยพร้อมเพย์หรือบัญชี
    // ธนาคารก่อนเสมอ settings.ts บังคับไว้แล้วตอนบันทึกค่า แต่เช็คซ้ำที่นี่
    // เผื่อครอบครัวใหม่ที่ยังไม่เคยบันทึกช่องทางรับเงินเลยมาออกบิลตรง ๆ
    // บัญชีธนาคารนับว่าใช้ได้เฉพาะเมื่อมีทั้งชื่อธนาคารและเลขบัญชีครบคู่
    // เลขบัญชีอย่างเดียวโดยไม่รู้ธนาคารทำให้ผู้เช่าโอนเงินไม่ได้จริง
    const hasBankPayout = payee.bankName !== "" && payee.bankAccountNumber !== "";

    if (payee.promptpayId === "" && !hasBankPayout) {
      return c.json(
        errorBody("VALIDATION", "กรุณาตั้งค่าพร้อมเพย์หรือบัญชีธนาคารรับเงินก่อนออกบิล"),
        400,
      );
    }

    const occupiedById = new Map(
      (await loadOccupiedRooms(c.env, family)).map((room) => [room.room_id, room]),
    );

    const seen = new Set<string>();
    const repeated: string[] = [];

    for (const entry of entries) {
      if (seen.has(entry.roomId)) {
        repeated.push(roomLabel(occupiedById, entry.roomId));
      }

      seen.add(entry.roomId);
    }

    if (repeated.length > 0) {
      return c.json(
        errorBody(
          "VALIDATION",
          `มีห้องซ้ำในรายการ: ${repeated.join(", ")}`,
          "entries",
        ),
        400,
      );
    }

    const unknownRooms: string[] = [];
    const vacantRooms: string[] = [];

    for (const entry of entries) {
      if (occupiedById.has(entry.roomId)) {
        continue;
      }

      const room = await c.env.DB.prepare(
        "SELECT room_number FROM rooms WHERE family_id = ? AND id = ?",
      )
        .bind(family, entry.roomId)
        .first<{ room_number: string }>();

      if (room === null) {
        unknownRooms.push(entry.roomId);
      } else {
        vacantRooms.push(room.room_number);
      }
    }

    if (unknownRooms.length > 0) {
      return c.json(
        errorBody(
          "VALIDATION",
          `ไม่พบห้องในรายการ: ${unknownRooms.join(", ")}`,
          "entries",
        ),
        400,
      );
    }

    if (vacantRooms.length > 0) {
      return c.json(
        errorBody(
          "VALIDATION",
          `ออกบิลได้เฉพาะห้องที่มีผู้เช่า: ${vacantRooms.join(", ")}`,
          "entries",
        ),
        400,
      );
    }

    const billed = await c.env.DB.prepare(
      "SELECT room_id FROM bills WHERE family_id = ? AND period = ?",
    )
      .bind(family, period)
      .all<{ room_id: string }>();
    const billedRoomIds = new Set(billed.results.map((row) => row.room_id));
    const conflicts = entries
      .filter((entry) => billedRoomIds.has(entry.roomId))
      .map((entry) => roomLabel(occupiedById, entry.roomId));

    if (conflicts.length > 0) {
      return c.json(
        errorBody(
          "CONFLICT",
          `เดือนนี้มีบิลแล้ว: ${conflicts.join(", ")}`,
          "entries",
        ),
        409,
      );
    }

    const latest = await loadLatestReadings(c.env, family, period);
    const paired = entries
      .map((entry) => ({ entry, room: occupiedById.get(entry.roomId) }))
      .filter(
        (item): item is { entry: GenerateEntry; room: OccupiedRoomRow } =>
          item.room !== undefined,
      );

    const statements: D1PreparedStatement[] = [];
    const createdIds: string[] = [];

    for (const item of paired) {
      const room = item.room;
      const entry = item.entry;
      const previousWater =
        latest.get(room.room_id)?.water_current ?? room.water_meter_init;
      const previousElectric =
        latest.get(room.room_id)?.electric_current ?? room.electric_meter_init;

      if (entry.waterCurrent < previousWater) {
        return c.json(
          errorBody(
            "VALIDATION",
            `เลขมิเตอร์น้ำต้องไม่น้อยกว่าครั้งก่อน (ห้อง ${room.room_number})`,
            "waterCurrent",
          ),
          400,
        );
      }

      if (entry.electricCurrent < previousElectric) {
        return c.json(
          errorBody(
            "VALIDATION",
            `เลขมิเตอร์ไฟต้องไม่น้อยกว่าครั้งก่อน (ห้อง ${room.room_number})`,
            "electricCurrent",
          ),
          400,
        );
      }

      const mode = toElectricMode(room.electric_mode);
      const waterUnits = entry.waterCurrent - previousWater;
      const waterRate = room.water_rate ?? rates.water;
      const waterAmount = chargeFromUnits(waterUnits, waterRate);
      let electricUnits: number | null = null;
      let electricRate: number | null = null;
      let electricAmount = 0;

      if (mode === "flat") {
        if (entry.flatElectricAmount === null) {
          return c.json(
            errorBody(
              "VALIDATION",
              `กรุณากรอกยอดค่าไฟเหมาจ่าย (ห้อง ${room.room_number})`,
              "flatElectricAmount",
            ),
            400,
          );
        }

        electricAmount = chargeFromFlatAmount(entry.flatElectricAmount);
      } else {
        electricUnits = entry.electricCurrent - previousElectric;
        electricRate = room.electric_rate ?? rates.electric;
        electricAmount = chargeFromUnits(electricUnits, electricRate);
      }

      const chargeTotal = entry.charges.reduce(
        (sum, charge) => sum + charge.amount,
        0,
      );
      const total = room.rent + waterAmount + electricAmount + chargeTotal;
      const id = crypto.randomUUID();

      createdIds.push(id);
      statements.push(
        c.env.DB.prepare(insertBillSql).bind(
          id,
          family,
          room.room_id,
          room.tenant_id,
          period,
          room.room_number,
          room.tenant_name,
          room.rent,
          previousWater,
          entry.waterCurrent,
          waterUnits,
          waterRate,
          waterAmount,
          mode,
          previousElectric,
          entry.electricCurrent,
          electricUnits,
          electricRate,
          electricAmount,
          total,
          payee.dormName,
          payee.ownerName,
          payee.promptpayId,
          payee.promptpayType,
          payee.promptpayName,
          payee.bankName,
          payee.bankAccountNumber,
          payee.bankAccountName,
        ),
      );

      entry.charges.forEach((charge, index) => {
        statements.push(
          c.env.DB.prepare(insertChargeSql).bind(
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

    await c.env.DB.batch(statements);

    const createdIdSet = new Set(createdIds);
    const created = (await loadBills(c.env, family, period, period)).filter((bill) =>
      createdIdSet.has(bill.id),
    );

    return c.json({ ok: true, bills: created }, 201);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "generate bills failed",
        period,
        error: detail,
      }),
    );

    if (detail.includes("UNIQUE") && detail.includes("bills")) {
      return c.json(
        errorBody("CONFLICT", `เดือนนี้มีบิลแล้ว: ${period}`, "entries"),
        409,
      );
    }

    return c.json(errorBody("INTERNAL", "สร้างบิลไม่สำเร็จ"), 500);
  }
});

bills.patch("/:id", async (c) => {
  const family = familyId(c);
  const id = c.req.param("id");
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  try {
    const existing = await loadBill(c.env, family, id);

    if (existing === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบบิลที่ต้องการแก้ไข"), 404);
    }

    if (existing.status === "paid") {
      return c.json(errorBody("CONFLICT", "บิลที่จ่ายแล้วแก้ไขไม่ได้"), 409);
    }

    // บิลเดือนถัดไปของห้องนี้เริ่มนับจากเลขที่กำลังจะแก้ ถ้าแก้ให้เกินจุดนั้น
    // หน่วยช่วงเดียวกันจะถูกคิดเงินซ้ำสองรอบ
    const readingChanged =
      body.waterCurrent !== undefined || body.electricCurrent !== undefined;
    const next = readingChanged
      ? await c.env.DB.prepare(nextReadingSql)
          .bind(family, existing.roomId, existing.period)
          .first<{ water_previous: number; electric_previous: number }>()
      : null;

    let waterCurrent = existing.waterCurrent;

    if (body.waterCurrent !== undefined) {
      const parsed = parseReading(body.waterCurrent);

      if (parsed === null) {
        return c.json(
          errorBody(
            "VALIDATION",
            "เลขมิเตอร์น้ำต้องเป็นตัวเลขไม่ติดลบ",
            "waterCurrent",
          ),
          400,
        );
      }

      if (parsed < existing.waterPrevious) {
        return c.json(
          errorBody(
            "VALIDATION",
            `เลขมิเตอร์น้ำต้องไม่น้อยกว่าครั้งก่อน (ห้อง ${existing.roomNumber})`,
            "waterCurrent",
          ),
          400,
        );
      }

      if (next !== null && parsed > next.water_previous) {
        return c.json(
          errorBody(
            "VALIDATION",
            `เลขมิเตอร์น้ำต้องไม่เกิน ${next.water_previous} เพราะบิลเดือนถัดไปเริ่มนับจากเลขนี้แล้ว (ห้อง ${existing.roomNumber})`,
            "waterCurrent",
          ),
          400,
        );
      }

      waterCurrent = parsed;
    }

    let electricCurrent = existing.electricCurrent;

    if (body.electricCurrent !== undefined) {
      const parsed = parseReading(body.electricCurrent);

      if (parsed === null) {
        return c.json(
          errorBody(
            "VALIDATION",
            "เลขมิเตอร์ไฟต้องเป็นตัวเลขไม่ติดลบ",
            "electricCurrent",
          ),
          400,
        );
      }

      if (parsed < existing.electricPrevious) {
        return c.json(
          errorBody(
            "VALIDATION",
            `เลขมิเตอร์ไฟต้องไม่น้อยกว่าครั้งก่อน (ห้อง ${existing.roomNumber})`,
            "electricCurrent",
          ),
          400,
        );
      }

      if (next !== null && parsed > next.electric_previous) {
        return c.json(
          errorBody(
            "VALIDATION",
            `เลขมิเตอร์ไฟต้องไม่เกิน ${next.electric_previous} เพราะบิลเดือนถัดไปเริ่มนับจากเลขนี้แล้ว (ห้อง ${existing.roomNumber})`,
            "electricCurrent",
          ),
          400,
        );
      }

      electricCurrent = parsed;
    }

    let charges = existing.charges;
    let chargesProvided = false;

    if (body.charges !== undefined) {
      const parsed = parseCharges(body.charges);

      if (parsed === null) {
        return c.json(
          errorBody(
            "VALIDATION",
            "ค่าใช้จ่ายเพิ่มเติมต้องมีชื่อและจำนวนเงินเป็นจำนวนเต็มไม่ติดลบ",
            "charges",
          ),
          400,
        );
      }

      charges = parsed;
      chargesProvided = true;
    }

    let electricUnits = existing.electricUnits;
    let electricRate = existing.electricRate;
    let electricAmount = existing.electricAmount;

    if (existing.electricMode === "flat") {
      const rawFlat = body.flatElectricAmount;

      if (rawFlat === undefined) {
        return c.json(
          errorBody(
            "VALIDATION",
            `กรุณากรอกยอดค่าไฟเหมาจ่าย (ห้อง ${existing.roomNumber})`,
            "flatElectricAmount",
          ),
          400,
        );
      }

      if (
        typeof rawFlat !== "number" ||
        !Number.isFinite(rawFlat) ||
        rawFlat < 0
      ) {
        return c.json(
          errorBody(
            "VALIDATION",
            "ยอดค่าไฟเหมาจ่ายต้องเป็นตัวเลขไม่ติดลบ",
            "flatElectricAmount",
          ),
          400,
        );
      }

      electricUnits = null;
      electricRate = null;
      electricAmount = chargeFromFlatAmount(rawFlat);
    } else {
      if (body.flatElectricAmount !== undefined) {
        return c.json(
          errorBody(
            "VALIDATION",
            "บิลห้องมิเตอร์ไม่ใช้ยอดค่าไฟเหมาจ่าย",
            "flatElectricAmount",
          ),
          400,
        );
      }

      if (body.electricCurrent !== undefined) {
        const units = electricCurrent - existing.electricPrevious;
        electricUnits = units;
        electricRate = existing.electricRate;
        electricAmount = chargeFromUnits(units, existing.electricRate ?? 0);
      }
    }

    const waterUnits = waterCurrent - existing.waterPrevious;
    const waterAmount = chargeFromUnits(waterUnits, existing.waterRate);
    const chargeTotal = charges.reduce((sum, charge) => sum + charge.amount, 0);
    const total = existing.rent + waterAmount + electricAmount + chargeTotal;

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(updateBillSql).bind(
        waterCurrent,
        waterUnits,
        waterAmount,
        electricCurrent,
        electricUnits,
        electricRate,
        electricAmount,
        total,
        id,
        family,
      ),
    ];

    if (chargesProvided) {
      statements.push(c.env.DB.prepare(deleteChargesSql).bind(id, family));

      charges.forEach((charge, index) => {
        statements.push(
          c.env.DB.prepare(insertChargeSql).bind(
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

    await c.env.DB.batch(statements);

    const bill = await loadBill(c.env, family, id);

    if (bill === null) {
      console.error(
        JSON.stringify({ message: "update bill readback failed", billId: id }),
      );
      return c.json(errorBody("INTERNAL", "บันทึกบิลไม่สำเร็จ"), 500);
    }

    return c.json({ ok: true, bill }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "update bill failed",
        billId: id,
        error: detail,
      }),
    );
    return c.json(errorBody("INTERNAL", "บันทึกบิลไม่สำเร็จ"), 500);
  }
});

bills.delete("/:id", async (c) => {
  const family = familyId(c);
  const id = c.req.param("id");

  try {
    const existing = await loadBill(c.env, family, id);

    if (existing === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบบิลที่ต้องการลบ"), 404);
    }

    if (existing.status === "paid") {
      return c.json(errorBody("CONFLICT", "บิลที่จ่ายแล้วลบไม่ได้"), 409);
    }

    await c.env.DB.batch([
      c.env.DB.prepare(deleteChargesSql).bind(id, family),
      c.env.DB.prepare(deleteBillSql).bind(id, family),
    ]);

    return c.json({ ok: true }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    /**
     * บิลที่มีสลิปอ้างถึงลบไม่ได้ — foreign key ไม่ให้ลบ และนั่นถูกต้องแล้ว
     * เพราะสลิปต้องอ้างถึงใบที่มันเทียบไว้เพื่อให้ย้อนตรวจได้
     *
     * เดิมตอบ 500 "ลบบิลไม่สำเร็จ" ซึ่งผู้ใช้อ่านแล้วไม่รู้ว่าต้องทำอะไร
     * ทั้งที่ทางออกมีอยู่: ตัดสินสลิปให้จบก่อน หรือปิดบิลด้วยมือ
     */
    if (isForeignKeyViolation(error)) {
      console.log(
        JSON.stringify({ message: "delete bill blocked by a slip", billId: id }),
      );
      return c.json(
        errorBody(
          "CONFLICT",
          "บิลนี้มีสลิปอ้างถึงอยู่ ลบไม่ได้ — ตรวจสลิปในคิวรอตรวจให้จบก่อน แล้วค่อยลบ",
        ),
        409,
      );
    }

    console.error(
      JSON.stringify({
        message: "delete bill failed",
        billId: id,
        error: detail,
      }),
    );
    return c.json(errorBody("INTERNAL", "ลบบิลไม่สำเร็จ"), 500);
  }
});

bills.post("/:id/mark-paid", async (c) => {
  const family = familyId(c);
  const id = c.req.param("id");
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  try {
    const existing = await loadBill(c.env, family, id);

    if (existing === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบบิลที่ต้องการปิด"), 404);
    }

    if (existing.status === "paid") {
      return c.json(errorBody("CONFLICT", "บิลนี้ปิดไปแล้ว"), 409);
    }

    const method = body.method;

    if (method !== "transfer" && method !== "cash") {
      return c.json(
        errorBody(
          "VALIDATION",
          "ช่องทางชำระต้องเป็น transfer หรือ cash",
          "method",
        ),
        400,
      );
    }

    let paidAt: string;

    if (body.paidAt === undefined) {
      paidAt = new Date().toISOString();
    } else {
      const parsed = parsePaidAt(body.paidAt);

      if (parsed === null) {
        return c.json(
          errorBody("VALIDATION", "วันเวลาที่ชำระไม่ถูกต้อง", "paidAt"),
          400,
        );
      }

      paidAt = parsed;
    }

    // เงื่อนไข status อยู่ใน UPDATE เอง ไม่ใช่แค่เช็คใน JS ก่อนหน้า
    // คำขอที่กดซ้ำพร้อมกันจะเปลี่ยนได้แค่คำขอเดียว อีกคำขอได้ CONFLICT
    const result = await c.env.DB.prepare(
      "UPDATE bills SET status = 'paid', paid_at = ?, paid_method = ? WHERE id = ? AND family_id = ? AND status = 'unpaid'",
    )
      .bind(paidAt, method, id, family)
      .run();

    if (result.meta.changes === 0) {
      return c.json(errorBody("CONFLICT", "บิลนี้ปิดไปแล้ว"), 409);
    }

    const bill = await loadBill(c.env, family, id);

    if (bill === null) {
      console.error(
        JSON.stringify({
          message: "mark bill paid readback failed",
          billId: id,
        }),
      );
      return c.json(errorBody("INTERNAL", "ปิดบิลไม่สำเร็จ"), 500);
    }

    const event: BillPaidEvent = {
      billId: bill.id,
      roomNumber: bill.roomNumber,
      tenantName: bill.tenantName,
      period: bill.period,
      total: bill.total,
      method,
      source: "mark-paid",
      paidAt,
      slipImageKey: null,
    };

    // ค่าที่เจ้าของกรอกในหน้าตั้งค่าชนะ env — การแจ้งเตือนผู้เช่า/เจ้าของใช้ token
    // ตัวเดียวกับที่ส่งบิล จึงต้องมาจากที่เดียวกัน
    const env = await integrationEnv(c.env, family);

    // แท็บที่กดปิดเองไม่ต้องรับ event กลับ (มี toast ของหน้าไปแล้ว) จึงส่ง
    // connectionId ของตัวเองไปให้ DO ข้าม
    await broadcastBillPaid(env, family, event, c.req.header("x-realtime-id") ?? null, c.get("session").userId);
    c.executionCtx.waitUntil(pushOwnerBillPaid(env, family, publicBaseUrl(c.req.url), event));

    return c.json({ ok: true, bill }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "mark bill paid failed",
        billId: id,
        error: detail,
      }),
    );
    return c.json(errorBody("INTERNAL", "ปิดบิลไม่สำเร็จ"), 500);
  }
});

bills.post("/send-all", async (c) => {
  const family = familyId(c);
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const period = body.period;

  if (!isPeriod(period)) {
    return c.json(
      errorBody("VALIDATION", "เดือนต้องอยู่ในรูปแบบ YYYY-MM", "period"),
      400,
    );
  }

  try {
    const list = await loadBills(c.env, family, period, period);

    if (list.length === 0) {
      return c.json(
        errorBody(
          "VALIDATION",
          `ยังไม่มีบิลของเดือน ${thaiPeriodLabel(period)}`,
          "period",
        ),
        400,
      );
    }

    let targets = list;
    const rawBillIds = body.billIds;

    if (rawBillIds !== undefined) {
      if (
        !Array.isArray(rawBillIds) ||
        rawBillIds.some((value) => typeof value !== "string")
      ) {
        return c.json(
          errorBody("VALIDATION", "รายการบิลที่จะส่งไม่ถูกต้อง", "billIds"),
          400,
        );
      }

      const requested = rawBillIds as string[];
      const unknown = requested.filter(
        (billId) => !list.some((bill) => bill.id === billId),
      );

      if (unknown.length > 0) {
        return c.json(
          errorBody(
            "VALIDATION",
            `ไม่พบบิลของเดือนนี้ในรายการ: ${unknown.join(", ")}`,
            "billIds",
          ),
          400,
        );
      }

      const selected = new Set(requested);
      targets = list.filter((bill) => selected.has(bill.id));
    }

    const alreadyPaid = targets.filter((bill) => bill.status === "paid");
    targets = targets.filter((bill) => bill.status !== "paid");

    // ค่าที่เจ้าของกรอกในหน้าตั้งค่าชนะ env — การเช็ค "ตั้งค่าแล้วหรือยัง" กับการ push
    // ต้องใช้ env ตัวเดียวกัน ไม่งั้นหอที่ตั้งค่าในหน้าจอจะยังโดน 503 ว่าไม่ได้ตั้งค่า
    const env = await integrationEnv(c.env, family);

    if (demoModeOn(env)) {
      return c.json(
        errorBody("UPSTREAM", "การส่งบิลทาง LINE ปิดอยู่ในโหมดสาธิต"),
        503,
      );
    }

    if (!lineChannelConfigured(env)) {
      console.error(
        JSON.stringify({
          message: "send all bills failed",
          period,
          reason: "line channel is not configured",
        }),
      );
      return c.json(
        errorBody("UPSTREAM", "ช่องทาง LINE ของหอยังไม่ได้ตั้งค่า"),
        503,
      );
    }

    const baseUrl = publicBaseUrl(c.req.url);
    const payees = await loadBillPayees(c.env, family, targets.map((bill) => bill.id));
    const links = await loadLinkedTenants(c.env, family);

    let sent = 0;
    let failed = 0;
    const failedRooms: string[] = [];
    const failedIds: string[] = [];
    const skipped: SkippedBill[] = [];
    const sentIds: string[] = [];

    for (const bill of targets) {
      const lineUserId = links.get(bill.tenantId);

      if (lineUserId === undefined) {
        skipped.push({
          roomNumber: bill.roomNumber,
          tenantName: bill.tenantName,
        });
        continue;
      }

      const delivered = await pushMessage(env, lineUserId, [
        buildBillFlexMessage(bill, payees.get(bill.id) ?? emptyPayee, baseUrl),
      ]);

      if (delivered === null) {
        failed += 1;
        failedRooms.push(bill.roomNumber);
        failedIds.push(bill.id);
        continue;
      }

      sent += 1;
      sentIds.push(bill.id);
    }

    if (sentIds.length > 0) {
      const sentAt = new Date().toISOString();
      await c.env.DB.batch(
        sentIds.map((billId) =>
          c.env.DB.prepare(
            "UPDATE bills SET sent_at = ? WHERE id = ? AND family_id = ?",
          ).bind(sentAt, billId, family),
        ),
      );
    }

    const total = targets.reduce((sum, bill) => sum + bill.total, 0);

    await sendOwnerSummary(env, family, {
      period,
      count: targets.length,
      total,
      sent,
      failed,
      failedRooms,
      skipped,
    });

    return c.json(
      {
        ok: true,
        period,
        sent,
        failed,
        failedIds,
        skipped,
        alreadyPaid: alreadyPaid.map((bill) => ({
          roomNumber: bill.roomNumber,
          tenantName: bill.tenantName,
        })),
        alreadyPaidIds: alreadyPaid.map((bill) => bill.id),
      },
      200,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "send all bills failed",
        period,
        error: detail,
      }),
    );
    return c.json(errorBody("INTERNAL", "ส่งบิลทาง LINE ไม่สำเร็จ"), 500);
  }
});

bills.post("/:id/send", async (c) => {
  const family = familyId(c);
  const id = c.req.param("id");

  try {
    const bill = await loadBill(c.env, family, id);

    if (bill === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบบิลที่ต้องการส่ง"), 404);
    }

    if (bill.status === "paid") {
      return c.json(
        errorBody("CONFLICT", "บิลที่จ่ายแล้วส่งเป็นใบแจ้งหนี้ไม่ได้"),
        409,
      );
    }

    // ค่าที่เจ้าของกรอกในหน้าตั้งค่าชนะ env — เช็ค "ตั้งค่าแล้วหรือยัง" กับ push
    // ต้องใช้ env ตัวเดียวกัน (ดูเหตุผลเดียวกับ send-all)
    const env = await integrationEnv(c.env, family);

    if (demoModeOn(env)) {
      return c.json(
        errorBody("UPSTREAM", "การส่งบิลทาง LINE ปิดอยู่ในโหมดสาธิต"),
        503,
      );
    }

    if (!lineChannelConfigured(env)) {
      console.error(
        JSON.stringify({
          message: "send bill failed",
          billId: id,
          reason: "line channel is not configured",
        }),
      );
      return c.json(
        errorBody("UPSTREAM", "ช่องทาง LINE ของหอยังไม่ได้ตั้งค่า"),
        503,
      );
    }

    const link = await c.env.DB.prepare(
      "SELECT line_user_id FROM tenants WHERE family_id = ? AND id = ?",
    )
      .bind(family, bill.tenantId)
      .first<{ line_user_id: string | null }>();
    const lineUserId = link?.line_user_id ?? null;

    if (lineUserId === null || lineUserId === "") {
      return c.json(
        errorBody("CONFLICT", "ผู้เช่ารายนี้ยังไม่เชื่อม LINE ส่งบิลไม่ได้"),
        409,
      );
    }

    const baseUrl = publicBaseUrl(c.req.url);
    const payee = await loadBillPayee(c.env, family, id);
    const delivered = await pushMessage(env, lineUserId, [
      buildBillFlexMessage(bill, payee ?? emptyPayee, baseUrl),
    ]);

    if (delivered === null) {
      console.error(
        JSON.stringify({
          message: "send bill failed",
          billId: id,
          reason: "line push failed",
        }),
      );
      return c.json(errorBody("UPSTREAM", "ส่งบิลทาง LINE ไม่สำเร็จ"), 502);
    }

    await c.env.DB.prepare(
      "UPDATE bills SET sent_at = ? WHERE id = ? AND family_id = ?",
    )
      .bind(new Date().toISOString(), id, family)
      .run();

    const updated = await loadBill(c.env, family, id);

    if (updated === null) {
      console.error(
        JSON.stringify({ message: "send bill readback failed", billId: id }),
      );
      return c.json(
        errorBody("INTERNAL", "บันทึกสถานะการส่งบิลไม่สำเร็จ"),
        500,
      );
    }

    return c.json({ ok: true, bill: updated }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "send bill failed",
        billId: id,
        error: detail,
      }),
    );
    return c.json(errorBody("INTERNAL", "ส่งบิลไม่สำเร็จ"), 500);
  }
});

export default bills;
