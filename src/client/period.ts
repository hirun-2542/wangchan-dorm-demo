/**
 * ตรรกะรอบบิล (period "YYYY-MM") ล้วน ๆ ไม่มี React — แยกออกจาก bills-shared.tsx
 * เพื่อให้โมดูลข้อมูลล้วนอื่น ๆ (เช่น bills-export-range.ts) import ได้โดยไม่ลาก
 * JSX เข้ามาด้วย ซึ่งจะทำให้ typecheck ฝั่ง worker พังเมื่อไฟล์เทสต์ import ตาม
 * (tsconfig.worker.json รวม test/**\/*.ts ทั้งหมดแต่ไม่ได้ตั้งค่า --jsx)
 */

const thaiMonths = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

export const buddhistYearOffset = 543;

export function periodLabel(period: string): string {
  const [yearPart, monthPart] = period.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const monthName = thaiMonths[month - 1];

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    monthName === undefined
  ) {
    return period;
  }

  return `${monthName} ${year + buddhistYearOffset}`;
}

export function periodCode(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function periodAt(monthOffset: number): string {
  const now = new Date();
  return periodCode(
    new Date(now.getFullYear(), now.getMonth() + monthOffset, 1),
  );
}

export function recentPeriods(count: number): string[] {
  const list: string[] = [];

  for (let index = 0; index < count; index += 1) {
    list.push(periodAt(-index));
  }

  return list;
}

export function periodOptions(billed: string[], months = 6): string[] {
  return Array.from(new Set([...recentPeriods(months), ...billed]))
    .sort()
    .reverse();
}
