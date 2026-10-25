/**
 * เส้นทางกลับหลังเข้าสู่ระบบ ("next")
 *
 * ปุ่มใน LINE Flex Message เปิดจากเซิร์ฟเวอร์ของ LINE ไม่พ่วงคุกกี้ของเรา
 * เจ้าของที่กด "เปิดบิลในเว็บ" จึงยังไม่มีเซสชัน และต้องผ่าน Google OAuth ก่อน
 * OAuth พาเบราว์เซอร์ออกไปนอกแอปแล้วกลับมาที่ /api/auth/google/callback ซึ่ง
 * อยู่คนละหน้าจอ — **fragment (#bills/detail/…) ไม่ถูกส่งมาถึงเซิร์ฟเวอร์เลย**
 * จึงต้องฝากปลายทางไว้ในคุกกี้ของเราเองแล้วค่อยเด้งกลับ
 *
 * รูปแบบที่ยอมรับคือ **fragment ของ origin ตัวเองเท่านั้น** (`#bills/detail/x`)
 * ไม่ใช่ path เต็มหรือ URL เต็ม — ปลายทางจริงของแอปนี้อยู่ใน fragment ทั้งหมด
 * และการรับเฉพาะ `#…` ตัดความเสี่ยง open redirect ทิ้งตั้งแต่ต้นทาง: ค่าที่ผ่าน
 * การตรวจนี้จะถูกต่อท้าย URL ของ origin ที่รับคำขอเสมอ และ **fragment เปลี่ยน
 * host หรือ scheme ไม่ได้ไม่ว่าเนื้อหาข้างในจะเป็นอะไร** จึงไม่ต้องมาไล่ห้าม
 * `//` `:` หรือ `\` ซึ่งมีแต่จะไปปฏิเสธ fragment ที่ถูกต้องของจริง (เช่น เลขห้อง
 * ที่มีอักขระแปลก) โดยไม่ได้ความปลอดภัยเพิ่ม
 *
 * สิ่งที่ยังต้องกันคือ **อักขระควบคุม** เพราะค่านี้ถูกใส่ใน Location header —
 * `\r\n` ใน header คือช่องยิง header แถมเข้ามา
 */
const maxReturnPathLength = 512;

/**
 * ตรวจว่าเป็น fragment ภายในที่ปลอดภัย คืนค่าที่ใช้ได้ หรือ null
 *
 * ปฏิเสธ: ไม่ขึ้นต้นด้วย # · ว่าง · ยาวเกิน · มีอักขระควบคุม
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (value.length < 2 || value.length > maxReturnPathLength) {
    return null;
  }

  if (!value.startsWith("#")) {
    return null;
  }

  // eslint-disable-next-line no-control-regex -- จงใจจับอักขระควบคุมเพื่อปฏิเสธ
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }

  return value;
}
