-- Hosted-only (the hosted service's operator admin); unused in this repo.
CREATE TABLE IF NOT EXISTS admin_passkeys (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL UNIQUE,   -- base64url
  public_key BLOB NOT NULL,             -- COSE key bytes, as the authenticator sent them
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  label TEXT,
  email TEXT
);
CREATE TABLE IF NOT EXISTS admin_challenges (
  challenge TEXT PRIMARY KEY,           -- base64url, 32 random bytes
  kind TEXT NOT NULL,                   -- 'register' | 'login'
  enroll_hash TEXT,                     -- for 'register': which enroll link asked for it
  expires_at INTEGER NOT NULL           -- 5 minutes
);
CREATE TABLE IF NOT EXISTS admin_enroll_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,          -- 15 minutes
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash TEXT PRIMARY KEY,             -- sha256 of the scrobe_session cookie
  passkey_id TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL           -- 12 hours
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
-- a blocked account's /v1 requests and spending routes get 403
ALTER TABLE workspaces ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
