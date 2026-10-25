-- snapshot ผู้รับเงิน (พร้อมเพย์ + บัญชีธนาคาร) ลงบิลแต่ละใบ ณ ตอนออกบิล
--
-- ก่อนหน้านี้ /qr/:id.png, /invoices/:id.pdf และข้อความ LINE อ่านพร้อมเพย์
-- จากตาราง settings แบบสด ทั้งที่หน้าตั้งค่าเขียนไว้ชัดว่า "บิลที่สร้างไปแล้ว
-- ยังใช้พร้อมเพย์ที่บันทึกไว้ในบิลนั้น" — คำนั้นไม่จริง เปลี่ยนพร้อมเพย์ใน
-- ตั้งค่าแล้ว QR ของบิลเก่าที่ส่งให้ผู้เช่าไปแล้วจะเปลี่ยนตามทันที ผิดหลัก
-- "เงินต้องไม่ผิดและต้องตรวจย้อนได้" เช่นเดียวกับที่ room_number/tenant_name
-- ถูก snapshot ไว้แล้วใน migration 0010
--
-- ค่าเริ่มต้นว่างเปล่าใช้ได้กับ CHECK เพราะ 'phone' เป็นค่าที่ผ่านเงื่อนไขเสมอ
-- บิลเก่าที่มีอยู่ก่อน migration นี้ไม่เคยถูก snapshot มาก่อน จึง backfill
-- จากค่าปัจจุบันในตั้งค่าของครอบครัวนั้นเป็นค่าประมาณที่ดีที่สุดที่มี
-- (เหมือนวิธี backfill room_number/tenant_name ใน 0010) ไม่ใช่ค่าจริง ณ
-- วันที่ออกบิล เพราะไม่มีการบันทึกไว้ตั้งแต่ต้น

ALTER TABLE bills ADD COLUMN payee_dorm_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN payee_owner_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN payee_promptpay_id TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN payee_promptpay_type TEXT NOT NULL DEFAULT 'phone' CHECK (payee_promptpay_type IN ('phone','citizen-id'));
ALTER TABLE bills ADD COLUMN payee_promptpay_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN payee_bank_name TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN payee_bank_account_number TEXT NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN payee_bank_account_name TEXT NOT NULL DEFAULT '';

UPDATE bills SET
  payee_dorm_name = COALESCE((SELECT value FROM settings WHERE family_id = bills.family_id AND key = 'dorm_name'), ''),
  payee_owner_name = COALESCE((SELECT value FROM settings WHERE family_id = bills.family_id AND key = 'owner_name'), ''),
  payee_promptpay_id = COALESCE((SELECT value FROM settings WHERE family_id = bills.family_id AND key = 'promptpay_id'), ''),
  payee_promptpay_type = CASE
    WHEN (SELECT value FROM settings WHERE family_id = bills.family_id AND key = 'promptpay_type') = 'citizen-id' THEN 'citizen-id'
    ELSE 'phone'
  END,
  payee_promptpay_name = COALESCE((SELECT value FROM settings WHERE family_id = bills.family_id AND key = 'promptpay_name'), ''),
  payee_bank_name = COALESCE((SELECT value FROM settings WHERE family_id = bills.family_id AND key = 'bank_name'), ''),
  payee_bank_account_number = COALESCE((SELECT value FROM settings WHERE family_id = bills.family_id AND key = 'bank_account_number'), ''),
  payee_bank_account_name = COALESCE((SELECT value FROM settings WHERE family_id = bills.family_id AND key = 'bank_account_name'), '');
