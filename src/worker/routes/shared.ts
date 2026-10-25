export type ErrorCode = "VALIDATION" | "CONFLICT" | "DUPLICATE" | "NOT_FOUND" | "INTERNAL" | "UPSTREAM";

export interface ErrorBody {
  ok: false;
  error: { code: ErrorCode; message: string; field?: string };
}

/** ตั้งค่าของครอบครัว — คีย์คือ (family_id, key) จึงต้องผูก family_id เป็นพารามิเตอร์ตัวแรกเสมอ */
export const upsertSettingSql =
  "INSERT INTO settings (family_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(family_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";

/** ห้องที่ใช้บิลการไฟฟ้ารวมล่าสุด — จำไว้ให้กล่องคำนวณในหน้าออกบิลเลือกไว้ให้เดือนถัดไป */
export const sharedElectricRoomIdsKey = "shared_electric_room_ids";

export function roomNumberOrder(column: string): string {
  return `LENGTH(${column}), ${column}`;
}

export function errorBody(code: ErrorCode, message: string, field?: string): ErrorBody {
  return field === undefined ? { ok: false, error: { code, message } } : { ok: false, error: { code, message, field } };
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return asRecord(body);
  } catch {
    return null;
  }
}
