import { Hono } from "hono";
import { type AppEnv, familyId } from "../lib/auth";
import { errorBody } from "./shared";

export const realtimeRoute = new Hono<AppEnv>();

/**
 * ยกระดับคำขอเป็น WebSocket ของครอบครัวผู้ใช้ที่ล็อกอินอยู่
 *
 * เส้นทางนี้อยู่ใต้ /api/* จึงผ่าน requireAuth แล้ว (เกตของ index.ts) — แท็บ
 * ที่ยังไม่ล็อกอินจึงไม่ได้ 101 แต่ได้ 401 เหมือน API อื่น
 */
realtimeRoute.get("/", async (c) => {
  if ((c.req.header("upgrade") ?? "").toLowerCase() !== "websocket") {
    return c.json(
      errorBody("VALIDATION", "เส้นทางนี้รับเฉพาะการเชื่อมต่อ WebSocket"),
      426,
    );
  }

  // sameOriginOnly ตรวจเฉพาะ method ที่เปลี่ยนข้อมูล (auth.ts) — handshake เป็น
  // GET จึงหลุดการตรวจ ต้องตรวจ Origin เองตรงนี้
  const origin = c.req.header("origin");
  const requestOrigin = new URL(c.req.url).origin;

  if (origin !== undefined && origin !== requestOrigin) {
    return c.json(
      errorBody("VALIDATION", "คำขอมาจากต้นทางที่ไม่ได้รับอนุญาต"),
      403,
    );
  }

  return c.env.REALTIME.get(c.env.REALTIME.idFromName(familyId(c))).fetch(c.req.raw);
});
