import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./lib/auth";
import { requireAuth, sameOriginOnly } from "./lib/auth";
import auth from "./routes/auth";
import bills from "./routes/bills";
import { invoiceRoute, qrRoute } from "./routes/bills-render";
import demo from "./routes/demo";
import family from "./routes/family";
import health from "./routes/health";
import line, { lineAdmin } from "./routes/line";
import notifications from "./routes/notifications";
import pea from "./routes/pea";
import { realtimeRoute } from "./routes/realtime";
import register, { registerPage } from "./routes/register";
import rooms from "./routes/rooms";
import api from "./routes/seam-probe";
import settings from "./routes/settings";
import { errorBody } from "./routes/shared";
import slips from "./routes/slips";
import slipsAdmin from "./routes/slips-admin";
import stats from "./routes/stats";
import tenants from "./routes/tenants";
import welcome from "./routes/welcome";

const app = new Hono<AppEnv>();

/**
 * เส้นทางใต้ /api ที่เปิดได้โดยไม่ต้องล็อกอิน
 *
 * ตั้งใจให้เป็นรายการ "ยกเว้น" ไม่ใช่รายการ "ที่ต้องกัน" เพราะ route ใหม่
 * ที่ใครสักคนเพิ่มเข้ามาทีหลังจะถูกกันไว้เองโดยอัตโนมัติ
 */
const publicApiPrefixes = ["/api/auth/", "/api/demo/", "/api/register"];

app.use("/api/*", sameOriginOnly);

/** เกตล็อกอินของ /api/* ทั้งหมด ยกเว้นรายการข้างต้น */
const requireAuthUnlessPublic: MiddlewareHandler<AppEnv> = (c, next) => {
  const path = new URL(c.req.url).pathname;

  if (publicApiPrefixes.some((prefix) => path === prefix || path.startsWith(prefix))) {
    return next();
  }

  return requireAuth(c, next);
};

app.use("/api/*", requireAuthUnlessPublic);

app.route("/health", health);
app.route("/api", api);
app.route("/api/auth", auth);
app.route("/api/bills", bills);
app.route("/api/demo", demo);
app.route("/api/family", family);
app.route("/api/line", lineAdmin);
app.route("/api/notifications", notifications);
app.route("/api/pea", pea);
app.route("/api/register", register);
app.route("/api/rooms", rooms);
app.route("/api/realtime", realtimeRoute);
app.route("/api/settings", settings);
app.route("/api/slips", slipsAdmin);
app.route("/api/stats", stats);
app.route("/api/tenants", tenants);
app.route("/webhook/line", line);
app.route("/register", registerPage);
app.route("/welcome", welcome);
app.route("/qr", qrRoute);
app.route("/slips", slips);
app.route("/invoices", invoiceRoute);

/** API ต้องได้ JSON เสมอ ไม่ใช่ข้อความเปล่าของ Hono */
app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json(errorBody("NOT_FOUND", "ไม่พบเส้นทางนี้"), 404);
  }

  return c.text("Not Found", 404);
});

app.onError((error, c) => {
  console.error(
    JSON.stringify({
      message: "unhandled worker error",
      path: new URL(c.req.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  // รายละเอียดของข้อผิดพลาดอยู่ใน log เท่านั้น ไม่ส่งออกไปให้ผู้เรียก
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json(errorBody("INTERNAL", "ระบบขัดข้อง กรุณาลองใหม่"), 500);
  }

  return c.text("Internal Server Error", 500);
});

export default app;

/** wrangler หา Durable Object class จาก export ของ entry module */
export { FamilyRealtime } from "./realtime";
