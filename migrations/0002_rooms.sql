CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  room_number TEXT NOT NULL UNIQUE,
  rent INTEGER NOT NULL,
  water_rate REAL,
  electric_mode TEXT NOT NULL DEFAULT 'meter' CHECK (electric_mode IN ('meter','flat')),
  electric_rate REAL,
  water_meter_init REAL NOT NULL DEFAULT 0,
  electric_meter_init REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'vacant' CHECK (status IN ('vacant','occupied')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
