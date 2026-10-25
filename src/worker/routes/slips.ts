import { Hono } from "hono";
import type { AppEnv } from "../lib/auth";
import { familyId, requireAuth } from "../lib/auth";
import { slipSignatureValid } from "../lib/slip-link";
import { errorBody } from "./shared";

export const slipsRoute = new Hono<AppEnv>();

const filePattern = /^[A-Za-z0-9_-]+\.(png|jpg|jpeg)$/;

/**
 * รูปสลิปสำหรับปุ่มใน LINE — สาธารณะแต่ต้องมีลายเซ็นที่ยังไม่หมดอายุ
 *
 * วางไว้ก่อน `/:file` เพราะทั้งคู่เป็น GET ใต้ /slips เหมือนกัน ต้องให้เส้นทาง
 * ที่เจาะจงกว่าจับก่อน (`/:file` รับ segment เดียวจึงไม่ชนกับ /p/xxx อยู่แล้ว
 * แต่ลำดับที่อ่านแล้วเห็นเจตนาชัดกว่าคือแบบนี้)
 *
 * ต่างจากการบังคับ session ของ `/:file` ตรงที่ผู้ถือลิงก์ดูได้โดยไม่ต้องมี
 * session — ลายเซ็นผูกกับ imageKey และมีเวลาหมดอายุอยู่ในตัว ลิงก์ที่หลุดจึง
 * ใช้ได้ไม่เกินหนึ่งรอบบิล ไม่ใช่ตลอดกาล
 */
slipsRoute.get("/p/:file", async (c) => {
  const file = c.req.param("file");

  if (!filePattern.test(file)) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบรูปสลิปที่ต้องการ"), 404);
  }

  const expires = c.req.query("e") ?? "";
  const signature = c.req.query("s") ?? "";
  const expiresSeconds = Number(expires);

  if (!Number.isFinite(expiresSeconds) || expiresSeconds <= Date.now() / 1000) {
    // แยกข้อความจากกรณีลายเซ็นผิด เพื่อให้เจ้าของรู้ว่าต้องเปิดจากหน้าเว็บแทน
    // (บอกก่อนตรวจลายเซ็น เพราะไม่ว่ารูปไหน "หมดอายุ" ก็ต้องทำแบบเดียวกัน)
    return c.json(
      errorBody("NOT_FOUND", "ลิงก์รูปสลิปหมดอายุแล้ว กรุณาเปิดจากหน้าเว็บแทน"),
      404,
    );
  }

  if (!(await slipSignatureValid(c.env, file, expires, signature))) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบรูปสลิปที่ต้องการ"), 404);
  }

  try {
    const object = await c.env.SLIPS.get(file);

    if (object === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบรูปสลิปที่ต้องการ"), 404);
    }

    return c.body(object.body, 200, {
      "content-type": object.httpMetadata?.contentType ?? "image/png",
      // ตั้งใจต่างจาก no-store ของ /:file — เบราว์เซอร์ในแอป LINE โหลดซ้ำ/ซูมได้
      // โดยไม่ต้องยิงใหม่ทุกครั้ง ลิงก์ยังหมดอายุตามลายเซ็นอยู่ดี
      "cache-control": "private, max-age=3600",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({ message: "serve signed slip image failed", imageKey: file, error: detail }),
    );
    return c.json(errorBody("INTERNAL", "โหลดรูปสลิปไม่สำเร็จ"), 500);
  }
});

/**
 * รูปสลิปมีเลขบัญชี ชื่อ และยอดโอนของผู้เช่า จึงต้องล็อกอินก่อนดูเสมอ และ
 * ต้องเป็นรูปของครอบครัวตัวเองเท่านั้น — คีย์สุ่ม 128-bit เดาไม่ได้ก็จริง แต่
 * เดาไม่ได้ไม่เท่ากับปลอดภัย ถ้าลิงก์รั่วออกไป (แชร์ผิด, log, proxy) ใครถือ
 * ลิงก์ก็ดูรูปได้ตลอดกาลโดยไม่ต้องล็อกอิน จึงเปลี่ยนมาบังคับ session ด้วย
 */
slipsRoute.get("/:file", requireAuth, async (c) => {
  const file = c.req.param("file");

  if (!filePattern.test(file)) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบรูปสลิปที่ต้องการ"), 404);
  }

  try {
    const owned = await c.env.DB.prepare(
      "SELECT 1 AS one FROM slips WHERE family_id = ? AND image_key = ?",
    )
      .bind(familyId(c), file)
      .first<{ one: number }>();

    if (owned === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบรูปสลิปที่ต้องการ"), 404);
    }

    const object = await c.env.SLIPS.get(file);

    if (object === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบรูปสลิปที่ต้องการ"), 404);
    }

    return c.body(object.body, 200, {
      "content-type": object.httpMetadata?.contentType ?? "image/png",
      // รูปเป็นข้อมูลส่วนตัวของผู้เช่า — ห้ามแคชสาธารณะ แต่ให้เบราว์เซอร์ของเจ้าของเองเก็บได้ 1 ชั่วโมง
      // เพราะคิวรอตรวจแสดงรูปย่อของทุกรายการซ้ำทุกครั้งที่เปิดหน้า (no-store เดิมทำให้โหลดไฟล์เต็มใหม่หมด)
      "cache-control": "private, max-age=3600",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "serve slip image failed", imageKey: file, error: detail }));
    return c.json(errorBody("INTERNAL", "โหลดรูปสลิปไม่สำเร็จ"), 500);
  }
});

export default slipsRoute;
