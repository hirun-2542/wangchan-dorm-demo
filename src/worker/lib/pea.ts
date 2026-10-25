import { readBodyWithin } from "../line/api";
import { asRecord } from "../routes/shared";

/**
 * ประวัติบิลของการไฟฟ้าส่วนภูมิภาค (PEA)
 *
 * หน้า https://www.pea.co.th/our-services/bill-history เรียก API เดียวกันนี้
 * จากเบราว์เซอร์ด้วย POST แบบไม่ต้องล็อกอิน: { ca, peano, lang:"th" } แล้วอ่าน
 * `response.data` เป็นรายการบิล (ดูสคริปต์ในหน้าเว็บจริง ไม่ได้เดาจากเอกสาร)
 *
 * ค่าที่หน้านั้นใช้แสดงผลต่อแถว: `billperiod` (ป้ายเดือนของ PEA), `totalAmountInv`
 * (ยอดเงิน), `unit` (หน่วย), `paydate` (วันที่ชำระ) — worker จึงคงชื่อเดิมไว้
 * ทั้งหมดและไม่แปลง `billperiod` เป็นรูปแบบเดือนของแอป เพราะการเดาเดือนผิด
 * ทำให้ผู้ใช้นำยอดของเดือนอื่นไปออกบิล
 */

export interface PeaAccount {
  /** ปลายทางที่จำคู่ CA/มิเตอร์ไว้ — "shared" หรือ id ของห้องที่มีอยู่ในหอ */
  target: string;
  ca: string;
  peano: string;
}

export interface PeaBill {
  /** ป้ายงวดจาก PEA ตามที่ได้รับมา (ไม่แปลง ไม่เดาเดือน) */
  billPeriod: string;
  amount: number;
  units: number;
  /** วันที่ชำระตามที่ PEA ส่งมา — null เมื่อไม่มี */
  paidAt: string | null;
  /**
   * เลขมิเตอร์ที่ PEA จดล่าสุด (`unitAfter`) — null เมื่อ PEA ไม่ส่งมาหรือ `unitAfter - unitPrev`
   * ไม่ตรงกับ `unit` ของใบเดียวกัน (แปลว่าเราเข้าใจความหมายของช่องผิด จึงไม่ยกไปใช้)
   */
  meter: number | null;
}

/** ปลายทางเดียวที่ไม่ใช่ห้อง = กล่องไฟรวมของหอ */
export const peaSharedTarget = "shared";

/** ที่อยู่ตายตัว ไม่รับจากผู้เรียก — กัน SSRF ผ่านค่า target/พารามิเตอร์ */
export const peaHistoryUrl = "https://www.pea.co.th/api/bill-history";

/**
 * PEA ตอบ "ไม่พบข้อมูลที่สอบถาม" กับคำขอที่ไม่มี Origin/Referer ของหน้าตัวเอง แม้หมายเลขถูกต้อง
 * (วัดจริงด้วยคู่หมายเลขที่ใช้ได้: ไม่มีสองหัวนี้ → ไม่พบ, มี → ได้ประวัติครบ; UA/cookie ไม่เกี่ยว)
 * จึงต้องส่งสองหัวนี้ — นี่คือ endpoint ภายในของหน้าเว็บ ไม่ใช่ API สาธารณะ อาจเปลี่ยนได้โดยไม่แจ้ง
 */
export const peaPageOrigin = "https://www.pea.co.th";
export const peaPageReferer = "https://www.pea.co.th/our-services/bill-history";

/** ทุกคำขอออกนอก Worker ต้องมีเพดานเวลา (แบบเดียวกับ LINE/SlipOK) */
export const peaOutboundTimeoutMs = 10_000;

/** ประวัติ 6 เดือนมีขนาดเล็กมาก — เพดานนี้กันเนื้อหาผิดปกติไม่ให้กินหน่วยความจำ */
export const maxPeaResponseBytes = 64 * 1024;

/** settings ของครอบครัว: `pea_account:<target>` เก็บ JSON { ca, peano } */
export const peaAccountSettingPrefix = "pea_account:";

export const peaRejectedMessage = "ตรวจสอบหมายเลขผู้ใช้ไฟฟ้า (CA) และรหัสเครื่องวัดอีกครั้ง";

export const peaUpstreamMessage =
  "ตรวจสอบข้อมูลกับการไฟฟ้าไม่สำเร็จ กรุณาลองใหม่ภายหลัง";

export function peaAccountSettingKey(target: string): string {
  return `${peaAccountSettingPrefix}${target}`;
}

export type PeaLookupErrorKind = "rejected" | "upstream";

/**
 * `rejected` = PEA ตอบว่าคำขอไม่ถูกต้อง (ผู้ใช้แก้ไขเองได้ → 400)
 * `upstream` = ตอบผิดรูป/ช้า/ไม่ใช่ 2xx/ใหญ่เกิน (ผู้ใช้แก้ไม่ได้ → 502)
 */
export class PeaLookupError extends Error {
  readonly kind: PeaLookupErrorKind;

  constructor(kind: PeaLookupErrorKind, message: string) {
    super(message);
    this.name = "PeaLookupError";
    this.kind = kind;
  }
}

/**
 * เลขผู้ใช้ไฟฟ้า (CA) และเลขมิเตอร์เป็น "สตริงตัวเลข" 1–12 หลัก
 *
 * เก็บเป็นสตริงเพราะเลขมิเตอร์มีศูนย์นำหน้าได้ ถ้าแปลงเป็นตัวเลขแล้วศูนย์หาย
 * จะกลายเป็นเลขของผู้ใช้อื่น ตัดช่องว่างหัวท้ายเท่านั้น ไม่ตัดอักขระอื่น
 */
export function normalizePeaCredential(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return /^\d{1,12}$/.test(trimmed) ? trimmed : null;
}

/** ค่าที่จำไว้ใน settings — อ่านแบบเข้มงวด ค่าที่เสียหายถูกข้าม ไม่เดาแทน */
export function parseStoredPeaAccount(value: string): { ca: string; peano: string } | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  const record = asRecord(parsed);

  if (record === null) {
    return null;
  }

  const ca = normalizePeaCredential(record.ca);
  const peano = normalizePeaCredential(record.peano);

  return ca === null || peano === null ? null : { ca, peano };
}

/**
 * ยอดเงิน/หน่วยอาจมาเป็น number หรือสตริงตัวเลข ("1234.50")
 *
 * รับเฉพาะค่าที่ไม่ติดลบและเป็นตัวเลขจริง — ค่าติดลบ/มีหน่วยปน/ว่าง คือข้อมูล
 * ที่เราไม่เข้าใจ ไม่ใช่ค่าที่ควรเดา
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
}

function toPaidAt(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  // PEA ส่ง "N/A" สำหรับงวดที่ยังไม่ชำระ (เห็นจากบิลจริงของงวดล่าสุด)
  return trimmed === "" || trimmed.toUpperCase() === "N/A" ? null : trimmed;
}

/** แถวที่อ่านไม่ได้ทั้งแถว = null (ผู้เรียกตอบ 502 ไม่ใช่ข้ามแถวเงียบ ๆ) */
function parsePeaBillRow(row: unknown): PeaBill | null {
  const record = asRecord(row);

  if (record === null) {
    return null;
  }

  // เก็บป้ายงวดตามที่ PEA ส่งมาเป๊ะ ๆ (แค่ตัดสินว่าใช้ได้) — การ trim หรือแปลง
  // เป็นรูปแบบของแอปคือการตีความที่อาจจับคู่ผิดเดือน
  const rawPeriod = record.billperiod;

  if (typeof rawPeriod !== "string" || rawPeriod.trim() === "") {
    return null;
  }

  const billPeriod = rawPeriod;

  const amount = toFiniteNumber(record.totalAmountInv);

  if (amount === null) {
    return null;
  }

  const units = toFiniteNumber(record.unit);

  if (units === null) {
    return null;
  }

  const paidAt = toPaidAt(record.paydate);

  if (paidAt === undefined) {
    return null;
  }

  // เลขมิเตอร์เป็นข้อมูลเสริม: อ่านไม่ได้ไม่ทำให้ทั้งใบใช้ไม่ได้ (ยอดเงินยังนำไปใช้ได้)
  const meterAfter = toFiniteNumber(record.unitAfter);
  const meterPrev = toFiniteNumber(record.unitPrev);
  const meter =
    meterAfter !== null && meterPrev !== null && Math.abs(meterAfter - meterPrev - units) < 0.005
      ? meterAfter
      : null;

  return { billPeriod, amount, units, paidAt, meter };
}

function rejectionMessage(value: unknown): string {
  if (typeof value !== "string") {
    return peaRejectedMessage;
  }

  const trimmed = value.trim();

  // ข้อความจาก PEA เป็นภาษาไทยที่ผู้ใช้อ่านรู้เรื่อง — ส่งต่อได้ แต่จำกัดขนาด
  return trimmed === "" || trimmed.length > 200 ? peaRejectedMessage : trimmed;
}

/** วันจดมิเตอร์ของ PEA เป็น `YYYYMMDD` (เช่น "20261022") — ใช้เทียบหาแถวล่าสุดได้ตรง ๆ ตามตัวอักษร */
const peaMeterReadDate = /^\d{8}$/;

/**
 * เลือกบิลล่าสุดจากวันจดมิเตอร์ ไม่ใช่ตำแหน่งในรายการ (PEA ไม่รับประกันลำดับ)
 *
 * ไม่เดา: ถ้าแถวใดไม่มีวันจดที่อ่านได้ แถวนั้นอาจเป็นแถวที่ใหม่สุด และถ้ามีสองแถวใหม่สุด
 * วันเดียวกันก็ไม่มีหลักฐานว่าใบไหนล่าสุด — ทั้งสองกรณีถือเป็นคำตอบที่ใช้ไม่ได้ (502)
 * แถวที่เก่ากว่าไม่ถูกอ่านยอด จึงไม่ทำให้ใบล่าสุดล้มเพราะข้อมูลเก่าที่ผิดรูป
 */
function latestRow(rows: unknown[]): unknown {
  let latest: unknown;
  let latestDate = "";
  let tied = false;

  for (const row of rows) {
    const date = asRecord(row)?.mrdate;

    if (typeof date !== "string" || !peaMeterReadDate.test(date)) {
      throw new PeaLookupError("upstream", peaUpstreamMessage);
    }

    if (date > latestDate) {
      latest = row;
      latestDate = date;
      tied = false;
    } else if (date === latestDate) {
      tied = true;
    }
  }

  if (tied) {
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  return latest;
}

function parseEnvelope(text: string): PeaBill | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  const record = asRecord(parsed);

  if (record === null) {
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  if (record.result === false) {
    throw new PeaLookupError("rejected", rejectionMessage(record.message));
  }

  if (record.result !== true || !Array.isArray(record.data)) {
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  // สำเร็จแต่ไม่มีบิลเป็นเรื่องปกติ (เช่น เพิ่งย้ายเข้า) — ไม่มีบิลล่าสุดให้นำเข้า
  if (record.data.length === 0) {
    return null;
  }

  const bill = parsePeaBillRow(latestRow(record.data));

  if (bill === null) {
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  return bill;
}

/**
 * เรียก PEA แบบไม่เก็บข้อมูลผู้ใช้ลง log
 *
 * ทุกความล้มเหลวที่ผู้ใช้แก้ไม่ได้โยน `PeaLookupError("upstream")`; ผลลัพธ์ที่
 * PEA ปฏิเสธคำขอโยน `PeaLookupError("rejected")` พร้อมข้อความไทยของ PEA
 */
export async function fetchLatestPeaBill(ca: string, peano: string): Promise<PeaBill | null> {
  let response: Response;

  try {
    response = await fetch(peaHistoryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: peaPageOrigin,
        Referer: peaPageReferer,
      },
      body: JSON.stringify({ ca, peano, lang: "th" }),
      // Workers รองรับ manual/follow เท่านั้น; ไม่ตาม redirect และปฏิเสธ 3xx ด้านล่าง
      redirect: "manual",
      signal: AbortSignal.timeout(peaOutboundTimeoutMs),
    });
  } catch {
    // ไม่บันทึก error ดิบ เพราะข้อความของ fetch อาจมี URL/บริบทของผู้เรียก
    logPeaFailure("request");
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  if (!response.ok) {
    logPeaFailure(`status ${String(response.status)}`);
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  const declared = response.headers.get("content-length");

  if (declared !== null) {
    const size = Number.parseInt(declared, 10);

    if (Number.isFinite(size) && size > maxPeaResponseBytes) {
      logPeaFailure("oversize declared");
      throw new PeaLookupError("upstream", peaUpstreamMessage);
    }
  }

  let bytes: ArrayBuffer | null;

  try {
    bytes = await readBodyWithin(response, maxPeaResponseBytes);
  } catch {
    logPeaFailure("read");
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  if (bytes === null) {
    logPeaFailure("oversize body");
    throw new PeaLookupError("upstream", peaUpstreamMessage);
  }

  return parseEnvelope(new TextDecoder().decode(bytes));
}

/**
 * log แบบไม่มี CA/เลขมิเตอร์/เนื้อหาคำตอบ
 *
 * ตัวเลขสองตัวนี้ใช้ค้นข้อมูลการใช้ไฟของบ้านได้ จึงไม่ควรอยู่ใน log ของ Worker
 */
function logPeaFailure(reason: string): void {
  console.error(JSON.stringify({ message: "pea bill history failed", reason }));
}
