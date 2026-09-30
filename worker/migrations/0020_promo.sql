-- Hosted-only (promo codes); unused in this repo.
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  usd REAL NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  unlock INTEGER NOT NULL DEFAULT 1,     -- 1: counts as a card on file (full free credit spendable)
  expires_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS promo_redemptions (
  code TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  PRIMARY KEY (code, workspace_id)
);
