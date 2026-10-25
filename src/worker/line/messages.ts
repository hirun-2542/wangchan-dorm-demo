import type { FlexContent } from "./bill-message";
import { formatBaht, thaiPeriodLabel } from "../lib/invoice";

export type LineFlexMessage = { type: "flex"; altText: string; contents: FlexContent };

type Tone = "success" | "info" | "warning" | "danger";

interface TonePalette {
  background: string;
  title: string;
}

interface CardRow {
  label: string;
  value: string;
  bold?: boolean;
}

/**
 * โทนสีของหัวการ์ด — ใช้ token สถานะชุดเดียวกับ badge ของแอป
 *
 * เดิมใช้ชุดพาสเทลของตัวเอง (success #ECFDF5, info #EFF6FF, warning #FFFBEB)
 * ซึ่งเป็นเฉดที่สองของสีเดียวกัน ทำให้จอเดียวมีเขียว/อำพันสองเฉดที่ดูคล้ายกัน
 * แต่ไม่ใช่ค่าเดียวกัน มาอยู่บน token ของระบบแล้วการ์ด LINE กับ badge ในเว็บ
 * จึงพูดสีเดียวกันจริง — ความหมายยังตรงกับสถานะ (สำเร็จ=paid, รอ=review,
 * ผิดพลาด=danger) ไม่ใช่การยืม token ข้ามความหมาย
 *
 * ตรวจ contrast แล้วทุกคู่ผ่าน WCAG AA (ต่ำสุด paid 4.57:1, review 4.71:1)
 */
const tonePalettes: Record<Tone, TonePalette> = {
  success: { background: "#dcfce7", title: "#15803d" },
  info: { background: "#dbeaff", title: "#1e40af" },
  warning: { background: "#fff7e6", title: "#b45309" },
  danger: { background: "#fef2f2", title: "#b91c1c" },
};

function separator(): FlexContent {
  return { type: "separator", color: "#E5E5E5" };
}

function header(tone: Tone, title: string): FlexContent {
  const palette = tonePalettes[tone];

  return {
    type: "box",
    layout: "vertical",
    backgroundColor: palette.background,
    paddingAll: "16px",
    contents: [{ type: "text", text: title, size: "lg", weight: "bold", color: palette.title, wrap: true }],
  };
}

function row(item: CardRow): FlexContent {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    contents: [
      { type: "text", text: item.label, size: "sm", color: "#525252", flex: 3, wrap: true },
      {
        type: "text",
        text: item.value,
        size: "sm",
        weight: item.bold === true ? "bold" : "regular",
        color: "#171717",
        align: "end",
        flex: 5,
        wrap: true,
      },
    ],
  };
}

function rows(list: readonly CardRow[]): FlexContent[] {
  const contents: FlexContent[] = [];

  list.forEach((item, index) => {
    if (index > 0) {
      contents.push(separator());
    }

    contents.push(row(item));
  });

  return contents;
}

function note(text: string): FlexContent {
  return { type: "text", text, size: "sm", color: "#525252", wrap: true };
}

/**
 * ปุ่มหลักของการ์ดใช้ ink เดียวกับ `.btn-primary` ของแอป
 *
 * เดิมเป็นน้ำเงิน #2563eb ซึ่งใน DESIGN.md สงวนไว้เป็น "สีเน้น" ไม่ใช่สีปุ่ม —
 * การ์ดบิล (ใบแรกในแคตตาล็อก) ใช้ ink อยู่แล้ว การเปลี่ยนมารวมที่ ink จึงทำให้
 * ปุ่มหลักของผลิตภัณฑ์เหลือค่าเดียว (การ์ดบิล ink, การ์ดอื่น ink, ปุ่มแอป ink)
 */
function footerButton(label: string, uri: string): FlexContent {
  return {
    type: "box",
    layout: "vertical",
    paddingAll: "16px",
    contents: [{ type: "button", style: "primary", color: "#171717", action: { type: "uri", label, uri } }],
  };
}

interface CardButton {
  label: string;
  uri: string;
  primary: boolean;
}

/**
 * ปุ่มหลายปุ่มใน footer เดียว — ปุ่มแรกที่ primary คือ action หลักของการ์ด
 * (LINE จัดวางปุ่มซ้อนกันในแนวตั้งให้เอง)
 */
function footerButtons(buttons: readonly CardButton[]): FlexContent {
  return {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    paddingAll: "16px",
    contents: buttons.map((button) => ({
      type: "button",
      style: button.primary ? "primary" : "secondary",
      ...(button.primary ? { color: "#171717" } : {}),
      action: { type: "uri", label: button.label, uri: button.uri },
    })),
  };
}

function card(tone: Tone, title: string, altText: string, body: FlexContent[], footer?: FlexContent): LineFlexMessage {
  const contents: FlexContent = {
    type: "bubble",
    size: "mega",
    header: header(tone, title),
    body: { type: "box", layout: "vertical", spacing: "md", paddingAll: "16px", contents: body },
  };

  if (footer !== undefined) {
    contents.footer = footer;
  }

  return { type: "flex", altText, contents };
}

function bahtText(value: number): string {
  const rounded = Math.round(value * 100) / 100;

  return Number.isInteger(rounded)
    ? formatBaht(rounded)
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function welcomeMessage(dormName: string): LineFlexMessage {
  return card("info", "ยินดีต้อนรับ", `ยินดีต้อนรับสู่${dormName} พิมพ์เลขห้องเพื่อเชื่อม LINE`, [
    note(`ยินดีต้อนรับสู่${dormName}`),
    note("พิมพ์เลขห้องของคุณ เช่น A101 เพื่อเชื่อม LINE"),
  ]);
}

export function linkedMessage(fullName: string, roomNumber: string): LineFlexMessage {
  return card("success", "เชื่อม LINE สำเร็จ", `เชื่อม LINE กับคุณ${fullName} ห้อง ${roomNumber} สำเร็จ`, rows([
    { label: "ผู้เช่า", value: fullName },
    { label: "ห้อง", value: roomNumber },
  ]));
}

export function notMatchedMessage(text: string): LineFlexMessage {
  const trimmed = text.trim();

  if (/^[A-Za-z]\d+$/.test(trimmed) || /^\d+$/.test(trimmed)) {
    return card("danger", "ไม่พบห้องนี้", `ไม่พบห้อง ${trimmed} กรุณาตรวจสอบเลขห้องอีกครั้ง`, [
      note(`ไม่พบห้อง ${trimmed} ที่มีผู้เช่าอยู่ในระบบ`),
      note("กรุณาตรวจสอบเลขห้องอีกครั้ง หรือติดต่อเจ้าของหอ"),
    ]);
  }

  return card("info", "ยังไม่พบห้องของคุณ", "พิมพ์เลขห้องเพื่อเชื่อม LINE หรือติดต่อเจ้าของหอ", [
    note("ยังไม่พบห้องของคุณ"),
    note("กรุณาพิมพ์เลขห้อง เช่น A101 เพื่อเชื่อม LINE หรือติดต่อเจ้าของหอ"),
  ]);
}

export function ownerLinkedMessage(): LineFlexMessage {
  return card("success", "เชื่อม LINE เจ้าของสำเร็จ", "เชื่อม LINE เจ้าของเรียบร้อย ระบบจะแจ้งเตือนที่ห้องแชทนี้", [
    note("เชื่อม LINE เจ้าของเรียบร้อย"),
    note("ระบบจะแจ้งเตือนที่ห้องแชทนี้"),
  ]);
}

export function slipNotLinkedMessage(): LineFlexMessage {
  return card("warning", "ยังไม่ได้เชื่อม LINE", "เชื่อม LINE กับห้องก่อนส่งสลิป พิมพ์เลขห้อง เช่น A101", [
    note("กรุณาเชื่อม LINE กับห้องของคุณก่อนส่งสลิป"),
    note("พิมพ์เลขห้อง เช่น A101 เพื่อเชื่อม"),
  ]);
}

export function slipDownloadFailedMessage(): LineFlexMessage {
  return card("danger", "รับสลิปไม่สำเร็จ", "ระบบดาวน์โหลดรูปสลิปไม่สำเร็จ กรุณาส่งรูปสลิปอีกครั้ง", [
    note("ระบบดาวน์โหลดรูปสลิปไม่สำเร็จ"),
    note("กรุณาส่งรูปสลิปอีกครั้ง"),
  ]);
}

export function slipMatchedMessage(amount: number, period: string): LineFlexMessage {
  const periodLabel = thaiPeriodLabel(period);
  const amountLabel = `${bahtText(amount)} บาท`;

  return card(
    "success",
    "ปิดบิลเรียบร้อย",
    `ได้รับชำระบิลประจำเดือน ${periodLabel} ยอด ${amountLabel} เรียบร้อยแล้ว`,
    rows([
      { label: "รอบบิล", value: periodLabel },
      { label: "ยอดชำระ", value: amountLabel, bold: true },
    ]),
  );
}

export function slipPendingReviewMessage(): LineFlexMessage {
  return card("warning", "สลิปรอตรวจสอบ", "ได้รับสลิปแล้ว เจ้าของหอจะตรวจสอบและยืนยันผลการชำระให้อีกครั้ง", [
    note("ได้รับสลิปแล้ว"),
    note("เจ้าของหอจะตรวจสอบและยืนยันผลการชำระให้อีกครั้ง"),
  ]);
}

export function slipDuplicateMessage(): LineFlexMessage {
  return card("danger", "สลิปซ้ำ", "สลิปนี้ถูกใช้ปิดบิลไปแล้ว กรุณาส่งสลิปของรายการใหม่", [
    note("สลิปนี้ถูกใช้ปิดบิลไปแล้ว"),
    note("กรุณาส่งสลิปของรายการใหม่หรือติดต่อเจ้าของหอ"),
  ]);
}

/**
 * ผู้ให้บริการบอกว่าสลิปซ้ำ แต่เราไม่พบบิลที่ปิดด้วยสลิปนี้
 *
 * ข้อความต้องไม่กล่าวหาว่า "ถูกใช้ปิดบิลไปแล้ว" เพราะเรายังไม่พบว่าถูกใช้ —
 * และต้องบอกผู้เช่าว่าเงินไม่ได้หายไปไหน แค่รอเจ้าของหอตรวจ
 */
export function slipDuplicateReviewMessage(): LineFlexMessage {
  return card("warning", "สลิปรอตรวจสอบ", "ระบบเคยเห็นสลิปใบนี้แล้ว แต่ยังไม่พบบิลที่ปิดด้วยสลิปนี้ เจ้าของหอจะตรวจสอบให้", [
    note("ระบบเคยเห็นสลิปใบนี้แล้ว"),
    note("ยังไม่พบบิลที่ปิดด้วยสลิปนี้ เจ้าของหอจะตรวจสอบและยืนยันผลให้อีกครั้ง"),
  ]);
}

export function ownerSlipPendingMessage(
  roomNumber: string,
  tenantName: string,
  slipAmount: number | null,
  billTotal: number | null,
  reasonNote: string | null = null,
): LineFlexMessage {
  const amountValue = slipAmount === null ? "อ่านไม่ได้" : `${bahtText(slipAmount)} บาท`;
  const compareValue = billTotal === null ? "ตอนรับสลิปไม่พบบิลค้าง" : `${bahtText(billTotal)} บาท`;

  return card("warning", "มีสลิปใหม่รอตรวจ", `มีสลิปใหม่รอตรวจจากห้อง ${roomNumber} คุณ${tenantName}`, [
    ...rows([
      { label: "ห้อง", value: roomNumber },
      { label: "ผู้เช่า", value: tenantName },
      { label: "ยอดในสลิป", value: amountValue, bold: true },
      { label: "เทียบกับยอดบิล", value: compareValue, bold: true },
    ]),
    ...(reasonNote === null ? [] : [separator(), note(reasonNote)]),
    separator(),
    note("เปิดหน้าคิวรอตรวจเพื่อปิดบิลหรือปฏิเสธ"),
  ]);
}

export interface OwnerSendSkip {
  roomNumber: string;
  tenantName: string;
}

export interface OwnerSendSummary {
  period: string;
  count: number;
  total: number;
  sent: number;
  failed: number;
  failedRooms: readonly string[];
  skipped: readonly OwnerSendSkip[];
}

export function ownerSendSummaryMessage(summary: OwnerSendSummary): LineFlexMessage {
  const periodLabel = thaiPeriodLabel(summary.period);
  const skippedCount = summary.skipped.length;
  const complete = summary.sent === summary.count && summary.failed === 0 && skippedCount === 0;
  const tail: FlexContent[] = [];

  if (summary.failed > 0) {
    tail.push(separator(), note(`ส่งไม่สำเร็จ: ${summary.failedRooms.join(", ")}`));
  }

  if (skippedCount > 0) {
    tail.push(
      separator(),
      note(`ยังไม่เชื่อม LINE: ${summary.skipped.map((item) => `${item.roomNumber} ${item.tenantName}`).join(" · ")}`),
    );
  }

  return card(
    complete ? "success" : "warning",
    complete ? "ส่งบิลครบทุกห้อง" : "ส่งบิลไม่ครบทุกห้อง",
    `สรุปการส่งบิลเดือน ${periodLabel} ส่งสำเร็จ ${summary.sent} ใบ จากทั้งหมด ${summary.count} ใบ`,
    [
      ...rows([
        { label: "รอบบิล", value: periodLabel },
        { label: "บิลทั้งหมด", value: `${summary.count} ใบ` },
        { label: "ยอดรวม", value: `${bahtText(summary.total)} บาท`, bold: true },
        { label: "ส่งสำเร็จ", value: `${summary.sent} ใบ` },
        { label: "ส่งไม่สำเร็จ", value: `${summary.failed} ใบ` },
        { label: "ยังไม่เชื่อม LINE", value: `${skippedCount} ห้อง` },
      ]),
      ...tail,
    ],
  );
}

export interface OwnerBillPaidCard {
  roomNumber: string;
  tenantName: string;
  period: string;
  total: number;
  /** ข้อความช่องทางที่พร้อมแสดง เช่น "สลิปอัตโนมัติ" */
  methodLabel: string;
  /** เวลาที่ชำระแบบไทย เช่น "24 ก.ย. 2569 14:05" */
  paidAtLabel: string;
  billUrl: string;
  /** null เมื่อไม่มีสลิป (ปิดบิลเอง) หรือยังไม่ตั้ง SLIP_LINK_SECRET */
  slipUrl: string | null;
}

/**
 * แจ้งเจ้าของหอว่าบิลถูกปิดแล้ว — การ์ดเดียวที่ยิงทุกเส้นทางปิดบิล
 *
 * ปุ่ม "ดูสลิป" มีเฉพาะเมื่อมีลิงก์ที่เซ็นแล้วจริง ถ้าไม่มีสลิป (ปิดเอง) หรือยัง
 * ไม่ตั้ง SLIP_LINK_SECRET ปุ่มนั้นหายไป แต่แถว "ช่องทาง" ยังบอกอยู่เสมอว่า
 * เงินเข้ามาทางไหน จึงไม่ต้องมีปุ่มที่กดแล้วพาไปเจอ 404
 */
export function ownerBillPaidMessage(input: OwnerBillPaidCard): LineFlexMessage {
  const periodLabel = thaiPeriodLabel(input.period);

  return card(
    "success",
    "รับชำระแล้ว",
    `ห้อง ${input.roomNumber} ชำระบิล ${periodLabel} แล้ว ยอด ${bahtText(input.total)} บาท`,
    rows([
      { label: "ห้อง", value: input.roomNumber },
      { label: "ผู้เช่า", value: input.tenantName },
      { label: "รอบบิล", value: periodLabel },
      { label: "ยอดชำระ", value: `${bahtText(input.total)} บาท`, bold: true },
      { label: "ช่องทาง", value: input.methodLabel },
      { label: "เวลาที่ชำระ", value: input.paidAtLabel },
    ]),
    footerButtons(
      input.slipUrl === null
        ? [{ label: "เปิดบิลในเว็บ", uri: input.billUrl, primary: true }]
        : [
            { label: "ดูสลิป", uri: input.slipUrl, primary: true },
            { label: "เปิดบิลในเว็บ", uri: input.billUrl, primary: false },
          ],
    ),
  );
}

export interface TenantBillSummary {
  period: string;
  total: number;
  status: "paid" | "unpaid";
}

export function slipInstructionMessage(): LineFlexMessage {
  return card("info", "ส่งสลิปได้เลย", "ส่งรูปสลิปโอนเงินในแชทนี้ ระบบจะตรวจสอบให้อัตโนมัติ", [
    note("ส่งรูปสลิปโอนเงินในแชทนี้ได้เลย"),
    note("ระบบจะตรวจสอบสลิปให้อัตโนมัติ"),
  ]);
}

export function billStatusMessage(roomNumber: string, bills: readonly TenantBillSummary[]): LineFlexMessage {
  const latest = bills[0];

  if (latest === undefined) {
    return card("info", "ยังไม่มีบิล", `ยังไม่มีบิลของห้อง ${roomNumber} ในระบบ`, [
      note(`ยังไม่มีบิลของห้อง ${roomNumber} ในระบบ`),
      note("เมื่อเจ้าของหอออกบิลแล้วจะแจ้งให้ทราบในแชทนี้"),
    ]);
  }

  const unpaid = bills.filter((bill) => bill.status === "unpaid");
  const outstanding = unpaid[0];

  if (outstanding === undefined) {
    const periodLabel = thaiPeriodLabel(latest.period);
    const totalLabel = `${bahtText(latest.total)} บาท`;

    return card("success", "บิลล่าสุดชำระแล้ว", `บิลห้อง ${roomNumber} ประจำเดือน ${periodLabel} ชำระแล้ว ยอด ${totalLabel}`, [
      ...rows([
        { label: "ห้อง", value: roomNumber },
        { label: "รอบบิล", value: periodLabel },
        { label: "ยอด", value: totalLabel, bold: true },
      ]),
      separator(),
      note("ไม่มียอดค้างชำระ"),
    ]);
  }

  const periodLabel = thaiPeriodLabel(outstanding.period);
  const totalLabel = `${bahtText(outstanding.total)} บาท`;
  const tail = [note("กรุณาชำระและส่งสลิปในแชทนี้")];

  if (unpaid.length > 1) {
    tail.push(note(`มียอดค้างชำระอีก ${unpaid.length - 1} ใบ`));
  }

  return card("warning", "มียอดค้างชำระ", `บิลห้อง ${roomNumber} ประจำเดือน ${periodLabel} ยอด ${totalLabel} ยังไม่ชำระ`, [
    ...rows([
      { label: "ห้อง", value: roomNumber },
      { label: "รอบบิล", value: periodLabel },
      { label: "ยอดค้างชำระ", value: totalLabel, bold: true },
    ]),
    separator(),
    ...tail,
  ]);
}

export function registerRequiredMessage(registerUrl: string): LineFlexMessage {
  return card(
    "warning",
    "ลงทะเบียนก่อนเชื่อม LINE",
    `กรุณาลงทะเบียนผู้เช่าเพื่อผูก LINE กับห้องของคุณก่อน ลงทะเบียนได้ที่ ${registerUrl}`,
    [note("กรุณาลงทะเบียนผู้เช่าเพื่อผูก LINE กับห้องของคุณก่อน"), note(registerUrl)],
    footerButton("เปิดหน้าลงทะเบียน", registerUrl),
  );
}

export function registerLinkMessage(registerUrl: string): LineFlexMessage {
  return card("info", "ลิงก์ลงทะเบียนผู้เช่า", `ลิงก์ลงทะเบียนผู้เช่า ${registerUrl}`, [
    note("เปิดลิงก์นี้เพื่อลงทะเบียนผู้เช่า"),
    note(registerUrl),
  ], footerButton("เปิดหน้าลงทะเบียน", registerUrl));
}

export function contactOwnerMessage(
  ownerName: string,
  ownerPhone: string,
  ownerLineId = "",
): LineFlexMessage {
  const name = ownerName.trim();
  const phone = ownerPhone.trim();
  const lineId = ownerLineId.trim();
  const who = name === "" ? "เจ้าของหอ" : `เจ้าของหอ ${name}`;

  /**
   * แถว LINE **ส่วนตัว** ของเจ้าของ พร้อมปุ่มคัดลอก — โครงเดียวกับแถวพร้อมเพย์
   *
   * ต้องเป็น LINE ส่วนตัวเท่านั้น ห้ามใช้ id ของ OA หอ (เช่น @490secnd) เพราะ
   * ผู้เช่าอ่านการ์ดนี้อยู่ในแชทของ OA นั้นแล้ว — ส่ง id กลับไปเท่ากับบอกให้เขา
   * เพิ่มเพื่อนบัญชีที่เขากำลังคุยด้วยอยู่แล้ว
   */
  const lineRow: FlexContent[] =
    lineId === ""
      ? []
      : [
          separator(),
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
                  note("LINE ส่วนตัวของเจ้าของ"),
                  {
                    type: "text",
                    text: lineId,
                    wrap: true,
                    size: "md",
                    weight: "bold",
                    color: "#171717",
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
                  clipboardText: lineId,
                },
              },
            ],
          },
        ];

  if (phone === "" && lineId === "") {
    return card("info", "ติดต่อเจ้าของหอ", `${who} ยังไม่ได้บันทึกช่องทางติดต่อไว้`, [
      note(`${who} ยังไม่ได้บันทึกช่องทางติดต่อไว้`),
      note("กรุณาฝากคำถามไว้ในแชทนี้แล้วรอการติดต่อกลับ"),
    ]);
  }

  const list: CardRow[] = [];

  if (name !== "") {
    list.push({ label: "เจ้าของหอ", value: name });
  }

  if (phone !== "") {
    list.push({ label: "เบอร์โทร", value: phone, bold: true });
  }

  return card(
    "info",
    "ติดต่อเจ้าของหอ",
    phone === ""
      ? `ติดต่อเจ้าของหอ LINE ส่วนตัว ${lineId}`
      : `ติดต่อเจ้าของหอ เบอร์โทร ${phone}`,
    [...rows(list), ...lineRow],
  );
}
