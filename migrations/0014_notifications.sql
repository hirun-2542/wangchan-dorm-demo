-- ประวัติแจ้งเตือน (กระดิ่ง) เก็บฝั่งเซิร์ฟเวอร์
--
-- เดิมรายการแจ้งเตือนเกิดจาก WebSocket ตอนมีแท็บเปิดอยู่เท่านั้น เหตุการณ์ที่เกิดตอนปิด
-- เบราว์เซอร์ (ผู้เช่าส่งสลิปตอนกลางคืน, ลงทะเบียนเอง) จึงไม่เคยถึงกระดิ่งเลย ตารางนี้เก็บทุก
-- เหตุการณ์ตอนที่มันเกิด แล้วหน้าเว็บอ่านมาแสดงตอนเปิด
--
-- เพิ่มตารางใหม่ล้วน ๆ ไม่แตะตารางเดิม ย้อนกลับได้ด้วยการ DROP สองตารางนี้ (โค้ดเก่าไม่รู้จัก
-- ตารางนี้จึงทำงานต่อได้เหมือนเดิม) ไม่มีข้อมูลเดิมให้ย้าย: ประวัติเริ่มนับจากการ deploy ครั้งนี้
--
-- ขอบเขตครอบครัวบังคับที่ทุกคำสั่งอ่าน/เขียนด้วย family_id และ FK ไป families(id)
-- ลบครอบครัวแล้วประวัติหายตามไปเอง

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bill-paid', 'tenant-joined')),
  -- กุญแจกันซ้ำของเหตุการณ์เดียวกัน: bill-paid = id บิล (ปิดได้ครั้งเดียว)
  -- tenant-joined = id ผู้เช่า + เวลาเข้า (เช็คเอาท์แล้วเข้าใหม่ถือเป็นเหตุการณ์ใหม่)
  ref TEXT NOT NULL,
  -- JSON ของเหตุการณ์ รูปเดียวกับที่ส่งทาง WebSocket (ไม่รวม v/type)
  payload TEXT NOT NULL,
  -- คนที่กดให้เกิดเหตุการณ์นี้เอง (ปิดบิลมือ/ยืนยันสลิป/เชื่อม LINE) เป็น NULL เมื่อมาจาก
  -- LINE หรือระบบอัตโนมัติ — คนนั้นรู้อยู่แล้ว จึงนับเป็น "อ่านแล้ว" สำหรับเขา
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (family_id, kind, ref)
);

CREATE INDEX IF NOT EXISTS idx_notifications_family ON notifications(family_id, id DESC);

-- สถานะรายผู้ใช้: อ่านถึงลำดับที่เท่าไร / ล้างถึงลำดับที่เท่าไร
-- ใช้ลำดับ (id) ไม่ใช่เวลา เพื่อไม่ต้องพึ่งนาฬิกา และเหตุการณ์ที่เข้ามาหลังกดอ่าน/ล้างยังเป็น
-- "ใหม่" เสมอ — สองคนในครอบครัวล้างของตัวเองได้โดยไม่กระทบอีกคน
CREATE TABLE IF NOT EXISTS notification_state (
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_through INTEGER NOT NULL DEFAULT 0,
  cleared_through INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (family_id, user_id)
);
