import type { Bill } from "./api";
import { electricUnitsOf } from "../shared/billing";

/**
 * จัดรูปบิลเป็นรายการชีตสำหรับสร้างไฟล์ Excel
 *
 * ทำไมต้องแยกเป็นโมดูลข้อมูลล้วน: ไฟล์ถูกสร้างในเบราว์เซอร์ (Worker ใกล้เต็มขนาด
 * จาก pdf-lib + ฟอนต์ไทย) การจัดรูปจึงต้องทดสอบได้โดยไม่ต้องมี DOM หรือ HTTP
 * และต้องไม่ผูกกับไลบรารีสร้างไฟล์ เพื่อให้เปลี่ยนไลบรารีได้โดยไม่แตะตรรกะนี้
 */

export type BillsExportColumnKind = "period" | "text" | "money" | "units";
export interface BillsExportColumn {
  header: string;
  kind: BillsExportColumnKind;
  width: number;
}
/** null = เซลล์ว่าง ใช้แยก "บิลไม่มีรายการนี้" ออกจาก "มีรายการนี้แต่มูลค่าศูนย์" */
export type BillsExportCell = string | number | Date | null;
export interface BillsExportSheet {
  name: string;
  columns: BillsExportColumn[];
  rows: BillsExportCell[][];
}

const excelNameLimit = 31;
const forbiddenSheetChars = /[\\/?*[\]:]/g;

/**
 * ปรับชื่อชีตให้ถูกกติกา Excel: แทนอักขระต้องห้ามด้วย "-" ตัดเครื่องหมายคำพูด
 * หัวท้าย จำกัด 31 ตัว ว่างให้ใช้ "ห้อง" และกันชื่อซ้ำแบบไม่สนตัวพิมพ์
 * (Excel ไม่ยอมให้มีสองชีตชื่อเดียวกันและไม่สนตัวพิมพ์เล็กใหญ่)
 *
 * taken เป็นตัวสะสมที่ผู้เรียกใช้ร่วมกันทุกชีต จึงต้องถูกแก้ไขในที่ ไม่คืนค่าใหม่
 */
function excelSheetName(raw: string, taken: Set<string>): string {
  let name = raw
    .replace(forbiddenSheetChars, "-")
    .trim()
    .replace(/^'|'$/g, "")
    .slice(0, excelNameLimit);
  if (name === "") name = "ห้อง";
  let candidate = name;
  let suffix = 2;
  while (taken.has(candidate.toLowerCase())) {
    const tail = ` (${suffix})`;
    // ตัดชื่อฐาน (ไม่ใช่ตัวต่อท้าย) เพื่อให้ชื่อกับตัวต่อท้ายรวมกันไม่เกิน 31 ตัว
    candidate = name.slice(0, excelNameLimit - tail.length) + tail;
    suffix += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * เรียงเลขห้องแบบเดียวกับที่ฝั่งเซิร์ฟเวอร์เรียง (SQL: LENGTH แล้วตามตัวอักษร)
 * ห้ามใช้ localeCompare เพราะเรียงต่างกันในบางค่า ชีตจะสลับกับที่เห็นบนจอ
 */
function compareRoomNumbers(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * คอลัมน์ของทุกชีต — ชุดเดียวกันตลอด เพื่อให้เทียบข้ามห้องได้ตรงตำแหน่ง
 * ค่าใช้จ่ายเพิ่มเติมได้คอลัมน์ละหนึ่งชื่อ ความกว้างยืดตามความยาวชื่อไทย
 */
function sheetColumns(chargeNames: string[]): BillsExportColumn[] {
  return [
    { header: "รอบบิล", kind: "period", width: 14 },
    { header: "ผู้เช่า", kind: "text", width: 24 },
    { header: "ค่าห้อง", kind: "money", width: 10 },
    { header: "หน่วยน้ำ", kind: "units", width: 10 },
    { header: "หน่วยไฟ", kind: "units", width: 10 },
    { header: "ค่าน้ำ", kind: "money", width: 10 },
    { header: "ค่าไฟ", kind: "money", width: 10 },
    ...chargeNames.map((name) => ({
      header: name,
      kind: "money" as const,
      width: Math.max(10, name.length + 2),
    })),
    { header: "รวม", kind: "money", width: 10 },
    { header: "สถานะ", kind: "text", width: 12 },
  ];
}

/** ชื่อค่าใช้จ่ายที่ใช้เทียบ/จัดกลุ่ม — ต้องเป็นกฎเดียวกันทั้งตอนเก็บชื่อ
 * คอลัมน์และตอนรวมยอดต่อบิล ไม่งั้นสองจุดจะเพี้ยนออกจากกันได้ถ้าแก้ที่เดียว */
function normalizedChargeName(name: string): string {
  return name.trim();
}

/** ชื่อค่าใช้จ่ายที่พบทั้งหมด ตามครั้งแรกที่พบ (ไล่ตามลำดับบิลที่ API ส่งมา) */
function chargeNamesOf(bills: Bill[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const bill of bills) {
    for (const charge of bill.charges) {
      const name = normalizedChargeName(charge.name);
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * รอบบิลเป็นวันที่ 1 ของเดือนตามเวลาสากล ไม่ใช่เวลาท้องถิ่น มิฉะนั้นเขตเวลา
 * ไทย (UTC+7) จะไม่เลื่อนวันที่ แต่เขตเวลาที่น้อยกว่า UTC จะถอยไปเดือนก่อนหน้า
 */
function periodDate(period: string): Date {
  const [year, month] = period.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1));
}

/**
 * ยอดของค่าใช้จ่ายหนึ่งชื่อในบิลนั้น (ชื่อซ้ำรวมกัน) คืน null เมื่อบิลไม่มี
 * รายการนี้ เพราะ 0 จะแปลว่า "มีรายการนี้แต่มูลค่าศูนย์" ซึ่งคนละเรื่องกัน
 */
function chargeCellOf(bill: Bill, name: string): number | null {
  let sum = 0;
  let found = false;
  for (const charge of bill.charges) {
    if (normalizedChargeName(charge.name) !== name) continue;
    sum += charge.amount;
    found = true;
  }
  return found ? sum : null;
}

function rowOf(bill: Bill, chargeNames: string[]): BillsExportCell[] {
  return [
    periodDate(bill.period),
    bill.tenantName,
    bill.rent,
    bill.waterUnits,
    electricUnitsOf(bill),
    bill.waterAmount,
    bill.electricAmount,
    ...chargeNames.map((name) => chargeCellOf(bill, name)),
    bill.total,
    bill.status === "paid" ? "จ่ายแล้ว" : "ยังไม่จ่าย",
  ];
}

export function billsExportSheets(bills: Bill[]): BillsExportSheet[] {
  if (bills.length === 0) return [];

  const rowsByRoom = new Map<string, Bill[]>();
  for (const bill of bills) {
    const rows = rowsByRoom.get(bill.roomNumber);
    if (rows) rows.push(bill);
    else rowsByRoom.set(bill.roomNumber, [bill]);
  }

  const chargeNames = chargeNamesOf(bills);
  const columns = sheetColumns(chargeNames);
  const taken = new Set<string>();
  return [...rowsByRoom.entries()]
    .sort(([a], [b]) => compareRoomNumbers(a, b))
    .map(([roomNumber, roomBills]) => ({
      name: excelSheetName(roomNumber, taken),
      columns,
      // เรียงรอบบิลเก่า→ใหม่เอง ไม่พึ่งลำดับที่ผู้เรียกส่งมา เพราะสเปกระบุ
      // ลำดับแถวไว้ตรง ๆ — ถ้าปล่อยให้ผู้เรียกรับผิดชอบ วันหนึ่งมีผู้เรียก
      // รายใหม่ที่ส่งมาไม่เรียงก็จะได้ไฟล์ผิดลำดับแบบเงียบ ๆ
      rows: roomBills
        .toSorted((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0))
        .map((bill) => rowOf(bill, chargeNames)),
    }));
}
