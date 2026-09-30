-- Agent sign-up: POST /agent/start makes a guest account with a working key; the claim link attaches it to a person later.
CREATE TABLE IF NOT EXISTS claims (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  guest_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claimed_by TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS claims_ws ON claims (workspace_id);
