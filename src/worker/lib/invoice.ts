export type ElectricMode = "meter" | "flat";

const buddhistYearOffset = 543;

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

const thaiMonthsShort = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

export interface InvoiceCharge {
  name: string;
  amount: number;
}

export interface InvoiceAmountSource {
  rent: number;
  waterUnits: number;
  waterRate: number;
  waterAmount: number;
  electricMode: ElectricMode;
  electricUnits: number | null;
  electricRate: number | null;
  electricAmount: number;
  charges: InvoiceCharge[];
}

export interface InvoiceBill extends InvoiceAmountSource {
  roomNumber: string;
  tenantName: string;
  period: string;
  waterPrevious: number;
  waterCurrent: number;
  electricPrevious: number;
  electricCurrent: number;
  total: number;
  createdAt: string;
}

export interface InvoiceRow {
  group: string;
  label: string;
  detail: string;
  /** จำนวนที่คิดเงิน — 1 สำหรับรายการคงที่ต่อเดือน */
  quantity: number;
  /** ราคาต่อหน่วยเป็นบาท — เท่ากับจำนวนเงินเมื่อ quantity เป็น 1 */
  unitPrice: number;
  amount: number;
}

export interface InvoiceDocument {
  number: string;
  issueDate: string;
  periodLabel: string;
  roomNumber: string;
  tenantName: string;
  waterMeter: string;
  electricMeter: string;
  meterSummary: string;
  rows: InvoiceRow[];
  total: number;
}

export function formatBaht(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** ราคาต่อหน่วย — เก็บทศนิยมไม่เกิน 2 ตำแหน่ง เพราะอัตราน้ำ/ไฟมีทศนิยมได้ */
export function formatPrice(value: number): string {
  const rounded = Math.round(value * 100) / 100;

  return Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : rounded.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

export function formatUnits(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function invoiceNumber(period: string, roomNumber: string): string {
  const [yearPart, monthPart] = period.split("-");
  const year = Number(yearPart);

  if (!Number.isInteger(year) || monthPart === undefined) {
    return `${period}-${roomNumber}`;
  }

  return `B${year + buddhistYearOffset}-${monthPart}-${roomNumber}`;
}

export function thaiPeriodLabel(period: string): string {
  const [yearPart, monthPart] = period.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const monthName = thaiMonths[month - 1];

  if (!Number.isInteger(year) || monthName === undefined) {
    return period;
  }

  return `${monthName} ${year + buddhistYearOffset}`;
}

export function thaiDateLabel(value: string): string {
  const [datePart = ""] = value.split(/[T ]/);
  const [yearPart, monthPart, dayPart] = datePart.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const monthName = thaiMonthsShort[month - 1];

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(day) ||
    monthName === undefined
  ) {
    return value;
  }

  return `${day} ${monthName} ${year + buddhistYearOffset}`;
}

const groupPremises = "ค่าที่พัก";
const groupUtilities = "ค่าสาธารณูปโภค";
const groupExtras = "ค่าใช้จ่ายเพิ่มเติม";

function waterRow(bill: InvoiceBill): InvoiceRow {
  const units = Math.round(bill.waterUnits * 100) / 100;

  return {
    group: groupUtilities,
    label: "ค่าน้ำ",
    detail: `มิเตอร์ ${formatUnits(bill.waterPrevious)} → ${formatUnits(bill.waterCurrent)}`,
    quantity: units,
    unitPrice: bill.waterRate,
    amount: bill.waterAmount,
  };
}

function electricRow(bill: InvoiceBill): InvoiceRow {
  if (bill.electricMode === "flat") {
    return {
      group: groupUtilities,
      label: "ค่าไฟ",
      detail: "เหมาจ่ายรายเดือน",
      quantity: 1,
      unitPrice: bill.electricAmount,
      amount: bill.electricAmount,
    };
  }

  const units = Math.round((bill.electricUnits ?? 0) * 100) / 100;

  return {
    group: groupUtilities,
    label: "ค่าไฟ",
    detail: `มิเตอร์ ${formatUnits(bill.electricPrevious)} → ${formatUnits(bill.electricCurrent)}`,
    quantity: units,
    unitPrice: bill.electricRate ?? 0,
    amount: bill.electricAmount,
  };
}

export function buildInvoiceRows(bill: InvoiceBill): InvoiceRow[] {
  const rows: InvoiceRow[] = [
    {
      group: groupPremises,
      label: "ค่าเช่าห้อง",
      detail: "รายเดือน",
      quantity: 1,
      unitPrice: bill.rent,
      amount: bill.rent,
    },
    waterRow(bill),
    electricRow(bill),
  ];

  for (const charge of bill.charges) {
    rows.push({
      group: groupExtras,
      label: charge.name,
      detail: "ค่าประจำของหอ",
      quantity: 1,
      unitPrice: charge.amount,
      amount: charge.amount,
    });
  }

  return rows;
}

export function buildInvoiceDocument(bill: InvoiceBill): InvoiceDocument {
  const waterMeter = `${formatUnits(bill.waterPrevious)} → ${formatUnits(bill.waterCurrent)}`;
  const electricMeter = `${formatUnits(bill.electricPrevious)} → ${formatUnits(bill.electricCurrent)}`;

  return {
    number: invoiceNumber(bill.period, bill.roomNumber),
    issueDate: thaiDateLabel(bill.createdAt),
    periodLabel: thaiPeriodLabel(bill.period),
    roomNumber: bill.roomNumber,
    tenantName: bill.tenantName,
    waterMeter,
    electricMeter,
    meterSummary: `มิเตอร์น้ำ ${waterMeter} · มิเตอร์ไฟ ${electricMeter}`,
    rows: buildInvoiceRows(bill),
    total: bill.total,
  };
}
