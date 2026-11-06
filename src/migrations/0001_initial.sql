PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone_number TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'success',
  reference_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_ref ON transactions(reference_id);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_hours INTEGER NOT NULL CHECK (duration_hours >= 1 AND duration_hours <= 8760),
  price INTEGER NOT NULL CHECK (price > 0 AND price <= 2000000000)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_hash ON auth_sessions(token_hash, revoked_at);

CREATE TABLE IF NOT EXISTS access_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mac_address TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  duration_hours INTEGER NOT NULL CHECK (duration_hours >= 1 AND duration_hours <= 8760),
  expires_at DATETIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','revoked')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_access_token ON access_sessions(token, status);
CREATE INDEX IF NOT EXISTS idx_access_mac ON access_sessions(mac_address, status);

CREATE TABLE IF NOT EXISTS payment_orders (
  merchant_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  duration_hours INTEGER NOT NULL,
  phone_number TEXT NOT NULL,
  mac_address TEXT,
  expected_amount INTEGER NOT NULL CHECK (expected_amount > 0),
  currency TEXT NOT NULL DEFAULT 'TZS',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed','expired')),
  provider_state TEXT NOT NULL DEFAULT 'unconfigured',
  provider_reference TEXT,
  idempotency_key TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON payment_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON payment_orders(status);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_outbox (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  event_type TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_outbox(event_id);

CREATE TABLE IF NOT EXISTS gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
