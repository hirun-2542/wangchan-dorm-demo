import banksData from "../../../public/bank-logo/banks.json";

/**
 * ตั้งค่าเก็บ "รหัสธนาคาร" ไว้ (เช่น "scb") ไม่ใช่ชื่อไทย เพื่อให้จับคู่กับ
 * โลโก้ในหน้าตั้งค่าได้ (`src/client/pages/banks.ts` ทำแบบเดียวกันฝั่ง client)
 * ไฟล์นี้เป็นฝั่ง worker ที่ไม่มี tsconfig ร่วมกับ client จึง import ไฟล์
 * `public/bank-logo/banks.json` เดียวกันตรง ๆ แทนการคัดลอกข้อมูลธนาคารซ้ำ
 */
const thaiBanks: Record<string, { thai_name: string }> = banksData.th;

/** คืนชื่อธนาคารภาษาไทย หรือรหัสเดิมถ้าไม่รู้จัก หรือค่าว่างถ้าไม่ได้ตั้งค่า */
export function bankThaiName(id: string): string {
  const trimmed = id.trim();

  if (trimmed === "") {
    return "";
  }

  return thaiBanks[trimmed]?.thai_name ?? trimmed;
}
