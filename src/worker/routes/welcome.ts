import { Hono } from "hono";
import { demoModeOn } from "../line/api";
import type { AppEnv } from "../lib/auth";
import { demoEntryPath, landingConfig } from "./welcome-config";

/**
 * หน้าแนะนำโปรเจคสำหรับคนที่มาดูผลงาน — หน้าสาธารณะหน้าที่สองต่อจากหน้า
 * ลงทะเบียนผู้เช่า จึงเรนเดอร์ HTML เองทั้งหมดโดยไม่โหลดบันเดิลของ SPA
 *
 * หน้านี้ไม่แตะ DB หรือ R2 และไม่มีเกตล็อกอิน จึงเสิร์ฟ HTML ล้วนที่ไม่มีทาง
 * รั่วข้อมูลของผู้เช่าออกจากตัวมันเอง
 *
 * โทเคนสีคัดจาก `@theme` ใน `src/client/styles.css` ห้ามคิดค่าสีใหม่ที่นี่
 *
 * สื่อของหน้าอยู่ที่ `/welcome-media/` ซึ่งเป็นพาธข้างหน้า ไม่ใช่พาธย่อยของหน้า
 * เพราะรายการใน `assets.run_worker_first` แบบไม่มี `*` จับพาธตรงตัว แต่ถ้าวันหนึ่ง
 * มีคนเปลี่ยนเป็น `/welcome*` (เช่นตอนเพิ่มหน้าอื่นใต้พาธนี้) ไฟล์ใต้ `/welcome/`
 * จะถูก worker รับก่อนแล้วตกไปที่ fallback ของ SPA ทันทีโดยไม่มีใครรู้
 *
 * สื่อทุกไฟล์ต้องถูกคัดเข้า `dist/client` ด้วย `npm run build` เท่านั้น —
 * การก็อปไฟล์ลง `dist/client` ตรง ๆ แล้วยิงขอจะได้ `index.html` กลับมา เพราะ
 * asset manifest ถูกสร้างตอน build ไม่ได้อ่านจากโฟลเดอร์สด ๆ
 */
const welcomeStyles = `
      :root {
        --ink: #0a0a0a;
        --charcoal: #171717;
        --steel: #525252;
        --fog: #6b6b6b;
        --silver: #a3a3a3;
        --ash: #e5e5e5;
        --paper: #f5f5f5;
        --white: #ffffff;
        --blue: #2563eb;
        --radius-btn: 8px;
        --radius-card: 12px;
        --radius-panel: 16px;
        --radius-pill: 9999px;
        --shadow-sm: rgba(0, 0, 0, 0.1) 0 4px 6px -1px, rgba(0, 0, 0, 0.1) 0 2px 4px -2px;
        --monogram: conic-gradient(from -81deg, #ff0000, #eab308 99deg, #5cff80 162deg, #00fff9 216deg, #3a8bfd 288deg, #855afc);
        --ease: cubic-bezier(0.16, 1, 0.3, 1);
        /* สองตัวนี้คัดจากสไตล์ชีตของแอป (::selection และ scrollbar-color) เพื่อให้
           พื้นผิวของเบราว์เซอร์เหมือนกันทั้งระบบ ไม่ใช่คิดค่าขึ้นใหม่ */
        --selection-bg: #dbeaff;
        --scrollbar: #d4d4d4;
        /* ฟอร์มคอนโทรลและสกรอลบาร์ของเบราว์เซอร์เป็นของเราด้วย ไม่ใช่ของระบบ */
        color-scheme: light;
      }

      * {
        box-sizing: border-box;
        scrollbar-width: thin;
        scrollbar-color: var(--scrollbar) transparent;
      }

      ::selection { background: var(--selection-bg); color: var(--charcoal); }

      body {
        margin: 0;
        background: var(--white);
        color: var(--charcoal);
        font-family: Inter, "Noto Sans Thai", ui-sans-serif, system-ui, sans-serif;
        /* 16px คือขนาดเนื้อความมาตรฐานของแอป (DESIGN.md: "16px as the canonical body
           size" — พบบ่อยสุด 1220 ครั้งในโค้ดแอป) เดิมหน้านี้ใช้ 15px ซึ่งต่ำกว่าพื้น
           ของเนื้อความบนเว็บทั่วไป เนื้อความส่วนใหญ่ของหน้านี้คือคำอธิบายที่ต้องอ่านจริง */
        font-size: 16px;
        line-height: 1.7;
        -webkit-text-size-adjust: 100%;
      }

      .container {
        width: 100%;
        max-width: 1120px;
        margin: 0 auto;
        padding: 0 24px;
      }

      /* หัวข้อต้องไม่ถูกบีบระยะตัวอักษร
         ค่า -0.02em เป็นธรรมเนียมของอักษรละติน (ตัวพิมพ์ใหญ่ชนกันได้) แต่อักษรไทย
         มีสระและวรรณยุกต์ซ้อนบน-ล่าง ไม่ได้ออกแบบมาให้ชนกันในแนวนอน การบีบที่ h1
         เท่ากับ -1.04px ซึ่งทำให้พยัญชนะชิดกันและอ่านช้าลงตลอดทั้งหน้า
         text-wrap: balance ช่วยให้หัวข้อสั้น ๆ ขึ้นบรรทัดใหม่สมดุลแทนที่จะเหลือคำเดียว */
      h1, h2, h3 { margin: 0; letter-spacing: 0; font-weight: 600; text-wrap: balance; }
      h1 { font-size: clamp(32px, 4.2vw, 52px); line-height: 1.15; }
      h2 { font-size: 28px; line-height: 1.3; }
      /* h3 เป็นบทบาทเดียว ใช้ค่าเดียวทั้งหน้า เดิมกระจายอยู่ 6 ค่า (14/15/16px)
         ซึ่งทำให้บทบาทเดียวกันหน้าตาไม่เหมือนกันข้ามส่วน */
      h3 { font-size: 16px; line-height: 1.4; }
      p { margin: 0; text-wrap: pretty; }
      a { color: inherit; }

      .lede { font-size: 18px; line-height: 1.6; color: var(--steel); }
      .note { font-size: 12px; color: var(--fog); }
      .num { font-variant-numeric: tabular-nums; }

      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 20px;
        border: 1px solid transparent;
        border-radius: var(--radius-btn);
        font: inherit;
        font-weight: 500;
        text-decoration: none;
        cursor: pointer;
      }
      .btn-primary { background: var(--ink); color: var(--white); }
      .btn-secondary { background: var(--white); border-color: var(--ash); color: var(--charcoal); }
      .btn:hover { box-shadow: var(--shadow-sm); }
      /* ปุ่มที่ยังกดไม่ได้ (ยังไม่ตั้งที่อยู่เดโม) ต้องดูออกว่าไม่ใช่ลิงก์
         ใช้ตัวอักษรเข้มบนพื้นเทา — ขาวบนเทาได้แค่ 2.5:1 ซึ่งอ่านไม่ออก */
      .btn[aria-disabled="true"] { background: var(--silver); color: var(--charcoal); cursor: not-allowed; }
      .btn[aria-disabled="true"]:hover { box-shadow: none; }
      .btn:focus-visible, a:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
        border-radius: var(--radius-btn);
      }

      .mark {
        display: grid;
        width: 28px;
        height: 28px;
        flex: none;
        padding: 2px;
        place-items: center;
        border-radius: 9px;
        background: var(--monogram);
      }
      .mark-inner {
        display: grid;
        width: 100%;
        height: 100%;
        place-items: center;
        border-radius: 7px;
        background: var(--white);
        color: var(--charcoal);
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
      }

      .nav { border-bottom: 1px solid var(--ash); }
      .nav-inner { display: flex; align-items: center; gap: 16px; min-height: 64px; }
      .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; text-decoration: none; }
      .nav-links { display: flex; align-items: center; gap: 20px; margin-left: auto; }
      /* :not(.btn) จำเป็นสองเหตุผล — (1) ถ้าไม่ใส่ selector นี้ (0,1,1) จะทับ
         .btn-primary (0,1,0) ที่ประกาศไว้ก่อนหน้า ทำให้สีข้อความบนปุ่มหลักกลายเป็น
         --steel บนพื้น --ink ซึ่งอ่านไม่ออก (2.53:1) (2) พื้นที่กดของลิงก์ข้อความ
         ต้องถึง 44px แม้ตัวอักษรจะสูงแค่ 24px จึงใช้ padding แนวตั้ง ไม่ใช่ขยายฟอนต์ */
      .nav-links a:not(.btn) { display: inline-flex; align-items: center; min-height: 44px; text-decoration: none; color: var(--steel); font-size: 14px; }
      .nav-links a:not(.btn):hover { color: var(--charcoal); }

      .band { padding: 88px 0; }
      .band-paper { background: var(--paper); }
      .band h2 + p { margin-top: 12px; max-width: 62ch; }
      /* คำกำกับยาว ๆ ยังต้องมีความกว้างสูงสุด ไม่งั้นบรรทัดเดียวจะยาวเกิน 160 ตัวอักษร
         บนจอ wide — .band .note ที่ไม่มี max-width คือจุดที่เคยหลุด */
      .band .note { margin-top: 12px; max-width: 62ch; }

      .hero-grid { display: grid; gap: 40px; align-items: center; }
      .kicker { font-size: 12px; font-weight: 500; letter-spacing: 0.04em; color: var(--blue); }
      .hero h1 { margin-top: 12px; }
      .hero .lede { margin-top: 16px; max-width: 46ch; }
      .hero-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }

      .frame { overflow: hidden; border: 1px solid var(--ash); border-radius: var(--radius-card); background: var(--white); box-shadow: var(--shadow-sm); }
      .frame-bar { display: flex; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--ash); background: var(--paper); }
      .frame-dot { width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--silver); }
      .frame img { display: block; width: 100%; height: auto; }

      /* .subhead ต้องต่างจาก .note (12px #6b6b6b) ให้อ่านออกว่าเป็นป้ายกำกับหัวข้อ
         ไม่ใช่คำอธิบาย และ .step h3 ต้องหนักกว่าเนื้อความ 15px/400 รอบตัว ไม่ใช่เท่ากัน */
      .subhead { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; color: var(--steel); }
      .subhead-spaced { margin-top: 40px; }

      .steps { display: grid; gap: 1px; margin: 20px 0 0; padding: 0; overflow: hidden; border: 1px solid var(--ash); border-radius: var(--radius-card); background: var(--ash); list-style: none; }
      /* บทบาทในระบบ — สองบรรทัดที่ต้องอ่านก่อนห้าขั้นตอน เพราะบอกว่าใครเป็นคนทำ
         แยกด้วยเส้นคั่นอย่างเดียว ไม่ใส่การ์ดซ้อนในแบนด์ที่เป็นพื้นเทาอยู่แล้ว */
      .roles { display: grid; gap: 1px; margin: 24px 0 0; padding: 0; overflow: hidden; border: 1px solid var(--ash); border-radius: var(--radius-card); background: var(--ash); }
      .roles > div { padding: 16px 20px; background: var(--white); }
      .roles dt { font-size: 13px; font-weight: 600; color: var(--charcoal); }
      .roles dd { margin: 4px 0 0; font-size: 14px; color: var(--steel); max-width: 68ch; }
      .step { padding: 20px; background: var(--white); }
      .step-num { font-size: 13px; font-weight: 700; color: var(--blue); }
      .step h3 { margin-top: 10px; }
      .step h3 + p { margin-top: 6px; font-size: 14px; color: var(--steel); }

      .demo-grid { display: grid; gap: 40px; margin-top: 28px; align-items: start; }
      .demo-panel { padding: 28px; border: 1px solid var(--ash); border-radius: var(--radius-panel); background: var(--white); }
      .demo-panel ul { margin: 12px 0 0; padding-left: 20px; }
      .demo-panel li { font-size: 14px; color: var(--steel); }
      .demo-panel li + li { margin-top: 6px; }
      .demo-panel .btn { margin-top: 20px; width: 100%; }

      .closure { margin-top: 20px; padding: 20px 24px; border: 1px solid var(--ash); border-radius: var(--radius-card); background: var(--paper); }
      .closure p { margin-top: 6px; font-size: 14px; color: var(--steel); }
      .closure ul { margin: 10px 0 0; padding-left: 20px; }
      .closure li { font-size: 14px; color: var(--steel); }
      .closure li + li { margin-top: 4px; }

      .footer { border-top: 1px solid var(--ash); }
      .footer .container { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding-top: 32px; padding-bottom: 32px; }
      .footer .note { margin: 0; }
      .footer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-left: auto; }

      .shots { display: grid; gap: 40px; margin-top: 28px; }
      .shot { margin: 0; }
      .shot figcaption { margin-top: 14px; }
      .shot p { margin-top: 6px; font-size: 14px; color: var(--steel); max-width: 68ch; }

      .decisions { display: grid; gap: 20px; margin-top: 28px; }
      .decision { padding: 24px; border: 1px solid var(--ash); border-radius: var(--radius-card); background: var(--white); }
      .decision dl { margin: 14px 0 0; }
      .decision dl > div { padding-top: 12px; border-top: 1px solid var(--ash); }
      .decision dl > div + div { margin-top: 12px; }
      /* แถว "ผลที่ตามมา" คือเหตุผลที่ทั้งส่วนนี้มีอยู่ — ข้อเสียที่ยอมรับ คือของจริง
         ที่ผู้ประเมินต้องเห็น ถ้าให้หน้าตาเท่ากับอีกสองแถว มันจะหายไปในสายตา
         แยกด้วยพื้นเทาที่เข้มขึ้น ไม่ใช่ขีดสีข้าง ซึ่งเป็นลายเซ็นของ UI ที่ประกอบขึ้น */
      .decision dl > div:last-child { margin-top: 14px; padding: 14px 16px; border-top: 0; background: var(--paper); border-radius: var(--radius-btn); }
      .decision dl > div:last-child dt { color: var(--steel); }
      .decision dl > div:last-child dd { color: var(--charcoal); }
      .decision dt { font-size: 12px; font-weight: 500; letter-spacing: 0.04em; color: var(--fog); }
      .decision dd { margin: 4px 0 0; font-size: 14px; color: var(--steel); }

      .stages { display: grid; gap: 1px; margin: 28px 0 0; padding: 0; overflow: hidden; border: 1px solid var(--ash); border-radius: var(--radius-card); background: var(--ash); list-style: none; }
      /* หลักฐานที่อ่านได้บนหน้าเอง — ตั๋วงานจริงหนึ่งใบ แทนการชี้ไปที่ path ในโปรเจค
         ซึ่งเปิดไม่ได้ตราบใดที่ repo ยังไม่สาธารณะ ส่วนนี้อยู่บนพื้น paper จึงใช้พื้นขาว
         ตัดกัน (ถ้าใช้ paper จะกลืนหาย) และไม่ใช้ขีดสีข้าง ซึ่งเป็นลายเซ็นของ UI ที่ประกอบขึ้น */
      .ticket { margin: 28px 0 0; padding: 20px 24px; border: 1px solid var(--ash); border-radius: var(--radius-card); background: var(--white); }
      .ticket figcaption { font-size: 12px; font-weight: 500; letter-spacing: 0.04em; color: var(--fog); }
      .ticket p { margin-top: 10px; max-width: 68ch; }
      .ticket .ticket-title { margin-top: 12px; color: var(--charcoal); }
      .stage { padding: 24px; background: var(--white); }
      .stage-num { font-size: 13px; font-weight: 700; color: var(--blue); }
      .stage h3 { margin-top: 10px; }
      .stage-tools { margin-top: 4px; font-size: 13px; font-weight: 500; color: var(--charcoal); }
      .stage p:last-child { margin-top: 8px; font-size: 14px; color: var(--steel); }

      /* ที่เดียวในหน้าที่ยังใช้ monospace และใช้กับสิ่งที่ควรใช้จริง ๆ คือ path ของไฟล์
         (docs/specs, .scratch/...) ไม่ใช่แต่งให้ดูเทคนิค — แอปไม่มีพื้นผิวโค้ดจึงไม่มี
         โทเคนนี้ให้คัดมา จึงใช้สแตกของแพลตฟอร์มแทนการคิดโทเคนใหม่ */
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }

      .reveal { transition: opacity 400ms var(--ease), transform 400ms var(--ease); }
      html.js .reveal:not(.in) { opacity: 0; transform: translateY(12px); }

      @media (max-width: 639px) {
        .band { padding: 56px 0; }
        /* ลิงก์กระโดดมีไว้ให้คนที่อยากข้ามไปอ่าน ไม่ใช่ทางหลักของหน้า บนจอแคบมันดัน
           ปุ่มหลักตกขอบและตัดคำเป็นสองบรรทัด เนื้อหายังเข้าถึงตามลำดับอ่านปกติได้
           ต้องเขียนให้ specificity เท่ากับ .nav-links a:not(.btn) (0,2,1) ไม่งั้น
           กฎนั้นจะชนะแล้วลิงก์ยังโผล่บนมือถือ */
        .nav-links a.nav-jump { display: none; }
      }

      @media (min-width: 640px) {
        .container { padding: 0 40px; }
        .steps { grid-template-columns: repeat(2, 1fr); }
        .step:last-child { grid-column: 1 / -1; }
      }

      @media (min-width: 960px) {
        .container { padding: 0 64px; }
        .hero-grid { grid-template-columns: 1fr 1fr; gap: 56px; }
        /* ภาพหน้าจอเป็นภาพแนวตั้งจากจอแคบ ซึ่งเป็นแบบเดียวที่ตัวอักษรในแอปยังอ่านออก
           แต่มี 3 ภาพ จึงจับคู่ 2 คอลัมน์ได้ไม่ลงตัว — ช่องสุดท้ายว่างเสมอ (วัดได้ 1526px)
           ภาพแดชบอร์ดที่เป็นภาพแนวนอนจึงกินเต็มความกว้างเป็นภาพนำ แล้วภาพแนวตั้งสองใบ
           อยู่แถวถัดไป ช่องว่างเหลือเท่าความต่างความสูงของสองใบนั้น
           ภาพนำจำกัดที่ความกว้างจริง 804px เพื่อให้ตัวอักษรในภาพคมที่สุด (สเกล 100%) */
        .shots { grid-template-columns: 1fr 1fr; gap: 40px 32px; align-items: start; }
        .shots .shot-lead { grid-column: 1 / -1; }
        .shots .shot-lead img { width: 100%; max-width: 804px; margin: 0 auto; }
        .shots .shot-lead .frame { display: flex; justify-content: center; }
        .steps { grid-template-columns: repeat(5, 1fr); }
        .step:last-child { grid-column: auto; }
        .demo-grid { grid-template-columns: 1fr 1fr; gap: 56px; }
        .decisions { grid-template-columns: 1fr 1fr; gap: 24px; }
        .stages { grid-template-columns: repeat(3, 1fr); }
      }

      @media (prefers-reduced-motion: reduce) {
        .reveal { transition: none; }
        html.js .reveal:not(.in) { opacity: 1; transform: none; }
      }

      /* การพิมพ์/บันทึกเป็น PDF ไม่มีการเลื่อนจอ จึงไม่มีอะไร trigger IntersectionObserver
         ถ้าไม่ยกเลิกการซ่อน ส่วนที่ยังไม่ถูกเปิดจะพิมพ์ออกมาเป็นหน้าว่างทั้งหน้า

         ภาพหน้าจอเป็นภาพแนวตั้ง สูง 1491-1910px ตอนเรนเดอร์ที่ความกว้างของ A4 ซึ่งเกิน
         กล่อง printable (~1123px) เบราว์เซอร์จึงกันหน้าว่างไว้ให้ภาพที่ล้น วัดจริงได้
         3 หน้าว่างจาก 13 หน้า จำกัดความสูงให้พอดีหนึ่งหน้าแล้วห้ามตัด figure คร่อมหน้า */
      @media print {
        html.js .reveal:not(.in) { opacity: 1; transform: none; }
        .band { padding: 32px 0; }
        .frame { box-shadow: none; }
        .shot { break-inside: avoid; }
        .shot .frame img { display: block; width: auto; max-width: 100%; max-height: 860px; margin: 0 auto; }
      }
`;

const pageTitle = "หอพักวังจันทร์ — แนะนำโปรเจค";
const pageDescription =
  "ระบบจัดการหอพักขนาดเล็ก สร้างบิลทั้งหอจากการกรอกมิเตอร์ครั้งเดียว ส่งเข้า LINE พร้อม QR พร้อมเพย์ และปิดบิลเองเมื่อสลิปยอดตรง พร้อมเดโมสาธารณะให้ลองเอง";

/**
 * ปุ่มหลักของหน้าต้องไม่พาคนไปเจอ 404
 *
 * - ถ้าตั้งที่อยู่เดโมจริงแล้ว (วัน deploy) ใช้ที่อยู่นั้น
 * - ถ้ายังไม่ตั้ง แต่กำลังรันอยู่บน Worker เดโมเอง ใช้เส้นทางในเครื่องได้จริง
 * - ถ้ายังไม่ตั้ง และไม่ใช่เดโม (production ก่อน deploy) เส้นทางสำรองถูกปิดแบบ
 *   fail closed จึงตอบ 404 ปุ่มต้องแสดงเป็นสถานะปิดแทนลิงก์ที่กดแล้วพัง
 */
function primaryCta(demoMode: boolean): string {
  if (landingConfig.demoEntryUrl !== "") {
    return `<a class="btn btn-primary" href="${landingConfig.demoEntryUrl}">ทดลองระบบ</a>`;
  }

  if (demoMode) {
    return `<a class="btn btn-primary" href="${demoEntryPath}">ทดลองระบบ</a>`;
  }

  return `<span class="btn btn-primary" role="link" aria-disabled="true" title="ยังไม่ได้ตั้งที่อยู่เดโม">ทดลองระบบ</span>`;
}

function navSection(demoMode: boolean): string {
  return `<header class="nav">
      <div class="container nav-inner">
        <a class="brand" href="/welcome"><span class="mark" aria-hidden="true"><span class="mark-inner">วจ</span></span>หอพักวังจันทร์</a>
        <nav class="nav-links" aria-label="หัวข้อในหน้านี้">
          <a class="nav-jump" href="#demo">ลองระบบ</a>
          <a class="nav-jump" href="#build">ข้อตัดสินใจ</a>
          <a class="nav-jump" href="#process">กระบวนการ</a>
          ${primaryCta(demoMode)}
        </nav>
      </div>
    </header>`;
}

function heroSection(demoMode: boolean): string {
  return `<section class="band hero">
      <div class="container hero-grid">
        <div>
          <p class="kicker">โปรเจคจัดการหอพักขนาดเล็ก</p>
          <h1>จากสมุดจด<br />สู่บิลที่ส่งเองทั้งหอ</h1>
          <p class="lede">หอไม่เกิน 20 ห้อง กรอกเลขมิเตอร์ครั้งเดียวแล้วออกบิลได้ทั้งหอ ส่งเข้า LINE พร้อม QR พร้อมเพย์ยอดตรง และปิดบิลให้เองเมื่อสลิปยอดถูกต้อง</p>
          <div class="hero-actions">
            ${primaryCta(demoMode)}
            <a class="btn btn-secondary" href="#build">ดูว่าเขียนยังไง</a>
          </div>
        </div>
        <div>
          <div class="frame">
            <div class="frame-bar" aria-hidden="true"><span class="frame-dot"></span><span class="frame-dot"></span><span class="frame-dot"></span></div>
            <img src="/welcome-media/hero-bill-create.webp" width="804" height="798" fetchpriority="high" decoding="async" alt="การ์ดห้อง A101 ของสมชาย ใจดี กรอกเลขมิเตอร์น้ำและไฟแล้ว ระบบคำนวณค่าน้ำ ค่าไฟ และยอดรวม 3,999 บาท พร้อมสถานะพร้อมสร้าง" />
          </div>
          <p class="note">ภาพหน้าจอจากข้อมูลตัวอย่าง</p>
        </div>
      </div>
    </section>`;
}

const steps: ReadonlyArray<readonly [string, string]> = [
  ["อ่านมิเตอร์", "เดินอ่านเลขน้ำและไฟทีละห้อง จดลงกระดาษเหมือนเดิม"],
  ["กรอกหน้าเดียว", "พิมพ์เลขลงตารางเดียวทั้งหอ เห็นยอดของทุกห้องขยับทันที"],
  ["สร้างบิลทั้งหอ", "กดครั้งเดียวได้บิลทุกห้อง ราคาถูกตรึงไว้ ณ วันสร้าง"],
  ["ส่งเข้า LINE", "บิลพร้อม QR พร้อมเพย์ยอดตรงถึงแชทที่ผู้เช่าใช้อยู่แล้ว"],
  ["สลิปเข้า ปิดบิล", "ยอดตรงปิดบิลให้เอง ยอดไม่ตรงเข้าคิวรอเจ้าของตรวจ"],
];

/**
 * บทบาทในระบบ — สองบรรทัดที่ทำให้คนใหม่เข้าใจรูปร่างของระบบ
 *
 * ข้อเท็จจริงที่ทำให้ระบบนี้ต่างจากซอฟต์แวร์หอเช่าทั่วไปคือ "มีคนใช้จริงคนเดียว
 * และผู้เช่าไม่มีบัญชีเลย" ซึ่งเดิมถูกอธิบายเฉพาะในฐานะ "ข้อตัดสินใจ" ที่อยู่ลึก
 * ลงไปครึ่งหน้า ผู้ชมที่อ่านจากบนลงล่างจึงเข้าใจว่านี่คือแอปสำหรับเจ้าของหอ และ
 * เพิ่งมารู้ทีหลังว่าฝั่งผู้เช่าไม่มีหน้าจอเลย การบอกบทบาทไว้ตรงนี้ทำให้อ่านส่วน
 * ห้าขั้นตอนที่ตามมาด้วยรู้ว่าใครเป็นคนทำขั้นไหน
 */
const systemRoles: ReadonlyArray<readonly [string, string]> = [
  ["เจ้าของหอ", "คนเดียวที่มีบัญชี เข้าด้วย Google ทำงานทั้งรอบบิลตั้งแต่กรอกมิเตอร์จนปิดบิล"],
  ["ผู้เช่า", "ไม่มีบัญชีและไม่ต้องติดตั้งอะไร รับบิล จ่ายผ่าน QR แล้วส่งสลิปกลับในแชท LINE ของหอ"],
];

function contextSection(): string {
  const cards = steps
    .map(
      ([title, detail], index) =>
        `<li class="step"><p class="step-num num" aria-hidden="true">${String(index + 1).padStart(2, "0")}</p><h3>${title}</h3><p>${detail}</p></li>`,
    )
    .join("\n        ");

  const roles = systemRoles
    .map(([role, detail]) => `<div><dt>${role}</dt><dd>${detail}</dd></div>`)
    .join("\n          ");

  return `<section id="flow" class="band band-paper reveal" aria-labelledby="flow-title">
      <div class="container">
        <h2 id="flow-title">หอเล็กที่เจ้าของคนเดียวทำทุกอย่างเอง</h2>
        <p>หอขนาดไม่เกิน 20 ห้อง ไม่มีพนักงานประจำ และไม่มีระบบเดิมให้ต่อ เจ้าของหอเดินอ่านมิเตอร์เอง จดใส่กระดาษ แล้วกลับมาเปิดโปรแกรมเพื่อออกบิล ส่งให้ผู้เช่า และตามเก็บเงิน ทุกเดือนด้วยมือคนเดียว ระบบนี้ออกแบบจากงานนั้น — งานที่ทำซ้ำทุกเดือนและไม่มีใครช่วยแบ่งเบา</p>
        <dl class="roles" aria-label="บทบาทในระบบ">
          ${roles}
        </dl>
        <p class="subhead subhead-spaced">ห้าขั้นตอนของรอบบิล</p>
        <ol class="steps">
        ${cards}
        </ol>
      </div>
    </section>`;
}

function demoSection(demoMode: boolean): string {
  return `<section id="demo" class="band reveal" aria-labelledby="demo-title">
      <div class="container">
        <h2 id="demo-title">ลองระบบจริงด้วยมือตัวเอง</h2>
        <p class="lede">กดปุ่มเดียวเข้าไปได้ทันที ไม่ต้องมีบัญชี Google และแก้ข้อมูลได้จริงทุกหน้า เพราะการดูระบบที่กดอะไรก็ไม่ตอบสนองไม่ได้บอกอะไรเกี่ยวกับงานชิ้นนี้</p>

        <div class="demo-grid">
          <div class="demo-panel">
            <h3>สิ่งที่คุณจะเจอเมื่อเข้าไป</h3>
            <ul>
              <li>แดชบอร์ดรายรับของเดือนก่อนหน้า พร้อมยอดค้างชำระและห้องว่าง</li>
              <li>บิลสองเดือนย้อนหลัง ครอบคลุมทั้งจ่ายแล้ว ยังไม่จ่าย และสลิปรอตรวจ</li>
              <li>เดือนปัจจุบันเว้นว่างไว้ ให้ได้ลองออกบิลทั้งหอด้วยมือตัวเอง</li>
            </ul>
            ${primaryCta(demoMode)}
            <p class="note">เดโมใช้ฐานข้อมูลคนละก้อนกับหอจริง แก้หรือลบข้อมูลในนั้นได้ไม่มีผลกับข้อมูลจริง</p>
          </div>

          <div>
            <div class="closure">
              <h3>สิ่งที่ปิดไว้ในโหมดตัวอย่าง</h3>
              <ul>
                <li>ไม่ส่งข้อความ LINE จริงถึงใคร</li>
                <li>ไม่เรียกบริการตรวจสลิปที่คิดค่าใช้จ่ายต่อครั้ง</li>
                <li>ไม่ผูก LINE ด้วยรหัสของเจ้าของหอ</li>
              </ul>
              <p>สามอย่างนี้เป็นจุดเดียวที่ระบบติดต่อออกไปข้างนอก ในเดโม สามอย่างนี้ถูกปิดที่ตัวระบบเอง ไม่ใช่เพราะยังไม่ได้ใส่รหัสเชื่อมต่อ ปุ่มที่เกี่ยวข้องจึงตอบกลับว่าใช้ในโหมดตัวอย่างไม่ได้</p>
            </div>

            <div class="closure">
              <h3>เดโมนี้ใช้ร่วมกัน</h3>
              <p>ทุกคนที่เข้าไปเห็นข้อมูลชุดเดียวกันและแก้ข้อมูลชุดเดียวกัน ข้อมูลอาจถูกแก้โดยผู้ชมคนอื่น หรือถูกรีเซ็ตกลับเป็นข้อมูลตัวอย่างชุดเริ่มต้นได้ตลอดเวลา เดโมจึงไม่ใช่พื้นที่ส่วนตัว และไม่ควรใส่ข้อมูลจริงลงไป</p>
            </div>

            <p class="note">ข้อมูลทั้งหมดในเดโมเป็นข้อมูลตัวอย่างที่สร้างขึ้นสำหรับหน้านี้ ไม่ใช่ข้อมูลผู้เช่าจริงของหอใด</p>
          </div>
        </div>
      </div>
    </section>`;
}

/**
 * ภาพหน้าจอสามใบกับคำอธิบาย
 *
 * ช่องสุดท้ายคือ alt ที่ต้องบอก "หลักฐานในภาพ" ไม่ใช่บอกชื่อส่วน เพราะ alt เดิม
 * ("แดชบอร์ดรายเดือน — ภาพหน้าจอจากข้อมูลตัวอย่าง") ซ้ำกับ h3 ที่อยู่ใต้ภาพพอดี
 * ผู้ใช้ screen reader จึงได้ยินชื่อซ้ำสองรอบและไม่รู้อะไรจากตัวภาพเลย บนหน้าที่
 * ทั้งหน้าเป็นเรื่อง "นี่คือหลักฐานจริง" การที่ภาพให้ข้อมูลไม่ได้คือการสูญเสียสาระ
 * คำกำกับว่าเป็นข้อมูลตัวอย่างมีอยู่แล้วที่ .note ท้ายส่วน ไม่ต้องซ้ำใน alt
 */
const screenshots: ReadonlyArray<readonly [string, string, string, number, number, string]> = [
  [
    "/welcome-media/bill-dashboard.webp",
    "แดชบอร์ดรายเดือน",
    "ยอดที่ควรเก็บ เก็บแล้ว และค้างชำระของเดือนที่เลือก พร้อมจำนวนห้องว่างและอัตราการเช่า",
    804,
    372,
    "การ์ดสรุปเดือนสิงหาคม 2569 ของหอ 18 ห้อง ยอดที่ควรเก็บ 63,324 บาท จาก 15 บิล เก็บแล้ว 47,140 บาท จาก 11 บิล ค้างชำระ 16,184 บาท จาก 4 ห้อง ห้องว่าง 3 จาก 18 ห้อง อัตราการเช่า 83 เปอร์เซ็นต์",
  ],
  [
    "/welcome-media/bill-line-qr.webp",
    "บิลที่ผู้เช่าได้รับ",
    "การ์ดบิลในแชท LINE พร้อมปุ่มเปิดใบแจ้งหนี้ และใบแจ้งหนี้ใบเดียวกันที่มี QR พร้อมเพย์ยอดตรงกับบิลนั้น",
    804,
    1684,
    "การ์ดบิลในแชท LINE ของห้อง A101 ผู้เช่าสมชาย ใจดี ยอด 4,046 บาท แจกแจงค่าเช่าห้อง 3,500 ค่าน้ำ 252 และค่าไฟ 294 บาท พร้อมปุ่มเปิดใบแจ้งหนี้ และรูปใบแจ้งหนี้ใบเดียวกันที่มี QR พร้อมเพย์เบอร์ 089-111-2233",
  ],
  [
    "/welcome-media/payment-status.webp",
    "สถานะการชำระและคิวรอตรวจ",
    "สลิปที่ยอดไม่ตรงหรือตรวจไม่ผ่านจะเข้าคิวนี้ เจ้าของหอเห็นยอดเทียบกับยอดบิลแล้วตัดสินปิดหรือปฏิเสธ",
    736,
    1974,
    "คิวรอตรวจของห้อง A105 อรุณี แสงทอง สลิปยอด 4,046 บาท ตรงกับยอดบิล แต่ผลตรวจจาก SlipOK ขึ้นว่าตรวจไม่ผ่านเพราะไม่พบเลขอ้างอิงการโอน พร้อมปุ่มปฏิเสธสลิปและปิดบิลด้วยสลิปนี้",
  ],
];

function screenshotsSection(): string {
  const cards = screenshots
    .map(
      ([src, title, detail, width, height, alt], index) =>
        `<figure class="shot${index === 0 ? " shot-lead" : ""}"><div class="frame"><img src="${src}" width="${String(width)}" height="${String(height)}" alt="${alt}" loading="lazy" /></div><figcaption><h3>${title}</h3><p>${detail}</p></figcaption></figure>`,
    )
    .join("\n        ");

  return `<section id="screens" class="band band-paper reveal" aria-labelledby="screens-title">
      <div class="container">
        <h2 id="screens-title">หน้าจอจริงจากตัวระบบ</h2>
        <p>สามหน้าจอที่บอกว่างานนี้หน้าตาเป็นอย่างไรตอนใช้งาน ไม่ใช่ตอนนำเสนอ</p>
        <div class="shots">
        ${cards}
        </div>
      </div>
    </section>`;
}

const engineeringDecisions: ReadonlyArray<readonly [string, string, string, string]> = [
  [
    "ผู้เช่าไม่มีบัญชี",
    "หอมีผู้เช่าที่ผลัดเปลี่ยนทุกเดือน การออกแบบหน้าจอและระบบยืนยันตัวตนฝั่งผู้เช่าจึงเป็นงานที่ต้องดูแลตลอดแต่ใช้น้อย",
    "ใช้ LINE เป็นช่องทางเดียว ผู้เช่าไม่ต้องติดตั้งหรือสมัครอะไร และไม่มีรหัสผ่านของผู้เช่าเก็บอยู่ในระบบเลย",
    "การยืนยันตัวตนอ่อนกว่าการมีบัญชี และผู้เช่าไม่มีหน้าเว็บให้ตรวจสอบย้อนหลังด้วยตัวเอง ต้องพิมพ์เลขห้องในแชทจึงจะยืนยันได้",
  ],
  [
    "ราคาถูกตรึงไว้ในบิล",
    "ค่าเช่า ค่าน้ำ และค่าไฟของแต่ละห้องไม่เท่ากัน และค่าตั้งต้นอย่างอัตราค่าน้ำถูกแก้ได้ตลอดปี ถ้าบิลอ่านค่าปัจจุบันทุกครั้ง ใบเก่าจะเปลี่ยนยอดย้อนหลัง",
    "บิลเก็บสำเนาทุกค่าไว้เอง ณ วันที่ออกบิล ทั้งค่าเช่า หน่วยมิเตอร์ อัตราที่ใช้คิด และรายการค่าใช้จ่าย",
    "แก้ค่าตั้งต้นภายหลังไม่ย้อนไปเปลี่ยนบิลที่ออกไปแล้ว แต่ทุกบิลต้องเก็บสำเนารายการและยอดไว้ครบ ซึ่งเป็นข้อมูลที่ซ้ำกันในทุกแถว",
  ],
  [
    "ปิดบิลเองเมื่อยอดตรงเป๊ะ",
    "ต้นเดือนมีสลิปเข้ามาหลายสิบใบถ้าเจ้าของต้องนั่งเทียบยอดทีละใบ งานที่ซ้ำและไม่ต้องใช้ดุลยพินิจจะกินเวลาส่วนใหญ่ไปเปล่า",
    "สลิปที่ผ่านการตรวจของผู้ให้บริการภายนอกและมียอดตรงกับยอดบิลพอดีจะปิดบิลให้เอง ที่เหลือเข้าคิวรอตรวจเสมอ",
    "ระบบเชื่อผลตรวจของผู้ให้บริการภายนอก ถ้าสลิปปลอมหลุดรอดการตรวจและยอดบังเอิญตรง ระบบจะปิดบิลผิด ยอมรับความเสี่ยงนี้เพราะมีเจ้าของหอคนเดียวคอยดูอยู่ และคิวรอตรวจรองรับกรณีผิดปกติไว้แล้ว",
  ],
  [
    "ไม่มีงานตั้งเวลา",
    "ระบบที่ไม่มีงานตั้งเวลาไม่มีอะไรต้องเฝ้า และไม่พังเงียบ ๆ ตอนไม่มีใครดูอยู่",
    "ทุกอย่างเกิดจากคำขอจริง ทั้งการออกบิล การส่ง และการตรวจสลิป ไม่มี cron ให้ดูแลเบื้องหลัง",
    "ไม่มีค่าใช้จ่ายและงานดูแลฝั่งเซิร์ฟเวอร์ แต่ก็ไม่มีอะไรทำงานแทนคนเมื่อไม่มีใครเข้ามาใช้ งานที่ควรเกิดเองตามเวลาเช่นการแจ้งเตือน จะไม่เกิดขึ้นถ้าไม่มีคำขอเข้ามา",
  ],
];

function decisionsSection(): string {
  const cards = engineeringDecisions
    .map(
      ([title, problem, decision, consequence]) =>
        `<article class="decision">
          <h3>${title}</h3>
          <dl>
            <div><dt>ปัญหา</dt><dd>${problem}</dd></div>
            <div><dt>ตัดสินใจ</dt><dd>${decision}</dd></div>
            <div><dt>ผลที่ตามมา</dt><dd>${consequence}</dd></div>
          </dl>
        </article>`,
    )
    .join("\n        ");

  return `<section id="build" class="band reveal" aria-labelledby="build-title">
      <div class="container">
        <h2 id="build-title">ข้อตัดสินใจที่กำหนดรูปร่างระบบ</h2>
        <p>สี่เรื่องที่เลือกทางใดทางหนึ่งแล้วได้ข้อเสียติดมาด้วยทุกข้อ เขียนไว้ตรง ๆ ทั้งข้อดีและข้อเสีย</p>
        <div class="decisions">
        ${cards}
        </div>
      </div>
    </section>`;
}

const workflowStages: ReadonlyArray<readonly [string, string, string]> = [
  ["Plan", "ChatGPT · Claude", "เกลาปัญหาให้เป็นข้อกำหนด เขียนสเปกแยกงาน และแยกเป็นตั๋วงานที่ตรวจรับได้ทีละใบก่อนเริ่มเขียนโค้ด"],
  ["Build", "Codex · Claude Code", "เขียนโค้ดตามตั๋วทีละใบในโปรเจคจริง รันคำสั่งจริงบนเครื่อง และแก้จากการทดสอบที่ล้ม"],
  ["Verify", "ชุดเทส · การตรวจด้วยตาเปล่า", "รันชุดเทสบนรันไทม์เดียวกับที่ deploy จริง แล้วเปิดหน้าจอจริงดูก่อนรับงานทุกครั้ง"],
];

/**
 * ตัวอย่างตั๋วงานจริงหนึ่งใบ ยกมาแสดงบนหน้าแทนการชี้ไปที่ path ในโปรเจค
 *
 * สเปก 0003 อนุญาตหลักฐานจริงได้ 1-2 ชิ้น (สเปกตัวอย่าง หรือตั๋วงานตัวอย่าง)
 * และห้ามเปิดเผย prompt หรือ log ภายใน — ข้อความนี้คือหัวข้อกับเกณฑ์ตรวจรับของ
 * ตั๋ว 06 ที่ใช้จริง ไม่ใช่คำโฆษณา และอ่านได้โดยไม่ต้องมีสิทธิ์เข้าโปรเจค
 */
const ticketExcerpt: readonly [string, string] = [
  "06 — ประตูเข้าเดโมที่ปิดสนิท สร้างเซสชันจริง และรีเซ็ตแบบเช็กกิจกรรม",
  "มีอยู่จริงเฉพาะเมื่อโหมดสาธิตเปิดอยู่ · สร้างเซสชันด้วยกลไกเดิมของระบบ ไม่สร้างกลไกคู่ขนาน · รีเซ็ตกลับเป็นชุดข้อมูลสังเคราะห์ แต่ข้ามถ้ามีคนเพิ่งเข้าไป · รับงานเมื่อยอดและสถานะของสองเดือนตรงกับที่กำหนด และคำขอที่มาพร้อมกันต้องไม่รีเซ็ตซ้อนกัน",
];

function workflowSection(): string {
  const stages = workflowStages
    .map(
      ([name, tools, detail], index) =>
        `<li class="stage"><p class="stage-num num" aria-hidden="true">${String(index + 1).padStart(2, "0")}</p><h3>${name}</h3><p class="stage-tools">${tools}</p><p>${detail}</p></li>`,
    )
    .join("\n        ");

  return `<section id="process" class="band band-paper reveal" aria-labelledby="process-title">
      <div class="container">
        <h2 id="process-title">สร้างขึ้นอย่างไร</h2>
        <p>ใช้ผู้ช่วย AI สามขั้นตอนนี้ตลอดงาน คนเป็นคนกำหนดว่าอะไรต้องได้ ปิดงานแต่ละใบด้วยการตรวจ ไม่ใช่ด้วยความมั่นใจ</p>
        <ol class="stages">
        ${stages}
        </ol>
        <figure class="ticket">
          <figcaption>ตัวอย่างตั๋วงานที่ใช้จริง — ตั๋วที่ 06 ของงานนี้</figcaption>
          <p class="ticket-title">${ticketExcerpt[0]}</p>
          <p>${ticketExcerpt[1]}</p>
        </figure>
        <p class="note">ตั๋วงานถูกเขียนก่อนเริ่มโค้ดทุกใบ และปิดเมื่อเกณฑ์ตรวจรับผ่านจริง ห้ามเปิดเผยบทสนทนาภายใน และไม่ลงตัวเลขที่ไม่มีการวัดรองรับ</p>
      </div>
    </section>`;
}

function contactRow(): string {
  const links: string[] = [];

  if (landingConfig.githubProfileUrl !== "") {
    links.push(`<a class="btn btn-secondary" href="${landingConfig.githubProfileUrl}">โปรไฟล์ GitHub</a>`);
  }

  if (landingConfig.contactEmail !== "") {
    links.push(`<a class="btn btn-secondary" href="mailto:${landingConfig.contactEmail}">${landingConfig.contactEmail}</a>`);
  }

  return links.join("\n        ");
}

function footerSection(demoMode: boolean): string {
  const contact = contactRow();

  return `<footer class="footer">
      <div class="container">
        <span class="brand"><span class="mark" aria-hidden="true"><span class="mark-inner">วจ</span></span>หอพักวังจันทร์</span>
        <p class="note">ข้อมูลทั้งหมดที่แสดงในหน้านี้เป็นข้อมูลตัวอย่าง</p>
        <div class="footer-actions">
        ${contact}
        ${primaryCta(demoMode)}
        </div>
      </div>
    </footer>`;
}

const revealScript = `
      (function () {
        var targets = document.querySelectorAll(".reveal");
        var reveal = function (element) { element.classList.add("in"); };

        if (!("IntersectionObserver" in window)) {
          Array.prototype.forEach.call(targets, reveal);
          return;
        }

        var observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              reveal(entry.target);
              observer.unobserve(entry.target);
            }
          });
        });

        Array.prototype.forEach.call(targets, function (target) { observer.observe(target); });

        /**
         * กันกรณีกระโดดข้าม: การเลื่อนแบบกระโดดไกล (กดสมอ หรือปัดเร็วมาก)
         * ทำให้บางหัวข้อไม่เคย intersect เลยและค้างซ่อนอยู่ ทั้งที่ผู้ใช้อยู่ต่ำกว่าแล้ว
         * ตัวนี้จึงเปิดให้หัวข้อที่อยู่เหนือจอไปแล้วโดยไม่ต้องรออนิเมชัน
         */
        var backstop = function () {
          var hidden = 0;

          Array.prototype.forEach.call(targets, function (target) {
            if (target.classList.contains("in")) {
              return;
            }

            if (target.getBoundingClientRect().bottom < 0) {
              reveal(target);
            } else {
              hidden += 1;
            }
          });

          if (hidden === 0) {
            window.removeEventListener("scroll", backstop);
          }
        };

        window.addEventListener("scroll", backstop, { passive: true });
      })();
`;

/**
 * เรนเดอร์หน้าทั้งหน้าเป็นสตริงเดียว
 *
 * `origin` รับมาจากคำขอเพื่อให้ URL ของภาพที่ใช้แชร์เป็นแบบเต็ม (og:image
 * ต้องเป็น URL เต็ม ตัว crawler ของ LINE ไม่แก้ URL แบบ نسبให้) — ฟังก์ชันยัง
 * บริสุทธิ์และเรียกตรงในเทสได้ด้วย origin คงที่
 */
export function renderWelcomePage(origin: string, demoMode = false): string {
  return `<!doctype html>
<html lang="th">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${pageTitle}</title>
    <meta name="description" content="${pageDescription}" />
    <meta property="og:title" content="${pageTitle}" />
    <meta property="og:description" content="${pageDescription}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${origin}/welcome" />
    <meta property="og:image" content="${origin}/welcome-media/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Noto+Sans+Thai:wght@400;500;600&display=swap" rel="stylesheet" />
    <script>document.documentElement.className = "js";</script>
    <style>${welcomeStyles}</style>
  </head>
  <body>
    ${navSection(demoMode)}
    <main>
      ${heroSection(demoMode)}
      ${contextSection()}
      ${demoSection(demoMode)}
      ${screenshotsSection()}
      ${decisionsSection()}
      ${workflowSection()}
    </main>
    ${footerSection(demoMode)}
    <script>${revealScript}</script>
  </body>
</html>
`;
}

const welcomePage = new Hono<AppEnv>();

welcomePage.get("/", (c) => c.html(renderWelcomePage(new URL(c.req.url).origin, demoModeOn(c.env))));

export default welcomePage;
