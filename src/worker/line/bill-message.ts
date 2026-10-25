import {
  buildInvoiceDocument,
  type InvoiceBill,
  type InvoiceDocument,
  type InvoiceRow,
} from "../lib/invoice";

export interface BillMessageBill extends InvoiceBill {
  id: string;
}

/** ข้อมูลช่องทางรับเงิน — ว่างได้ถ้ายังไม่ได้ตั้งค่าในหน้าตั้งค่า */
export interface BillMessagePayee {
  promptpayId: string;
  promptpayName: string;
  /** ชื่อธนาคารภาษาไทยที่ resolve แล้ว ไม่ใช่รหัส */
  bankName: string;
  bankAccountNumber: string;
  bankAccountName: string;
}

export type FlexContent = Record<string, unknown>;

export type BillFlexMessage = {
  type: "flex";
  altText: string;
  contents: FlexContent;
};

/** สีเดียวกับ token ฝั่งแอป — charcoal / steel / fog / ash */
const ink = "#171717";
const steel = "#525252";
const fog = "#6b6b6b";
const ash = "#e5e5e5";
const onInk = "#ffffff";

function label(text: string, options: FlexContent = {}): FlexContent {
  return {
    type: "text",
    text,
    wrap: true,
    color: steel,
    size: "sm",
    flex: 1,
    ...options,
  };
}

function value(text: string, options: FlexContent = {}): FlexContent {
  return {
    type: "text",
    text,
    wrap: true,
    color: ink,
    size: "sm",
    align: "end",
    flex: 0,
    ...options,
  };
}

function pairRow(
  left: string,
  right: string,
  leftOptions: FlexContent = {},
  rightOptions: FlexContent = {},
): FlexContent {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    contents: [label(left, leftOptions), value(right, rightOptions)],
  };
}

function note(text: string, options: FlexContent = {}): FlexContent {
  return { type: "text", text, wrap: true, color: fog, size: "xs", ...options };
}

function separator(margin: string): FlexContent {
  return { type: "separator", margin, color: ash };
}

function formatAmount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function amountRow(row: InvoiceRow): FlexContent {
  return pairRow(row.label, `${formatAmount(row.amount)} บาท`);
}

function header(document: InvoiceDocument): FlexContent {
  return {
    type: "box",
    layout: "vertical",
    backgroundColor: ink,
    paddingAll: "16px",
    spacing: "xs",
    contents: [
      {
        type: "text",
        text: "ใบแจ้งหนี้ / INVOICE",
        wrap: true,
        size: "lg",
        weight: "bold",
        color: onInk,
      },
      {
        type: "text",
        text: `ห้อง ${document.roomNumber} | ประจำเดือน ${document.periodLabel}`,
        wrap: true,
        size: "sm",
        color: onInk,
      },
    ],
  };
}

function body(document: InvoiceDocument): FlexContent {
  return {
    type: "box",
    layout: "vertical",
    spacing: "md",
    paddingAll: "16px",
    contents: [
      pairRow("ผู้เช่า", document.tenantName),
      separator("md"),
      ...document.rows.map(amountRow),
      separator("lg"),
      pairRow(
        "ยอดรวม",
        `${formatAmount(document.total)} บาท`,
        { size: "md", color: steel },
        { size: "xl", weight: "bold", color: ink },
      ),
    ],
  };
}

/** แถวคัดลอกเลขพร้อมเพย์ — ผู้เช่ากดแล้วได้เลขไปวางในแอปธนาคารได้เลย */
function promptpayRow(payee: BillMessagePayee): FlexContent[] {
  const account = payee.promptpayId.trim();

  if (account === "") {
    return [];
  }

  return [
    separator("md"),
    {
      type: "box",
      layout: "horizontal",
      spacing: "md",
      contents: [
        {
          type: "box",
          layout: "vertical",
          flex: 1,
          contents: [
            note("พร้อมเพย์ / PromptPay"),
            {
              type: "text",
              text: account,
              wrap: true,
              size: "md",
              weight: "bold",
              color: ink,
            },
          ],
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          flex: 0,
          action: {
            type: "clipboard",
            label: "คัดลอก",
            clipboardText: account,
          },
        },
      ],
    },
    ...(payee.promptpayName.trim() === ""
      ? []
      : [note(`ชื่อบัญชี ${payee.promptpayName.trim()}`)]),
  ];
}

/** แถวบัญชีธนาคาร — ทางเลือกแทนหรือคู่กับพร้อมเพย์ ก็คัดลอกเลขบัญชีได้เช่นกัน */
function bankRow(payee: BillMessagePayee): FlexContent[] {
  const accountNumber = payee.bankAccountNumber.trim();

  if (accountNumber === "") {
    return [];
  }

  const bankLabel = payee.bankName.trim() === "" ? "บัญชีธนาคาร" : payee.bankName.trim();

  return [
    separator("md"),
    {
      type: "box",
      layout: "horizontal",
      spacing: "md",
      contents: [
        {
          type: "box",
          layout: "vertical",
          flex: 1,
          contents: [
            note(bankLabel),
            {
              type: "text",
              text: accountNumber,
              wrap: true,
              size: "md",
              weight: "bold",
              color: ink,
            },
          ],
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          flex: 0,
          action: {
            type: "clipboard",
            label: "คัดลอก",
            clipboardText: accountNumber,
          },
        },
      ],
    },
    ...(payee.bankAccountName.trim() === ""
      ? []
      : [note(`ชื่อบัญชี ${payee.bankAccountName.trim()}`)]),
  ];
}

function footer(pdfUrl: string, payee: BillMessagePayee): FlexContent {
  return {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    paddingAll: "16px",
    contents: [
      {
        type: "button",
        style: "primary",
        color: ink,
        action: { type: "uri", label: "เปิดใบแจ้งหนี้ PDF", uri: pdfUrl },
      },
      ...promptpayRow(payee),
      ...bankRow(payee),
      note("กรุณาตรวจสอบรายละเอียดในไฟล์ PDF", { align: "center" }),
    ],
  };
}

export function buildBillFlexMessage(
  bill: BillMessageBill,
  payee: BillMessagePayee,
  baseUrl: string,
): BillFlexMessage {
  const origin = baseUrl.replace(/\/+$/, "");
  const document = buildInvoiceDocument(bill);
  const pdfUrl = `${origin}/invoices/${encodeURIComponent(bill.id)}.pdf`;

  return {
    type: "flex",
    altText: `ใบแจ้งหนี้ห้อง ${document.roomNumber} ประจำเดือน ${document.periodLabel} ยอด ${formatAmount(document.total)} บาท`,
    contents: {
      type: "bubble",
      header: header(document),
      body: body(document),
      footer: footer(pdfUrl, payee),
    },
  };
}
