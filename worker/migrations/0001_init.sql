CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS magic_links (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, jev_mode TEXT NOT NULL DEFAULT 'understudy', ts_key_enc TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS proxy_keys (id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, workspace_id TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_ws_user ON workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_keys_ws ON proxy_keys(workspace_id);
