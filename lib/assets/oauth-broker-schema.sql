PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  verifier_enc TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('waiting','exchanging','completed','error')),
  error TEXT,
  callback_origin TEXT NOT NULL,
  result_enc TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state_hash);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  google_refresh_token_enc TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_expires ON credentials(expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
