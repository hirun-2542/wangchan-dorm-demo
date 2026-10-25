/**
 * ลิงก์รูปสลิปแบบเซ็นชื่อและมีอายุ
 *
 * ปุ่มใน LINE Flex Message เปิดจากเซิร์ฟเวอร์ของ LINE (ไม่พ่วงคุกกี้ของเรา)
 * จึงใช้เส้นทางที่บังคับ session อย่าง `/slips/:file` ไม่ได้ ทางออกคือเซ็น
 * (imageKey, เวลาหมดอายุ) ด้วยความลับที่ฝั่งเซิร์ฟเวอร์เท่านั้นที่รู้ ใครถือ
 * ลิงก์ก็ดูรูปได้จนหมดอายุ และหมดอายุเองภายในหนึ่งรอบบิล — ต่างจาก session
 * ที่รั่วแล้วใช้ได้ตลอดกาล ของเดิมยังคงบังคับ session อยู่ ไม่ได้ผ่อนลง
 */
export const slipLinkTtlSeconds = 7 * 24 * 60 * 60;

async function signatureOf(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));

  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * เทียบแบบ constant-time — เช็กความยาวก่อนแล้ว XOR สะสมทุกตัวอักษร
 *
 * ลายเซ็นไม่ใช่ความลับที่โจมตีได้จากภายนอกอยู่แล้ว แต่การเทียบแบบนี้กันการวัด
 * เวลาตอบกลับเพื่อเดาลายเซ็นไปทีละตัว ซึ่งเป็นข้อบกพร่องคลาสสิกของ HMAC ที่
 * เขียนเองด้วย `===`
 */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let accumulator = 0;

  for (let index = 0; index < a.length; index += 1) {
    accumulator |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return accumulator === 0;
}

/**
 * URL รูปสลิปที่แนบไปกับ LINE — null เมื่อยังไม่ตั้ง SLIP_LINK_SECRET
 *
 * คืน null แทนการ throw เพราะผู้เรียกคือเส้นทางปิดบิลที่ทำงานสำเร็จไปแล้ว:
 * การ์ดแจ้งเตือนต้องส่งได้เสมอโดยแค่ซ่อนปุ่ม "ดูสลิป"
 */
export async function signedSlipUrl(
  env: Env,
  origin: string,
  imageKey: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const secret = (env.SLIP_LINK_SECRET ?? "").trim();

  if (secret === "") {
    console.warn(JSON.stringify({ message: "slip link secret is not configured" }));
    return null;
  }

  const expires = String(Math.floor(nowMs / 1000) + slipLinkTtlSeconds);
  const signature = await signatureOf(secret, `${imageKey}.${expires}`);

  return `${origin}/slips/p/${imageKey}?e=${expires}&s=${signature}`;
}

export async function slipSignatureValid(
  env: Env,
  imageKey: string,
  expires: string,
  signature: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const secret = (env.SLIP_LINK_SECRET ?? "").trim();

  if (secret === "") {
    console.warn(JSON.stringify({ message: "slip link secret is not configured" }));
    return false;
  }

  const expiresSeconds = Number(expires);

  if (!Number.isFinite(expiresSeconds) || expiresSeconds <= nowMs / 1000) {
    return false;
  }

  return sameSignature(await signatureOf(secret, `${imageKey}.${expires}`), signature);
}
