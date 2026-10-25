/**
 * รายชื่อธนาคารไทยจาก public/bank-logo/banks.json
 * โลโก้ทุกไฟล์เป็นสีขาวบนพื้นโปร่งใส จึงต้องแสดงบนพื้นสีของธนาคารเสมอ
 */
export interface Bank {
  /** รหัสไฟล์โลโก้ เช่น kbank → /bank-logo/th/kbank.svg */
  id: string;
  /** รหัสธนาคาร 3 หลักตามมาตรฐานธนาคารแห่งประเทศไทย */
  code: string;
  /** สีประจำธนาคาร ใช้เป็นพื้นหลังของโลโก้ */
  color: string;
  thaiName: string;
}

interface BankEntry {
  code?: unknown;
  color?: unknown;
  thai_name?: unknown;
}

interface BanksFile {
  th?: Record<string, BankEntry>;
}

function toBank(id: string, entry: BankEntry): Bank | null {
  const { code, color, thai_name: thaiName } = entry;

  if (
    typeof code !== "string" ||
    typeof color !== "string" ||
    typeof thaiName !== "string"
  ) {
    return null;
  }

  if (thaiName.trim() === "" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return null;
  }

  return { id, code, color: color.toLowerCase(), thaiName };
}

/** โหลดรายชื่อธนาคาร — ไฟล์เสียหรือไม่มีจะได้รายการว่าง ไม่ทำให้หน้าพัง */
export async function fetchBanks(): Promise<Bank[]> {
  try {
    const response = await fetch("/bank-logo/banks.json");

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as BanksFile;
    const entries = data.th;

    if (entries === undefined) {
      return [];
    }

    return Object.entries(entries)
      .map(([id, entry]) => toBank(id, entry))
      .filter((bank): bank is Bank => bank !== null)
      .sort((a, b) => a.code.localeCompare(b.code));
  } catch {
    return [];
  }
}

export function bankLogoUrl(id: string): string {
  return `/bank-logo/th/${encodeURIComponent(id)}.svg`;
}
