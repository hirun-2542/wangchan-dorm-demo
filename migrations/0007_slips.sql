CREATE TABLE IF NOT EXISTS slips (
  id TEXT PRIMARY KEY,
  bill_id TEXT,
  line_user_id TEXT NOT NULL,
  image_key TEXT NOT NULL,
  verify_result TEXT,
  amount INTEGER,
  trans_ref TEXT,
  bill_total INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending_review','matched','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_slips_status ON slips(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_slips_matched_trans_ref ON slips(trans_ref) WHERE status = 'matched';
