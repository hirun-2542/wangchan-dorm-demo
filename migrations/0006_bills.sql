CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  period TEXT NOT NULL,
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
  UNIQUE (room_id, period)
);
CREATE TABLE IF NOT EXISTS bill_charges (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id),
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bills_period ON bills(period);
