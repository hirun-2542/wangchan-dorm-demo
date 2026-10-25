-- ค่าใช้จ่ายประจำของหอ (dorm-wide recurring charges) + การปิดรายห้อง
--
-- เดิมค่าใช้จ่ายเป็นคุณสมบัติของห้องล้วน ๆ (room_charges) ทำให้ค่าบริการของหอ
-- ถูกเก็บซ้ำหนึ่งแถวต่อหนึ่งห้อง และไม่มีที่เก็บ "ค่าของหอ" จริง ๆ
-- migration นี้ยกของที่ซ้ำกันขึ้นมาเป็นระดับหอ แล้วปิดเป็นรายห้องได้
--
-- ประวัติยังปลอดภัย: บิลอ่านค่าใช้จ่ายจาก bill_charges (snapshot) เท่านั้น
-- ไม่มีเส้นทางอ่านใดของบิลที่แตะตารางในไฟล์นี้

CREATE TABLE IF NOT EXISTS dorm_charges (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

-- ค่าเริ่มต้นคือ "ถึงทุกห้อง" จึงเก็บรายการที่ "ปิด" ไม่ใช่ที่ "เปิด"
CREATE TABLE IF NOT EXISTS room_charge_excludes (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  dorm_charge_id TEXT NOT NULL REFERENCES dorm_charges(id),
  PRIMARY KEY (room_id, dorm_charge_id)
);

CREATE INDEX IF NOT EXISTS idx_dorm_charges_position ON dorm_charges(position);

-- ยุบ room_charges ที่ซ้ำกันทุกห้องขึ้นเป็นค่าใช้จ่ายระดับหอ
-- จัดกลุ่มด้วย (name, amount) ไม่ใช่ position เพื่อไม่ให้รายการเดียวกัน
-- ที่อยู่คนละลำดับในต่างห้องกลายเป็นสองรายการ
INSERT INTO dorm_charges (id, name, amount, position)
SELECT lower(hex(randomblob(16))), name, amount, MIN(position)
FROM room_charges
GROUP BY name, amount
ORDER BY MIN(position);

-- หลังยุบแล้วทุกแถวเดิมมีตัวแทนอยู่ที่ระดับหอ จึงล้างของเดิมทิ้ง
-- (ข้อมูลจริง: 15 ห้องถือชุดเดียวกัน 45 แถว = 3 รายการ)
DELETE FROM room_charges;
