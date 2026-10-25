-- บัญชีผู้ใช้รายคน + ครอบครัว (family) เป็นขอบเขตของข้อมูลทั้งหมด
--
-- เดิมทั้งแอปไม่มีการยืนยันตัวตนเลย ทุก endpoint เปิดสาธารณะ
-- migration นี้เพิ่ม users/families/sessions แล้วผูกข้อมูลเดิมทุกตาราง
-- เข้ากับ "ครอบครัวเดิม" หนึ่งชุด เพื่อไม่ให้ข้อมูลที่มีอยู่กำพร้า
--
-- ข้อมูลเดิมจะไม่ถูกผู้สมัครรายแรกยึดไปเอง: ครอบครัวเดิมยังไม่มีสมาชิก
-- จนกว่าจะ claim ผ่าน /api/auth/bootstrap ด้วย BOOTSTRAP_SECRET
--
-- การแยกครอบครัวถูกบังคับที่ฐานข้อมูล ไม่ใช่แค่ที่ WHERE ของโค้ด:
-- ทุกตารางแม่มี UNIQUE (family_id, id) และตารางลูกอ้างด้วย
-- FOREIGN KEY (family_id, parent_id) จึงผูกข้ามครอบครัวไม่ได้เลย
-- แม้โค้ดจะลืมใส่เงื่อนไข family_id สักจุดหนึ่ง
--
-- ประวัติเงินยังปลอดภัย: ไม่มีคอลัมน์จำนวนเงินใดถูกคำนวณใหม่
-- คัดลอกค่าเดิมตรง ๆ ทุกแถว
--
-- ลำดับงานตั้งใจเปลี่ยนชื่อตารางเดิมทั้งชุดออกไปก่อน แล้วค่อยลบไล่จาก
-- ลูกขึ้นไปหาแม่ เพราะถ้า DROP ตารางแม่ทั้งที่ยังมีลูกอ้างอยู่
-- SQLite จะค้างตัวนับ deferred foreign key ไว้จน COMMIT ไม่ผ่าน

-- ── ตัวตนและครอบครัว ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS family_members (
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (family_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_family_members_user ON family_members(user_id);

-- หนึ่งบัญชีอยู่ได้ครอบครัวเดียว ทำให้การล็อกอินไม่ต้องเดาว่าจะเข้าครอบครัวไหน
-- และไม่มีสมาชิกภาพที่เข้าถึงไม่ได้ซ่อนอยู่
CREATE UNIQUE INDEX IF NOT EXISTS idx_family_members_single_family ON family_members(user_id);

-- เซสชันเก็บเฉพาะ hash ของ token อ่านฐานข้อมูลแล้วสวมสิทธิ์ไม่ได้
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- คำเชิญเก็บเฉพาะ hash ของ token เช่นกัน
CREATE TABLE IF NOT EXISTS family_invites (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_family_invites_family ON family_invites(family_id);
CREATE INDEX IF NOT EXISTS idx_family_invites_email ON family_invites(email);

-- ใช้จำกัดอัตราการล็อกอิน เก็บเฉพาะช่วงเวลาสั้น ๆ แล้วลบทิ้ง
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_scope ON login_attempts(scope, attempted_at);

-- กัน webhook ที่ LINE ส่งซ้ำไม่ให้ประมวลผลสองรอบ
CREATE TABLE IF NOT EXISTS line_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_line_events_received ON line_events(received_at);

-- ── ครอบครัวเดิมสำหรับข้อมูลที่มีอยู่ ────────────────────────────────

INSERT OR IGNORE INTO families (id, name)
SELECT
  '00000000-0000-4000-8000-000000000001',
  COALESCE((SELECT value FROM settings WHERE key = 'dorm_name'), 'หอพักของฉัน');

-- LINE channel หนึ่งช่องผูกกับครอบครัวเดียว เพราะ secret/token เป็นค่าระดับ Worker
INSERT OR IGNORE INTO meta (key, value)
VALUES ('line_family_id', '00000000-0000-4000-8000-000000000001');

-- ── ย้ายตารางเดิมออกไปก่อนทั้งชุด ───────────────────────────────────

ALTER TABLE room_charge_excludes RENAME TO room_charge_excludes_old;
ALTER TABLE room_charges RENAME TO room_charges_old;
ALTER TABLE bill_charges RENAME TO bill_charges_old;
ALTER TABLE slips RENAME TO slips_old;
ALTER TABLE bills RENAME TO bills_old;
ALTER TABLE tenants RENAME TO tenants_old;
ALTER TABLE dorm_charges RENAME TO dorm_charges_old;
ALTER TABLE rooms RENAME TO rooms_old;
ALTER TABLE settings RENAME TO settings_old;
ALTER TABLE line_pending RENAME TO line_pending_old;

-- ── ตารางใหม่ที่ผูกขอบเขตครอบครัวไว้ในโครงสร้าง ─────────────────────

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  room_number TEXT NOT NULL,
  rent INTEGER NOT NULL,
  water_rate REAL,
  electric_mode TEXT NOT NULL DEFAULT 'meter' CHECK (electric_mode IN ('meter','flat')),
  electric_rate REAL,
  water_meter_init REAL NOT NULL DEFAULT 0,
  electric_meter_init REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'vacant' CHECK (status IN ('vacant','occupied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (family_id, room_number),
  UNIQUE (family_id, id)
);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  room_id TEXT NOT NULL,
  check_in_date TEXT NOT NULL,
  check_out_date TEXT,
  line_user_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','moved-out')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (family_id, id),
  FOREIGN KEY (family_id, room_id) REFERENCES rooms(family_id, id)
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  room_number TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  rent INTEGER NOT NULL,
  water_previous REAL NOT NULL,
  water_current REAL NOT NULL,
  water_units REAL NOT NULL,
  water_rate REAL NOT NULL,
  water_amount INTEGER NOT NULL,
  electric_mode TEXT NOT NULL CHECK (electric_mode IN ('meter','flat')),
  electric_previous REAL NOT NULL,
  electric_current REAL NOT NULL,
  electric_units REAL,
  electric_rate REAL,
  electric_amount INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid')),
  paid_at TEXT,
  paid_method TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (room_id, period),
  UNIQUE (family_id, id),
  FOREIGN KEY (family_id, room_id) REFERENCES rooms(family_id, id),
  FOREIGN KEY (family_id, tenant_id) REFERENCES tenants(family_id, id)
);

CREATE TABLE bill_charges (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  bill_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (family_id, bill_id) REFERENCES bills(family_id, id)
);

CREATE TABLE slips (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  bill_id TEXT,
  line_user_id TEXT NOT NULL,
  image_key TEXT NOT NULL,
  verify_result TEXT,
  amount INTEGER,
  trans_ref TEXT,
  bill_total INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending_review','matched','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (family_id, bill_id) REFERENCES bills(family_id, id)
);

CREATE TABLE dorm_charges (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (family_id, id)
);

CREATE TABLE room_charges (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (family_id, room_id) REFERENCES rooms(family_id, id)
);

CREATE TABLE room_charge_excludes (
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  dorm_charge_id TEXT NOT NULL,
  PRIMARY KEY (room_id, dorm_charge_id),
  FOREIGN KEY (family_id, room_id) REFERENCES rooms(family_id, id),
  FOREIGN KEY (family_id, dorm_charge_id) REFERENCES dorm_charges(family_id, id)
);

CREATE TABLE settings (
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (family_id, key)
);

CREATE TABLE line_pending (
  line_user_id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  display_name TEXT,
  last_message TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── คัดลอกข้อมูลเดิมเข้าครอบครัวเดิม ────────────────────────────────

INSERT INTO rooms (id, family_id, room_number, rent, water_rate, electric_mode, electric_rate, water_meter_init, electric_meter_init, status, created_at)
SELECT id, '00000000-0000-4000-8000-000000000001', room_number, rent, water_rate, electric_mode, electric_rate, water_meter_init, electric_meter_init, status, created_at
FROM rooms_old;

INSERT INTO tenants (id, family_id, full_name, phone, room_id, check_in_date, check_out_date, line_user_id, status, created_at)
SELECT id, '00000000-0000-4000-8000-000000000001', full_name, phone, room_id, check_in_date, check_out_date, line_user_id, status, created_at
FROM tenants_old;

INSERT INTO dorm_charges (id, family_id, name, amount, position)
SELECT id, '00000000-0000-4000-8000-000000000001', name, amount, position
FROM dorm_charges_old;

-- เลขห้องและชื่อผู้เช่าถูก snapshot ลงบิล ณ ตอนนี้ เพื่อให้เลขที่ใบแจ้งหนี้
-- ของบิลที่ออกไปแล้วไม่เปลี่ยนตามการแก้ชื่อห้องหรือชื่อผู้เช่าภายหลัง
INSERT INTO bills (id, family_id, room_id, tenant_id, period, room_number, tenant_name, rent, water_previous, water_current, water_units, water_rate, water_amount, electric_mode, electric_previous, electric_current, electric_units, electric_rate, electric_amount, total, status, paid_at, paid_method, sent_at, created_at)
SELECT b.id, '00000000-0000-4000-8000-000000000001', b.room_id, b.tenant_id, b.period, r.room_number, t.full_name, b.rent, b.water_previous, b.water_current, b.water_units, b.water_rate, b.water_amount, b.electric_mode, b.electric_previous, b.electric_current, b.electric_units, b.electric_rate, b.electric_amount, b.total, b.status, b.paid_at, b.paid_method, b.sent_at, b.created_at
FROM bills_old b
JOIN rooms_old r ON r.id = b.room_id
JOIN tenants_old t ON t.id = b.tenant_id;

INSERT INTO bill_charges (id, family_id, bill_id, name, amount, position)
SELECT id, '00000000-0000-4000-8000-000000000001', bill_id, name, amount, position
FROM bill_charges_old;

INSERT INTO slips (id, family_id, bill_id, line_user_id, image_key, verify_result, amount, trans_ref, bill_total, status, created_at)
SELECT id, '00000000-0000-4000-8000-000000000001', bill_id, line_user_id, image_key, verify_result, amount, trans_ref, bill_total, status, created_at
FROM slips_old;

INSERT INTO room_charges (id, family_id, room_id, name, amount, position)
SELECT id, '00000000-0000-4000-8000-000000000001', room_id, name, amount, position
FROM room_charges_old;

INSERT INTO room_charge_excludes (family_id, room_id, dorm_charge_id)
SELECT '00000000-0000-4000-8000-000000000001', room_id, dorm_charge_id
FROM room_charge_excludes_old;

INSERT INTO settings (family_id, key, value, updated_at)
SELECT '00000000-0000-4000-8000-000000000001', key, value, updated_at
FROM settings_old;

INSERT INTO line_pending (line_user_id, family_id, display_name, last_message, last_seen_at)
SELECT line_user_id, '00000000-0000-4000-8000-000000000001', display_name, last_message, last_seen_at
FROM line_pending_old;

-- ── ลบของเดิมไล่จากลูกขึ้นไปหาแม่ ───────────────────────────────────

DROP TABLE room_charge_excludes_old;
DROP TABLE room_charges_old;
DROP TABLE bill_charges_old;
DROP TABLE slips_old;
DROP TABLE bills_old;
DROP TABLE tenants_old;
DROP TABLE dorm_charges_old;
DROP TABLE rooms_old;
DROP TABLE settings_old;
DROP TABLE line_pending_old;

-- ── ดัชนี ───────────────────────────────────────────────────────────
-- รวมดัชนีที่เดิมขาดไปและทำให้ทุกหน้าสแกนทั้งตาราง

CREATE INDEX idx_rooms_family ON rooms(family_id);
CREATE INDEX idx_rooms_family_status ON rooms(family_id, status);

CREATE INDEX idx_tenants_room_status ON tenants(room_id, status);
CREATE UNIQUE INDEX idx_tenants_one_current_per_room ON tenants(room_id) WHERE status = 'current';
CREATE INDEX idx_tenants_family ON tenants(family_id);

CREATE INDEX idx_bills_period ON bills(period);
CREATE INDEX idx_bills_family_period ON bills(family_id, period);
CREATE INDEX idx_bills_tenant ON bills(tenant_id);
CREATE INDEX idx_bills_room ON bills(room_id);
CREATE INDEX idx_bills_family_status ON bills(family_id, status);

CREATE INDEX idx_bill_charges_bill ON bill_charges(bill_id);

CREATE INDEX idx_slips_status ON slips(status);
CREATE UNIQUE INDEX idx_slips_matched_trans_ref ON slips(trans_ref) WHERE status = 'matched';
CREATE INDEX idx_slips_family_status ON slips(family_id, status);
CREATE INDEX idx_slips_bill ON slips(bill_id);

CREATE INDEX idx_dorm_charges_position ON dorm_charges(position);
CREATE INDEX idx_dorm_charges_family ON dorm_charges(family_id, position);

CREATE INDEX idx_room_charges_room ON room_charges(room_id);

CREATE INDEX idx_line_pending_family_seen ON line_pending(family_id, last_seen_at);
