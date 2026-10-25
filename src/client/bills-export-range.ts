/**
 * ตรรกะล้วนของหน้าต่างเลือกช่วงส่งออกบิล (ค่าเริ่มต้น ปุ่มลัด ชื่อไฟล์)
 *
 * แยกจาก React เพื่อให้เทสต์ได้ด้วย known test vector ไม่ต้องมี DOM —
 * ตามแบบเดียวกับ bills-export.ts ซึ่งเป็นโมดูลข้อมูลล้วนของฟีเจอร์เดียวกัน
 */

import { periodCode, periodLabel } from "./period";

export interface PeriodRange {
  from: string;
  to: string;
}

/** เดือนล่าสุดที่มีบิล — หาเองจากค่า ไม่พึ่งว่า billed ถูกเรียงมาแล้ว เพราะ
 * ถ้าวันหนึ่งผู้เรียกเปลี่ยนลำดับ (เช่น endpoint แก้ ORDER BY) ฟังก์ชันนี้ต้อง
 * ไม่ผิดไปด้วยแบบเงียบ ๆ */
function latestBilledPeriod(billed: string[]): string | null {
  return rangeOf(billed)?.to ?? null;
}

/** ช่วงที่บิลจากเดือน/ปีที่เกี่ยวข้อง เรียงหาต้น–ปลายเอง ไม่พึ่งลำดับของ billed */
function rangeOf(periods: string[]): PeriodRange | null {
  if (periods.length === 0) return null;
  const sorted = [...periods].sort();
  const from = sorted[0];
  const to = sorted[sorted.length - 1];
  if (from === undefined || to === undefined) return null;
  return { from, to };
}

/**
 * ค่าเริ่มต้นของช่วงส่งออก — เดือนที่กำลังดูอยู่บนจอถ้ามีบิลแล้ว เพราะนั่นคือ
 * ที่ผู้ใช้สนใจอยู่แล้ว ไม่งั้นถอยไปเดือนล่าสุดที่มีบิลจริง (เดือนบนจออาจเป็น
 * เดือนปัจจุบันที่ยังไม่ได้สร้างบิลเลย ซึ่งส่งออกแล้วจะได้ไฟล์ว่างเปล่า)
 */
export function defaultExportRange(
  billed: string[],
  currentPeriod: string,
): PeriodRange | null {
  const period = billed.includes(currentPeriod)
    ? currentPeriod
    : latestBilledPeriod(billed);
  return period === null ? null : { from: period, to: period };
}

/** ช่วงปีปฏิทินที่ให้มา (ค.ศ.) เฉพาะเดือนที่มีบิลจริงในปีนั้น */
export function yearToDateRange(
  billed: string[],
  now = new Date(),
): PeriodRange | null {
  const year = String(now.getFullYear());
  return rangeOf(billed.filter((period) => period.startsWith(`${year}-`)));
}

/** ช่วง 12 เดือนล่าสุดนับถึงเดือนนี้ เฉพาะเดือนที่มีบิลจริงในหน้าต่างนั้น */
export function trailingYearRange(
  billed: string[],
  now = new Date(),
): PeriodRange | null {
  const windowStart = periodCode(
    new Date(now.getFullYear(), now.getMonth() - 11, 1),
  );
  const currentPeriod = periodCode(now);
  return rangeOf(
    billed.filter((period) => period >= windowStart && period <= currentPeriod),
  );
}

/** ชื่อไฟล์ตามช่วงที่เลือก — เดือนเดียวหรือช่วง "เริ่ม - สุด" เป็นภาษาไทย */
export function exportFileName(range: PeriodRange): string {
  return range.from === range.to
    ? `บิล ${periodLabel(range.from)}.xlsx`
    : `บิล ${periodLabel(range.from)} - ${periodLabel(range.to)}.xlsx`;
}
