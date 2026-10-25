/**
 * แปลงรายการชีต (bills-export.ts) เป็นไฟล์ .xlsx จริงแล้วดาวน์โหลด
 *
 * บางเกินกว่าจะมีตรรกะให้เทสต์ (แค่จับคู่ชนิดคอลัมน์กับรูปแบบของ write-excel-file)
 * พิสูจน์ครั้งเดียวด้วยไฟล์จริงที่เปิดด้วย LibreOffice แทนเทสต์ถาวร ตามที่ระบุไว้
 * ใน docs/specs/0004 — โหลดไลบรารีแบบ lazy เพราะ write-excel-file ไม่จำเป็นสำหรับ
 * ผู้ใช้ส่วนใหญ่ที่ไม่เคยกดส่งออกเลยในเซสชันนั้น จึงไม่ควรอยู่ใน bundle หลัก
 */

import type { Bill } from "./api";
import {
  billsExportSheets,
  type BillsExportCell,
  type BillsExportColumnKind,
  type BillsExportSheet,
} from "./bills-export";
import { exportFileName, type PeriodRange } from "./bills-export-range";

/** วันที่รอบบิลแสดงแบบปฏิทินพุทธไทยของ Excel (เดือนย่อ + ปี พ.ศ.) */
const periodDateFormat = "[$-107041E]mmm yyyy";
/** ตัวเลข (เงินและหน่วยน้ำ/ไฟ) มีตัวคั่นหลักพันให้อ่านง่าย ไม่มีทศนิยมเพราะ
 * ยอดเงินทุกก้อนปัดเป็นบาทถ้วนอยู่แล้ว ส่วนหน่วยน้ำ/ไฟก็เป็นจำนวนเต็มเสมอ */
const numberFormat = "#,##0";

function cellOf(value: BillsExportCell, kind: BillsExportColumnKind) {
  if (value === null) return null;
  switch (kind) {
    case "period":
      return { value: value as Date, type: Date, format: periodDateFormat };
    case "money":
    case "units":
      return { value: value as number, type: Number, format: numberFormat };
    case "text":
      return { value: value as string, type: String };
  }
}

function sheetOf(sheet: BillsExportSheet) {
  const header = sheet.columns.map((column) => ({
    value: column.header,
    type: String,
    fontWeight: "bold" as const,
  }));
  const rows = sheet.rows.map((row) =>
    row.map((cell, index) => cellOf(cell, sheet.columns[index]!.kind)),
  );

  return {
    sheet: sheet.name,
    stickyRowsCount: 1,
    columns: sheet.columns.map((column) => ({ width: column.width })),
    data: [header, ...rows],
  };
}

export interface DownloadedWorkbook {
  bills: number;
  rooms: number;
}

/**
 * สร้างไฟล์ .xlsx จากบิลที่ได้มาแล้ว (fetchBillsRange) แล้วกระตุ้นดาวน์โหลดทันที
 * โยนต่อ error จาก fetch/ไลบรารีให้ผู้เรียกจัดการเอง (แสดงในหน้าต่างส่งออก)
 */
export async function downloadBillsWorkbook(
  bills: Bill[],
  range: PeriodRange,
): Promise<DownloadedWorkbook> {
  const sheets = billsExportSheets(bills);
  // ตั้งใจให้เป็น dynamic import ไม่ใช่เพราะเลือก path ตามเงื่อนไขรันไทม์ —
  // static import จะทำให้ write-excel-file ติดไปกับ bundle หลักที่โหลดทุกครั้ง
  // ที่เปิดแอป แม้เจ้าของจะไม่เคยกดส่งออกเลย ทั้งที่ต้องการให้โหลดเฉพาะตอนกด
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  await writeXlsxFile(sheets.map(sheetOf)).toFile(exportFileName(range));
  return { bills: bills.length, rooms: sheets.length };
}
