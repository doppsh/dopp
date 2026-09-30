-- "Connect an agent": a link that works once, for 15 minutes; redeeming it with curl mints a key straight into the agent's .env.
CREATE TABLE IF NOT EXISTS setup_links (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
