CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  check_in_date TEXT NOT NULL,
  check_out_date TEXT,
  line_user_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','moved-out')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenants_room_status ON tenants(room_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_one_current_per_room ON tenants(room_id) WHERE status = 'current';
