-- Setup v2. A model's setup: routes (who answers), oracle (who is right), plans (what trains).
-- Every save is a new version; the newest is the one in force. Nothing here changes the old `routing` table,
-- which the running workers keep reading until the new request path ships.
CREATE TABLE IF NOT EXISTS setups (project_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, t REAL NOT NULL, "by" TEXT, note TEXT,
  PRIMARY KEY (project_id, version));
-- Outside services an account plugs in once (Jev itself stays on the workspace row: jev_mode / ts_key_enc).
-- A model's Jev-shaped endpoints join this list the first time the account's connections are read (same id).
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, url TEXT,
  auth_enc TEXT, model TEXT, prompt TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_connections_ws ON connections(workspace_id);
