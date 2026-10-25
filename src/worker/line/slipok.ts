import { demoModeOn, failureDetail, lineUploadTimeoutMs, logLineFailure } from "./api";
import { asRecord } from "../routes/shared";

const slipOkEndpointBase = "https://api.slipok.com/api/line/apikey";

/** บัญชีผู้รับที่ผู้ให้บริการอ่านได้จากสลิป ค่าที่ได้ถูกปิดบางส่วนตามรูปแบบของแต่ละธนาคาร */
export interface SlipReceiver {
  proxyType: string | null;
  proxyValue: string | null;
  accountValue: string | null;
}

export interface SlipOkResult {
  verified: boolean;
  amount: number | null;
  transRef: string | null;
  date: string | null;
  duplicate: boolean;
  receiverMismatch: boolean;
  receiver: SlipReceiver | null;
  /**
   * รหัสและข้อความจากผู้ให้บริการ — เก็บไว้ให้หน้ารอตรวจบอกได้ว่า "ตรวจไม่ผ่าน
   * จากอะไร" เพราะ `verified: false` อย่างเดียวแยกไม่ออกระหว่างสลิปปลอม
   * รูปอ่านไม่ออก ธนาคารล่ม หรือยอดไม่ตรง
   */
  code: number | null;
  message: string | null;
  raw: unknown;
}

function notVerified(raw: unknown = null, duplicate = false): SlipOkResult {
  return {
    verified: false,
    amount: null,
    transRef: null,
    date: null,
    duplicate,
    receiverMismatch: false,
    receiver: null,
    code: readCode(asRecord(raw)?.code),
    message: readText(asRecord(raw)?.message),
    raw,
  };
}

function credential(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function imageExtension(contentType: string): string {
  if (contentType === "image/jpeg") {
    return "jpg";
  }

  if (contentType === "image/webp") {
    return "webp";
  }

  return "png";
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  const record = asRecord(value);

  if (record === null) {
    return null;
  }

  return readAmount(record.amount);
}

function readCode(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTransRef(data: Record<string, unknown>): string | null {
  for (const key of ["transRef", "transRef1", "transactionRef", "ref", "reference"]) {
    const value = readText(data[key]);

    if (value !== null) {
      return value;
    }
  }

  return null;
}

/**
 * SlipOK ส่งเวลาของสลิปมาเป็น transTimestamp (ISO 8601) หรือ transDate
 * (yyyyMMdd) คู่กับ transTime (HH:mm:ss) ตามเวลาประเทศไทย
 */
function readTimestamp(data: Record<string, unknown>): string | null {
  const timestamp = readText(data.transTimestamp);

  if (timestamp !== null) {
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const date = readText(data.transDate);

  if (date === null || !/^\d{8}$/.test(date)) {
    return null;
  }

  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

  if (Number.isNaN(new Date(`${isoDate}T00:00:00+07:00`).getTime())) {
    return null;
  }

  const time = readText(data.transTime);

  if (time === null || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    return isoDate;
  }

  const combined = `${isoDate}T${time.length === 5 ? `${time}:00` : time}+07:00`;
  return Number.isNaN(new Date(combined).getTime()) ? isoDate : combined;
}

function readReceiver(data: Record<string, unknown>): SlipReceiver | null {
  const receiver = asRecord(data.receiver);

  if (receiver === null) {
    return null;
  }

  const proxy = asRecord(receiver.proxy);
  const account = asRecord(receiver.account);
  const parsed: SlipReceiver = {
    proxyType: proxy === null ? null : readText(proxy.type),
    proxyValue: proxy === null ? null : readText(proxy.value),
    accountValue: account === null ? null : readText(account.value),
  };

  return parsed.proxyValue === null && parsed.accountValue === null ? null : parsed;
}

function verifiedResult(payload: unknown, data: Record<string, unknown>): SlipOkResult {
  const root = asRecord(payload);

  return {
    verified: true,
    amount: readAmount(data.amount),
    transRef: readTransRef(data),
    date: readTimestamp(data),
    duplicate: false,
    receiverMismatch: false,
    receiver: readReceiver(data),
    code: readCode(root?.code),
    message: readText(root?.message),
    raw: payload,
  };
}

function amountMismatch(payload: unknown, root: Record<string, unknown>): SlipOkResult {
  const result = verifiedResult(payload, asRecord(root.data) ?? {});

  return { ...result, amount: result.amount ?? readAmount(root.amount) };
}

/** รหัส 1014 คือสลิปจริงแต่โอนเข้าบัญชีที่ไม่ใช่บัญชีรับเงินที่ผูกกับสาขา */
function receiverMismatch(payload: unknown, root: Record<string, unknown>): SlipOkResult {
  const data = asRecord(root.data) ?? {};

  return {
    ...verifiedResult(payload, data),
    verified: false,
    receiverMismatch: true,
  };
}

/**
 * รหัส 1012 = ผู้ให้บริการเคยเห็นสลิปใบนี้แล้ว
 *
 * ตัว payload ยังมี transRef/amount/เวลาของรายการโอนครบ จึงต้องอ่านเก็บไว้
 * เหมือนสลิปปกติ ไม่ใช่ทิ้งเป็น null — เลขอ้างอิงคือสิ่งเดียวที่ทำให้เรารู้ว่า
 * "ซ้ำกับใบไหน" และเจ้าของหอต้องใช้เทียบกับรายการเดินบัญชี การทิ้งค่านี้ทำให้
 * ข้อความ "สลิปนี้ถูกใช้ปิดบิลไปแล้ว" กลายเป็นคำกล่าวอ้างที่ตรวจสอบไม่ได้
 */
function duplicateSlip(payload: unknown, root: Record<string, unknown>): SlipOkResult {
  return {
    ...verifiedResult(payload, asRecord(root.data) ?? {}),
    verified: false,
    duplicate: true,
  };
}

function normalise(payload: unknown): SlipOkResult {
  const root = asRecord(payload);

  if (root === null) {
    return notVerified(payload);
  }

  if (root.success !== true) {
    const code = readCode(root.code);

    if (code === 1012) {
      return duplicateSlip(payload, root);
    }

    if (code === 1013) {
      return amountMismatch(payload, root);
    }

    if (code === 1014) {
      return receiverMismatch(payload, root);
    }

    return notVerified(payload);
  }

  const data = asRecord(root.data);

  if (data === null || data.success === false) {
    return notVerified(payload);
  }

  const amount = readAmount(data.amount);

  if (amount === null) {
    return notVerified(payload);
  }

  return verifiedResult(payload, data);
}

/** บัญชีรับเงินของหอตามที่ตั้งไว้ในหน้าตั้งค่า */
export interface SlipPayee {
  proxyType: "MSISDN" | "NATID";
  proxyId: string;
  accountNumber: string;
}

export type ReceiverVerdict = "match" | "mismatch" | "unknown";

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * ค่าบัญชีผู้รับจากสลิปถูกปิดบางส่วนเสมอ จึงเทียบได้เต็มรูปแบบเฉพาะเมื่อ
 * ไม่มีตัวปิด
 *
 * ตัวปิดไม่ได้เปิดเลขท้ายเสมอไป — กสิกรเปิดหลักที่ 6-9 แล้วปิดหลักสุดท้าย
 * (`xxx-x-x6385-x` ของบัญชี 9662563851) การเทียบเลขท้าย 4 ตัวจึงตีบัญชีที่ถูกต้อง
 * ว่าโอนผิดบัญชี เมื่อความยาวเท่ากันจึงเทียบทีละตำแหน่ง โดยตัวปิดเป็นตัวแทนของ
 * ตัวอะไรก็ได้ ส่วนความยาวไม่เท่ากัน (เทียบตำแหน่งไม่ได้) ค่อยถอยไปเทียบเลขท้าย
 */
function maskedOrExactMatch(received: string, expected: string): boolean {
  const receivedDigits = digitsOnly(received);
  const expectedDigits = digitsOnly(expected);

  if (receivedDigits === "" || expectedDigits === "") {
    return false;
  }

  if (receivedDigits === expectedDigits) {
    return true;
  }

  if (!/[x*]/i.test(received)) {
    return false;
  }

  const receivedCells = received.replace(/[\s-]/g, "");

  if (receivedCells.length === expectedDigits.length && /^[\dx*]+$/i.test(receivedCells)) {
    return [...receivedCells].every((cell, index) => /[x*]/i.test(cell) || cell === expectedDigits[index]);
  }

  const tail = Math.min(4, receivedDigits.length, expectedDigits.length);
  return receivedDigits.slice(-tail) === expectedDigits.slice(-tail);
}

/**
 * เทียบผู้รับเงินบนสลิปกับบัญชีที่หอตั้งไว้
 *
 * "unknown" แปลว่าเทียบไม่ได้เลย (ไม่มีข้อมูลฝั่งใดฝั่งหนึ่ง) ซึ่งต่างจาก
 * "mismatch" ที่พิสูจน์ได้ว่าโอนเข้าบัญชีอื่น
 */
export function compareReceiver(receiver: SlipReceiver | null, payee: SlipPayee): ReceiverVerdict {
  const pairs: Array<[string, string]> = [];
  const proxyId = digitsOnly(payee.proxyId);
  const accountNumber = digitsOnly(payee.accountNumber);

  if (proxyId !== "" && receiver !== null && receiver.proxyValue !== null && receiver.proxyType === payee.proxyType) {
    pairs.push([receiver.proxyValue, proxyId]);
  }

  if (accountNumber !== "" && receiver !== null && receiver.accountValue !== null) {
    pairs.push([receiver.accountValue, accountNumber]);
  }

  if (pairs.length === 0) {
    return "unknown";
  }

  return pairs.some(([received, expected]) => maskedOrExactMatch(received, expected)) ? "match" : "mismatch";
}

/**
 * รหัสที่แปลว่า "ยังตัดสินสลิปไม่ได้" ไม่ใช่ "สลิปไม่ผ่าน"
 *
 * 1001/1002 คือเราตั้งค่าสาขาหรือคีย์ผิด, 1003/1004 คือแพ็กเกจของเราหมดอายุหรือเกินโควตา,
 * 1009/1010 คือฝั่งธนาคารยังไม่พร้อม — ทั้งหมดลองใหม่แล้วอาจผ่าน ต่างจาก 1007
 * (รูปไม่มี QR) ซึ่งเป็นคำตอบแน่ชัดว่ารูปนี้ใช้ปิดบิลไม่ได้
 */
const providerIssueCodes = new Set([1001, 1002, 1003, 1004, 1009, 1010]);

export interface SlipVerifyOutcome {
  result: SlipOkResult;
  /** true เมื่อ "ตรวจไม่ได้" (ไม่ใช่คำตอบว่าไม่จริง) เพราะคีย์หาย เน็ตล่ม หรือผู้ให้บริการล่ม */
  failed: boolean;
  /** เหตุผลที่ตรวจไม่ได้ ใช้ทั้งใน log และในหน้ารอตรวจ */
  failure: string | null;
}

function outcome(result: SlipOkResult, failed: boolean, failure: string | null): SlipVerifyOutcome {
  return { result, failed, failure };
}

export async function verifySlip(
  env: Env,
  imageBytes: ArrayBuffer,
  contentType: string,
  expectedAmount: number | null,
): Promise<SlipVerifyOutcome> {
  if (demoModeOn(env)) {
    logLineFailure("slipok verify skipped", "demo mode: outbound disabled");
    return outcome(notVerified(), true, "demo mode: outbound disabled");
  }

  const key = credential(env.SLIPOK_API_KEY);
  const branchId = credential(env.SLIPOK_BRANCH_ID);

  if (key === "") {
    logLineFailure("slipok verify skipped", "SLIPOK_API_KEY is not configured");
    return outcome(notVerified(), true, "SLIPOK_API_KEY is not configured");
  }

  if (branchId === "") {
    logLineFailure("slipok verify skipped", "SLIPOK_BRANCH_ID is not configured");
    return outcome(notVerified(), true, "SLIPOK_BRANCH_ID is not configured");
  }

  if (imageBytes.byteLength === 0) {
    logLineFailure("slipok verify skipped", "slip image is empty");
    return outcome(notVerified(), true, "slip image is empty");
  }

  const body = new FormData();
  body.append("files", new Blob([imageBytes], { type: contentType }), `slip.${imageExtension(contentType)}`);

  // log=true คือให้ผู้ให้บริการเทียบบัญชีผู้รับกับบัญชีที่ผูกกับสาขาและกันสลิปซ้ำ
  // ถ้าปิดค่านี้ สลิปที่โอนเข้าบัญชีอื่นจะผ่านเข้ามาปิดบิลได้
  body.append("log", "true");

  if (expectedAmount !== null) {
    body.append("amount", String(expectedAmount));
  }

  try {
    const response = await fetch(`${slipOkEndpointBase}/${encodeURIComponent(branchId)}`, {
      method: "POST",
      headers: { "x-authorization": key },
      body,
      signal: AbortSignal.timeout(lineUploadTimeoutMs),
    });

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      const detail = `status ${String(response.status)}: response is not json`;
      logLineFailure("slipok verify failed", detail);
      return outcome(notVerified(), true, detail);
    }

    // SlipOK ตอบ HTTP 400 ให้ทุก error code ที่เป็นผลการตรวจ (1012/1013/1014
    // และรหัสอื่น ๆ) ตัวตัดสินจริงคือ code ใน body ไม่ใช่สถานะ HTTP ถ้าเช็ค
    // response.ok ก่อน สลิปที่โอนผิดบัญชีจะกลายเป็น "ตรวจไม่ผ่าน" ธรรมดา
    // เลขอ้างอิงกับยอดที่ผู้ให้บริการอ่านได้จะถูกทิ้ง และรหัส 1012 จะไม่ถูก
    // ปฏิเสธเป็นสลิปซ้ำ — จึงอ่าน payload ก่อน แล้วใช้ status เป็นเพียง
    // ข้อมูลประกอบเมื่อ payload ไม่ได้บอกอะไรเลย
    const result = normalise(payload);

    if (!result.verified && !result.duplicate && !result.receiverMismatch) {
      const code = readCode(asRecord(payload)?.code);
      const message = readText(asRecord(payload)?.message);
      const detail = `status ${String(response.status)} code ${code === null ? "unknown" : String(code)}${message === null ? "" : `: ${message}`}`;
      logLineFailure("slipok verify rejected", detail);

      // "ตรวจไม่ได้" มีสองหน้าตา: รหัสที่บอกว่ายังตัดสินสลิปไม่ได้ (ธนาคารไม่พร้อม
      // แพ็กเกจเราหมดอายุ) หรือไม่มีรหัสตอบกลับมาเลยพร้อม HTTP ที่ไม่สำเร็จ
      // ส่วน payload ที่มีรหัสและไม่ใช่กลุ่มนั้นคือคำตอบของจริง แม้ HTTP จะเป็น 400
      // เพราะ SlipOK ใช้ 400 กับผลการตรวจทุกชนิด — 1007 จึงเป็น "ตรวจแล้วไม่ผ่าน"
      const cannotCheck =
        code === null ? !response.ok : providerIssueCodes.has(code);

      return cannotCheck ? outcome(notVerified(payload), true, detail) : outcome(result, false, null);
    }

    if (result.duplicate) {
      logLineFailure("slipok verify duplicate", "the provider reports this slip was already submitted");
      return outcome(result, false, null);
    }

    if (result.receiverMismatch) {
      logLineFailure("slipok verify receiver mismatch", "the provider reports the receiver is not this branch's account");
    }

    return outcome(result, false, null);
  } catch (error) {
    const detail = failureDetail(error);
    logLineFailure("slipok verify failed", detail);
    return outcome(notVerified(), true, detail);
  }
}
