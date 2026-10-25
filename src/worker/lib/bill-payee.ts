/**
 * ผู้รับเงิน (ชื่อหอ/เจ้าของ + พร้อมเพย์ + บัญชีธนาคาร) ที่ snapshot ลงบิลตอนออก
 * และการคำนวณบิลที่ "ยังไม่จ่าย" ทุกใบใหม่เมื่อช่องทางรับเงินเปลี่ยน
 *
 * ต่างจาก bill-rates.ts โดยตั้งใจ: บิลที่ส่งไปแล้วก็ยังต้องอัปเดตด้วยถ้ายังไม่จ่าย
 * เพราะการเปลี่ยนช่องทางรับเงิน (เช่น เปลี่ยนธนาคาร/เจ้าของบัญชี) ไม่กระทบยอดเงิน
 * เลย จึงไม่ชนกับการปิดบิลอัตโนมัติที่เทียบยอดสลิปตรงเป๊ะ (ADR 0001) และความเสี่ยง
 * ที่ผู้เช่าโอนเข้าบัญชี/ชื่อที่ไม่ใช่ตัวจริงอีกต่อไปสำคัญกว่าความสับสนที่ QR ใน
 * แชทเดิมกับใบแจ้งหนี้ที่เปิดใหม่ไม่ตรงกัน — บิลที่จ่ายแล้วเท่านั้นที่ยังคงเดิม
 * เพราะจบธุรกรรมไปแล้วจริง ๆ (ดู migration 0011)
 */

export interface PayeeSnapshot {
  dormName: string;
  ownerName: string;
  promptpayId: string;
  promptpayType: "phone" | "citizen-id";
  promptpayName: string;
  bankName: string;
  bankAccountNumber: string;
  bankAccountName: string;
}

export const payeeSettingKeys = [
  "dorm_name",
  "owner_name",
  "promptpay_id",
  "promptpay_type",
  "promptpay_name",
  "bank_name",
  "bank_account_number",
  "bank_account_name",
] as const;

/**
 * อ่านผู้รับเงินปัจจุบันของครอบครัว เพื่อ snapshot ลงบิลที่กำลังจะออก ณ ตอนนี้
 *
 * เรียกตอนออกบิลใหม่ และตอนคำนวณบิลที่ยังไม่จ่ายใหม่เมื่อช่องทางเปลี่ยน — ไม่ใช่
 * ตอนแสดงผลบิลตามปกติ ซึ่งอ่านจากคอลัมน์ snapshot ในบิลเองเสมอ
 */
export async function loadPayeeSnapshot(
  env: Env,
  family: string,
): Promise<PayeeSnapshot> {
  const placeholders = payeeSettingKeys.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE family_id = ? AND key IN (${placeholders})`,
  )
    .bind(family, ...payeeSettingKeys)
    .all<{ key: string; value: string }>();
  const stored = new Map(result.results.map((row) => [row.key, row.value]));

  return {
    dormName: stored.get("dorm_name") ?? "",
    ownerName: stored.get("owner_name") ?? "",
    promptpayId: stored.get("promptpay_id") ?? "",
    promptpayType: stored.get("promptpay_type") === "citizen-id" ? "citizen-id" : "phone",
    promptpayName: stored.get("promptpay_name") ?? "",
    bankName: stored.get("bank_name") ?? "",
    bankAccountNumber: stored.get("bank_account_number") ?? "",
    bankAccountName: stored.get("bank_account_name") ?? "",
  };
}

const recalcPayeeSql =
  "UPDATE bills SET payee_dorm_name = ?, payee_owner_name = ?, payee_promptpay_id = ?, payee_promptpay_type = ?, payee_promptpay_name = ?, payee_bank_name = ?, payee_bank_account_number = ?, payee_bank_account_name = ? WHERE family_id = ? AND status = 'unpaid'";

/**
 * เขียนผู้รับเงินปัจจุบันทับบิลที่ "ยังไม่จ่าย" ทุกใบของครอบครัว ไม่ว่าจะส่งไป
 * แล้วหรือยัง — ไม่แยกตามห้อง เพราะผู้รับเงินเป็นค่าเดียวของทั้งหอ ไม่มี override
 * รายห้องต่างจากอัตราน้ำ/ไฟ เรียกซ้ำได้เสมอ (idempotent)
 */
export async function recalcUnpaidBillsPayee(
  env: Env,
  family: string,
): Promise<void> {
  const payee = await loadPayeeSnapshot(env, family);

  await env.DB.prepare(recalcPayeeSql)
    .bind(
      payee.dormName,
      payee.ownerName,
      payee.promptpayId,
      payee.promptpayType,
      payee.promptpayName,
      payee.bankName,
      payee.bankAccountNumber,
      payee.bankAccountName,
      family,
    )
    .run();
}
