import fontkit, { type Font as ParsedFont } from "@pdf-lib/fontkit";
import {
  PDFDocument,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import boldFontData from "../fonts/IBMPlexSansThai-Bold.ttf";
import regularFontData from "../fonts/IBMPlexSansThai-Regular.ttf";
import { bahtWords } from "./baht-words";
import {
  formatBaht,
  formatPrice,
  formatUnits,
  type InvoiceDocument,
  type InvoiceRow,
} from "./invoice";

export interface InvoiceIssuer {
  dormName: string;
  ownerName: string;
  promptpayId: string;
  promptpayName: string;
  /** ชื่อธนาคารภาษาไทยที่ resolve แล้ว ไม่ใช่รหัส — ว่างได้ถ้าไม่ได้ตั้งค่า */
  bankName: string;
  bankAccountNumber: string;
  bankAccountName: string;
}

const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 48;
const contentRight = pageWidth - margin;
const contentWidth = contentRight - margin;
const pad = 8;

/* ── ฟอนต์ ───────────────────────────────────────────────────────────── */
/** ส่งเข้าฟอนต์เป็น Uint8Array ก้อนเดิมทุกครั้ง แคชด้านล่างจึงจับคู่ด้วยตัวออบเจกต์ได้ */
const regularFontBytes = new Uint8Array(regularFontData);
const boldFontBytes = new Uint8Array(boldFontData);

/**
 * fontkit.create แกะไฟล์ TTF ใหม่ทุกครั้งที่ embed (สองไฟล์รวม 232KB) ซึ่งแพงกว่า
 * ตอน subset มาก จึงแกะครั้งเดียวต่อโปรเซสแล้วใช้ซ้ำทุกคำขอ
 */
const parsedFonts = new WeakMap<Uint8Array, ParsedFont>();

const cachedFontkit = {
  create(data: Uint8Array): ParsedFont {
    const cached = parsedFonts.get(data);

    if (cached !== undefined) {
      return cached;
    }

    const parsed = fontkit.create(data);
    parsedFonts.set(data, parsed);

    return parsed;
  },
};

/* ── ตารางรายการ ─────────────────────────────────────────────────────── */
const seqWidth = 32;
const quantityWidth = 52;
const unitPriceWidth = 88;
const amountWidth = 96;
const labelWidth =
  contentWidth - seqWidth - quantityWidth - unitPriceWidth - amountWidth;
const tableHeadHeight = 30;
const rowHeight = 24;
const groupHeight = 22;
const totalHeight = 32;

/* ── บล็อกที่ต่อจากแถวล่าสุดของตาราง ─────────────────────────────────── */
const bahtWordsGap = 16;
const paymentGap = 26;
const paymentQrSize = 88;
const paymentBlockHeight = 40 + paymentQrSize + 12;
/**
 * ระยะจริงที่ต้องกันไว้ใต้แถวล่าสุด ไม่งั้นแถวสุดท้ายจะดันกล่องชำระเงินลงไป
 * ในขอบล่างและทับส่วนท้ายหน้า: 32 + 16 + 26 + 140 = 214
 */
const tailHeight = totalHeight + bahtWordsGap + paymentGap + paymentBlockHeight;

/* ── หัวเอกสาร ───────────────────────────────────────────────────────── */
/** ชื่อหอและชื่อผู้เช่าอยู่คนละฝั่งของบรรทัดเดียวกัน จึงแบ่งความกว้างครึ่งหนึ่ง */
const headerGap = 16;
const headerNameWidth = (contentWidth - headerGap) / 2;

/* ── token ของระบบ (src/client/styles.css) ───────────────────────────── */
const canvasWhite = rgb(1, 1, 1);
const paperMist = rgb(0.961, 0.961, 0.961);
const ash = rgb(0.898, 0.898, 0.898);
const charcoal = rgb(0.09, 0.09, 0.09);
const steel = rgb(0.322, 0.322, 0.322);
const fog = rgb(0.42, 0.42, 0.42);
const silver = rgb(0.639, 0.639, 0.639);
const electricBlue = rgb(0.145, 0.388, 0.922);

interface Ctx {
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  qr?: PDFImage;
}

const ellipsis = "…";

/**
 * ตัดข้อความให้พอดีความกว้างที่กำหนดแล้วต่อท้ายด้วย …
 * ใช้ไบเซกชันเพราะความกว้างของข้อความเพิ่มตามจำนวนตัวอักษร ส่วนการวนตัดทีละตัว
 * เป็น O(n²) และค้างเมื่อชื่อรายการยาวมาก
 */
function truncateToWidth(
  font: PDFFont,
  value: string,
  size: number,
  max: number,
): string {
  if (font.widthOfTextAtSize(value, size) <= max) {
    return value;
  }

  let fits = 0;
  let tooLong = value.length;

  while (fits < tooLong) {
    const middle = Math.ceil((fits + tooLong) / 2);
    const candidate = `${value.slice(0, middle)}${ellipsis}`;

    if (font.widthOfTextAtSize(candidate, size) <= max) {
      fits = middle;
    } else {
      tooLong = middle - 1;
    }
  }

  return `${value.slice(0, Math.max(fits, 1))}${ellipsis}`;
}

function text(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  size: number,
  opts: {
    bold?: boolean;
    color?: RGB;
    align?: "left" | "right" | "center";
    max?: number;
  } = {},
): void {
  const font = opts.bold === true ? ctx.bold : ctx.regular;
  const out =
    opts.max === undefined ? value : truncateToWidth(font, value, size, opts.max);
  const width = font.widthOfTextAtSize(out, size);
  const drawX =
    opts.align === "right"
      ? x - width
      : opts.align === "center"
        ? x - width / 2
        : x;

  ctx.page.drawText(out, {
    x: drawX,
    y,
    size,
    font,
    color: opts.color ?? charcoal,
  });
}

function hline(
  ctx: Ctx,
  y: number,
  color: RGB = ash,
  thickness = 1,
  from = margin,
  to = contentRight,
): void {
  ctx.page.drawLine({
    start: { x: from, y },
    end: { x: to, y },
    thickness,
    color,
  });
}

function fillBox(
  ctx: Ctx,
  x: number,
  top: number,
  width: number,
  height: number,
  color: RGB,
): void {
  ctx.page.drawRectangle({ x, y: top - height, width, height, color });
}

function kicker(ctx: Ctx, value: string, x: number, y: number): void {
  text(ctx, value, x, y, 8, { color: fog });
}

/** คอลัมน์ของตารางรายการ — ขอบซ้ายของแต่ละช่อง */
const columns = (() => {
  const seq = margin;
  const label = seq + seqWidth;
  const quantity = label + labelWidth;
  const unitPrice = quantity + quantityWidth;
  const amount = unitPrice + unitPriceWidth;

  return { seq, label, quantity, unitPrice, amount, end: contentRight };
})();

function tableHead(ctx: Ctx, top: number): void {
  fillBox(ctx, margin, top, contentWidth, tableHeadHeight, charcoal);

  const baseline = top - 19;
  text(ctx, "ลำดับ", columns.seq + seqWidth / 2, baseline, 8, {
    color: canvasWhite,
    align: "center",
  });
  text(ctx, "รายการ", columns.label + pad, baseline, 8, { color: canvasWhite });
  text(ctx, "จำนวน", columns.quantity + quantityWidth - pad, baseline, 8, {
    color: canvasWhite,
    align: "right",
  });
  text(
    ctx,
    "ราคาต่อหน่วย",
    columns.unitPrice + unitPriceWidth - pad,
    baseline,
    8,
    {
      color: canvasWhite,
      align: "right",
    },
  );
  text(ctx, "จำนวนเงิน (บาท)", columns.end - pad, baseline, 8, {
    color: canvasWhite,
    align: "right",
  });
}

function groupRow(ctx: Ctx, top: number, label: string): void {
  fillBox(ctx, margin, top, contentWidth, groupHeight, paperMist);
  text(ctx, label, columns.label + pad, top - 15, 9, {
    bold: true,
    color: steel,
  });
  hline(ctx, top - groupHeight);
}

function itemRow(
  ctx: Ctx,
  top: number,
  sequence: number,
  row: InvoiceRow,
): void {
  const baseline = top - 16;

  text(ctx, String(sequence), columns.seq + seqWidth / 2, baseline, 9, {
    color: fog,
    align: "center",
  });
  text(ctx, row.label, columns.label + pad, baseline, 10, {
    max: labelWidth - pad * 2,
  });
  text(
    ctx,
    formatUnits(row.quantity),
    columns.quantity + quantityWidth - pad,
    baseline,
    10,
    {
      align: "right",
    },
  );
  text(
    ctx,
    formatPrice(row.unitPrice),
    columns.unitPrice + unitPriceWidth - pad,
    baseline,
    10,
    {
      align: "right",
    },
  );
  text(ctx, formatBaht(row.amount), columns.end - pad, baseline, 10, {
    align: "right",
  });
  hline(ctx, top - rowHeight);
}

function totalRow(ctx: Ctx, top: number, total: number): void {
  fillBox(ctx, margin, top, contentWidth, totalHeight, paperMist);
  text(
    ctx,
    "รวมทั้งสิ้น",
    columns.unitPrice + unitPriceWidth - pad,
    top - 21,
    10,
    {
      bold: true,
      align: "right",
    },
  );
  text(ctx, `${formatBaht(total)} บาท`, columns.end - pad, top - 21, 12, {
    bold: true,
    color: electricBlue,
    align: "right",
  });
  hline(ctx, top - totalHeight);
}

/** กลุ่มที่มีรายการ — เรียงตามลำดับที่พบในเอกสาร */
function groupsOf(rows: readonly InvoiceRow[]): string[] {
  return [...new Set(rows.map((row) => row.group))];
}

function paymentBlock(ctx: Ctx, issuer: InvoiceIssuer, top: number): void {
  fillBox(ctx, margin, top, contentWidth, paymentBlockHeight, paperMist);
  kicker(ctx, "ช่องทางชำระเงิน / PAYMENT", margin + 12, top - 18);

  const hasPromptPay = issuer.promptpayId !== "";
  const hasBank = issuer.bankName !== "" && issuer.bankAccountNumber !== "";

  if (ctx.qr !== undefined) {
    ctx.page.drawImage(ctx.qr, {
      x: margin + 12,
      y: top - paymentBlockHeight + 12,
      width: paymentQrSize,
      height: paymentQrSize,
    });
  }

  // ไม่มี QR แสดง (ไม่ได้ตั้งพร้อมเพย์) เอาข้อความมาชิดซ้ายแทนที่จะทิ้งพื้นที่ว่าง
  const infoX = ctx.qr === undefined ? margin + 12 : margin + 114;
  const infoWidth = contentRight - pad - infoX;

  if (!hasPromptPay && !hasBank) {
    text(ctx, "ยังไม่ได้ตั้งค่าช่องทางรับเงิน", infoX, top - 44, 12, {
      bold: true,
      max: infoWidth,
    });
    text(ctx, "ติดต่อเจ้าของหอเพื่อสอบถามวิธีชำระเงิน", infoX, top - 60, 9, {
      color: steel,
      max: infoWidth,
    });
    return;
  }

  let line = top - 44;

  if (hasPromptPay) {
    text(ctx, issuer.promptpayId, infoX, line, 12, { bold: true, max: infoWidth });
    line -= 16;
    text(
      ctx,
      `พร้อมเพย์${issuer.promptpayName === "" ? "" : ` · ${issuer.promptpayName}`}`,
      infoX,
      line,
      9,
      { color: fog, max: infoWidth },
    );
    line -= 22;
    text(ctx, "สแกนจ่ายด้วยแอปธนาคาร แล้วส่งสลิปกลับในแชท LINE ของหอ", infoX, line, 9, {
      color: steel,
      max: infoWidth,
    });
    line -= 16;
  }

  if (hasBank) {
    const bankLabel = issuer.bankName === "" ? "บัญชีธนาคาร" : issuer.bankName;

    text(ctx, `${bankLabel} ${issuer.bankAccountNumber}`, infoX, line, hasPromptPay ? 9 : 12, {
      bold: !hasPromptPay,
      color: hasPromptPay ? steel : charcoal,
      max: infoWidth,
    });
    line -= hasPromptPay ? 12 : 16;

    if (issuer.bankAccountName !== "") {
      text(ctx, `ชื่อบัญชี ${issuer.bankAccountName}`, infoX, line, 9, {
        color: fog,
        max: infoWidth,
      });
      line -= 12;
    }

    if (!hasPromptPay) {
      text(ctx, "โอนเงินเข้าบัญชีนี้ แล้วส่งสลิปกลับในแชท LINE ของหอ", infoX, line, 9, {
        color: steel,
        max: infoWidth,
      });
    }
  }
}

export async function renderInvoicePdf(
  document: InvoiceDocument,
  issuer: InvoiceIssuer,
  qrPng?: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(cachedFontkit);

  const regular = await pdf.embedFont(regularFontBytes, {
    subset: true,
    features: { ccmp: false },
  });
  const bold = await pdf.embedFont(boldFontBytes, {
    subset: true,
    features: { ccmp: false },
  });

  pdf.setTitle(`ใบแจ้งหนี้ ${document.number}`);
  pdf.setCreator("Wang Chan Dorm");
  pdf.setProducer("Wang Chan Dorm");

  let page = pdf.addPage([pageWidth, pageHeight]);
  const qr = qrPng === undefined ? undefined : await pdf.embedPng(qrPng);
  let ctx: Ctx = { page, regular, bold, qr };

  /* หัวเอกสาร */
  text(ctx, "ใบแจ้งหนี้", margin, pageHeight - margin - 16, 16, { bold: true });
  text(ctx, "INVOICE", margin + 78, pageHeight - margin - 16, 16, {
    color: silver,
  });
  text(
    ctx,
    `เลขที่ ${document.number}`,
    contentRight,
    pageHeight - margin - 12,
    9,
    {
      color: steel,
      align: "right",
    },
  );
  text(
    ctx,
    `วันที่ออก ${document.issueDate}`,
    contentRight,
    pageHeight - margin - 26,
    9,
    { color: steel, align: "right" },
  );
  hline(ctx, pageHeight - margin - 38, charcoal, 1.5);

  /* ผู้ออก · ผู้รับ · รอบบิล · มิเตอร์ */
  let y = pageHeight - margin - 60;

  text(ctx, issuer.dormName, margin, y, 11, {
    bold: true,
    max: headerNameWidth,
  });
  text(ctx, `เจ้าของหอ ${issuer.ownerName}`, margin, y - 15, 9, {
    color: fog,
    max: headerNameWidth,
  });
  text(ctx, document.tenantName, contentRight, y, 11, {
    bold: true,
    align: "right",
    max: headerNameWidth,
  });
  text(
    ctx,
    `ห้อง ${document.roomNumber} · ${document.periodLabel}`,
    contentRight,
    y - 15,
    9,
    { color: fog, align: "right", max: headerNameWidth },
  );
  text(ctx, document.meterSummary, contentRight, y - 29, 9, {
    color: fog,
    align: "right",
    max: headerNameWidth,
  });

  y -= 50;

  const tableTop = y;
  tableHead(ctx, y);
  y -= tableHeadHeight;

  let sequence = 0;

  /** ขอบตารางของแต่ละหน้า — เก็บ page ไว้ด้วยเพราะเส้นแนวตั้งต้องวาดบนหน้าของตัวเอง */
  const segments: { page: PDFPage; top: number; bottom: number }[] = [
    { page, top: tableTop, bottom: y },
  ];

  for (const group of groupsOf(document.rows)) {
    groupRow(ctx, y, group);
    y -= groupHeight;

    for (const row of document.rows.filter((item) => item.group === group)) {
      if (y - rowHeight < margin + tailHeight) {
        const last = segments[segments.length - 1];

        if (last !== undefined) {
          last.bottom = y;
        }

        page = pdf.addPage([pageWidth, pageHeight]);
        ctx = { page, regular, bold, qr };
        y = pageHeight - margin;
        tableHead(ctx, y);
        y -= tableHeadHeight;
        segments.push({ page, top: y + tableHeadHeight, bottom: y });
      }

      sequence += 1;
      itemRow(ctx, y, sequence, row);
      y -= rowHeight;
    }
  }

  totalRow(ctx, y, document.total);
  y -= totalHeight;

  const current = segments[segments.length - 1];

  if (current !== undefined) {
    current.bottom = y;
  }

  const columnEdges = [
    columns.seq,
    columns.label,
    columns.quantity,
    columns.unitPrice,
    columns.end,
  ];

  for (const segment of segments) {
    for (const x of columnEdges) {
      segment.page.drawLine({
        start: { x, y: segment.top },
        end: { x, y: segment.bottom },
        thickness: 1,
        color: ash,
      });
    }
  }

  y -= bahtWordsGap;
  text(ctx, `(${bahtWords(document.total)})`, margin, y, 9, { color: steel });
  y -= paymentGap;

  paymentBlock(ctx, issuer, y);

  text(ctx, "ขอบคุณที่ใช้บริการ", margin, 34, 8, { color: silver });

  return new Uint8Array(await pdf.save());
}
