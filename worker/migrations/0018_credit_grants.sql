-- Hosted-only (credits); billing is off in this repo and the table stays empty.
CREATE TABLE IF NOT EXISTS credit_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  usd REAL NOT NULL,
  kind TEXT NOT NULL,            -- 'stripe' | 'gift'
  stripe_session TEXT UNIQUE,
  t INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS credit_grants_ws ON credit_grants (workspace_id);
