import { Hono } from "hono";
import type { AppEnv } from "../lib/auth";
import { errorBody } from "./shared";

const api = new Hono<AppEnv>();

api.get("/ping", (c) => c.json({ ok: true }));

api.post("/seam-probe", async (c) => {
  // ปิดเป็นค่าเริ่มต้น เปิดเฉพาะเมื่อตั้งค่าตรง ๆ ว่า "1" เท่านั้น
  // ตัวแปรที่พิมพ์ผิดหรือถูกตั้งเป็นค่าอื่นจึงปิดทางนี้ไว้ ไม่ใช่เปิดค้าง
  if (String(c.env.SEAM_PROBE) !== "1") {
    return c.json(errorBody("NOT_FOUND", "ไม่พบเส้นทางนี้"), 404);
  }

  let outboundUrl: string;

  try {
    const body = await c.req.json<{ outboundUrl?: string }>();
    outboundUrl = body.outboundUrl ?? "";
  } catch {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  let target: URL;

  try {
    target = new URL(outboundUrl);
  } catch {
    return c.json(errorBody("VALIDATION", "outboundUrl ต้องเป็น URL ที่ถูกต้อง"), 400);
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return c.json(errorBody("VALIDATION", "outboundUrl ต้องใช้ http หรือ https"), 400);
  }

  const value = crypto.randomUUID();
  const updatedAt = new Date().toISOString();
  const key = `seam-probe/${value}`;

  try {
    await c.env.DB.prepare(
      "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind("seam-probe", value, updatedAt)
      .run();

    const row = await c.env.DB.prepare("SELECT value FROM meta WHERE key = ?")
      .bind("seam-probe")
      .first<{ value: string }>();

    await c.env.SLIPS.put(key, value);

    const object = await c.env.SLIPS.get(key);
    const objectText = object === null ? null : await object.text();

    await c.env.SLIPS.delete(key);

    const outboundResponse = await fetch(target.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe: value }),
    });

    // ไม่ส่งเนื้อหาตอบกลับของปลายทางออกไป เพราะเป็นข้อความจากระบบอื่น
    // ที่เราไม่ได้ควบคุม และเส้นทางนี้ใช้ตรวจว่าเรียกออกไปได้จริงเท่านั้น
    await outboundResponse.body?.cancel();

    return c.json({
      ok: true,
      d1: { written: value, readBack: row?.value ?? null },
      r2: { key, readBack: objectText },
      outbound: { status: outboundResponse.status },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "seam probe failed", error: detail }));
    return c.json(errorBody("INTERNAL", "ตรวจสอบเส้นทางไม่สำเร็จ"), 500);
  }
});

export default api;
