CREATE TABLE IF NOT EXISTS line_pending (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  last_message TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
