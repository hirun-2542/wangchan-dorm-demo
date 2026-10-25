/**
 * ธีมของแอป (สว่าง/มืด)
 *
 * ค่าที่ผู้ใช้เลือกเก็บใน localStorage ("wangchan-theme") — ค่าเริ่มต้นคือ "light"
 * (สว่าง) ตรงกับดีไซน์หลักของแอป ส่วนคนที่อยากตาม OS หรือล็อกธีมมืดเลือกเองได้
 *
 * ค่าจริงถูกตัดสินเป็น "light"/"dark" แล้วติดไว้ที่ <html data-theme> แทนการให้ CSS
 * อ่าน prefers-color-scheme เอง เพราะผู้ใช้เลือกทับ OS ได้ — CSS จึงมีชุดสีมืดชุดเดียว
 * ที่ผูกกับ [data-theme="dark"] (ดูท้ายไฟล์ src/client/styles.css)
 *
 * สคริปต์สั้นใน index.html ตัดสินค่าเดียวกันก่อน first paint เพื่อกันจอวาบขาว
 * โมดูลนี้ทำหน้าที่ "ตามให้ทัน" หลังแอปเริ่ม: ซิงก์ theme-color ของเบราว์เซอร์
 * และฟังการเปลี่ยนธีมของ OS เฉพาะตอนที่ยังเลือก "ตามระบบ"
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** ต้องตรงกับคีย์ที่สคริปต์ใน index.html อ่าน */
const storageKey = "wangchan-theme";
const darkQuery = "(prefers-color-scheme: dark)";

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "light";
  } catch {
    // โหมดส่วนตัว/ปิด storage — ยังได้ค่าเริ่มต้น (สว่าง) ตามปกติ
    return "light";
  }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") {
    return preference;
  }

  return window.matchMedia(darkQuery).matches ? "dark" : "light";
}

/**
 * ใช้ธีมกับเอกสาร — เรียกซ้ำได้เสมอ (idempotent)
 *
 * อัปเดต theme-color ด้วย เพื่อให้แถบสถานะบนมือถือตรงกับธีมที่เห็นจริง ไม่ใช่ตาม OS
 * (ผู้ใช้เลือกทับ OS ได้)
 */
export function applyTheme(preference: ThemePreference = readThemePreference()): ResolvedTheme {
  const theme = resolveTheme(preference);
  document.documentElement.dataset.theme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) {
    meta.setAttribute("content", theme === "dark" ? "#0e0e10" : "#ffffff");
  }

  return theme;
}

export function setThemePreference(preference: ThemePreference): ResolvedTheme {
  try {
    window.localStorage.setItem(storageKey, preference);
  } catch {
    // บันทึกไม่ได้ก็ยังใช้ค่าที่เพิ่งเลือกได้จนกว่าจะปิดแท็บ (อ่านจะได้ "light")
  }

  return applyTheme(preference);
}

/**
 * ฟังการเปลี่ยนธีมของ OS — มีผลเฉพาะตอนที่ผู้ใช้เลือก "ตามระบบ"
 * คืนฟังก์ชันถอด listener ให้ผู้เรียกใช้ต่อได้ (แอปเรียกครั้งเดียวตอนบูต)
 */
export function watchSystemTheme(): () => void {
  const query = window.matchMedia(darkQuery);
  const onChange = () => {
    if (readThemePreference() === "system") {
      applyTheme("system");
    }
  };

  query.addEventListener("change", onChange);

  return () => {
    query.removeEventListener("change", onChange);
  };
}
