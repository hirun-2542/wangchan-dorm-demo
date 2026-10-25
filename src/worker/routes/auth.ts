import { Hono } from "hono";
import type { AppEnv } from "../lib/auth";
import { isSecureRequest, maxFamilyMembers, requireAuth, sameOriginOnly } from "../lib/auth";
import {
  clearedGoogleReturnCookie,
  clearedGoogleStateCookie,
  exchangeGoogleCode,
  googleAuthorizeUrl,
  googleRedirectUri,
  googleReturnCookie,
  googleStateCookie,
  readGoogleReturnCookie,
  readGoogleStateCookie,
} from "../lib/google";
import { safeReturnPath } from "../../shared/return-path";
import {
  clearedSessionCookie,
  createSession,
  hashToken,
  newSessionToken,
  revokeSession,
  sessionCookie,
} from "../lib/session";
import { hashPassword, passwordError, verifyPassword } from "../lib/password";
import { isUniqueViolation } from "../lib/slips";
import { demoModeOn } from "../line/api";
import { errorBody, readJsonObject } from "./shared";

const auth = new Hono<AppEnv>();

auth.use("*", sameOriginOnly);

/** ครอบครัวที่ migration สร้างไว้ให้ข้อมูลเดิม รอเจ้าของมา claim */
const legacyFamilyId = "00000000-0000-4000-8000-000000000001";

const maxEmailLength = 254;

function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const email = value.trim().toLowerCase();

  if (email.length < 3 || email.length > maxEmailLength || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  return email;
}

/** เทียบอีเมลแบบไม่สนตัวพิมพ์ — ใช้ตัดสินว่าใครเป็นเจ้าของที่ตั้งค่าไว้ */
function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** อีเมลเจ้าของระบบที่ตั้งไว้ใน config — ค่าว่างแปลว่ายังไม่ได้ตั้ง */
function configuredOwnerEmail(env: Env): string {
  return normaliseEmail(env.OWNER_EMAIL ?? "") ?? "";
}

/** ครอบครัวเดิมมีเจ้าของแล้วหรือยัง — ตัวตัดสินว่าใครมีสิทธิ์ยึดข้อมูลเดิม */
async function familyHasOwner(db: D1Database, family: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM family_members WHERE family_id = ? LIMIT 1")
    .bind(family)
    .first<{ one: number }>();

  return row !== null;
}

/**
 * เพิ่มสมาชิกโดยไม่ให้เกินเพดาน แม้สองคำขอจะมาพร้อมกัน
 *
 * เงื่อนไขนับอยู่ในคำสั่ง INSERT เดียว และ ON CONFLICT ทำให้การเพิ่มซ้ำ
 * (คำขอที่แข่งกันของคนเดียวกัน) ไม่กลายเป็น error
 * คืน true เมื่อได้เป็นสมาชิกจริง ๆ ไม่ว่าจะเพิ่งเพิ่มหรือมีอยู่ก่อนแล้ว
 */
async function joinFamilyOnce(
  db: D1Database,
  family: string,
  userId: string,
  role: string,
): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO family_members (family_id, user_id, role)
       SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM family_members WHERE family_id = ?) < ?
       ON CONFLICT(family_id, user_id) DO NOTHING`,
    )
    .bind(family, userId, role, family, maxFamilyMembers)
    .run();

  if (inserted.meta.changes > 0) {
    return true;
  }

  // ไม่ได้เพิ่มแถวใหม่: เป็นสมาชิกอยู่แล้ว (คำขอที่แข่งกัน) หรือครอบครัวเต็ม
  const existing = await db
    .prepare("SELECT 1 AS one FROM family_members WHERE family_id = ? AND user_id = ?")
    .bind(family, userId)
    .first<{ one: number }>();

  return existing !== null;
}

/**
 * ตั้งเจ้าของคนแรกให้ครอบครัวเดิมที่ถือข้อมูลอยู่
 *
 * เดิมด่านนี้เป็น BOOTSTRAP_SECRET ซึ่งเจ้าของหอต้องไปหามาจากที่ไหนสักแห่ง
 * และจำไว้ ต่อมาใช้ OWNER_EMAIL ที่ตั้งไว้ใน config แทน และตอนนี้เหลือทางเดียว
 * คือเข้าด้วย Google ด้วยอีเมลนั้น: ตั้งบัญชีได้เฉพาะตอนที่ครอบครัวเดิมยังไม่มี
 * เจ้าของเท่านั้น
 *
 * ไม่เปิดสร้างครอบครัวใหม่จากที่นี่อีกแล้ว — การเพิ่มคนเข้าครอบครัวต้องผ่าน
 * เจ้าของครอบครัวเท่านั้น (คำเชิญ) จึงไม่มีทางเกิดครอบครัวแปลกปลอมขึ้นเอง
 */
async function claimLegacyFamily(
  db: D1Database,
  email: string,
  displayName: string,
  familyName: string,
): Promise<{ userId: string; familyId: string } | "taken"> {
  const userId = crypto.randomUUID();

  // "ยังไม่มีเจ้าของ" ต้องเป็นเงื่อนไขของการสร้างบัญชีเอง ไม่ใช่ตรวจก่อนแล้วค่อยเขียน
  // สองคำขอที่มาพร้อมกันจึงยึดครอบครัวเดียวกันได้ไม่ทั้งคู่ (SQLite เรียงคิวการเขียน
  // คำขอที่สองจึงเห็นผลของคำขอแรกแล้ว)
  //
  // คำสั่งที่สองมี EXISTS กำกับเพราะ family_members อ้าง users(id): ถ้าคำสั่งแรก
  // ไม่ได้สร้างผู้ใช้ (เพราะมีเจ้าของแล้ว) คำสั่งที่สองต้องไม่ทำอะไร ไม่ใช่พังเรื่อง FK
  //
  // password_hash เก็บเป็นค่าว่างเพราะบัญชีเกิดจาก Google ยังไม่มีรหัสผ่าน ผู้ใช้ตั้งเอง
  // ภายหลังจากหน้าบัญชีได้ (ค่าว่างเข้าสู่ระบบด้วยรหัสผ่านไม่ได้ ดู POST /login)
  const statements = [
    db
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash)
         SELECT ?, ?, ?, ''
         WHERE NOT EXISTS (SELECT 1 FROM family_members WHERE family_id = ?)`,
      )
      .bind(userId, email, displayName, legacyFamilyId),
    db
      .prepare(
        `INSERT INTO family_members (family_id, user_id, role)
         SELECT ?, ?, 'owner' WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
      )
      .bind(legacyFamilyId, userId, userId),
  ];

  if (familyName !== "") {
    statements.push(
      db.prepare("UPDATE families SET name = ? WHERE id = ?").bind(familyName, legacyFamilyId),
    );
  }

  const results = await db.batch(statements);

  if ((results[1]?.meta.changes ?? 0) === 0) {
    return "taken";
  }

  return { userId, familyId: legacyFamilyId };
}



/** พาไปหน้าเลือกบัญชีของ Google พร้อม state ที่เราจำไว้ */
auth.get("/google/start", (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID ?? "";

  if (clientId === "") {
    return c.redirect("/?auth=error&reason=google_disabled");
  }

  const secure = isSecureRequest(c);
  const state = newSessionToken();
  const redirectUri = googleRedirectUri(c.req.url);
  const response = c.redirect(googleAuthorizeUrl(clientId, redirectUri, state));

  response.headers.append("set-cookie", googleStateCookie(state, secure));

  /**
   * ที่หมายปลายทาง (fragment ของแอป) ฝากในคุกกี้แยก — ลิงก์ที่บอทส่งมาให้เจ้าของ
   * เปิดบิลจะพาไป `#bills/detail/<id>` และต้องรอดข้าม OAuth กลับมาให้ได้
   */
  const returnPath = safeReturnPath(c.req.query("next"));

  if (returnPath !== null) {
    response.headers.append("set-cookie", googleReturnCookie(returnPath, secure));
  }

  return response;
});

/**
 * สร้างคำตอบเด้งกลับหน้าแรก (หรือ fragment ที่ฝากไว้) ตามคำขอเดิม
 *
 * สร้างเองแทน Response.redirect() เพราะ Response.redirect() ให้ header ที่แก้ไม่ได้
 * (immutable) จึงต่อคุกกี้เข้าไปด้วยไม่ได้ — จะ throw ตอนรัน
 *
 * `returnPath` ถูกตรวจด้วย `safeReturnPath` ก่อนฝากไว้แล้ว และที่นี่ตรวจซ้ำอีกชั้น
 * เพราะคุกกี้เป็นข้อมูลที่ผู้ใช้แก้เองได้
 */
function redirectHome(
  requestUrl: string,
  params: Record<string, string>,
  cookies: string[],
  returnPath: string | null = null,
): Response {
  const origin = new URL(requestUrl).origin;
  const target = new URL("/", origin);

  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }

  const safe = safeReturnPath(returnPath);
  const location = safe === null ? target.toString() : `${target.toString()}${safe}`;
  const headers = new Headers({ location });

  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(null, { status: 302, headers });
}

/**
 * เด้งกลับหน้าแรกพร้อมรหัสสาเหตุ ให้หน้าเว็บแปลเป็นข้อความไทย
 *
 * ฝาก `next` ต่อไปด้วย เพราะล้มเหลวกลางทาง (ผู้ใช้กดยกเลิก เลือกบัญชีผิด) ไม่ควร
 * ทำให้ที่หมายหาย — กดลองใหม่จากหน้าเข้าสู่ระบบต้องไปถึงบิลใบเดิมได้
 */
function googleError(
  c: { req: { url: string } },
  reason: string,
  secure: boolean,
  returnPath: string | null,
): Response {
  const params: Record<string, string> = { auth: "error", reason };

  if (safeReturnPath(returnPath) !== null) {
    params.next = returnPath ?? "";
  }

  return redirectHome(c.req.url, params, [
    clearedGoogleStateCookie(secure),
    clearedGoogleReturnCookie(secure),
  ], returnPath);
}

/** ล็อกอินสำเร็จ: ตั้งคุกกี้เซสชันแล้วกลับหน้าแรก (หรือบิลที่ฝากไว้) */
function googleSuccess(
  c: { req: { url: string } },
  token: string,
  secure: boolean,
  returnPath: string | null,
): Response {
  return redirectHome(
    c.req.url,
    {},
    [sessionCookie(token, secure), clearedGoogleStateCookie(secure), clearedGoogleReturnCookie(secure)],
    returnPath,
  );
}

auth.get("/google/callback", async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET ?? "";
  const secure = isSecureRequest(c);
  const expectedState = readGoogleStateCookie(c.req.header("cookie"));
  const state = c.req.query("state") ?? "";
  // ที่หมายที่ฝากไว้ตอนเริ่มล็อกอิน — ต้องอ่านก่อนล้างคุกกี้
  const returnPath = safeReturnPath(readGoogleReturnCookie(c.req.header("cookie")));

  const fail = (reason: string): Response => googleError(c, reason, secure, returnPath);

  if (clientId === "" || clientSecret === "") {
    return fail("google_disabled");
  }

  if (c.req.query("error") !== undefined) {
    return fail("denied");
  }

  const code = c.req.query("code") ?? "";

  // state ต้องตรงกับคุกกี้ที่เราตั้งตอนเริ่ม ไม่งั้นเป็นคำขอที่ไม่ได้เริ่มจากเรา
  if (code === "" || state === "" || expectedState === null || state !== expectedState) {
    return fail("state");
  }

  const profile = await exchangeGoogleCode({
    code,
    clientId,
    clientSecret,
    redirectUri: googleRedirectUri(c.req.url),
  });

  if (profile === null) {
    return fail("google_failed");
  }

  const existing = await c.env.DB.prepare(
    `SELECT u.id AS user_id, u.display_name, m.family_id, m.role
     FROM users u LEFT JOIN family_members m ON m.user_id = u.id
     WHERE u.email = ?`,
  )
    .bind(profile.email)
    .first<{ user_id: string; display_name: string; family_id: string | null; role: string | null }>();

  if (existing !== null) {
    if (existing.family_id === null) {
      return fail("no_family");
    }

    const token = await createSession(c.env.DB, existing.user_id, existing.family_id);

    return googleSuccess(c, token, secure, returnPath);
  }

  // ยังไม่มีบัญชี: รับได้เฉพาะอีเมลเจ้าของที่ตั้งค่าไว้ หรืออีเมลที่มีคำเชิญค้าง
  const ownerEmail = configuredOwnerEmail(c.env);

  if (ownerEmail !== "" && sameEmail(profile.email, ownerEmail) && !(await familyHasOwner(c.env.DB, legacyFamilyId))) {
    const claimed = await claimLegacyFamily(c.env.DB, profile.email, profile.displayName, "");

    if (claimed !== "taken") {
      const token = await createSession(c.env.DB, claimed.userId, claimed.familyId);

      return googleSuccess(c, token, secure, returnPath);
    }
  }

  const invite = await c.env.DB.prepare(
    `SELECT token_hash, family_id, role FROM family_invites
     WHERE email = ? AND accepted_at IS NULL AND expires_at > datetime('now')
     ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(profile.email)
    .first<{ token_hash: string; family_id: string; role: string }>();

  if (invite === null) {
    return fail("not_invited");
  }

  // สร้างบัญชีให้ก่อนแล้วค่อยเข้าครอบครัว เพราะ family_members อ้าง users(id)
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, '') ON CONFLICT(email) DO NOTHING",
  )
    .bind(crypto.randomUUID(), profile.email, profile.displayName)
    .run();

  const created = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(profile.email)
    .first<{ id: string }>();

  if (created === null) {
    return fail("google_failed");
  }

  const joined = await joinFamilyOnce(c.env.DB, invite.family_id, created.id, invite.role === "owner" ? "owner" : "member");

  if (!joined) {
    return fail("family_full");
  }

  await c.env.DB.prepare(
    "UPDATE family_invites SET accepted_at = datetime('now'), accepted_by = ? WHERE token_hash = ? AND accepted_at IS NULL",
  )
    .bind(created.id, invite.token_hash)
    .run();

  const token = await createSession(c.env.DB, created.id, invite.family_id);

  return googleSuccess(c, token, secure, returnPath);
});



/**
 * ข้อมูลคำเชิญสำหรับหน้าเข้าครอบครัวของผู้รับ
 *
 * คนที่เปิดลิงก์คือคนที่ยังไม่มีบัญชี เส้นทางนี้จึงอยู่ใต้ /api/auth/ ที่ไม่ต้องล็อกอิน
 * และตอบเฉพาะสิ่งที่ผู้ถือลิงก์ควรเห็นอยู่แล้ว — ชื่อหอ · อีเมลที่ถูกเชิญ · วันหมดอายุ
 * ไม่ตอบว่าใครเชิญหรือมีใครอยู่ในครอบครัวแล้วบ้าง
 */
auth.get("/invites/:token", async (c) => {
  const rawToken = c.req.param("token").trim();

  if (rawToken === "" || rawToken.length > 200) {
    return c.json(errorBody("VALIDATION", "คำเชิญไม่ถูกต้องหรือหมดอายุแล้ว", "token"), 400);
  }

  const invite = await c.env.DB.prepare(
    `SELECT i.email, i.expires_at, f.name AS family_name
     FROM family_invites i
     JOIN families f ON f.id = i.family_id
     WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > datetime('now')`,
  )
    .bind(await hashToken(rawToken))
    .first<{ email: string; expires_at: string; family_name: string }>();

  if (invite === null) {
    return c.json(errorBody("VALIDATION", "คำเชิญไม่ถูกต้องหรือหมดอายุแล้ว", "token"), 400);
  }

  return c.json({
    ok: true,
    familyName: invite.family_name,
    email: invite.email,
    expiresAt: invite.expires_at,
  });
});

/**
 * ชื่อผู้ใช้สำหรับเข้าด้วยรหัสผ่าน — ตัวพิมพ์เล็ก ตัวเลข จุด ขีดกลาง ขีดล่าง
 *
 * เก็บเป็นตัวพิมพ์เล็กเสมอเพื่อให้ดัชนี unique กันชื่อซ้ำได้จริง ส่วนตอนเข้าสู่ระบบ
 * ผู้ใช้พิมพ์ตัวใหญ่ได้ (มือถือมักขึ้นตัวใหญ่ให้เอง) โดยไม่ทำให้เข้าไม่ได้
 */
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function normaliseUsername(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const username = value.trim().toLowerCase();
  return usernamePattern.test(username) ? username : null;
}

/** ยอมให้ล็อกอินพลาดได้เท่านี้ครั้งต่อหนึ่งช่วงเวลา */
const maxLoginAttempts = 8;
const loginAttemptWindowMinutes = 15;

async function tooManyAttempts(db: D1Database, scope: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE scope = ? AND attempted_at > datetime('now', ?)")
    .bind(scope, `-${String(loginAttemptWindowMinutes)} minutes`)
    .first<{ n: number }>();

  return (row?.n ?? 0) >= maxLoginAttempts;
}

async function recordAttempt(db: D1Database, scope: string): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO login_attempts (id, scope) VALUES (?, ?)").bind(crypto.randomUUID(), scope),
    db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 day')"),
  ]);
}

async function clearAttempts(db: D1Database, scopes: string[]): Promise<void> {
  await db.batch(scopes.map((scope) => db.prepare("DELETE FROM login_attempts WHERE scope = ?").bind(scope)));
}

/**
 * แฮชหลอกไว้ตรวจแทนเมื่อไม่มีชื่อผู้ใช้นั้นหรือบัญชีนั้นยังไม่มีรหัสผ่าน
 *
 * Argon2id ใช้เวลาราว 290ms ถ้าข้ามการตรวจเมื่อไม่พบผู้ใช้ เวลาตอบจะบอกผู้ยิงได้ว่า
 * ชื่อไหนมีอยู่จริง จึงตรวจกับแฮชหลอกให้ใช้เวลาเท่ากัน สร้างครั้งแรกที่ใช้แล้วจำไว้
 * ไม่สร้างตอนโหลดโมดูลเพราะจะไปกินเวลาสตาร์ตของทุกคำขอ
 */
let decoyHash: string | null = null;

function decoyPasswordHash(): string {
  decoyHash ??= hashPassword(crypto.randomUUID());
  return decoyHash;
}

/**
 * เข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่าน
 *
 * บัญชีทั้งหมดเริ่มจาก Google การมีชื่อผู้ใช้/รหัสผ่านต้องตั้งเองจากหน้าบัญชีหลังเข้า
 * ด้วย Google ก่อน (PUT /credentials) ทางนี้จึงไม่สร้างบัญชีและไม่รับคนนอกครอบครัว
 */
auth.post("/login", async (c) => {
  if (demoModeOn(c.env)) {
    return c.json(errorBody("VALIDATION", "เดโมไม่เปิดให้เข้าสู่ระบบด้วยรหัสผ่าน"), 403);
  }

  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const username = normaliseUsername(body.username);
  const password = typeof body.password === "string" ? body.password : "";
  const ipScope = `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`;
  const userScope = `user:${username ?? "invalid"}`;

  if ((await tooManyAttempts(c.env.DB, ipScope)) || (await tooManyAttempts(c.env.DB, userScope))) {
    return c.json(errorBody("VALIDATION", "พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่"), 429);
  }

  const failed = async () => {
    await recordAttempt(c.env.DB, ipScope);
    await recordAttempt(c.env.DB, userScope);
    return c.json(errorBody("VALIDATION", "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"), 401);
  };

  if (username === null || password === "" || password.length > 256) {
    return failed();
  }

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.password_hash, m.family_id
     FROM users u
     LEFT JOIN family_members m ON m.user_id = u.id
     WHERE u.username = ?
     LIMIT 1`,
  )
    .bind(username)
    .first<{ id: string; password_hash: string; family_id: string | null }>();

  const stored = row !== null && row.password_hash !== "" ? row.password_hash : null;
  const matches = verifyPassword(password, stored ?? decoyPasswordHash());

  if (row === null || stored === null || !matches) {
    return failed();
  }

  if (row.family_id === null) {
    return c.json(errorBody("VALIDATION", "บัญชีนี้ยังไม่ได้อยู่ในครอบครัวใด"), 403);
  }

  await clearAttempts(c.env.DB, [ipScope, userScope]);

  const token = await createSession(c.env.DB, row.id, row.family_id);
  c.header("set-cookie", sessionCookie(token, isSecureRequest(c)));

  return c.json({ ok: true });
});

/** บอกหน้าบัญชีว่าบัญชีนี้ตั้งชื่อผู้ใช้/รหัสผ่านไว้แล้วหรือยัง — ไม่ส่งแฮชออกไป */
auth.get("/credentials", requireAuth, async (c) => {
  const row = await c.env.DB.prepare("SELECT username, password_hash FROM users WHERE id = ?")
    .bind(c.get("session").userId)
    .first<{ username: string | null; password_hash: string }>();

  return c.json({
    ok: true,
    username: row?.username ?? null,
    // รหัสผ่านที่ไม่มีชื่อผู้ใช้เข้าสู่ระบบไม่ได้ จึงนับว่ายังไม่ได้ตั้ง
    hasPassword: row !== null && row.username !== null && row.password_hash !== "",
  });
});

/**
 * ตั้งหรือเปลี่ยนชื่อผู้ใช้และรหัสผ่านของตัวเอง
 *
 * ไม่ถามรหัสเดิมโดยตั้งใจ: เซสชันที่ล็อกอินอยู่ (ซึ่งเริ่มจาก Google) คือตัวยืนยันตัวตน
 * ผู้ที่ลืมรหัสจึงกู้เองได้ด้วยการเข้า Google แล้วตั้งใหม่ — ต่างจากระบบรหัสผ่านเดิมที่
 * ต้องรู้รหัสเดิมก่อนเปลี่ยนจึงเป็นทางตัน (ดู commit 01e9484)
 *
 * ตั้งได้เฉพาะของตัวเอง (ใช้ userId จากเซสชัน ไม่รับ id จากคำขอ)
 */
auth.put("/credentials", requireAuth, async (c) => {
  if (demoModeOn(c.env)) {
    return c.json(errorBody("VALIDATION", "เดโมไม่เปิดให้ตั้งรหัสผ่าน"), 403);
  }

  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const username = normaliseUsername(body.username);

  if (username === null) {
    return c.json(
      errorBody(
        "VALIDATION",
        "ชื่อผู้ใช้ต้องยาว 3-32 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ - และขึ้นต้นด้วยตัวอักษรหรือตัวเลข",
        "username",
      ),
      400,
    );
  }

  const passwordProblem = passwordError(body.password);

  if (passwordProblem !== null) {
    return c.json(errorBody("VALIDATION", passwordProblem, "password"), 400);
  }

  try {
    await c.env.DB.prepare("UPDATE users SET username = ?, password_hash = ? WHERE id = ?")
      .bind(username, hashPassword(body.password as string), c.get("session").userId)
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.json(errorBody("DUPLICATE", "ชื่อผู้ใช้นี้มีคนใช้แล้ว", "username"), 409);
    }

    throw error;
  }

  return c.json({ ok: true, username, hasPassword: true });
});

auth.post("/logout", requireAuth, async (c) => {
  await revokeSession(c.env.DB, c.get("sessionToken"));
  c.header("set-cookie", clearedSessionCookie(isSecureRequest(c)));

  return c.json({ ok: true });
});

auth.get("/me", requireAuth, (c) => {
  const session = c.get("session");

  return c.json({
    ok: true,
    user: {
      id: session.userId,
      email: session.email,
      displayName: session.displayName,
      role: session.role,
      familyId: session.familyId,
    },
  });
});

export default auth;
