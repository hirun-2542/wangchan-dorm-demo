export const sessionCookieName = "wangchan_session";

/** อายุเซสชัน 30 วัน นับใหม่ทุกครั้งที่ใช้งาน */
const sessionDays = 30;
const sessionSeconds = sessionDays * 24 * 60 * 60;

export type FamilyRole = "owner" | "member";

export interface SessionUser {
  userId: string;
  familyId: string;
  email: string;
  displayName: string;
  role: FamilyRole;
}

interface SessionRow {
  user_id: string;
  family_id: string;
  email: string;
  display_name: string;
  role: string;
}

function toHex(bytes: Uint8Array): string {
  let out = "";

  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }

  return out;
}

/** เก็บเฉพาะ hash ของ token ฐานข้อมูลที่รั่วจึงสวมสิทธิ์ไม่ได้ */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export function newSessionToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function sessionExpiryIso(): string {
  return new Date(Date.now() + sessionSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export async function createSession(db: D1Database, userId: string, familyId: string): Promise<string> {
  const token = newSessionToken();

  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, family_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(token), userId, familyId, sessionExpiryIso())
    .run();

  return token;
}

const sessionSelect = `SELECT s.user_id, s.family_id, u.email, u.display_name, m.role
FROM sessions s
JOIN users u ON u.id = s.user_id
JOIN family_members m ON m.family_id = s.family_id AND m.user_id = s.user_id
WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')`;

/**
 * คืนผู้ใช้ของเซสชัน หรือ null เมื่อ token ใช้ไม่ได้
 *
 * การ JOIN กับ family_members ทำให้การถอดสมาชิกออกจากครอบครัวมีผลทันที
 * กับทุกเซสชันของคนนั้น โดยไม่ต้องไล่เพิกถอนทีละใบ
 */
export async function loadSession(db: D1Database, token: string): Promise<SessionUser | null> {
  const row = await db
    .prepare(sessionSelect)
    .bind(await hashToken(token))
    .first<SessionRow>();

  if (row === null) {
    return null;
  }

  const role: FamilyRole = row.role === "owner" ? "owner" : "member";

  return {
    userId: row.user_id,
    familyId: row.family_id,
    email: row.email,
    displayName: row.display_name,
    role,
  };
}

export async function touchSession(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE token_hash = ?")
    .bind(sessionExpiryIso(), await hashToken(token))
    .run();
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await hashToken(token))
    .run();
}

/** ใช้ตอนถอดสมาชิกออกจากครอบครัว เพื่อเตะทุกอุปกรณ์ของคนนั้นออก */
export async function revokeUserSessions(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL")
    .bind(userId)
    .run();
}

export function sessionCookie(token: string, secure: boolean): string {
  const flags = [
    `${sessionCookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${sessionSeconds}`,
  ];

  if (secure) {
    flags.push("Secure");
  }

  return flags.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  const flags = [`${sessionCookieName}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];

  if (secure) {
    flags.push("Secure");
  }

  return flags.join("; ");
}

export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    if (part.slice(0, separator).trim() === sessionCookieName) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? null : value;
    }
  }

  return null;
}
