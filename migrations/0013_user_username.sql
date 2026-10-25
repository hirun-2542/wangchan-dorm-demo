-- ชื่อผู้ใช้สำหรับเข้าสู่ระบบด้วยรหัสผ่านควบคู่กับ Google
--
-- ไม่มีใครมีรหัสผ่านอยู่ก่อน (password_hash เป็นค่าว่างทุกแถวตั้งแต่ระบบเหลือ
-- Google ทางเดียว) จึงเพิ่มคอลัมน์ใหม่เป็น NULL ทั้งหมด แล้วให้เจ้าตัวตั้งเองจาก
-- หน้าบัญชีหลังเข้าด้วย Google — ไม่มีข้อมูลเดิมถูกแก้และไม่ต้อง backfill
--
-- เก็บเป็นตัวพิมพ์เล็กเสมอ (โค้ดปรับก่อนเขียน) ดัชนี unique จึงกันชื่อซ้ำได้จริง
-- และ NULL หลายแถวอยู่ร่วมกันได้ตามปกติของ SQLite
ALTER TABLE users ADD COLUMN username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
