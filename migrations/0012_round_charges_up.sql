-- ปัดค่าน้ำ/ค่าไฟ "ขึ้นเสมอ" สำหรับบิลที่ยังไม่จ่าย
--
-- เดิมสูตรคิดเงินปัดครึ่ง (`Math.round`) ทั้งฝั่ง worker และหน้าเว็บ เศษสตางค์
-- จากอัตราที่มีทศนิยม (เช่น น้ำ 18.5 บาท/หน่วย × 3 หน่วย = 55.5) จึงถูกปัดลง
-- ครึ่งหนึ่งของเวลา หอเก็บเงินเป็นบาทถ้วนและไม่รับภาระเศษที่เกิดจากอัตราของ
-- ตัวเอง กฎจึงเปลี่ยนเป็นปัดขึ้นเสมอ (ดู src/shared/billing.ts)
--
-- ขอบเขต: เฉพาะบิลที่ยังไม่จ่าย (`status = 'unpaid'`)
--   - บิลที่จ่ายแล้วเป็นการตกลงราคาที่เกิดขึ้นจริงกับผู้เช่าไปแล้ว (มีสลิป/การ
--     ยืนยัน) การคำนวณใหม่จะทำให้ยอดที่เก็บจริงไม่ตรงกับยอดในฐานข้อมูล
--   - บิลที่ยังไม่จ่ายยังไม่ถูกอ้างถึงด้วยการชำระ จึงปรับให้ตรงกฎปัจจุบันได้
--     และทำให้บิลทุกใบที่ยังใช้อยู่คิดด้วยสูตรเดียวกัน
--
-- คำนวณจากคอลัมน์ snapshot ของบิลเอง (units × rate ที่บันทึกไว้) ไม่ใช่ค่า
-- ตั้งค่าปัจจุบันของห้อง — บิลต้องไม่เปลี่ยนตามการแก้ตั้งค่าภายหลัง
--
-- SQLite ที่ D1 ใช้ **ไม่มี `ceiling()`** (ถูกปิด: "not authorized to use
-- function: ceiling") จึงปัดขึ้นด้วยวิธีจำนวนเต็ม: CAST ตัดทศนิยมทิ้ง แล้วบวก 1
-- เมื่อค่าจริงมากกว่าค่าที่ตัดแล้ว (พิสูจน์กับ D1 จริงแล้วว่าตรงกับ Math.ceil:
-- 55.5→56, 36.5→37, 72→72, 0→0, 7.5→8, 3.5→4)

UPDATE bills
SET
  water_amount = CAST(water_units * water_rate AS INTEGER)
    + ((water_units * water_rate) > CAST(water_units * water_rate AS INTEGER)),
  electric_amount = CASE
    -- เหมาจ่ายเป็นยอดที่ผู้ใช้กรอกไว้แล้ว ไม่มี units/rate ให้คำนวณ
    WHEN electric_mode = 'flat' THEN electric_amount
    ELSE CAST(COALESCE(electric_units, 0) * COALESCE(electric_rate, 0) AS INTEGER)
      + (
        (COALESCE(electric_units, 0) * COALESCE(electric_rate, 0))
        > CAST(COALESCE(electric_units, 0) * COALESCE(electric_rate, 0) AS INTEGER)
      )
  END
WHERE status = 'unpaid';

-- `total` ต้องคิดใหม่จากส่วนประกอบทั้งหมดเหมือนสูตรใน worker
-- (rent + water + electric + ค่าใช้จ่ายเพิ่มจาก bill_charges)
UPDATE bills
SET total = rent
  + water_amount
  + electric_amount
  + COALESCE((SELECT SUM(bc.amount) FROM bill_charges bc WHERE bc.bill_id = bills.id), 0)
WHERE status = 'unpaid';
