import { Hono } from "hono";
import { lineMessageUrl } from "../lib/line-link";
import type { AppEnv } from "../lib/auth";
import { familyId, maxFamilyMembers, requireAuth, requireRole, sameOriginOnly } from "../lib/auth";
import { hashToken, newSessionToken, revokeUserSessions } from "../lib/session";
import { errorBody, readJsonObject } from "./shared";

const family = new Hono<AppEnv>();

family.use("*", sameOriginOnly, requireAuth);

/** คำเชิญอายุ 7 วัน พอให้ส่งต่อทางแชทแล้วกดรับทัน */
const inviteDays = 7;
const maxOpenInvites = 20;

interface MemberRow {
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  created_at: string;
}

interface InviteRow {
  token_hash: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
}

function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const email = value.trim().toLowerCase();

  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  return email;
}

function parseRole(value: unknown): "owner" | "member" | null {
  return value === "owner" || value === "member" ? value : null;
}

family.get("/", async (c) => {
  const id = familyId(c);
  const isOwner = c.get("session").role === "owner";

  const [info, members] = await Promise.all([
    c.env.DB.prepare("SELECT id, name FROM families WHERE id = ?").bind(id).first<{ id: string; name: string }>(),
    c.env.DB.prepare(
      `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
       FROM family_members m JOIN users u ON u.id = m.user_id
       WHERE m.family_id = ?
       ORDER BY m.role = 'owner' DESC, m.created_at ASC`,
    )
      .bind(id)
      .all<MemberRow>(),
  ]);

  if (info === null) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบครอบครัวนี้"), 404);
  }

  // รายการคำเชิญค้างเป็นเรื่องของเจ้าของเท่านั้น สมาชิกเห็นได้แค่รายชื่อคนในครอบครัว
  const invites = isOwner
    ? (
        await c.env.DB.prepare(
          `SELECT token_hash, email, role, created_at, expires_at FROM family_invites
           WHERE family_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')
           ORDER BY created_at ASC`,
        )
          .bind(id)
          .all<InviteRow>()
      ).results
    : [];

  return c.json({
    ok: true,
    family: { id: info.id, name: info.name },
    maxMembers: maxFamilyMembers,
    members: members.results.map((row) => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      joinedAt: row.created_at,
    })),
    invites: invites.map((row) => ({
      id: row.token_hash,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    })),
  });
});

family.patch("/", requireRole("owner"), async (c) => {
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";

  if (name === "" || name.length > 80) {
    return c.json(errorBody("VALIDATION", "ชื่อครอบครัวต้องยาว 1–80 ตัวอักษร", "name"), 400);
  }

  await c.env.DB.prepare("UPDATE families SET name = ? WHERE id = ?").bind(name, familyId(c)).run();

  return c.json({ ok: true, family: { id: familyId(c), name } });
});

/**
 * ออกคำเชิญ คืน token เต็มครั้งเดียวในคำตอบนี้เท่านั้น
 * ฐานข้อมูลเก็บแค่ hash จึงกู้ลิงก์เดิมกลับมาไม่ได้ ต้องออกใบใหม่
 */
family.post("/invites", requireRole("owner"), async (c) => {
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const email = normaliseEmail(body.email);
  const role = parseRole(body.role ?? "member");
  const id = familyId(c);

  if (email === null) {
    return c.json(errorBody("VALIDATION", "อีเมลไม่ถูกต้อง", "email"), 400);
  }

  if (role === null) {
    return c.json(errorBody("VALIDATION", "สิทธิ์ต้องเป็นเจ้าของหรือสมาชิก", "role"), 400);
  }

  const already = await c.env.DB.prepare(
    `SELECT 1 AS one FROM family_members m JOIN users u ON u.id = m.user_id
     WHERE m.family_id = ? AND u.email = ?`,
  )
    .bind(id, email)
    .first<{ one: number }>();

  if (already !== null) {
    return c.json(errorBody("DUPLICATE", "อีเมลนี้อยู่ในครอบครัวแล้ว", "email"), 409);
  }

  // เพดานจริงบังคับตอนเข้าครอบครัว (ซึ่งกันการแข่งกันแบบอะตอมิก) ที่นี่แค่เตือน
  // ตั้งแต่ต้นไม่ให้ออกคำเชิญที่จะไม่มีวันถูกใช้ — คำเชิญที่ออกไปก่อนครอบครัวเต็ม
  // ยังคงใช้ไม่ได้เมื่อถึงเวลาจริง
  const memberCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM family_members WHERE family_id = ?",
  )
    .bind(id)
    .first<{ n: number }>();

  if ((memberCount?.n ?? 0) >= maxFamilyMembers) {
    return c.json(
      errorBody("CONFLICT", `ครอบครัวนี้มีสมาชิกครบ ${maxFamilyMembers} คนแล้ว`),
      409,
    );
  }

  const open = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM family_invites WHERE family_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')",
  )
    .bind(id)
    .first<{ n: number }>();

  if ((open?.n ?? 0) >= maxOpenInvites) {
    return c.json(errorBody("CONFLICT", "มีคำเชิญค้างอยู่มากเกินไป"), 409);
  }

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + inviteDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  await c.env.DB.prepare(
    "INSERT INTO family_invites (token_hash, family_id, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(await hashToken(token), id, email, role, c.get("session").userId, expiresAt)
    .run();

  return c.json(
    {
      ok: true,
      invite: {
        email,
        role,
        expiresAt,
        token,
        url: lineMessageUrl(`${new URL(c.req.url).origin}/#invite/${token}`),
      },
    },
    201,
  );
});

family.delete("/invites/:id", requireRole("owner"), async (c) => {
  const result = await c.env.DB.prepare(
    "DELETE FROM family_invites WHERE token_hash = ? AND family_id = ? AND accepted_at IS NULL",
  )
    .bind(c.req.param("id"), familyId(c))
    .run();

  if (result.meta.changes === 0) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบคำเชิญนี้"), 404);
  }

  return c.json({ ok: true });
});

family.patch("/members/:userId", requireRole("owner"), async (c) => {
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const role = parseRole(body.role);
  const targetId = c.req.param("userId");
  const id = familyId(c);

  if (role === null) {
    return c.json(errorBody("VALIDATION", "สิทธิ์ต้องเป็นเจ้าของหรือสมาชิก", "role"), 400);
  }

  const target = await c.env.DB.prepare("SELECT role FROM family_members WHERE family_id = ? AND user_id = ?")
    .bind(id, targetId)
    .first<{ role: string }>();

  if (target === null) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบสมาชิกคนนี้"), 404);
  }

  // ครอบครัวต้องเหลือเจ้าของอย่างน้อยหนึ่งคนเสมอ ไม่งั้นจะไม่มีใครจัดการได้อีก
  //
  // เงื่อนไขนี้อยู่ใน WHERE ของคำสั่งเดียว ไม่ใช่ SELECT ตรวจก่อนแล้วค่อย UPDATE
  // แยกกันสองคำสั่ง เพราะสอง request ที่ลดตำแหน่งเจ้าของคนละคนพร้อมกันจะเห็นผล
  // การนับที่ยังไม่ได้อัปเดตเหมือนกันทั้งคู่ และผ่านการตรวจทั้งคู่ได้พร้อมกัน
  // D1 รันแต่ละคำสั่งเป็นธุรกรรมเดี่ยวที่ SQLite เรียงคิวการเขียนไว้แล้ว
  // เงื่อนไขที่คำนวณในคำสั่งเดียวกันจึงกันสองคำขอไม่ให้ผ่านพร้อมกันได้จริง
  const updated = await c.env.DB.prepare(
    `UPDATE family_members SET role = ?
     WHERE family_id = ? AND user_id = ?
       AND (? != 'member' OR role != 'owner'
            OR (SELECT COUNT(*) FROM family_members WHERE family_id = ? AND role = 'owner' AND user_id != ?) > 0)`,
  )
    .bind(role, id, targetId, role, id, targetId)
    .run();

  if (updated.meta.changes === 0) {
    return c.json(errorBody("CONFLICT", "ต้องมีเจ้าของอย่างน้อยหนึ่งคน"), 409);
  }

  return c.json({ ok: true });
});

family.delete("/members/:userId", requireRole("owner"), async (c) => {
  const targetId = c.req.param("userId");
  const id = familyId(c);

  const target = await c.env.DB.prepare("SELECT role FROM family_members WHERE family_id = ? AND user_id = ?")
    .bind(id, targetId)
    .first<{ role: string }>();

  if (target === null) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบสมาชิกคนนี้"), 404);
  }

  // เหตุผลเดียวกับ PATCH ด้านบน: เงื่อนไขต้องอยู่ในคำสั่ง DELETE เดียว
  const deleted = await c.env.DB.prepare(
    `DELETE FROM family_members
     WHERE family_id = ? AND user_id = ?
       AND (role != 'owner'
            OR (SELECT COUNT(*) FROM family_members WHERE family_id = ? AND role = 'owner' AND user_id != ?) > 0)`,
  )
    .bind(id, targetId, id, targetId)
    .run();

  if (deleted.meta.changes === 0) {
    return c.json(errorBody("CONFLICT", "ต้องมีเจ้าของอย่างน้อยหนึ่งคน"), 409);
  }

  // ถอดออกแล้วต้องหมดสิทธิ์ทันที ไม่ใช่รอเซสชันหมดอายุเอง
  await revokeUserSessions(c.env.DB, targetId);

  return c.json({ ok: true });
});

export default family;
