import { Hono } from "hono";
import type { AppEnv } from "../lib/auth";
import { familyId, requireRole } from "../lib/auth";
import {
  defaultElectricRate,
  defaultWaterRate,
  loadEffectiveRates,
  recalcRoomsUsingDormDefaults,
} from "../lib/bill-rates";
import {
  credentialError,
  credentialStatusFrom,
  credentialsStatus,
  integrationEnv,
  isCredentialName,
  saveCredentials,
  type CredentialName,
  type CredentialsStatus,
} from "../lib/credentials";
import { payeeSettingKeys, recalcUnpaidBillsPayee } from "../lib/bill-payee";
import {
  loadDormCharges,
  maxDormCharges,
  parseChargeList,
  replaceDormCharges,
} from "../lib/charges";
import { errorBody, readJsonObject, sharedElectricRoomIdsKey, upsertSettingSql } from "./shared";
import { demoModeOn, failureDetail, fetchBotInfo, fetchProfile, lineOutboundTimeoutMs, logLineFailure } from "../line/api";

const settings = new Hono<AppEnv>();

type PromptpayType = "phone" | "citizen-id";

const defaultSettings = {
  dorm_name: "หอพักวังจันทร์",
  owner_name: "สมศักดิ์ ใจดี",
  owner_phone: "",
  /**
   * LINE **ส่วนตัว** ของเจ้าของหอ (ไม่ใช่ OA ของหอ) — คนละค่ากับ `owner_line_user_id`
   *
   * สองค่านี้ต่างกันคนละเรื่อง:
   * - `owner_line_user_id` = userId ของเจ้าของ **ใน OA ของหอ** ที่บอทใช้ push หา
   * - `owner_line_id` = ชื่อที่ผู้เช่าค้นหาเพื่อ **เพิ่มเพื่อนเจ้าของเป็นการส่วนตัว**
   *
   * OA ของหอ (เช่น `@490secnd`) ต้องไม่ถูกใส่ในช่องนี้เด็ดขาด เพราะผู้เช่าที่อ่าน
   * การ์ดนี้กำลังคุยอยู่ในแชทนั้นอยู่แล้ว การส่ง id ของ OA กลับไปจึงไม่มีประโยชน์
   * และทำให้ผู้เช่าเข้าใจผิดว่ากดเพิ่มเพื่อนเจ้าของแล้ว
   */
  owner_line_id: "",
  default_water_rate: String(defaultWaterRate),
  default_electric_rate: String(defaultElectricRate),
  promptpay_type: "phone",
  // ค่าเริ่มต้นของช่องทางรับเงินต้องว่าง เพื่อให้ "ยังไม่ได้ตั้งค่า" แทนได้จริง
  // และตรงกับที่เส้นทางใบแจ้งหนี้อ่าน (อ่านจากฐานข้อมูลเท่านั้น ไม่ใส่ค่าแทน)
  promptpay_id: "",
  promptpay_name: "",
  bank_name: "",
  bank_account_number: "",
  bank_account_name: "",
} as const;

/** คีย์ที่บอกว่าหอนี้รับเงินทางไหนได้บ้าง — bank_name ต้องมาคู่ bank_account_number เสมอ */
const payoutKeys = ["promptpay_id", "bank_name", "bank_account_number"] as const;

/** รหัสเชื่อม LINE ของเจ้าของ: หมดอายุใน 15 นาที และใช้ได้ครั้งเดียว */
const ownerCodeKey = "owner_link_code";
const ownerCodeExpiresKey = "owner_link_code_expires_at";
const ownerCodeTtlMs = 15 * 60 * 1000;

const noPayoutMessage =
  "ต้องมีพร้อมเพย์ หรือทั้งชื่อธนาคารและเลขบัญชีธนาคารคู่กันอย่างน้อยหนึ่งช่องทาง เพื่อให้ผู้เช่ารู้ว่าจะโอนไปที่ไหน";

/**
 * กันไม่ให้คำขอเดียวลบวิธีรับเงินทางสุดท้ายออกไป
 *
 * ต้องเช็คในทรานแซกชันเดียวกับการเขียน เพราะอ่านก่อนแล้วค่อยเขียนเปิดช่องให้
 * PUT สองคำขอที่มาพร้อมกันผ่านการตรวจทั้งคู่ แล้วหอเหลือศูนย์วิธีรับเงิน
 * (ใบแจ้งหนี้ทุกใบจะไม่มีคิวอาร์ให้โอน) แถวนี้จะถูก INSERT ก็ต่อเมื่อตอนนั้น
 * ไม่เหลือวิธีรับเงินแล้ว และค่า NULL จะชน NOT NULL ของ settings.value
 * ทำให้ทั้ง batch ถูกยกเลิกไปพร้อมกัน
 *
 * บัญชีธนาคารนับว่า "ใช้ได้" เฉพาะเมื่อมีทั้งชื่อธนาคารและเลขบัญชีครบคู่
 * เลขบัญชีอย่างเดียวโดยไม่รู้ธนาคารทำให้ผู้เช่าโอนเงินไม่ได้จริง
 */
const payoutGuardSql = `INSERT INTO settings (family_id, key, value, updated_at) SELECT ?, 'payout_guard', NULL, datetime('now') WHERE NOT EXISTS (SELECT 1 FROM settings WHERE family_id = ? AND key = 'promptpay_id' AND trim(value) <> '') AND NOT (EXISTS (SELECT 1 FROM settings WHERE family_id = ? AND key = 'bank_name' AND trim(value) <> '') AND EXISTS (SELECT 1 FROM settings WHERE family_id = ? AND key = 'bank_account_number' AND trim(value) <> ''))`;


type SettingsKey = keyof typeof defaultSettings;

const writableKeys = [
  "dormName",
  "ownerName",
  "ownerPhone",
  "ownerLineId",
  "defaultWaterRate",
  "defaultElectricRate",
  "promptpayType",
  "promptpayId",
  "promptpayName",
  "bankName",
  "bankAccountNumber",
  "bankAccountName",
] as const;

type WritableKey = (typeof writableKeys)[number];

const fieldToKey: Record<WritableKey, SettingsKey> = {
  dormName: "dorm_name",
  ownerName: "owner_name",
  ownerPhone: "owner_phone",
  ownerLineId: "owner_line_id",
  defaultWaterRate: "default_water_rate",
  defaultElectricRate: "default_electric_rate",
  promptpayType: "promptpay_type",
  promptpayId: "promptpay_id",
  promptpayName: "promptpay_name",
  bankName: "bank_name",
  bankAccountNumber: "bank_account_number",
  bankAccountName: "bank_account_name",
};

const textMessages: Record<"dormName" | "ownerName", string> = {
  dormName: "กรุณากรอกชื่อหอ",
  ownerName: "กรุณากรอกชื่อเจ้าของ",
};

const rateMessages: Record<"defaultWaterRate" | "defaultElectricRate", string> =
  {
    defaultWaterRate: "อัตราค่าน้ำต้องเป็นตัวเลขมากกว่า 0",
    defaultElectricRate: "อัตราค่าไฟต้องเป็นตัวเลขมากกว่า 0",
  };

interface SettingsPayload {
  dormName: string;
  ownerName: string;
  ownerPhone: string;
  /** LINE ID ที่ผู้เช่าค้นหาเจ้าของหอได้ (คนละค่ากับ userId ที่บอทใช้ push) */
  ownerLineId: string;
  defaultWaterRate: number;
  defaultElectricRate: number;
  promptpayType: PromptpayType;
  promptpayId: string;
  promptpayName: string;
  bankName: string;
  bankAccountNumber: string;
  bankAccountName: string;
  ownerLinkCode: string;
  ownerLineConnected: boolean;
  /** ห้องที่ใช้บิลการไฟฟ้ารวมครั้งล่าสุด (ตั้งผ่าน POST /api/rooms/shared-electric) */
  sharedElectricRoomIds: string[];
  /** ชื่อที่แสดงของบัญชี LINE ที่ผูกอยู่ — null เมื่อยังไม่ผูก, "" เมื่อผูกแล้วแต่ไม่รู้ชื่อ */
  ownerLineDisplayName: string | null;
  /** OA ของหอ (ชื่อที่แสดง + basic id ที่ค้นหาได้) — null เมื่อดึงไม่ได้ */
  lineBot: { displayName: string; basicId: string } | null;
  integrations: { lineConfigured: boolean; slipOkConfigured: boolean };
  /** สถานะค่าที่เจ้าของกรอกเอง — ความลับไม่ถูกส่งค่าจริงกลับมา (ดู lib/credentials) */
  credentials: CredentialsStatus;
}

function isWritableKey(key: string): key is WritableKey {
  return (writableKeys as readonly string[]).includes(key);
}

function isConfigured(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function toNumber(key: SettingsKey, value: string, fallback: number): number {
  const parsed = Number(value);

  if (Number.isFinite(parsed)) {
    return parsed;
  }

  console.error(
    JSON.stringify({ message: "invalid stored setting", key, value }),
  );
  return fallback;
}

function generateOwnerCode(): string {
  const digits = new Uint32Array(1);
  let code = "000000";

  while (code === "000000") {
    crypto.getRandomValues(digits);
    code = String((digits[0] ?? 0) % 1000000).padStart(6, "0");
  }

  return code;
}

function promptpayIdError(id: string, type: PromptpayType): string | null {
  const digits = id.replace(/\D/g, "");

  if (type === "phone") {
    return digits.length === 9 || digits.length === 10
      ? null
      : "พร้อมเพย์ไอดีประเภทเบอร์โทรต้องเป็นเบอร์ 9 หรือ 10 หลัก";
  }

  return digits.length === 13
    ? null
    : "พร้อมเพย์ไอดีประเภทเลขบัตรต้องเป็นเลข 13 หลัก";
}

function normalizeOwnerPhone(value: string): string {
  return value.replace(/[\s-]/g, "");
}

function ownerPhoneError(value: string): string | null {
  return /^0\d{9}$/.test(normalizeOwnerPhone(value))
    ? null
    : "เบอร์โทรเจ้าของต้องเป็นเบอร์ 10 หลัก เริ่มด้วย 0";
}

/**
 * LINE ID ของเจ้าของ — "@" นำหน้าได้ แต่ต้องไม่มีช่องว่างหรืออักขระตกแต่ง
 *
 * LINE รับ basic id เป็น "@" ตามด้วย 4–30 ตัวอักษร (a–z 0–9 . _ -) และผู้ใช้
 * มักคัดลอกมาพร้อมช่องว่าง/เครื่องหมายคำพูด จึงตัดให้ก่อนตรวจ ตัว "@" เก็บไว้
 * เพราะเป็นส่วนหนึ่งของชื่อที่ใช้ค้นหาในแอป LINE
 */
function normalizeOwnerLineId(value: string): string {
  return value.trim().replace(/^["'“”]|["'“”]$/g, "").replace(/\s+/g, "");
}

/**
 * OA ของหอเอง — ต้องไม่ถูกกรอกเป็น LINE ส่วนตัวของเจ้าของ
 *
 * ผู้เช่าที่อ่านการ์ด "ติดต่อเจ้าของหอ" กำลังคุยอยู่ในแชทของ OA นี้อยู่แล้ว
 * การส่ง id กลับไปจึงชี้ไปบัญชีที่เขาใช้งานอยู่ ไม่ใช่ช่องทางใหม่ และทำให้เข้าใจ
 * ผิดว่ากดเพิ่มเพื่อนเจ้าของแล้ว
 *
 * ค่าที่ใช้เทียบมาจาก LINE เอง (`loadBotInfo`) ไม่ใช่ค่าคงที่ในโค้ด — เปลี่ยน OA
 * แล้วด่านนี้ตามไปเอง จึงไม่มีทางค้างชี้ OA ตัวเก่าเหมือนที่เคยเป็น
 *
 * ดึง LINE ไม่ได้ (ไม่มี token, เครือข่ายล่ม, โหมดสาธิต) = ไม่บล็อก (fail-open)
 * เพราะด่านนี้กันความเข้าใจผิด ไม่ได้กันความเสียหาย — การปิดกั้นการบันทึกค่า
 * ทั้งหมดเพียงเพราะตรวจ OA ไม่ได้ จะทำให้เจ้าของหอตั้งค่าอื่นไม่ได้ไปด้วย
 */
function ownerLineIdError(value: string, dormBasicId: string): string | null {
  const normalized = normalizeOwnerLineId(value);
  const body = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  const bare = (id: string): string => id.trim().replace(/^@/, "").toLowerCase();
  const dorm = bare(dormBasicId);

  if (dorm !== "" && dorm === bare(normalized)) {
    return "นี่คือ LINE ของ OA หอ ไม่ใช่ LINE ส่วนตัวของคุณ — ผู้เช่าที่อ่านข้อความนี้คุยกับ OA หออยู่แล้ว กรุณาใส่ LINE ส่วนตัว (หรือเว้นว่างไว้)";
  }

  if (!/^[A-Za-z0-9._-]{4,30}$/.test(body)) {
    return "LINE ID ต้องเป็นตัวอักษรอังกฤษ ตัวเลข จุด ขีด หรือ _ ยาว 4–30 ตัว (ใส่ @ นำหน้าได้)";
  }

  return null;
}

/** เลขบัญชีธนาคารไทย 10–15 หลัก — เก็บเฉพาะตัวเลข ไม่เก็บขีดคั่น */
function normalizeAccountNumber(value: string): string {
  return value.replace(/\D/g, "");
}

function accountNumberError(value: string): string | null {
  const digits = normalizeAccountNumber(value);

  if (digits.length < 10 || digits.length > 15) {
    return "เลขบัญชีต้องเป็นตัวเลข 10–15 หลัก";
  }

  return null;
}

/**
 * ชื่อที่แสดงของบัญชี LINE ที่ผูกเป็นเจ้าของอยู่ — null เมื่อยังไม่ผูก
 *
 * ลำดับความน่าเชื่อถือ: `line_pending` (ชื่อที่ได้ตอนบอทเห็นข้อความล่าสุด ซึ่ง
 * สดกว่า) → LINE profile API (เรียกเมื่อยังไม่มีชื่อในเครื่อง) · ไม่มีชื่อก็ยัง
 * คืนสตริงว่างเพื่อให้หน้าจอรู้ว่า "ผูกแล้วแต่ไม่มีชื่อ" ไม่ใช่ "ยังไม่ผูก"
 */
async function ownerLineDisplayName(env: Env, family: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE family_id = ? AND key = 'owner_line_user_id'",
  )
    .bind(family)
    .first<{ value: string }>();
  const ownerId = (row?.value ?? "").trim();

  if (ownerId === "") {
    return null;
  }

  const pending = await env.DB.prepare(
    "SELECT display_name FROM line_pending WHERE family_id = ? AND line_user_id = ?",
  )
    .bind(family, ownerId)
    .first<{ display_name: string | null }>();

  if (pending !== null && (pending.display_name ?? "") !== "") {
    return pending.display_name ?? "";
  }

  const profile = await fetchProfile(env, ownerId);

  return profile === null ? "" : profile.displayName;
}

/**
 * webhook ที่ LINE ตั้งไว้สำหรับช่องนี้ — ใช้ยืนยันว่าข้อความจะมาถึง Worker นี้
 *
 * เคสจริงที่ทำให้เจ้าของงงว่า "พิมพ์รหัสแล้วไม่มีอะไรเกิดขึ้น": LINE ชี้
 * webhook ไปที่ Worker อีกตัว (production) ขณะที่รหัสที่เห็นอยู่บนเครื่อง dev
 * ข้อความจึงไปผิดที่โดยไม่มีสัญญาณเตือนใด ๆ ในหน้าจอ
 */
async function fetchWebhookEndpoint(
  env: Env,
): Promise<{ endpoint: string; active: boolean } | null> {
  const token = typeof env.LINE_CHANNEL_ACCESS_TOKEN === "string" ? env.LINE_CHANNEL_ACCESS_TOKEN.trim() : "";

  if (token === "" || demoModeOn(env)) {
    return null;
  }

  try {
    const response = await fetch("https://api.line.me/v2/bot/channel/webhook/endpoint", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(lineOutboundTimeoutMs),
    });

    if (!response.ok) {
      logLineFailure("line webhook endpoint failed", `status ${String(response.status)}`);
      return null;
    }

    const body = await response.json<{ endpoint?: string; active?: boolean }>();

    return {
      endpoint: typeof body.endpoint === "string" ? body.endpoint : "",
      active: body.active === true,
    };
  } catch (error) {
    logLineFailure("line webhook endpoint failed", failureDetail(error));
    return null;
  }
}

function ownerCodeExpiry(): string {
  return new Date(Date.now() + ownerCodeTtlMs).toISOString();
}

/** meta เก็บ JSON พร้อมเวลาที่ดึงมา — อ่านพัง/ไม่มีให้ถือว่ายังไม่เคยดึง */
interface BotInfoCache {
  displayName: string;
  basicId: string;
  fetchedAt: number;
}

const botInfoMetaKey = "line_bot_info";
/** อายุ cache ของข้อมูล OA — ตั้งชื่อบอทใหม่ไม่บ่อย จึงไม่ต้องยิง LINE ทุกครั้ง */
const botInfoTtlMs = 6 * 60 * 60 * 1000;

function parseBotInfoCache(value: string): BotInfoCache | null {
  try {
    const raw: unknown = JSON.parse(value);

    if (typeof raw !== "object" || raw === null) {
      return null;
    }

    const record = raw as Record<string, unknown>;

    if (typeof record.displayName !== "string" || typeof record.basicId !== "string" || typeof record.fetchedAt !== "number") {
      return null;
    }

    return { displayName: record.displayName, basicId: record.basicId, fetchedAt: record.fetchedAt };
  } catch {
    return null;
  }
}

/**
 * ข้อมูล OA ของหอสำหรับแสดงในหน้าตั้งค่า — cache ไว้ใน `meta` ไม่ผูกกับครอบครัว
 *
 * เรียก LINE เฉพาะเมื่อ cache หมดอายุหรือยังไม่มี ไม่งั้นทุกครั้งที่เปิดหน้าตั้งค่า
 * จะเป็นการรอเครือข่ายไปหา LINE ซึ่งช้าและพึ่งบริการภายนอกโดยไม่จำเป็น —
 * ค่าที่ดึงไม่ได้จะไม่ถูก cache เพื่อให้ลองใหม่ครั้งหน้า (ชื่อบอทเพิ่งตั้งเสร็จ
 * จึงยังไม่ปรากฏทันทีในรอบแรก)
 */
async function loadBotInfo(env: Env): Promise<{ displayName: string; basicId: string } | null> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?")
    .bind(botInfoMetaKey)
    .first<{ value: string }>();
  const cached = row === null ? null : parseBotInfoCache(row.value);

  if (cached !== null && Date.now() - cached.fetchedAt < botInfoTtlMs) {
    return { displayName: cached.displayName, basicId: cached.basicId };
  }

  const fresh = await fetchBotInfo(env);

  if (fresh === null) {
    // ดึงไม่ได้: ถ้ามีของเก่าอยู่ก็ยังใช้ต่อ ดีกว่าไม่แสดงอะไรเลย
    return cached === null ? null : { displayName: cached.displayName, basicId: cached.basicId };
  }

  const payload: BotInfoCache = {
    displayName: fresh.displayName,
    basicId: fresh.basicId,
    fetchedAt: Date.now(),
  };

  try {
    await env.DB.prepare(
      "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind(botInfoMetaKey, JSON.stringify(payload))
      .run();
  } catch (error) {
    // cache ไม่ได้ไม่ใช่เหตุให้หน้าล้ม — ค่าที่ดึงมาใช้ตอบรอบนี้ได้อยู่
    console.error(
      JSON.stringify({
        message: "cache line bot info failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return { displayName: fresh.displayName, basicId: fresh.basicId };
}

/** รหัสที่ยังใช้ได้เท่านั้น — รหัสที่หมดอายุหรือถูกใช้ไปแล้วอ่านกลับมาไม่ได้ */
function ownerCodeFrom(stored: Map<string, string>): string {
  const code = stored.get(ownerCodeKey) ?? "";
  const expires = Date.parse(stored.get(ownerCodeExpiresKey) ?? "");

  if (code !== "" && Number.isFinite(expires) && expires > Date.now()) {
    return code;
  }

  return "";
}

/**
 * ออกรหัสให้ครอบครัวที่ยังไม่มีรหัสที่ใช้ได้ หรือรหัสเดิมหมดอายุไปแล้ว
 *
 * เขียนแบบมีเงื่อนไขในคำสั่งเดียว (ไม่ใช่ ON CONFLICT DO NOTHING เฉย ๆ) เพราะ
 * ถ้ารหัสเดิมมีแถวอยู่แล้วแต่หมดอายุ DO NOTHING จะข้ามไปเฉย ๆ แล้วอ่านรหัส
 * เก่าที่หมดอายุกลับมาเสิร์ฟซ้ำตลอดไป ไม่มีทางได้รหัสใหม่จาก GET อีกเลย
 * เงื่อนไขคือ "แทนที่ได้ก็ต่อเมื่อยังไม่มีรหัสที่ใช้ได้จริงตอนนี้" ประเมินจาก
 * แถวเดิมก่อนเขียนเสมอ (มาตรฐาน SQL UPDATE/UPSERT ... WHERE) ทั้งสองคำสั่ง
 * (code, expiry) ใช้เงื่อนไขเดียวกันที่อ้างอิงแถว expiry เดิม จึงลง/ไม่ลงพร้อมกัน
 */
async function ensureOwnerCode(db: D1Database, family: string): Promise<string> {
  const stillValidSql = `NOT EXISTS (SELECT 1 FROM settings WHERE family_id = ? AND key = ? AND value <> '' AND datetime(value) > datetime('now'))`;
  const upsertIfExpired = `INSERT INTO settings (family_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(family_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE ${stillValidSql}`;
  const code = generateOwnerCode();

  const results = await db.batch<{ value: string }>([
    db.prepare(upsertIfExpired).bind(family, ownerCodeKey, code, family, ownerCodeExpiresKey),
    db.prepare(upsertIfExpired).bind(family, ownerCodeExpiresKey, ownerCodeExpiry(), family, ownerCodeExpiresKey),
    db
      .prepare("SELECT value FROM settings WHERE family_id = ? AND key = ?")
      .bind(family, ownerCodeKey),
  ]);

  return results[2]?.results[0]?.value ?? code;
}

/** อ่านรายการห้องที่จำไว้ — ค่าที่อ่านไม่ออกถือว่ายังไม่เคยเลือก ไม่ทำให้หน้าตั้งค่าโหลดไม่ขึ้น */
function parseRoomIds(raw: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function loadSettings(env: Env, family: string): Promise<SettingsPayload> {
  const result = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE family_id = ?",
  )
    .bind(family)
    .all<{ key: string; value: string }>();
  const stored = new Map(result.results.map((row) => [row.key, row.value]));
  const valueOf = (key: SettingsKey): string =>
    stored.get(key) ?? defaultSettings[key];
  const ownerLineUserId = stored.get("owner_line_user_id") ?? "";
  const ownerLineConnected = ownerLineUserId !== "";
  const promptpayType =
    valueOf("promptpay_type") === "citizen-id" ? "citizen-id" : "phone";

  // GET ต้องไม่หมุนรหัส: ส่งรหัสที่ยังใช้ได้กลับไปเสมอ ถ้าไม่มีรหัสที่ใช้ได้
  // และยังไม่ได้ผูก LINE จึงออกรหัสใหม่ให้ครั้งเดียว ถ้าผูกแล้วต้องกดออกรหัสใหม่
  // (POST /api/settings/owner-code) เท่านั้น จึงจะได้รหัสอีก
  let ownerLinkCode = ownerCodeFrom(stored);

  if (ownerLinkCode === "" && !ownerLineConnected) {
    ownerLinkCode = await ensureOwnerCode(env.DB, family);
  }

  /**
   * สถานะ credential คำนวณจากแถวที่อ่านมาแล้วรอบเดียว (ไม่ยิง D1 ซ้ำ) และใช้
   * ตัวเลขชุดเดียวกันทั้ง "ตั้งค่าแล้วหรือยัง" ของการ์ดรวมและรายละเอียดรายฟิลด์
   */
  const credentials = credentialStatusFrom(env, stored);

  return {
    dormName: valueOf("dorm_name"),
    ownerName: valueOf("owner_name"),
    ownerPhone: valueOf("owner_phone"),
    ownerLineId: valueOf("owner_line_id"),
    defaultWaterRate: toNumber(
      "default_water_rate",
      valueOf("default_water_rate"),
      Number(defaultSettings.default_water_rate),
    ),
    defaultElectricRate: toNumber(
      "default_electric_rate",
      valueOf("default_electric_rate"),
      Number(defaultSettings.default_electric_rate),
    ),
    promptpayType,
    promptpayId: valueOf("promptpay_id"),
    promptpayName: valueOf("promptpay_name"),
    bankName: valueOf("bank_name"),
    bankAccountNumber: valueOf("bank_account_number"),
    bankAccountName: valueOf("bank_account_name"),
    ownerLinkCode,
    ownerLineConnected,
    sharedElectricRoomIds: parseRoomIds(stored.get(sharedElectricRoomIdsKey)),
    /**
     * ใครกำลังเชื่อมอยู่ — ชื่อที่แสดงของบัญชี LINE นั้น
     *
     * `owner_line_user_id` เก็บ userId ซึ่งอ่านไม่รู้เรื่องสำหรับเจ้าของ จึงต้อง
     * แสดงชื่อด้วย ไม่งั้น "เชื่อมแล้ว" จะไม่มีทางรู้ว่าใคร (ดู ownerLineUserIdHint
     * ด้วย — userId ไม่ใช่ความลับที่ใช้สวมสิทธิ์ แต่ก็ไม่ควรแสดงเต็ม)
     */
    ownerLineDisplayName: await ownerLineDisplayName(env, family),
    /**
     * OA ของหอ — ให้หน้าตั้งค่าบอกได้ว่า "เพิ่มเพื่อน OA ตัวไหน" ก่อนพิมพ์รหัส
     * (null เมื่อยังไม่ตั้ง token หรือเรียก LINE ไม่ได้)
     */
    lineBot: await loadBotInfo(env),
    /**
     * "ตั้งค่าแล้วหรือยัง" นับทั้งค่าที่เจ้าของกรอกและ env — ใช้สถานะชุดเดียวกับ
     * ที่หน้าจอแสดงรายฟิลด์ จะได้ไม่มีที่ไหนตอบไม่ตรงกัน
     */
    integrations: {
      lineConfigured: credentials.lineAccessToken.configured,
      slipOkConfigured:
        credentials.slipOkApiKey.configured && credentials.slipOkBranchId.configured,
    },
    credentials,
  };
}

settings.get("/", async (c) => {
  try {
    const family = familyId(c);
    // ใช้ env ที่ค่าที่เจ้าของกรอกทับแล้ว เพื่อให้สถานะ OA ที่แสดงตรงกับค่าที่ใช้จริง
    const payload = await loadSettings(await integrationEnv(c.env, family), family);
    return c.json({ ok: true, settings: payload }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "load settings failed", error: detail }),
    );
    return c.json(errorBody("INTERNAL", "โหลดการตั้งค่าไม่สำเร็จ"), 500);
  }
});

settings.put("/", async (c) => {
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  try {
    const family = familyId(c);
    const rawType = body.promptpayType;

    if (
      "promptpayType" in body &&
      rawType !== "phone" &&
      rawType !== "citizen-id"
    ) {
      return c.json(
        errorBody(
          "VALIDATION",
          "ประเภทพร้อมเพย์ต้องเป็น phone หรือ citizen-id",
          "promptpayType",
        ),
        400,
      );
    }

    const storedTypeRow = await c.env.DB.prepare(
      "SELECT value FROM settings WHERE family_id = ? AND key = 'promptpay_type'",
    )
      .bind(family)
      .first<{ value: string }>();
    const storedType: PromptpayType =
      storedTypeRow?.value === "citizen-id" ? "citizen-id" : "phone";
    const effectiveType: PromptpayType =
      rawType === "phone" || rawType === "citizen-id" ? rawType : storedType;
    const updates = new Map<SettingsKey, string>();

    for (const key of Object.keys(body)) {
      if (!isWritableKey(key)) {
        return c.json(errorBody("VALIDATION", "ไม่รู้จักฟิลด์นี้", key), 400);
      }

      const value = body[key];
      const target = fieldToKey[key];

      if (key === "ownerPhone") {
        const raw = typeof value === "string" ? value.trim() : "";
        const message = raw === "" ? null : ownerPhoneError(raw);

        if (message !== null) {
          return c.json(errorBody("VALIDATION", message, key), 400);
        }

        updates.set(target, normalizeOwnerPhone(raw));
        continue;
      }

      if (key === "ownerLineId") {
        const raw = typeof value === "string" ? value.trim() : "";
        // ดึง OA ที่ใช้อยู่จาก LINE เฉพาะเมื่อมีค่าที่ต้องตรวจ — คำขอที่ไม่ได้แตะ
        // ฟิลด์นี้ (เกือบทั้งหมด) จึงไม่ต้องรอเครือข่ายเพิ่ม
        const dormBasicId =
          raw === "" ? "" : ((await loadBotInfo(c.env))?.basicId ?? "");
        const message = raw === "" ? null : ownerLineIdError(raw, dormBasicId);

        if (message !== null) {
          return c.json(errorBody("VALIDATION", message, key), 400);
        }

        updates.set(target, normalizeOwnerLineId(raw));
        continue;
      }

      if (
        key === "dormName" ||
        key === "ownerName" ||
        key === "promptpayId" ||
        key === "promptpayName" ||
        key === "bankName" ||
        key === "bankAccountName" ||
        key === "bankAccountNumber"
      ) {
        const text = typeof value === "string" ? value.trim() : "";

        if (key === "dormName" || key === "ownerName") {
          if (text === "") {
            return c.json(errorBody("VALIDATION", textMessages[key], key), 400);
          }

          updates.set(target, text);
          continue;
        }

        if (key === "promptpayId" && text !== "") {
          const message = promptpayIdError(text, effectiveType);

          if (message !== null) {
            return c.json(errorBody("VALIDATION", message, key), 400);
          }
        }

        if (key === "bankAccountNumber") {
          const message = text === "" ? null : accountNumberError(text);

          if (message !== null) {
            return c.json(errorBody("VALIDATION", message, key), 400);
          }

          updates.set(target, normalizeAccountNumber(text));
          continue;
        }

        updates.set(target, text);
        continue;
      }

      if (key === "defaultWaterRate" || key === "defaultElectricRate") {
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value <= 0
        ) {
          return c.json(errorBody("VALIDATION", rateMessages[key], key), 400);
        }

        updates.set(target, String(value));
        continue;
      }

      if (value !== "phone" && value !== "citizen-id") {
        return c.json(
          errorBody(
            "VALIDATION",
            "ประเภทพร้อมเพย์ต้องเป็น phone หรือ citizen-id",
            key,
          ),
          400,
        );
      }

      updates.set(target, value);
    }

    if (updates.size > 0) {
      const storedRow = await c.env.DB.prepare(
        "SELECT key, value FROM settings WHERE family_id = ?",
      )
        .bind(family)
        .all<{ key: string; value: string }>();
      const stored = new Map(
        storedRow.results.map((row) => [row.key, row.value]),
      );

      // ส่งค่าว่างทับช่องทางรับเงินที่ว่างอยู่แล้วไม่ใช่การลบวิธีรับเงิน
      // (และเป็นเรื่องปกติของการบันทึกฟอร์มทั้งใบของหอที่ยังไม่ได้ตั้งค่า)
      // ค่าที่เทียบคือค่าที่เก็บจริงเท่านั้น ค่าเริ่มต้นของช่องทางรับเงินว่างอยู่แล้ว
      for (const key of payoutKeys) {
        if (updates.get(key) === "" && !isConfigured(stored.get(key))) {
          updates.delete(key);
        }
      }

      if (updates.size > 0) {
        const statements = [...updates].map(([key, value]) =>
          c.env.DB.prepare(upsertSettingSql).bind(family, key, value),
        );
        const touchesPayout = payoutKeys.some((key) => updates.has(key));

        if (touchesPayout) {
          statements.push(
            c.env.DB.prepare(payoutGuardSql).bind(family, family, family, family),
          );
        }

        try {
          await c.env.DB.batch(statements);

          // อัตราเริ่มต้นของหอเปลี่ยน — คำนวณบิลที่ยังไม่จ่ายและยังไม่ได้ส่งของ
          // ห้องที่ "ไม่ได้ตั้งอัตราของตัวเอง" ใหม่ (ห้องที่ตั้งอัตราของตัวเอง
          // ไว้แล้วไม่ขึ้นกับค่าเริ่มต้นนี้ ไม่ต้องแตะ) ดู src/worker/lib/bill-rates.ts
          const waterChanged =
            updates.has("default_water_rate") &&
            updates.get("default_water_rate") !== stored.get("default_water_rate");
          const electricChanged =
            updates.has("default_electric_rate") &&
            updates.get("default_electric_rate") !== stored.get("default_electric_rate");

          if (waterChanged || electricChanged) {
            const freshRates = await loadEffectiveRates(c.env, family);
            await recalcRoomsUsingDormDefaults(
              c.env,
              family,
              { water: waterChanged, electric: electricChanged },
              freshRates,
            );
          }

          // ผู้รับเงิน (ชื่อหอ/เจ้าของ/พร้อมเพย์/บัญชีธนาคาร) เปลี่ยน — คำนวณบิล
          // ที่ยังไม่จ่ายของทั้งครอบครัวใหม่ ไม่ว่าจะส่งไปแล้วหรือยัง (ต่างจาก
          // อัตราน้ำ/ไฟ เพราะเปลี่ยนช่องทางรับเงินไม่กระทบยอด) ไม่แยกตามห้อง
          // เพราะผู้รับเงินเป็นค่าเดียวของทั้งหอ ดู src/worker/lib/bill-payee.ts
          const payeeChanged = payeeSettingKeys.some(
            (key) => updates.has(key) && updates.get(key) !== stored.get(key),
          );

          if (payeeChanged) {
            await recalcUnpaidBillsPayee(c.env, family);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);

          // คำขอที่แตะช่องทางรับเงินจะพ่วงแถวกันที่เขียนด้วยค่า NULL ไว้เสมอ
          // จึงพังที่ NOT NULL ของ settings.value เมื่อตอนเขียนจริงไม่เหลือ
          // วิธีรับเงินแล้ว ส่วนการเขียนค่าอื่นใน batch นี้เป็น NULL ไม่ได้
          // ถ้าข้อความไม่ตรง แปลว่าเป็นข้อผิดพลาดอื่นจริง ๆ
          if (
            !touchesPayout ||
            !detail.includes("NOT NULL constraint failed") ||
            !detail.includes("settings.value")
          ) {
            throw error;
          }

          return c.json(
            errorBody("VALIDATION", noPayoutMessage, "promptpayId"),
            400,
          );
        }
      }
    }

    const payload = await loadSettings(await integrationEnv(c.env, family), family);
    return c.json({ ok: true, settings: payload }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "save settings failed", error: detail }),
    );
    return c.json(errorBody("INTERNAL", "บันทึกการตั้งค่าไม่สำเร็จ"), 500);
  }
});

/**
 * บันทึก/ล้าง credential ของ LINE OA และ SlipOK
 *
 * ส่งสตริงว่างมา = ล้างค่านั้น (กลับไปใช้ค่าเดิมของ env) ส่วนการไม่ส่งคีย์นั้นมาเลย
 * = ไม่แตะ — หน้าจอจึงส่งเฉพาะช่องที่ผู้ใช้แก้จริง ๆ ได้
 *
 * จำกัดเฉพาะเจ้าของ: ค่าเหล่านี้คุม OA ของหอและการตรวจสลิป (ซึ่งตัดสินว่าบิลถูกปิด
 * หรือไม่) เทียบเท่าสิทธิ์ระดับโอนเงิน สมาชิกจึงดูสถานะได้แต่แก้ไม่ได้
 */
settings.put("/credentials", requireRole("owner"), async (c) => {
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const family = familyId(c);
  const updates = new Map<CredentialName, string | null>();

  for (const key of Object.keys(body)) {
    if (!isCredentialName(key)) {
      return c.json(errorBody("VALIDATION", "ไม่รู้จักฟิลด์นี้", key), 400);
    }

    const raw = body[key];
    const text = typeof raw === "string" ? raw.trim() : "";

    if (text === "") {
      updates.set(key, null);
      continue;
    }

    const message = credentialError(key, text);

    if (message !== null) {
      return c.json(errorBody("VALIDATION", message, key), 400);
    }

    updates.set(key, text);
  }

  try {
    await saveCredentials(c.env.DB, family, updates);

    /**
     * cache ข้อมูล OA ผูกกับ token — ต้องล้างเมื่อ token เปลี่ยน ไม่งั้นหน้าจอจะโชว์
     * ชื่อ OA ตัวเก่าต่ออีก 6 ชั่วโมง และดูเหมือนบันทึกไม่ติด
     */
    if (updates.has("lineAccessToken")) {
      await c.env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(botInfoMetaKey).run();
    }

    return c.json(
      { ok: true, credentials: await credentialsStatus(c.env, family) },
      200,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "save credentials failed", error: detail }),
    );
    return c.json(errorBody("INTERNAL", "บันทึกค่าเชื่อมต่อไม่สำเร็จ"), 500);
  }
});

settings.post("/owner-code", async (c) => {
  const family = familyId(c);

  try {
    const currentRow = await c.env.DB.prepare(
      "SELECT value FROM settings WHERE family_id = ? AND key = ?",
    )
      .bind(family, ownerCodeKey)
      .first<{ value: string }>();
    const current = currentRow?.value ?? "";
    let code = generateOwnerCode();

    for (let attempt = 0; attempt < 20 && code === current; attempt += 1) {
      code = generateOwnerCode();
    }

    // รหัสกับเวลาหมดอายุต้องถูกเขียนพร้อมกันเสมอ ไม่งั้นจะเหลือรหัสที่ไม่มีวันหมดอายุ
    await c.env.DB.batch([
      c.env.DB.prepare(upsertSettingSql).bind(family, ownerCodeKey, code),
      c.env.DB.prepare(upsertSettingSql).bind(
        family,
        ownerCodeExpiresKey,
        ownerCodeExpiry(),
      ),
    ]);

    return c.json({ ok: true, ownerLinkCode: code }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "regenerate owner code failed",
        error: detail,
      }),
    );
    return c.json(errorBody("INTERNAL", "ออกรหัสเชื่อมต่อใหม่ไม่สำเร็จ"), 500);
  }
});

settings.delete("/owner-link", async (c) => {
  const family = familyId(c);

  try {
    /**
     * เลิกเชื่อม LINE ของเจ้าของ — ใช้เมื่อเปลี่ยนเครื่อง/บัญชี หรือเลิกรับแจ้งเตือน
     *
     * ล้างทั้ง userId ที่ผูกไว้และรหัสค้าง เพื่อให้ครั้งหน้าที่ต้องการเชื่อม
     * หน้าตั้งค่าจะออกรหัสใหม่ให้เอง (ตรรกะใน loadSettings ออกรหัสเมื่อยังไม่ผูก
     * และไม่มีรหัสที่ใช้ได้) และรหัสเดิมต้องใช้ไม่ได้ทันทีหลังเลิกเชื่อม ไม่งั้น
     * คนที่ถือรหัสเก่าจะผูกบัญชีกลับเข้ามาได้โดยเจ้าของไม่ได้ตั้งใจ
     *
     * อ่าน userId มาก่อน batch เพราะคำสั่งลบต้องรู้ว่าจะลบ pending ของใคร —
     * ถ้าใส่ subquery ที่อ่านจาก settings ในชุดเดียวกัน มันจะเห็นค่าใหม่ (ว่าง)
     * ที่คำสั่งก่อนหน้าเพิ่งเขียน ตาม semantics ของ D1 batch ที่รันตามลำดับ
     */
    const row = await c.env.DB.prepare(
      "SELECT value FROM settings WHERE family_id = ? AND key = 'owner_line_user_id'",
    )
      .bind(family)
      .first<{ value: string }>();
    const ownerId = (row?.value ?? "").trim();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE settings SET value = '', updated_at = datetime('now')
         WHERE family_id = ? AND key IN ('owner_line_user_id', 'owner_link_code', 'owner_link_code_expires_at')`,
      ).bind(family),
      c.env.DB.prepare(
        "DELETE FROM line_pending WHERE family_id = ? AND line_user_id = ?",
      ).bind(family, ownerId),
    ]);

    return c.json({ ok: true }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "unlink owner line failed", error: detail }),
    );
    return c.json(errorBody("INTERNAL", "เลิกเชื่อม LINE ไม่สำเร็จ"), 500);
  }
});

/**
 * สถานะช่อง LINE ที่ใช้อยู่ — ให้หน้าตั้งค่าบอกได้ว่า OA ตัวไหนทำงานอยู่
 *
 * อ่านค่าที่มีผลจริง (ค่าที่เจ้าของกรอกในหน้าตั้งค่าชนะ env): token ใช้ตรวจว่ายังใช้ได้
 * และชี้ไป OA ตัวไหน ส่วน secret ตรวจแค่ว่ามีหรือไม่ (ใช้ตรวจลายเซ็นขาเข้า จะทดสอบ
 * ไม่ได้ถ้าไม่มีข้อความจริงส่งเข้ามา)
 */
settings.get("/line-channel", async (c) => {
  try {
    const env = await integrationEnv(c.env, familyId(c));
    const expectedPath = "/webhook/line";
    const configured = isConfigured(env.LINE_CHANNEL_ACCESS_TOKEN);
    const bot = configured ? await fetchBotInfo(env) : null;
    const webhook = configured ? await fetchWebhookEndpoint(env) : null;
    const origin = new URL(c.req.url).origin;

    return c.json(
      {
        ok: true,
        channel: {
          tokenConfigured: configured,
          secretConfigured: isConfigured(env.LINE_CHANNEL_SECRET),
          /** OA ที่ token ชี้อยู่จริง — null เมื่อยังไม่ตั้งหรือเรียก LINE ไม่ได้ */
          bot: bot === null ? null : { displayName: bot.displayName, basicId: bot.basicId },
          webhook,
          /** true เมื่อ webhook ที่ LINE ตั้งไว้ชี้กลับมาที่ Worker นี้ */
          webhookPointsHere: webhook !== null && webhook.endpoint === `${origin}${expectedPath}`,
          expectedWebhookEndpoint: `${origin}${expectedPath}`,
          liffId: (env.LIFF_ID ?? "").trim(),
        },
      },
      200,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "load line channel status failed", error: detail }),
    );
    return c.json(errorBody("INTERNAL", "ตรวจสอบสถานะ LINE ไม่สำเร็จ"), 500);
  }
});

/**
 * ตั้ง webhook ของช่อง LINE ให้ชี้กลับมาที่ Worker นี้
 *
 * เป็นขั้นตอนที่หลงลืมบ่อยที่สุดเวลาเปลี่ยน OA และอาการที่เกิดคือ "บอทเงียบ"
 * โดยไม่มีสัญญาณอะไรในหน้าจอ จึงให้กดจากแอปได้ แทนการรัน curl เอง
 *
 * เขียนได้เฉพาะ endpoint ของ Worker ที่รับคำขอนี้เท่านั้น (origin เดียวกัน) —
 * กันไม่ให้คำขอที่หลุดเข้ามาตั้ง webhook ไปชี้โดเมนอื่น ซึ่งจะพาข้อความผู้เช่า
 * ไปผิดที่แบบเงียบ ๆ ยิ่งอันตรายกว่าการไม่ตั้งเลย
 */
settings.post("/line-channel/webhook", async (c) => {
  try {
    const endpoint = `${new URL(c.req.url).origin}/webhook/line`;
    // token ของค่าที่มีผลจริง (ค่าที่เจ้าของกรอกชนะ env) ไม่ใช่ของ env ตรง ๆ
    const env = await integrationEnv(c.env, familyId(c));
    const token = typeof env.LINE_CHANNEL_ACCESS_TOKEN === "string" ? env.LINE_CHANNEL_ACCESS_TOKEN.trim() : "";

    if (token === "" || demoModeOn(env)) {
      return c.json(
        errorBody("VALIDATION", "ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN จึงตั้ง webhook ไม่ได้"),
        400,
      );
    }

    const response = await fetch("https://api.line.me/v2/bot/channel/webhook/endpoint", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
      signal: AbortSignal.timeout(lineOutboundTimeoutMs),
    });

    if (!response.ok) {
      logLineFailure("set line webhook failed", `status ${String(response.status)}`);
      return c.json(errorBody("INTERNAL", "ตั้ง webhook กับ LINE ไม่สำเร็จ"), 502);
    }

    console.log(JSON.stringify({ message: "line webhook endpoint updated", endpoint }));

    return c.json({ ok: true, endpoint }, 200);
  } catch (error) {
    logLineFailure("set line webhook failed", failureDetail(error));
    return c.json(errorBody("INTERNAL", "ตั้ง webhook กับ LINE ไม่สำเร็จ"), 500);
  }
});

settings.get("/charges", async (c) => {
  try {
    const charges = await loadDormCharges(c.env, familyId(c));
    return c.json(
      {
        ok: true,
        charges: charges.map((charge) => ({
          id: charge.id,
          name: charge.name,
          amount: charge.amount,
        })),
      },
      200,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "load dorm charges failed", error: detail }),
    );
    return c.json(errorBody("INTERNAL", "โหลดค่าใช้จ่ายของหอไม่สำเร็จ"), 500);
  }
});

settings.put("/charges", async (c) => {
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const parsed = parseChargeList(body.charges, maxDormCharges);

  if (parsed === null) {
    return c.json(
      errorBody(
        "VALIDATION",
        "ค่าใช้จ่ายของหอต้องมีชื่อและจำนวนเงินเป็นจำนวนเต็มไม่ติดลบ ไม่เกิน 20 รายการ",
        "charges",
      ),
      400,
    );
  }

  try {
    const saved = await replaceDormCharges(c.env, familyId(c), parsed);

    if (saved === null) {
      return c.json(
        errorBody(
          "VALIDATION",
          "มีรายการที่อ้างถึงไม่พบ หรืออ้างซ้ำ",
          "charges",
        ),
        400,
      );
    }

    return c.json(
      {
        ok: true,
        charges: saved.map((charge) => ({
          id: charge.id,
          name: charge.name,
          amount: charge.amount,
        })),
      },
      200,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "save dorm charges failed", error: detail }),
    );
    return c.json(errorBody("INTERNAL", "บันทึกค่าใช้จ่ายของหอไม่สำเร็จ"), 500);
  }
});

export default settings;
