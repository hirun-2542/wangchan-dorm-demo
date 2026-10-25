import { notificationsFromServer, type AppNotification } from "./notifications";

export type ElectricMode = "meter" | "flat";
export type RoomStatus = "vacant" | "occupied";
export type TenantStatus = "current" | "moved-out";

export interface Room {
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
  /** ชุดที่มีผลจริงของห้องนี้ = ค่าใช้จ่ายของหอ − ที่ปิดไว้ + ของห้องเอง (อ่านอย่างเดียว) */
  charges: BillCharge[];
  /** id ของค่าใช้จ่ายระดับหอที่ห้องนี้ปิดไว้ */
  excludedDormChargeIds: string[];
  /** ค่าใช้จ่ายที่เป็นของห้องนี้เอง ไม่ได้มาจากหอ */
  ownCharges: BillCharge[];
}

export interface DormCharge {
  id: string;
  name: string;
  amount: number;
}

export interface DormChargeInput {
  id?: string;
  name: string;
  amount: number;
}

export interface RoomInput {
  roomNumber: string;
  rent: number;
  waterRate: number | null;
  electricMode: ElectricMode;
  electricRate: number | null;
  waterMeterInit: number;
  electricMeterInit: number;
  excludedDormChargeIds?: string[];
  ownCharges?: BillCharge[];
}

export interface Tenant {
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

export interface TenantInput {
  fullName: string;
  phone: string;
  roomId: string;
  checkInDate: string;
}

export interface TenantUpdate {
  fullName?: string;
  phone?: string;
  checkInDate?: string;
}

export interface PendingLink {
  lineUserId: string;
  displayName: string;
  lastMessage: string | null;
  lastSeenAt: string;
}

export interface BillCharge {
  name: string;
  amount: number;
}

export type BillStatus = "paid" | "unpaid";

export interface Bill {
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
  charges: BillCharge[];
  total: number;
  status: BillStatus;
  paidAt: string | null;
  paidMethod: string | null;
  sentAt: string | null;
  createdAt: string;
}

export type BillPaidMethod = "transfer" | "cash";

export interface BillUpdate {
  waterCurrent?: number;
  electricCurrent?: number;
  flatElectricAmount?: number;
  charges?: BillCharge[];
}

export interface BillPaidInput {
  method: BillPaidMethod;
  paidAt?: string;
}

export interface MeterSheetRow {
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
  /** หน่วยไฟของบิลล่าสุดก่อนงวดนี้ (null = ห้องนี้ยังไม่เคยออกบิล) */
  electricUnitsPrevious: number | null;
  existingBillId: string | null;
  charges: BillCharge[];
}

export interface BillEntryInput {
  roomId: string;
  waterCurrent: number;
  electricCurrent: number;
  flatElectricAmount?: number;
  charges?: BillCharge[];
}

export type PromptpayType = "phone" | "citizen-id";

export interface SettingsIntegrations {
  lineConfigured: boolean;
  slipOkConfigured: boolean;
}

/** ที่มาของค่าที่ใช้จริง — "settings" = ค่าที่กรอกในหน้าตั้งค่า, "env" = wrangler secret */
export type CredentialSource = "settings" | "env" | null;

export interface IntegrationCredentialStatus {
  configured: boolean;
  source: CredentialSource;
  /** ค่าจริง — ส่งมาเฉพาะรายการที่ไม่ใช่ความลับ (LIFF ID, branch id) */
  value: string | null;
}

export type CredentialName =
  | "lineAccessToken"
  | "lineChannelSecret"
  | "liffId"
  | "slipOkApiKey"
  | "slipOkBranchId";

export type IntegrationCredentials = Record<CredentialName, IntegrationCredentialStatus>;

/** ส่งเฉพาะช่องที่แก้ — ค่าว่างคือ "ล้างค่า" (กลับไปใช้ค่าเดิมของ env) */
export type CredentialsUpdate = Partial<Record<CredentialName, string>>;

export interface Settings {
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
  /** ห้องที่ใช้บิลการไฟฟ้ารวมครั้งล่าสุด — ให้หน้าออกบิลเลือกไว้ให้ */
  sharedElectricRoomIds: string[];
  /** ชื่อที่แสดงของบัญชี LINE ที่ผูกอยู่ — null เมื่อยังไม่ผูก, "" เมื่อผูกแล้วแต่ไม่รู้ชื่อ */
  ownerLineDisplayName: string | null;
  /** OA ของหอ (ชื่อที่แสดง + basic id ที่ค้นหาได้) — null เมื่อดึงจาก LINE ไม่ได้ */
  lineBot: { displayName: string; basicId: string } | null;
  integrations: SettingsIntegrations;
  /** สถานะค่าที่เจ้าของกรอกเอง (ความลับไม่ถูกส่งค่าจริงกลับมา) */
  credentials: IntegrationCredentials;
}

export interface SettingsUpdate {
  dormName?: string;
  ownerName?: string;
  ownerPhone?: string;
  ownerLineId?: string;
  defaultWaterRate?: number;
  defaultElectricRate?: number;
  promptpayType?: PromptpayType;
  promptpayId?: string;
  promptpayName?: string;
  bankName?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
}

interface ErrorPayload {
  code: string;
  message: string;
  field?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly field?: string;
  /** สถานะ HTTP ที่เซิร์ฟเวอร์ตอบกลับ · 0 = คำขอไม่ถึงเซิร์ฟเวอร์ */
  readonly status: number;

  constructor(message: string, code: string, field?: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

function errorPayloadOf(body: unknown): ErrorPayload | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const error = record.error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const fields = error as Record<string, unknown>;
  const message = fields.message;
  const code = fields.code;

  if (typeof message !== "string" || typeof code !== "string") {
    return null;
  }

  const field = fields.field;

  return typeof field === "string"
    ? { code, message, field }
    : { code, message };
}

/** เพดานเวลาต่อคำขอ กันหน้าจอค้างตลอดไปเมื่อเซิร์ฟเวอร์ไม่ตอบ */
const requestTimeoutMs = 20_000;

/**
 * 401 จากเส้นทางนี้เป็นเรื่องปกติของหน้าเข้าสู่ระบบ (ยังไม่ล็อกอิน)
 * หน้าจอที่เรียกจึงจัดการเอง ไม่ต้องพาผู้ใช้ออกจากสิ่งที่กำลังทำอยู่
 */
const selfHandledAuthPaths = ["/api/auth/me", "/api/auth/login"];

let realtimeConnectionId: string | null = null;

/** ให้ชั้น realtime บอกว่าแท็บนี้คือ socket ไหน เซิร์ฟเวอร์จะได้ไม่ส่ง event กลับมาหาตัวเอง */
export function setRealtimeConnectionId(id: string | null): void {
  realtimeConnectionId = id;
}

let unauthorizedHandler: (() => void) | null = null;

/** ให้ AuthProvider ลงทะเบียนผู้รับเหตุ 401 เพื่อพากลับหน้าเข้าสู่ระบบ */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;

  return () => {
    if (unauthorizedHandler === handler) {
      unauthorizedHandler = null;
    }
  };
}

/**
 * แคชคำตอบ GET ในหน่วยความจำของแท็บ — กลับมาหน้าเดิมต้องไม่รอเครือข่ายอีก
 *
 * วัดบน production (Worker อยู่กรุงเทพ, D1 อยู่ APAC) แล้วแต่ละ API ใช้ 100–530ms
 * เพราะทุกคำขอต้องผ่านการตรวจเซสชันที่ D1 บวกคำสั่งของหน้านั้น การโหลดซ้ำทุกครั้งที่สลับหน้า
 * จึงรู้สึกช้าทุกหน้า ทั้งที่ข้อมูลยังไม่เปลี่ยน
 *
 * ความถูกต้องกันด้วยการล้างแคชทั้งก้อน (ไม่เลือกเป็นรายคีย์ เพราะ API หนึ่งเส้นกระทบหลายหน้า):
 * ทุกคำขอที่เปลี่ยนข้อมูล, ทุก announce* (event จาก WebSocket), 401 และเมื่อกลับมาที่แท็บหลังซ่อนไว้นาน
 * สิ่งที่แคชไม่เห็นคือแก้จากอีกเครื่องโดยไม่มี event — เก่าได้ไม่เกิน `cacheTtlMs`
 */
const cacheTtlMs = 10 * 60 * 1000;
/** ซ่อนแท็บนานกว่านี้แล้วกลับมา = ข้อมูลอาจเปลี่ยนจากอีกเครื่อง ล้างแคชก่อนใช้ต่อ */
const hiddenClearMs = 30 * 1000;
/**
 * ต้องสดทุกครั้งเสมอ:
 * - คิวที่ LINE เป็นฝ่ายเติม (สลิปรอตรวจ, คนที่ยังไม่ผูกห้อง) — webhook เขียนลงฐานข้อมูลโดยไม่มี event
 *   ส่งมาหน้าเว็บ (event มีแค่ "บิลถูกปิด"/"ผู้เช่าเชื่อมแล้ว") แคชคิวว่างไว้จะซ่อนของที่เพิ่งเข้ามา
 * - รายการแจ้งเตือนมี event ของตัวเอง ส่วน export เป็นก้อนใหญ่ที่ไม่ใช่การเปิดหน้า
 */
const uncachedGetPaths = ["/api/notifications", "/api/bills/export", "/api/slips", "/api/line/pending"];
/**
 * แดชบอร์ดแสดงสถานะสลิปรอตรวจ/การผูก LINE ของแต่ละห้อง ซึ่งเปลี่ยนจาก webhook ได้โดยไม่มี event
 * เหมือนคิวข้างบน แต่เป็นหน้าแรกที่เปิดบ่อยสุด จึงแคชแค่สั้น ๆ พอให้สลับหน้าไปมาไม่ต้องรอ
 */
const shortLivedGetPaths: Record<string, number> = { "/api/stats/dashboard": 30 * 1000 };

const getCache = new Map<string, { at: number; body: unknown }>();
const inflightGets = new Map<string, Promise<unknown>>();
/** คำขอที่เริ่มก่อนล้างแคชแล้วตอบหลังล้าง ต้องไม่ถูกเก็บ — ไม่งั้นข้อมูลก่อนแก้กลับเข้าแคช */
let cacheGeneration = 0;

export function clearApiCache(): void {
  cacheGeneration += 1;
  getCache.clear();
  inflightGets.clear();
}

// api.ts ถูก import จากชุดทดสอบฝั่ง worker ด้วย (ไม่มี lib.dom) จึงเข้าถึง document ผ่าน globalThis
const pageDocument = (
  globalThis as unknown as {
    document?: { visibilityState: string; addEventListener: (type: string, listener: () => void) => void };
  }
).document;

if (pageDocument !== undefined) {
  let hiddenAt: number | null = null;

  pageDocument.addEventListener("visibilitychange", () => {
    if (pageDocument.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }

    if (hiddenAt !== null && Date.now() - hiddenAt > hiddenClearMs) {
      clearApiCache();
    }

    hiddenAt = null;
  });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  // คำขอที่เปลี่ยนข้อมูลล้างแคชทั้งก่อนส่งและหลังตอบ: ก่อนส่งกัน GET ที่เริ่มระหว่างนั้นเก็บของเก่า
  // หลังตอบเพราะ GET ที่ออกไประหว่างรอ POST อาจอ่านข้อมูลก่อนที่ POST จะเขียนเสร็จ
  if (init.method !== undefined && init.method !== "GET") {
    clearApiCache();

    try {
      return await send<T>(path, init);
    } finally {
      clearApiCache();
    }
  }

  return send<T>(path, init);
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;

  // ไฟล์นี้ถูก import จากทั้งฝั่ง client (lib.dom RequestInit มี credentials)
  // และจากชุดทดสอบฝั่ง worker (workers-types RequestInit ไม่มี credentials)
  // ประกาศชนิดเป็น intersection เอง เพื่อให้คอมไพล์ผ่านทั้งสองฝั่งโดยไม่ใช้ any
  //
  // แนบ connectionId ของแท็บนี้ไปกับทุกคำขอที่เปลี่ยนข้อมูล — เซิร์ฟเวอร์ใช้
  // ค่านี้บอก Durable Object ให้ข้ามแท็บต้นทางเวลากระจาย event (กัน toast ซ้ำ)
  const headers = new Headers(init.headers);

  if (realtimeConnectionId !== null) {
    headers.set("x-realtime-id", realtimeConnectionId);
  }

  const requestInit: RequestInit & { credentials?: string } = {
    ...init,
    headers,
    credentials: "same-origin",
    signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
  };

  try {
    response = await fetch(path, requestInit);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError("เซิร์ฟเวอร์ไม่ตอบสนอง กรุณาลองใหม่", "TIMEOUT");
    }

    throw new ApiError("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ", "NETWORK");
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (
      response.status === 401 &&
      !selfHandledAuthPaths.some((known) => path.startsWith(known))
    ) {
      clearApiCache();
      unauthorizedHandler?.();
    }

    const payload = errorPayloadOf(body);
    throw payload === null
      ? new ApiError("ทำรายการไม่สำเร็จ", "UNKNOWN", undefined, response.status)
      : new ApiError(
          payload.message,
          payload.code,
          payload.field,
          response.status,
        );
  }

  return body as T;
}

export function apiGet<T>(path: string): Promise<T> {
  if (uncachedGetPaths.some((known) => path.startsWith(known))) {
    return request<T>(path, { method: "GET" });
  }

  const hit = getCache.get(path);

  const ttlMs =
    Object.entries(shortLivedGetPaths).find(([known]) => path.startsWith(known))?.[1] ?? cacheTtlMs;

  if (hit !== undefined && Date.now() - hit.at < ttlMs) {
    // สำเนาทุกครั้ง — หน้าที่เรียงหรือแก้ array ที่ได้มาตรง ๆ ต้องไม่ทำให้แคชเพี้ยน
    return Promise.resolve(structuredClone(hit.body) as T);
  }

  let pending = inflightGets.get(path);

  if (pending === undefined) {
    const generation = cacheGeneration;
    const started: Promise<unknown> = request<unknown>(path, { method: "GET" })
      .then((body) => {
        if (generation === cacheGeneration) {
          getCache.set(path, { at: Date.now(), body });
        }

        return body;
      })
      .finally(() => {
        if (inflightGets.get(path) === started) {
          inflightGets.delete(path);
        }
      });

    inflightGets.set(path, started);
    pending = started;
  }

  // คำขอเดียวกันที่ยิงพร้อมกัน (เช่น ดัชนีค้นหากับหน้าห้องพักขอ /api/rooms พร้อมกัน) ใช้คำตอบเดียว
  return pending.then((body) => structuredClone(body) as T);
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function fetchRooms(): Promise<Room[]> {
  const body = await apiGet<{ ok: true; rooms: Room[] }>("/api/rooms");
  return body.rooms;
}

export async function createRoom(input: RoomInput): Promise<Room> {
  const body = await apiPost<{ ok: true; room: Room }>("/api/rooms", input);
  return body.room;
}

export async function updateRoom(id: string, input: RoomInput): Promise<Room> {
  const body = await apiPatch<{ ok: true; room: Room }>(
    `/api/rooms/${encodeURIComponent(id)}`,
    input,
  );
  return body.room;
}

/** ตั้งค่าไฟต่อหน่วยของห้องที่ใช้บิลการไฟฟ้ารวม — worker คิดอัตราจากยอดเงินกับหน่วยในบิล */
export async function applySharedElectricBill(input: {
  roomIds: string[];
  billAmount: number;
  billUnits: number;
}): Promise<{ rate: number; roomIds: string[] }> {
  const body = await apiPost<{ ok: true; rate: number; roomIds: string[] }>(
    "/api/rooms/shared-electric",
    input,
  );
  return { rate: body.rate, roomIds: body.roomIds };
}

/**
 * บัญชี PEA ที่จำไว้ต่อปลายทาง — `target` เป็น "shared" หรือ id ของห้องที่หอนี้เป็นเจ้าของ
 * เซิร์ฟเวอร์กรองปลายทางที่ถูกลบ/ไม่ใช่ของหอออกให้แล้ว
 */
export interface PeaAccount {
  target: string;
  ca: string;
  peano: string;
}

/**
 * บิลจากการไฟฟ้า — `billPeriod` เป็นข้อความงวดบิลตามที่ PEA ส่งมา ไม่แปลงเป็นไทย
 * เพราะรูปแบบของ PEA ไม่การันตี การเดาเดือนเองจะทำให้ออกบิลผิดเดือน
 */
export interface PeaBill {
  billPeriod: string;
  amount: number;
  units: number;
  paidAt: string | null;
  /** เลขมิเตอร์ที่ PEA จดล่าสุด — null เมื่อ PEA ไม่ส่งหรืออ่านไม่ได้ (ไม่อนุมานจากจำนวนหน่วย) */
  meter: number | null;
}

/** หมายเลขผู้ใช้ไฟฟ้า/รหัสเครื่องวัดที่จำไว้ของหอนี้ (ใช้เติมช่องก่อนดึงบิล) */
export async function fetchPeaAccounts(): Promise<PeaAccount[]> {
  const body = await apiGet<{ ok: true; accounts: PeaAccount[] }>(
    "/api/pea/accounts",
  );
  return body.accounts;
}

/**
 * ดึงบิลล่าสุดจาก PEA ตามหมายเลขผู้ใช้ไฟฟ้ากับรหัสเครื่องวัด
 *
 * เซิร์ฟเวอร์เลือกใบล่าสุดจากวันจดมิเตอร์ของ PEA และจำคู่นี้ไว้กับ `target` ให้เองเมื่อ
 * สำเร็จ — คู่ที่ผิดจะไม่ถูกจำ คืน `bill` เป็น null เมื่อ PEA ตอบสำเร็จแต่ยังไม่มีบิล
 */
export async function fetchLatestPeaBill(input: {
  target: string;
  ca: string;
  peano: string;
  /** true = ตรวจว่าคู่นี้ใช้ได้โดยไม่บันทึกคู่ (ปุ่ม "ตรวจสอบการเชื่อมต่อ") */
  verifyOnly?: boolean;
}): Promise<{ account: PeaAccount; bill: PeaBill | null }> {
  const body = await apiPost<{
    ok: true;
    account: PeaAccount;
    bill: PeaBill | null;
  }>("/api/pea/history", input);
  return { account: body.account, bill: body.bill };
}

/**
 * ยกเลิกการเชื่อมต่อ PEA ของห้อง — ลบเฉพาะคู่ CA/รหัสเครื่องวัดใน settings
 * ไม่แตะบิลหรือเลขมิเตอร์ที่บันทึกไว้แล้ว
 */
export async function deletePeaAccount(target: string): Promise<void> {
  await apiDelete<{ ok: true; target: string }>(
    `/api/pea/accounts/${encodeURIComponent(target)}`,
  );
}

export async function fetchTenants(): Promise<Tenant[]> {
  const body = await apiGet<{ ok: true; tenants: Tenant[] }>("/api/tenants");
  return body.tenants;
}

export async function createTenant(input: TenantInput): Promise<Tenant> {
  const body = await apiPost<{ ok: true; tenant: Tenant }>(
    "/api/tenants",
    input,
  );
  return body.tenant;
}

export async function updateTenant(
  id: string,
  input: TenantUpdate,
): Promise<Tenant> {
  const body = await apiPatch<{ ok: true; tenant: Tenant }>(
    `/api/tenants/${encodeURIComponent(id)}`,
    input,
  );
  return body.tenant;
}

export async function checkoutTenant(
  id: string,
  checkOutDate: string,
): Promise<Tenant> {
  const body = await apiPost<{ ok: true; tenant: Tenant }>(
    `/api/tenants/${encodeURIComponent(id)}/checkout`,
    { checkOutDate },
  );
  return body.tenant;
}

export async function fetchSettings(): Promise<Settings> {
  const body = await apiGet<{ ok: true; settings: Settings }>("/api/settings");
  return body.settings;
}

export async function fetchDormCharges(): Promise<DormCharge[]> {
  const body = await apiGet<{ ok: true; charges: DormCharge[] }>(
    "/api/settings/charges",
  );
  return body.charges;
}

export async function saveDormCharges(
  charges: DormChargeInput[],
): Promise<DormCharge[]> {
  const body = await apiPut<{ ok: true; charges: DormCharge[] }>(
    "/api/settings/charges",
    { charges },
  );
  return body.charges;
}

export async function fetchPendingLinks(): Promise<PendingLink[]> {
  const body = await apiGet<{ ok: true; pending: PendingLink[] }>(
    "/api/line/pending",
  );
  return body.pending;
}

export async function linkPendingUser(
  lineUserId: string,
  tenantId: string,
): Promise<void> {
  await apiPost<{ ok: true }>(
    `/api/line/pending/${encodeURIComponent(lineUserId)}/link`,
    { tenantId },
  );
}

export type LineMessageAudience = "tenant" | "owner";

export interface LineFlexCard {
  type: "flex";
  altText: string;
  contents: Record<string, unknown>;
}

export interface LineMessageKind {
  key: string;
  title: string;
  audience: LineMessageAudience;
  trigger: string;
  message: LineFlexCard;
}

export interface LineMessageSource {
  period: string;
  roomNumber: string;
  tenantName: string;
}

/** การส่งบิลครั้งล่าสุดของหอ — คนละเรื่องกับ `source` ที่บอกว่าใช้บิลใบไหนเป็นตัวอย่าง */
export interface LineLastSent {
  sentAt: string;
  roomNumber: string;
  period: string;
}

export interface LineMessagesResult {
  source: LineMessageSource | null;
  lastSent: LineLastSent | null;
  messages: LineMessageKind[];
}

export async function fetchLineMessages(): Promise<LineMessagesResult> {
  const body = await apiGet<{
    ok: true;
    source: LineMessageSource | null;
    lastSent: LineLastSent | null;
    messages: LineMessageKind[];
  }>("/api/line/messages");
  return { source: body.source, lastSent: body.lastSent ?? null, messages: body.messages };
}

export async function updateSettings(input: SettingsUpdate): Promise<Settings> {
  const body = await apiPut<{ ok: true; settings: Settings }>(
    "/api/settings",
    input,
  );
  return body.settings;
}

/**
 * บันทึก/ล้างค่าเชื่อมต่อ (LINE OA · SlipOK) — เจ้าของเท่านั้น (สมาชิกได้ 403)
 *
 * ส่งเฉพาะช่องที่ผู้ใช้แก้ ค่าว่าง = ล้างค่านั้นและกลับไปใช้ค่าเดิมของ wrangler secret
 */
export async function updateCredentials(
  input: CredentialsUpdate,
): Promise<IntegrationCredentials> {
  const body = await apiPut<{ ok: true; credentials: IntegrationCredentials }>(
    "/api/settings/credentials",
    input,
  );
  return body.credentials;
}

export async function regenerateOwnerCode(): Promise<string> {
  const body = await apiPost<{ ok: true; ownerLinkCode: string }>(
    "/api/settings/owner-code",
    {},
  );
  return body.ownerLinkCode;
}

/** เลิกเชื่อม LINE ของเจ้าของ — รหัสค้างถูกยกเลิกไปด้วย ต้องออกรหัสใหม่ถ้าจะเชื่อมอีก */
export async function unlinkOwnerLine(): Promise<void> {
  await apiDelete<{ ok: true }>("/api/settings/owner-link");
}

export interface LineChannelStatus {
  tokenConfigured: boolean;
  secretConfigured: boolean;
  bot: { displayName: string; basicId: string } | null;
  webhook: { endpoint: string; active: boolean } | null;
  webhookPointsHere: boolean;
  expectedWebhookEndpoint: string;
  liffId: string;
}

export async function fetchLineChannel(): Promise<LineChannelStatus> {
  const body = await apiGet<{ ok: true; channel: LineChannelStatus }>(
    "/api/settings/line-channel",
  );
  return body.channel;
}

/** ตั้ง webhook ของช่อง LINE ให้ชี้กลับมาที่ Worker นี้ (ใช้ตอนเปลี่ยน OA) */
export async function setLineWebhook(): Promise<string> {
  const body = await apiPost<{ ok: true; endpoint: string }>(
    "/api/settings/line-channel/webhook",
    {},
  );
  return body.endpoint;
}

export async function fetchBills(period: string): Promise<Bill[]> {
  const body = await apiGet<{ ok: true; period: string; bills: Bill[] }>(
    `/api/bills?period=${encodeURIComponent(period)}`,
  );
  return body.bills;
}

export async function fetchBillPeriods(): Promise<string[]> {
  const body = await apiGet<{ ok: true; periods: string[] }>(
    "/api/bills/periods",
  );
  return body.periods;
}

export async function fetchBillsRange(from: string, to: string): Promise<Bill[]> {
  const body = await apiGet<{ ok: true; from: string; to: string; bills: Bill[] }>(
    `/api/bills/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return body.bills;
}

export interface BillsFocus {
  roomNumber: string;
  period: string;
}

export function billsFocusTarget(
  room: { roomNumber: string; lastElectricPeriod: string | null },
  fallbackPeriod: string | null,
): BillsFocus {
  return {
    roomNumber: room.roomNumber,
    period: room.lastElectricPeriod ?? fallbackPeriod ?? "",
  };
}

export function billsFocusHash(focus: BillsFocus): string {
  const params = new URLSearchParams();
  params.set("room", focus.roomNumber);

  if (focus.period !== "") {
    params.set("period", focus.period);
  }

  return `#bills?${params.toString()}`;
}

export function billsFocusOf(hash: string): BillsFocus | null {
  const [routePart = "", searchPart = ""] = hash.replace(/^#/, "").split("?");

  if (routePart !== "bills" || searchPart === "") {
    return null;
  }

  const params = new URLSearchParams(searchPart);
  const roomNumber = params.get("room") ?? "";

  if (roomNumber === "") {
    return null;
  }

  return { roomNumber, period: params.get("period") ?? "" };
}

export async function fetchMeterSheet(
  period: string,
): Promise<MeterSheetRow[]> {
  const body = await apiGet<{
    ok: true;
    period: string;
    rows: MeterSheetRow[];
  }>(`/api/bills/meter-sheet?period=${encodeURIComponent(period)}`);
  return body.rows;
}

export async function generateBills(
  period: string,
  entries: BillEntryInput[],
): Promise<Bill[]> {
  const body = await apiPost<{ ok: true; bills: Bill[] }>(
    "/api/bills/generate",
    { period, entries },
  );
  return body.bills;
}

export async function updateBill(id: string, input: BillUpdate): Promise<Bill> {
  const body = await apiPatch<{ ok: true; bill: Bill }>(
    `/api/bills/${encodeURIComponent(id)}`,
    input,
  );
  return body.bill;
}

export async function deleteBill(id: string): Promise<void> {
  await apiDelete<{ ok: true }>(`/api/bills/${encodeURIComponent(id)}`);
}

export async function markBillPaid(
  id: string,
  input: BillPaidInput,
): Promise<Bill> {
  const body = await apiPost<{ ok: true; bill: Bill }>(
    `/api/bills/${encodeURIComponent(id)}/mark-paid`,
    input,
  );
  return body.bill;
}

export interface SkippedBill {
  roomNumber: string;
  tenantName: string;
}

export interface SendAllResult {
  period: string;
  sent: number;
  failed: number;
  failedIds: string[];
  skipped: SkippedBill[];
}

export async function sendBill(id: string): Promise<Bill> {
  const body = await apiPost<{ ok: true; bill: Bill }>(
    `/api/bills/${encodeURIComponent(id)}/send`,
    {},
  );
  return body.bill;
}

export async function sendBills(
  period: string,
  billIds?: string[],
): Promise<SendAllResult> {
  const body = await apiPost<{
    ok: true;
    period: string;
    sent: number;
    failed: number;
    failedIds: string[];
    skipped: SkippedBill[];
  }>(
    "/api/bills/send-all",
    billIds === undefined ? { period } : { period, billIds },
  );

  return {
    period: body.period,
    sent: body.sent,
    failed: body.failed,
    failedIds: body.failedIds,
    skipped: body.skipped,
  };
}

export type SlipStatus = "pending_review" | "matched" | "rejected";

export type SlipReason =
  | "mismatch"
  | "not_verified"
  | "no_unpaid_bill"
  | "duplicate_slip"
  | "verify_failed";

export type SlipResolveAction = "settle" | "reject";

export interface SlipBill {
  id: string;
  roomNumber: string;
  tenantName: string;
  period: string;
  total: number;
}

export interface Slip {
  id: string;
  createdAt: string;
  imageKey: string;
  imageUrl: string;
  status: SlipStatus;
  reason: SlipReason | null;
  slipAmount: number | null;
  bill: SlipBill | null;
  verified: boolean;
  verify: {
    verified: boolean;
    transRef: string | null;
    date: string | null;
    code: number | null;
    message: string | null;
    detail: string | null;
    usedSlipId: string | null;
  };
  transferAt: string | null;
}

export interface SlipQuery {
  status?: SlipStatus;
  billId?: string;
}

export async function fetchSlips(query: SlipQuery = {}): Promise<Slip[]> {
  const params = new URLSearchParams();

  if (query.status !== undefined) {
    params.set("status", query.status);
  }

  if (query.billId !== undefined) {
    params.set("billId", query.billId);
  }

  const search = params.toString();
  const body = await apiGet<{ ok: true; slips: Slip[] }>(
    `/api/slips${search === "" ? "" : `?${search}`}`,
  );

  return body.slips;
}

export async function resolveSlip(
  id: string,
  action: SlipResolveAction,
  billId?: string,
): Promise<Slip> {
  const payload: { action: SlipResolveAction; billId?: string } =
    billId === undefined ? { action } : { action, billId };
  const body = await apiPost<{ ok: true; slip: Slip }>(
    `/api/slips/${encodeURIComponent(id)}/resolve`,
    payload,
  );

  return body.slip;
}

export const reviewQueueChangedEvent = "wangchan:review-queue-changed";

export function announceReviewQueueChanged(): void {
  // ผู้ฟังโหลดข้อมูลใหม่ทันที — ต้องล้างก่อน ไม่งั้นได้แคชเก่ากลับไป
  clearApiCache();
  const target = globalThis as unknown as EventTarget;
  target.dispatchEvent(new Event(reviewQueueChangedEvent));
}

export const billsChangedEvent = "wangchan:bills-changed";

/** บอกหน้ารายการบิลว่าชุดบิลเปลี่ยนแล้ว (สร้าง/ส่ง/แก้/ลบ) ให้โหลดใหม่ */
export function announceBillsChanged(): void {
  // ผู้ฟังโหลดข้อมูลใหม่ทันที — ต้องล้างก่อน ไม่งั้นได้แคชเก่ากลับไป
  clearApiCache();
  const target = globalThis as unknown as EventTarget;
  target.dispatchEvent(new Event(billsChangedEvent));
}

export const tenantsChangedEvent = "wangchan:tenants-changed";

/**
 * บอกว่าชุดผู้เช่าเปลี่ยนแล้ว (ลงทะเบียนใหม่/เชื่อม LINE ให้)
 *
 * ต้องมีเพราะการลงทะเบียนเกิดบนอุปกรณ์ของ **ผู้เช่า** (LIFF) ไม่ใช่ในแท็บนี้
 * หน้าผู้เช่าจึงไม่มีทางรู้ถ้าไม่มีสัญญาณ — และแดชบอร์ดนับจำนวนห้องว่างกับ
 * จำนวนผู้เช่าจากข้อมูลชุดเดียวกัน
 */
export function announceTenantsChanged(): void {
  // ผู้ฟังโหลดข้อมูลใหม่ทันที — ต้องล้างก่อน ไม่งั้นได้แคชเก่ากลับไป
  clearApiCache();
  const target = globalThis as unknown as EventTarget;
  target.dispatchEvent(new Event(tenantsChangedEvent));
}

export interface DashboardKpis {
  bills: number;
  dueAmount: number;
  collectedAmount: number;
  unpaidAmount: number;
  unpaidRooms: number;
  unbilledRooms: number;
  vacantRooms: number;
  totalRooms: number;
  sentCount: number;
  paidCount: number;
}

export interface RevenuePoint {
  period: string;
  amount: number;
  unpaidAmount: number;
  hasBills: boolean;
}

export interface UnpaidBillStat {
  id: string;
  roomNumber: string;
  tenantName: string;
  total: number;
  createdAt: string;
  sentAt: string | null;
  hasPendingSlip: boolean;
}

export type DashboardRoomStatus = "paid" | "unpaid" | "unbilled" | "vacant";

export interface DashboardRoom {
  id: string;
  roomNumber: string;
  status: DashboardRoomStatus;
  hasPendingSlip: boolean;
  hasMismatchSlip: boolean;
  hasLine: boolean;
  lastBilledPeriod: string | null;
  behindPeriods: number;
  /** บิลค้างของงวดก่อน ๆ ที่ยังไม่ได้รับเงิน (ไม่นับงวดที่กำลังดูอยู่) */
  arrears: DashboardArrears;
}

export interface DashboardArrears {
  periods: string[];
  amount: number;
}

export interface DashboardStats {
  period: string;
  latestBilledPeriod: string | null;
  kpis: DashboardKpis;
  revenue: RevenuePoint[];
  unpaidBills: UnpaidBillStat[];
  rooms: DashboardRoom[];
}

export async function fetchDashboardStats(
  period: string,
): Promise<DashboardStats> {
  const body = await apiGet<{ ok: true } & DashboardStats>(
    `/api/stats/dashboard?period=${encodeURIComponent(period)}`,
  );

  return {
    period: body.period,
    latestBilledPeriod: body.latestBilledPeriod,
    kpis: body.kpis,
    revenue: body.revenue,
    unpaidBills: body.unpaidBills,
    rooms: body.rooms,
  };
}

export type FamilyRole = "owner" | "member";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: FamilyRole;
  familyId: string;
}

export async function fetchMe(): Promise<AuthUser> {
  const body = await apiGet<{ ok: true; user: AuthUser }>("/api/auth/me");
  return body.user;
}

export async function fetchDemoStatus(): Promise<boolean> {
  const body = await apiGet<{ ok: true; demoMode: boolean }>("/api/demo/status");
  return body.demoMode;
}

export async function logout(): Promise<void> {
  await apiPost<{ ok: true }>("/api/auth/logout", {});
}

/** เข้าสู่ระบบด้วยชื่อผู้ใช้/รหัสผ่าน — สำเร็จแล้วเซิร์ฟเวอร์ตั้งคุกกี้เซสชันให้เอง */
export async function loginWithPassword(username: string, password: string): Promise<void> {
  await apiPost<{ ok: true }>("/api/auth/login", { username, password });
}

export interface CredentialsStatus {
  username: string | null;
  hasPassword: boolean;
}

export async function fetchCredentials(): Promise<CredentialsStatus> {
  const body = await apiGet<{ ok: true } & CredentialsStatus>("/api/auth/credentials");
  return { username: body.username, hasPassword: body.hasPassword };
}

export async function saveCredentials(username: string, password: string): Promise<CredentialsStatus> {
  const body = await apiPut<{ ok: true } & CredentialsStatus>("/api/auth/credentials", { username, password });
  return { username: body.username, hasPassword: body.hasPassword };
}

/**
 * ประวัติแจ้งเตือนของผู้ใช้คนนี้จากเซิร์ฟเวอร์ (ใหม่สุดก่อน) พร้อมลำดับล่าสุดที่เห็น
 * ใช้ส่งกลับตอนกดอ่าน/ล้าง ดูเหตุผลที่ `notificationsFromServer`
 */
export async function fetchNotifications(): Promise<{ items: AppNotification[]; newestSeq: number }> {
  const body = await apiGet<{ ok: true; notifications: unknown }>("/api/notifications");
  return notificationsFromServer(body.notifications);
}

/** บันทึกว่าอ่านถึงลำดับนี้แล้ว (ตอนเปิดแผง) */
export async function markNotificationsRead(through: number): Promise<void> {
  await apiPost<{ ok: true }>("/api/notifications/read", { through });
}

/** ล้างประวัติของผู้ใช้คนนี้ถึงลำดับนี้ */
export async function clearNotifications(through: number): Promise<void> {
  await apiPost<{ ok: true }>("/api/notifications/clear", { through });
}

/** ปลายทางเริ่มล็อกอินด้วย Google — พาเบราว์เซอร์ไปทั้งหน้า ไม่ใช่ fetch */
export const googleSignInPath = "/api/auth/google/start";

/**
 * ลิงก์เริ่มล็อกอินที่พา "ที่หมาย" ติดไปด้วย
 *
 * fragment ไม่ถูกส่งไปเซิร์ฟเวอร์ จึงต้องยัดเป็น query ให้เซิร์ฟเวอร์อ่านแล้วฝาก
 * ในคุกกี้ข้าม OAuth — ที่หมายที่ปลอดภัยต้องขึ้นต้นด้วย `#` เท่านั้น เบราว์เซอร์
 * จึงไม่ตีความเป็นอย่างอื่น
 */
export function googleSignInUrl(hash: string): string {
  if (!hash.startsWith("#") || hash.length <= 1) {
    return googleSignInPath;
  }

  return `${googleSignInPath}?next=${encodeURIComponent(hash)}`;
}

export interface InvitePreview {
  /** ชื่อหอที่คำเชิญชวนไปร่วม */
  familyName: string;
  /** อีเมลที่คำเชิญผูกไว้ — เซิร์ฟเวอร์เป็นคนกำหนด ผู้ใช้แก้ไม่ได้ */
  email: string;
  expiresAt: string;
}

/**
 * ดูข้อมูลคำเชิญจากโทเคน ก่อนให้ผู้รับกดเข้าสู่ระบบด้วย Google
 *
 * ทำให้หน้าคำเชิญบอกได้ว่าใครเชิญไปหอไหน และรู้ทันทีถ้าลิงก์ใช้ไม่ได้
 * เส้นทางนี้เปิดให้ไม่ต้องล็อกอิน เพราะคนที่เปิดลิงก์ยังไม่มีบัญชี
 */
export async function fetchInvitePreview(token: string): Promise<InvitePreview> {
  const body = await apiGet<{ ok: true } & InvitePreview>(
    `/api/auth/invites/${encodeURIComponent(token)}`,
  );

  return {
    familyName: body.familyName,
    email: body.email,
    expiresAt: body.expiresAt,
  };
}

export interface FamilyInfo {
  id: string;
  name: string;
}

export interface FamilyMember {
  userId: string;
  email: string;
  displayName: string;
  role: FamilyRole;
  joinedAt: string;
}

export interface FamilyInvite {
  id: string;
  email: string;
  role: FamilyRole;
  createdAt: string;
  expiresAt: string;
}

export interface FamilyOverview {
  family: FamilyInfo;
  members: FamilyMember[];
  invites: FamilyInvite[];
  /** เพดานสมาชิกต่อครอบครัว — เซิร์ฟเวอร์เป็นเจ้าของตัวเลขนี้ ฝั่งจอไม่ต้องจำเอง */
  maxMembers: number;
}

export interface CreatedInvite {
  email: string;
  role: FamilyRole;
  expiresAt: string;
  /** คืนมาเต็มครั้งเดียวตอนออกคำเชิญเท่านั้น ฐานข้อมูลเก็บแค่ค่าแฮช */
  token: string;
  url: string;
}

export async function fetchFamily(): Promise<FamilyOverview> {
  const body = await apiGet<{ ok: true } & FamilyOverview>("/api/family");

  return {
    family: body.family,
    members: body.members,
    invites: body.invites,
    maxMembers: body.maxMembers,
  };
}

export async function renameFamily(name: string): Promise<FamilyInfo> {
  const body = await apiPatch<{ ok: true; family: FamilyInfo }>(
    "/api/family",
    { name },
  );

  return body.family;
}

export async function createFamilyInvite(
  email: string,
  role: FamilyRole,
): Promise<CreatedInvite> {
  const body = await apiPost<{ ok: true; invite: CreatedInvite }>(
    "/api/family/invites",
    { email, role },
  );

  return body.invite;
}

export async function revokeFamilyInvite(id: string): Promise<void> {
  await apiDelete<{ ok: true }>(
    `/api/family/invites/${encodeURIComponent(id)}`,
  );
}

export async function setFamilyMemberRole(
  userId: string,
  role: FamilyRole,
): Promise<void> {
  await apiPatch<{ ok: true }>(
    `/api/family/members/${encodeURIComponent(userId)}`,
    { role },
  );
}

export async function removeFamilyMember(userId: string): Promise<void> {
  await apiDelete<{ ok: true }>(
    `/api/family/members/${encodeURIComponent(userId)}`,
  );
}
