-- Hosted-only (hosted-model subscriptions); billing is off in this repo and the table stays empty.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,                 -- Stripe subscription id
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,                -- active | past_due | canceled | ...
  period_end INTEGER,                  -- ms epoch
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_project ON subscriptions (project_id, status);
CREATE INDEX IF NOT EXISTS subscriptions_ws ON subscriptions (workspace_id);
