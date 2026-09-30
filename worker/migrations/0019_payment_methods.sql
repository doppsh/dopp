-- Hosted-only (cards on file); billing is off in this repo and the table stays empty.
CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  brand TEXT,
  last4 TEXT,
  stripe_pm TEXT,
  t INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_methods_ws ON payment_methods (workspace_id);
