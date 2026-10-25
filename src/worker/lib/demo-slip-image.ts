/**
 * รูปสลิปตัวอย่างสำหรับโหมดสาธิต — PNG 525x700 สังเคราะห์ขึ้นเองทั้งหมด
 * (ชื่อ เลขพร้อมเพย์ เลขอ้างอิง และยอด ล้วนเป็นข้อมูลตัวอย่าง) ฝังเป็น base64
 * เพื่อให้ Worker ตัวเดโมมีรูปจริงใช้แสดงในหน้าคิวรอตรวจโดยไม่ต้องพึ่ง R2
 * ของ production หรือไฟล์ภายนอก
 *
 * ข้อมูลในภาพต้องสอดคล้องกับบิลที่สลิปนี้ผูกอยู่จริง (demo-room-a105 · อรุณี แสงทอง):
 *   - ผู้จ่าย = อรุณี แสงทอง (ผู้เช่าห้อง A105) ไม่ใช่ผู้เช่าห้องอื่น
 *   - พร้อมเพย์ = 089-111-2233 (หอพักวังจันทร์) ไม่ใช่เบอร์ของผู้เช่า
 *   - ยอด 4,046 บาท = bill.total ของบิลห้อง A105 ที่ seed ชั้น 2 สร้าง (water +29, electric +87)
 *     ยอดนี้ฝังอยู่ในภาพ จึงตรึงไว้ด้วยเทสต์ใน test/demo.test.ts ถ้าเปลี่ยน offset ของ
 *     การ seed ต้องวาดภาพใหม่ให้ตรง ไม่งั้นผู้ชมที่ซูมดูจะเห็นยอดในภาพไม่ตรงกับยอดในหน้าจอ
 *
 * เหตุผลที่ต้องมีรูปจริงแทนพิกเซลโปร่งใส 1x1: คิวรอตรวจเป็นหน้าจอที่ผู้ชมเดโม
 * เห็นเป็นอย่างแรก ๆ การใส่รูปเปล่าทำให้ทั้งหน้าดูพัง ซึ่งขัดกับข้อกำหนดของ
 * สเปก 0003 ที่ว่าเดโมต้องไม่ดูเหมือนมีอะไรเสีย
 */
const slipImageBase64 =
  "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"
  + "/Acz+wiRaRhnnwAAAABJRU5ErkJggg==";

/** ถอด base64 เป็นไบต์ — เล็กพอที่จะทำตอนมีคำขอ ไม่ต้องแคช */
export function demoSlipImage(): Uint8Array<ArrayBuffer> {
  const binary = atob(slipImageBase64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
