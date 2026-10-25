/**
 * ลิงก์ที่ส่งไปในแชท LINE
 *
 * LINE เปิดลิงก์ในข้อความด้วย **in-app browser ของตัวเองเสมอ** และ Google
 * บล็อก OAuth ใน embedded webview ตั้งแต่ 24 ก.ค. 2023 (ตอบ disallowed_useragent)
 * ลิงก์ที่กดแล้วต้องผ่านการเข้าสู่ระบบด้วย Google จึงพังทันทีถ้าเปิดในแอป
 *
 * `openExternalBrowser=1` สั่งให้ LINE เปิด Safari/Chrome แทน และเอกสาร LINE
 * ระบุว่าใช้ได้กับ "all URLs accessed from the LINE app, except for LIFF apps"
 * (LIFF ถูกออกแบบให้อยู่ใน LINE จึงไม่ใช้พารามิเตอร์นี้)
 *
 * **ตำแหน่งสำคัญ**: ต้องเป็น query parameter เท่านั้น ห้ามต่อท้าย fragment
 * เพราะ fragment ไม่ถูกส่งไปเซิร์ฟเวอร์และ LINE จะมองไม่เห็น — URL ที่มี hash
 * อยู่แล้วจึงต้องแทรกก่อน `#` ไม่ใช่ต่อท้ายสตริง
 */
export const externalBrowserParam = "openExternalBrowser=1";

/**
 * เติม `openExternalBrowser=1` ให้ URL ที่จะส่งในแชท LINE (ก่อน fragment)
 *
 * คืนค่าเดิมเมื่อ URL ไม่ใช่ http(s) เช่นลิงก์ LIFF — จะได้ไม่ไปเติมพารามิเตอร์
 * ที่เอกสาร LINE บอกว่าไม่ทำงานและทำให้ URL อ่านยากขึ้นโดยไม่ได้อะไร
 */
export function lineMessageUrl(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return url;
  }

  if (parsed.hostname === "liff.line.me") {
    return url;
  }

  // ตั้งทับค่าเดิมเสมอ: ค่าที่ซ้ำ (`...=1&...=0`) ให้ผลไม่แน่นอน แล้วแต่ LINE
  parsed.searchParams.set("openExternalBrowser", "1");

  return parsed.toString();
}

/**
 * ลิงก์ตรงไปยังบิลหนึ่งใบในเว็บ พร้อมพารามิเตอร์สำหรับเปิดนอกแอป LINE
 *
 * **ต้องมี `period` ติดไปด้วยเสมอ** เพราะหน้ารายละเอียดไม่ได้ดึงบิลตาม id เดี่ยว ๆ
 * แต่หาจากบิลที่โหลดมาแล้วของ "รอบบิลที่กำลังดูอยู่" และค่าเริ่มต้นคือรอบปัจจุบัน
 * ลิงก์ที่ไม่มี period จึงพาไปบิลของเดือนก่อน ๆ ไม่เจอ แล้วขึ้นว่า "ไม่พบบิลที่จะแสดง"
 * ทั้งที่บิลมีอยู่จริง — ซึ่งแย่กว่าเดิมเพราะดูเหมือนข้อมูลหาย
 */
export function billDetailUrl(origin: string, billId: string, period: string): string {
  const query = period === "" ? "" : `?period=${encodeURIComponent(period)}`;

  return lineMessageUrl(`${origin}/#bills/detail/${encodeURIComponent(billId)}${query}`);
}
