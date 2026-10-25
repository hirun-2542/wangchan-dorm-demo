import type { Context, MiddlewareHandler } from "hono";
import { errorBody } from "../routes/shared";
import type { FamilyRole, SessionUser } from "./session";
import { loadSession, readSessionCookie, touchSession } from "./session";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    session: SessionUser;
    sessionToken: string;
  };
}

export type AppContext = Context<AppEnv>;

/** ครอบครัวของผู้ใช้ที่ล็อกอินอยู่ ทุกคำสั่ง SQL ต้องกรองด้วยค่านี้ */
export function familyId(c: AppContext): string {
  return c.get("session").familyId;
}

export function isSecureRequest(c: { req: { url: string } }): boolean {
  return new URL(c.req.url).protocol === "https:";
}

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * หนึ่งครอบครัวมีได้สูงสุดเท่านี้ (นับเจ้าของรวมแล้ว)
 *
 * หอพักหนึ่งที่มีเจ้าของหนึ่งคนและผู้ช่วยอีกหนึ่งคนเป็นเพดานของผลิตภัณฑ์
 * ไม่ได้กันที่ชั้นฐานข้อมูลเพราะ SQLite ไม่มี CHECK ที่นับแถวข้ามตารางได้
 * แต่ทุกเส้นทางที่เพิ่มสมาชิกใส่เงื่อนไขนับในคำสั่ง INSERT เดียวกัน
 * (SELECT ... WHERE (SELECT COUNT(*)) < maxFamilyMembers) จึงแข่งกันเพิ่ม
 * ทีละสองคำขอพร้อมกันแล้วเกินเพดานไม่ได้
 */
export const maxFamilyMembers = 2;

/**
 * กัน CSRF ด้วยการตรวจต้นทางของคำขอที่เปลี่ยนข้อมูล
 *
 * คุกกี้เซสชันเป็น SameSite=Lax ซึ่งกันฟอร์มข้ามเว็บได้เกือบหมดอยู่แล้ว
 * แต่ Lax ยังปล่อย top-level POST บางกรณี จึงตรวจ Origin ซ้ำอีกชั้น
 * คำขอที่ไม่มี Origin เลย (เช่น curl) ยังผ่าน เพราะไม่ใช่คำขอจากเบราว์เซอร์
 * ที่พ่วงคุกกี้มาเอง และ LINE webhook ก็ไม่ส่ง Origin
 */
export const sameOriginOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!mutatingMethods.has(c.req.method)) {
    return next();
  }

  const origin = c.req.header("origin");

  if (origin !== undefined && origin !== new URL(c.req.url).origin) {
    return c.json(errorBody("VALIDATION", "คำขอมาจากต้นทางที่ไม่ได้รับอนุญาต"), 403);
  }

  return next();
};

/** ทุก route ที่ผ่าน middleware นี้มีผู้ใช้และครอบครัวแน่นอน */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readSessionCookie(c.req.header("cookie"));

  if (token === null) {
    return c.json(errorBody("VALIDATION", "กรุณาเข้าสู่ระบบ"), 401);
  }

  const session = await loadSession(c.env.DB, token);

  if (session === null) {
    return c.json(errorBody("VALIDATION", "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง"), 401);
  }

  c.set("session", session);
  c.set("sessionToken", token);

  // ต่ออายุแบบ sliding เพื่อไม่ให้ผู้ใช้ที่ใช้งานอยู่ถูกเตะออกกลางคัน
  c.executionCtx.waitUntil(touchSession(c.env.DB, token));

  return next();
};

export function requireRole(role: FamilyRole): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("session").role !== role) {
      return c.json(errorBody("VALIDATION", "ต้องเป็นเจ้าของครอบครัวจึงจะทำรายการนี้ได้"), 403);
    }

    return next();
  };
}
