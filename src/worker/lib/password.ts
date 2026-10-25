import { argon2id } from "@noble/hashes/argon2.js";

/**
 * พารามิเตอร์ตามระดับที่ OWASP แนะนำเป็นขั้นต่ำสำหรับ Argon2id
 * (m=19456 KiB, t=2, p=1) วัดจริงในรันไทม์ของ Workers ได้ราว 290ms ต่อครั้ง
 * ล็อกอินไม่ได้เกิดถี่ จึงแลกเวลานี้กับความทนต่อการเดารหัสผ่านได้คุ้ม
 */
const memoryKib = 19456;
const timeCost = 2;
const parallelism = 1;
const keyLength = 32;
const saltLength = 16;

/** ความยาวต่ำสุดของรหัสผ่าน อิงตามที่ NIST แนะนำ */
export const minPasswordLength = 12;

/** กันไม่ให้ payload ยาวผิดปกติกลายเป็นภาระ CPU */
export const maxPasswordLength = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

/** เทียบไบต์แบบเวลาคงที่ ไม่รั่วข้อมูลผ่านเวลาที่ใช้ */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }

  return diff === 0;
}

/** คืนสตริงรูปแบบ PHC ที่เก็บพารามิเตอร์ไว้ในตัวเอง ปรับค่าภายหลังได้ */
export function hashPassword(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(saltLength));
  const hash = argon2id(password, salt, {
    m: memoryKib,
    t: timeCost,
    p: parallelism,
    dkLen: keyLength,
  });

  const params = `m=${memoryKib},t=${timeCost},p=${parallelism}`;
  return `$argon2id$v=19$${params}$${toBase64(salt)}$${toBase64(hash)}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");

  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") {
    return false;
  }

  const params = new Map<string, number>();

  for (const pair of (parts[3] ?? "").split(",")) {
    const [name, raw] = pair.split("=");
    const value = Number(raw);

    if (name === undefined || !Number.isInteger(value) || value <= 0) {
      return false;
    }

    params.set(name, value);
  }

  const m = params.get("m");
  const t = params.get("t");
  const p = params.get("p");
  const salt = fromBase64(parts[4] ?? "");
  const expected = fromBase64(parts[5] ?? "");

  if (m === undefined || t === undefined || p === undefined || salt === null || expected === null) {
    return false;
  }

  // กันไม่ให้แฮชที่ถูกแก้ให้ค่าสูงเกินจริงกลายเป็นช่องทำ CPU ให้หมด
  if (m > 65536 || t > 8 || p > 4 || expected.length > 64) {
    return false;
  }

  const actual = argon2id(password, salt, { m, t, p, dkLen: expected.length });
  return equalBytes(actual, expected);
}

/** รหัสผ่านที่สั้นหรือว่างเปล่าเกินไปถูกปฏิเสธก่อนถึงการแฮช */
export function passwordError(value: unknown): string | null {
  if (typeof value !== "string" || value === "") {
    return "กรุณากรอกรหัสผ่าน";
  }

  if (value.length < minPasswordLength) {
    return `รหัสผ่านต้องยาวอย่างน้อย ${minPasswordLength} ตัวอักษร`;
  }

  if (value.length > maxPasswordLength) {
    return `รหัสผ่านต้องยาวไม่เกิน ${maxPasswordLength} ตัวอักษร`;
  }

  return null;
}
