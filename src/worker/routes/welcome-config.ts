/**
 * ค่าที่เปลี่ยนตามการ deploy ของหน้า `/welcome` — รวมไว้ที่เดียวตามสเปก 0003
 * ("ค่าที่เปลี่ยนตามการ deploy อยู่ในที่เดียวที่แก้ได้ และปล่อยเป็นค่าตั้งต้นว่าง
 * ไว้ก่อน — ห้ามใส่ค่าปลอมลงหน้าเว็บ")
 *
 * ค่าที่เว้นว่างจะไม่ถูกแสดงเป็นลิงก์เลย หน้าเว็บจึงไม่มีลิงก์ที่กดแล้วไปไหนไม่ได้
 */
export interface LandingConfig {
  /** ที่อยู่เข้าเดโมสาธารณะแบบเต็ม — ว่างได้ก่อน deploy */
  demoEntryUrl: string;
  /** อีเมลติดต่อ */
  contactEmail: string;
  /** โปรไฟล์ GitHub ของเจ้าของงาน */
  githubProfileUrl: string;
}

export const landingConfig: LandingConfig = {
  // ยืนยันแล้วด้วยการ deploy จริง: Worker ชื่อ wangchan-demo บนบัญชีนี้
  // (subdomain เดาไม่ได้จากโค้ด จึงต้องมาจากการ deploy เท่านั้น)
  demoEntryUrl: "https://wangchan-demo.nodhk2545.workers.dev",
  // ค่าจริงจากเจ้าของงาน — เทสต์ยืนยันว่า footer เรนเดอร์เป็นลิงก์เมื่อมีค่า
  contactEmail: "nodhk2545@gmail.com",
  githubProfileUrl: "https://github.com/hirun-2542",
};

/**
 * เส้นทางเข้าเดโมภายในเครื่อง ใช้เฉพาะเมื่อรันอยู่บน Worker เดโมเอง
 *
 * เส้นทางนี้ทำงานได้ทุกที่ที่ตัวเดโมเข้าถึงได้ (ตัวเดโมรันแอปเดียวกันทั้งหมด จึง
 * เสิร์ฟ `/welcome` เองด้วย) ส่วน production จะตั้ง `demoEntryUrl` เป็นที่อยู่
 * ของ Worker เดโมตอน deploy จริง — ก่อนถึงตอนนั้นปุ่มหลักจะแสดงเป็นสถานะปิด
 * แทนที่จะเป็นลิงก์ที่กดแล้วเจอ 404 เพราะเส้นทางนี้ถูกปิดแบบ fail closed บน production
 */
export const demoEntryPath = "/api/demo/enter";
