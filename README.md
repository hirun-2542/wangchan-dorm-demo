# Wang Chan Dorm — Demo

เดโมสาธารณะของระบบจัดการหอพักสำหรับเจ้าของคนเดียว: ออกบิลรายเดือน ส่งบิลทาง LINE
และปิดบิลอัตโนมัติเมื่อผู้เช่าส่งสลิปการโอน

repo นี้มีแค่สองหน้าให้ดู — **หน้า `/welcome`** (แนะนำโปรเจกต์) และ **เดโมที่ใช้งานได้จริง**
โดยไม่ต้องสมัครหรือล็อกอิน ข้อมูลทั้งหมดเป็นข้อมูลสมมติ

**Live demo:** https://wangchan-demo.nodhk2545.workers.dev

<img src="public/welcome-media/hero-bill-create.webp" width="420" alt="หน้าสร้างบิลของห้อง A101">
<img src="public/welcome-media/payment-status.webp" width="240" alt="คิวรอตรวจสลิป">

## ลองใช้งาน

1. เปิด `/welcome` — อ่านภาพรวมและเหตุผลเบื้องหลังการออกแบบ
2. กด **ทดลองระบบ** (หรือเปิด `/` ตรง ๆ) — ระบบพาเข้าเดโมทันที ไม่มีหน้าล็อกอิน
   (รันในเครื่องแล้วปุ่มนี้พาไป live demo ด้านบน ถ้าอยากให้เข้าเดโมในเครื่อง ตั้ง `demoEntryUrl` เป็น `""` ใน `welcome-config.ts`)
3. เดโมมีหอตัวอย่าง 18 ห้อง ผู้เช่า 15 คน บิลย้อนหลัง 2 เดือน ลองทำตามนี้

| เมนู | ลองทำอะไร |
|------|-----------|
| แดชบอร์ด | ดู KPI รายเดือน กราฟรายรับ 6 เดือน และผังสถานะทุกห้อง |
| บิล | สร้างบิลทั้งหอจากหน้าจอเดียว กรอกเลขมิเตอร์ ระบบคิดยอดให้ แล้วเปิดใบแจ้งหนี้ PDF กับ QR พร้อมเพย์ |
| รอตรวจ | มีสลิปห้อง A105 รอตัดสิน ดูเหตุผลที่ตรวจไม่ผ่านและกดปิดบิลเอง |
| ห้องพัก / ผู้เช่า | แก้ค่าเช่า อัตราน้ำไฟ ย้ายผู้เช่าเข้า-ออก |
| ตั้งค่า | ชื่อหอ บัญชีรับเงิน พร้อมเพย์ |

ข้อจำกัดของโหมดเดโม (ตั้งใจ):

- **ไม่ส่งข้อความ LINE จริงและไม่ตรวจสลิปกับ SlipOK จริง** ทุกจุดที่ออกไปข้างนอกถูกปิดด้วย `DEMO_MODE=1`
  ปุ่มส่งบิลจึงตอบสำเร็จโดยไม่มีข้อความออกไปไหน
- **ไม่เชื่อมต่อ PEA จริง** เส้นทาง `/api/pea/*` ตอบ 404 ในเดโม
- **ข้อมูลถูกรีเซ็ต** เมื่อไม่มีใครใช้งานเกิน 5 นาทีแล้วมีคนเข้าใหม่ คนที่เข้าพร้อมกันแชร์ข้อมูลชุดเดียวกัน
  อย่าใส่ข้อมูลจริง

## รันในเครื่อง

ต้องมี Node.js 24 ขึ้นไปและ npm ไม่ต้องมีบัญชี Cloudflare เพราะ `wrangler dev` ใช้ D1/R2 จำลองในเครื่อง

```bash
npm install
npm run dev
```

`npm run dev` ทำให้ตามลำดับ: apply migrations กับ D1 ในเครื่อง → build client → เปิด `wrangler dev`
(http://127.0.0.1:8787) คู่กับ `vite dev` (http://localhost:5173 พร้อม hot reload)

- http://localhost:5173/welcome — หน้า welcome
- http://localhost:5173/ — เดโม

> ถ้าตั้ง `NODE_ENV=production` ไว้ npm จะข้าม devDependencies ให้ใช้ `NODE_ENV=development npm install`

## Deploy ขึ้น Cloudflare ของคุณเอง

```bash
npx wrangler login
npm run deploy
```

`wrangler.jsonc` ไม่ใส่ `database_id` ไว้ wrangler จึงสร้าง D1 (`wangchan-demo`) และ R2 (`wangchan-demo-slips`)
บนบัญชีของคุณให้เองตอน deploy แล้วสคริปต์รัน migrations กับ D1 ระยะไกลต่อให้

หลัง deploy แก้ `src/worker/routes/welcome-config.ts`:

- `demoEntryUrl` — ใส่ URL ของ Worker ที่คุณเพิ่ง deploy
- `contactEmail`, `githubProfileUrl` — ใส่ของคุณ หรือเว้นว่างเพื่อซ่อนลิงก์

## โครงสร้าง

| ส่วน | เทคโนโลยี |
|------|-----------|
| Runtime | Cloudflare Workers — Worker เดียวเสิร์ฟทั้ง API และ SPA |
| API | Hono 4 + TypeScript |
| ฐานข้อมูล / ไฟล์ | Cloudflare D1 (SQLite) / R2 |
| Realtime | Durable Object ส่งการเปลี่ยนแปลงของบิลไปทุกแท็บที่เปิดอยู่ |
| Frontend | React 19 + Vite + Tailwind CSS 4 |
| ใบแจ้งหนี้ | `pdf-lib` + ฟอนต์ IBM Plex Sans Thai ฝังใน Worker, QR พร้อมเพย์ตามมาตรฐาน EMVCo |

- `src/worker/routes/welcome.ts` — หน้า `/welcome`
- `src/worker/routes/demo.ts` — ทางเข้าเดโม ข้อมูลตัวอย่าง และการรีเซ็ต
- `src/client/` — แอปของเจ้าของหอ
- `migrations/` — schema ของ D1

```bash
npm run check   # typecheck + lint
```

## License

สัญญาอนุญาตแยกตามไฟล์ — หน้า welcome, ทางเข้าเดโม และสื่อใน `public/welcome-media/` เป็น MIT ส่วนที่เหลือ (ตรรกะของระบบหอพักและหน้าจอเจ้าของหอ) สงวนลิขสิทธิ์ ดู [LICENSE](LICENSE)
