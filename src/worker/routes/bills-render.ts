import { Hono } from "hono";
import type { AppEnv } from "../lib/auth";
import { requireAuth } from "../lib/auth";
import { bankThaiName } from "../lib/banks";
import { buildInvoiceDocument, type InvoiceBill } from "../lib/invoice";
import { renderInvoicePdf } from "../lib/pdf";
import { buildPromptPayPayload, type PromptPayIdType } from "../lib/promptpay";
import { encodeQrPng } from "../lib/qr";
import { errorBody } from "./shared";

/**
 * เลขห้อง ชื่อผู้เช่า และผู้รับเงิน (พร้อมเพย์/บัญชีธนาคาร) อ่านจาก snapshot
 * ในบิลเอง ไม่ใช่ JOIN ตารางที่มีชีวิตหรืออ่านตั้งค่าปัจจุบัน มิฉะนั้นแก้
 * ชื่อห้องหรือช่องทางรับเงินภายหลังจะเปลี่ยนใบแจ้งหนี้ที่ออกไปแล้วย้อนหลัง
 * (ดู migration 0010 และ 0011)
 */
const billColumns =
  "b.family_id, b.room_number, b.tenant_name, b.period, b.rent, b.water_previous, b.water_current, b.water_units, b.water_rate, b.water_amount, b.electric_mode, b.electric_previous, b.electric_current, b.electric_units, b.electric_rate, b.electric_amount, b.total, b.created_at, b.payee_dorm_name, b.payee_owner_name, b.payee_promptpay_id, b.payee_promptpay_type, b.payee_promptpay_name, b.payee_bank_name, b.payee_bank_account_number, b.payee_bank_account_name";

const billFrom = "FROM bills b";

/** เพดานยอดเงินของ QR ตัวอย่าง — กันไม่ให้ใช้โดเมนหอสร้าง QR ยอดใดก็ได้ */
const maxPreviewAmount = 2_000_000;

interface BillRow {
  family_id: string;
  room_number: string;
  tenant_name: string;
  period: string;
  rent: number;
  water_previous: number;
  water_current: number;
  water_units: number;
  water_rate: number;
  water_amount: number;
  electric_mode: string;
  electric_previous: number;
  electric_current: number;
  electric_units: number | null;
  electric_rate: number | null;
  electric_amount: number;
  total: number;
  created_at: string;
  payee_dorm_name: string;
  payee_owner_name: string;
  payee_promptpay_id: string;
  payee_promptpay_type: string;
  payee_promptpay_name: string;
  payee_bank_name: string;
  payee_bank_account_number: string;
  payee_bank_account_name: string;
}

interface ChargeRow {
  name: string;
  amount: number;
}

interface Issuer {
  dormName: string;
  ownerName: string;
  promptpayId: string;
  promptpayType: PromptPayIdType;
  promptpayName: string;
  bankName: string;
  bankAccountNumber: string;
  bankAccountName: string;
}

interface LoadedBill {
  bill: InvoiceBill;
  family: string;
  issuer: Issuer;
}

export const qrRoute = new Hono<AppEnv>();
export const invoiceRoute = new Hono<{ Bindings: Env }>();

function fileId(file: string, extension: string): string | null {
  if (!file.endsWith(extension)) {
    return null;
  }

  const id = file.slice(0, -extension.length);
  return id === "" ? null : id;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function loadInvoiceBill(env: Env, id: string): Promise<LoadedBill | null> {
  const row = await env.DB.prepare(`SELECT ${billColumns} ${billFrom} WHERE b.id = ?`).bind(id).first<BillRow>();

  if (row === null) {
    return null;
  }

  const charges = await env.DB.prepare(
    "SELECT name, amount FROM bill_charges WHERE family_id = ? AND bill_id = ? ORDER BY position ASC",
  )
    .bind(row.family_id, id)
    .all<ChargeRow>();

  return {
    family: row.family_id,
    bill: {
      roomNumber: row.room_number,
      tenantName: row.tenant_name,
      period: row.period,
      rent: row.rent,
      waterPrevious: row.water_previous,
      waterCurrent: row.water_current,
      waterUnits: row.water_units,
      waterRate: row.water_rate,
      waterAmount: row.water_amount,
      electricMode: row.electric_mode === "flat" ? "flat" : "meter",
      electricPrevious: row.electric_previous,
      electricCurrent: row.electric_current,
      electricUnits: row.electric_units,
      electricRate: row.electric_rate,
      electricAmount: row.electric_amount,
      charges: charges.results,
      total: row.total,
      createdAt: row.created_at,
    },
    issuer: {
      dormName: row.payee_dorm_name,
      ownerName: row.payee_owner_name,
      promptpayId: row.payee_promptpay_id,
      promptpayType: row.payee_promptpay_type === "citizen-id" ? "citizen-id" : "phone",
      promptpayName: row.payee_promptpay_name,
      bankName: bankThaiName(row.payee_bank_name),
      bankAccountNumber: row.payee_bank_account_number,
      bankAccountName: row.payee_bank_account_name,
    },
  };
}

function promptPayIdError(id: string, type: PromptPayIdType): string | null {
  const digits = id.replace(/\D/g, "");

  if (type === "phone") {
    return digits.length === 9 || digits.length === 10 ? null : "พร้อมเพย์ไอดีประเภทเบอร์โทรต้องเป็นเบอร์ 9 หรือ 10 หลัก";
  }

  return digits.length === 13 ? null : "พร้อมเพย์ไอดีประเภทเลขบัตรต้องเป็นเลข 13 หลัก";
}

async function buildPromptPayQr(type: PromptPayIdType, id: string, amount: number): Promise<Uint8Array<ArrayBuffer>> {
  return encodeQrPng(buildPromptPayPayload(type, id, amount));
}

/**
 * QR ตัวอย่างสำหรับหน้าตั้งค่า — ต้องล็อกอินก่อน
 *
 * เส้นทางนี้รับพร้อมเพย์ไอดีและยอดเงินจากผู้เรียก จึงไม่ใช่ capability URL
 * เหมือน /qr/:billId.png ถ้าเปิดสาธารณะจะกลายเป็นหน้าเว็บของหอที่ใช้
 * สร้าง QR ให้บัญชีและยอดเงินของใครก็ได้
 */
qrRoute.get("/preview.png", requireAuth, async (c) => {
  const rawType = c.req.query("type");
  const type = rawType === "phone" || rawType === "citizen-id" ? rawType : null;

  if (type === null) {
    return c.json(errorBody("VALIDATION", "ประเภทพร้อมเพย์ต้องเป็น phone หรือ citizen-id", "type"), 400);
  }

  const id = (c.req.query("id") ?? "").trim();
  const idMessage = id === "" ? "กรุณากรอกพร้อมเพย์ไอดี" : promptPayIdError(id, type);

  if (idMessage !== null) {
    return c.json(errorBody("VALIDATION", idMessage, "id"), 400);
  }

  const amount = Number(c.req.query("amount"));

  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json(errorBody("VALIDATION", "ยอดเงินต้องเป็นตัวเลขมากกว่า 0", "amount"), 400);
  }

  if (amount > maxPreviewAmount) {
    return c.json(
      errorBody("VALIDATION", `ยอดเงินต้องไม่เกิน ${maxPreviewAmount.toLocaleString("en-US")} บาท`, "amount"),
      400,
    );
  }

  try {
    const png = await buildPromptPayQr(type, id, amount);

    return c.body(png, 200, {
      "content-type": "image/png",
      "cache-control": "no-store",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "render promptpay preview qr failed", promptpayId: id, error: detail }));
    return c.json(errorBody("INTERNAL", "สร้างรูป QR พร้อมเพย์ไม่สำเร็จ"), 500);
  }
});

qrRoute.get("/:file", async (c) => {
  const billId = fileId(c.req.param("file"), ".png");

  if (billId === null) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบรูป QR พร้อมเพย์ที่ต้องการ"), 404);
  }

  try {
    const loaded = await loadInvoiceBill(c.env, billId);

    if (loaded === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบบิลของรูป QR พร้อมเพย์นี้"), 404);
    }

    const issuer = loaded.issuer;

    if (issuer.promptpayId === "") {
      console.error(JSON.stringify({ message: "promptpay qr failed", billId, reason: "promptpay id is not configured" }));
      return c.json(errorBody("INTERNAL", "ยังไม่ได้ตั้งค่าพร้อมเพย์ไอดี"), 500);
    }

    const png = await buildPromptPayQr(issuer.promptpayType, issuer.promptpayId, loaded.bill.total);

    // บิลแก้ยอดได้ตลอด จึงห้ามให้ cache เก็บรูปเก่าไว้เสิร์ฟยอดเดิม
    return c.body(png, 200, {
      "content-type": "image/png",
      "cache-control": "no-store",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "render promptpay qr failed", billId, error: detail }));
    return c.json(errorBody("INTERNAL", "สร้างรูป QR พร้อมเพย์ไม่สำเร็จ"), 500);
  }
});

invoiceRoute.get("/:file", async (c) => {
  const billId = fileId(c.req.param("file"), ".pdf");

  if (billId === null) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบใบแจ้งหนี้ที่ต้องการ"), 404);
  }

  try {
    const loaded = await loadInvoiceBill(c.env, billId);

    if (loaded === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบใบแจ้งหนี้ของบิลนี้"), 404);
    }

    const issuer = loaded.issuer;
    const document = buildInvoiceDocument(loaded.bill);
    const qrPng =
      issuer.promptpayId === ""
        ? undefined
        : await buildPromptPayQr(issuer.promptpayType, issuer.promptpayId, loaded.bill.total);
    const pdf = await renderInvoicePdf(document, issuer, qrPng);

    return c.body(pdf, 200, {
      "content-type": "application/pdf",
      "cache-control": "no-store",
      "content-disposition": `inline; filename="${safeFileName(document.number)}.pdf"`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "render invoice pdf failed", billId, error: detail }));
    return c.json(errorBody("INTERNAL", "สร้างใบแจ้งหนี้ไม่สำเร็จ"), 500);
  }
});
