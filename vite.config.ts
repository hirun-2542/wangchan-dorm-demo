import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * ตอน dev แอปถูกเสิร์ฟจาก vite (5173) คนละ origin กับ Worker (8787) แล้ว proxy
 * ส่งต่อไปให้ Worker — ค่าเริ่มต้นของ proxy คือเขียน Host header เป็นปลายทาง
 * ซึ่งทำให้ Worker มองว่า origin ของตัวเองคือ http://127.0.0.1:8787 ขณะที่
 * เบราว์เซอร์ส่ง Origin: http://localhost:5173 มา ผลคือ middleware ตรวจ CSRF
 * (`sameOriginOnly` ใน `src/worker/lib/auth.ts`) ปฏิเสธทุกคำขอที่เปลี่ยนข้อมูล
 * รวมถึงการล็อกอิน ด้วย 403 "คำขอมาจากต้นทางที่ไม่ได้รับอนุญาต"
 *
 * production ไม่มีปัญหานี้เพราะแอปกับ `/api` อยู่ origin เดียวกัน จึงแก้ที่ proxy
 * ให้เก็บ Host เดิมของเบราว์เซอร์ไว้ (`changeOrigin: false`) เพื่อให้ dev
 * เหมือน production แทนที่จะไปผ่อนการตรวจ CSRF ฝั่ง Worker ซึ่งจะอ่อนแอจริง
 */
const apiTarget = "http://127.0.0.1:8787";

const apiProxy = {
  target: apiTarget,
  changeOrigin: false,
  // ต้องเปิด ไม่งั้น vite ไม่ส่งต่อ upgrade request ของ /api/realtime
  // แล้ว WebSocket จะต่อไม่ติดตอน npm run dev (production เป็น origin เดียวกัน)
  ws: true,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist/client",
  },
  server: {
    /**
     * ห้าม vite เลื่อนไปพอร์ตอื่น (5174, 5175, …) โดยเด็ดขาด
     *
     * redirect URI ของ Google ผูกกับพอร์ต: Worker สร้างมันจาก Host ที่เบราว์เซอร์
     * ส่งมา ซึ่งก็คือพอร์ตของ vite ถ้า 5173 ไม่ว่างแล้ว vite แอบไป 5174 หน้าเว็บ
     * จะเปิดได้และปุ่มอื่นทำงานปกติ แต่กด Google แล้ว Google จะตอบ
     * redirect_uri_mismatch ทันที — พังแบบเงียบ หาสาเหตุยาก
     * จึงให้ล้มตั้งแต่ตอนสตาร์ทแทน: "Port 5173 is already in use"
     */
    strictPort: true,
    proxy: {
      "/api": apiProxy,
      "/health": apiProxy,
      "/slips": apiProxy,
      "/qr": apiProxy,
      "/invoices": apiProxy,
    },
  },
});
