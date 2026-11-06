-- Additive account-authentication and hotspot-session schema.
-- Existing users are preserved; password_hash remains NULL until the user sets credentials.
CREATE TABLE IF NOT EXISTS gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_hours INTEGER NOT NULL,
  price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone_number TEXT UNIQUE,
  full_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY,
  balance REAL NOT NULL DEFAULT 0 CHECK(balance >= 0),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  reference_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mac_address TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  duration_hours INTEGER NOT NULL CHECK(duration_hours > 0),
  expires_at DATETIME NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'expired')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, idempotency_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expiry ON auth_sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_access_sessions_user_created ON access_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_access_sessions_mac_status ON access_sessions(mac_address, status);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at);

CREATE TRIGGER IF NOT EXISTS wallets_integer_minor_units_insert
BEFORE INSERT ON wallets
WHEN typeof(NEW.balance) NOT IN ('integer', 'real') OR NEW.balance < 0 OR NEW.balance != CAST(NEW.balance AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'wallet balance must be non-negative integer TZS');
END;

CREATE TRIGGER IF NOT EXISTS wallets_integer_minor_units_update
BEFORE UPDATE OF balance ON wallets
WHEN typeof(NEW.balance) NOT IN ('integer', 'real') OR NEW.balance < 0 OR NEW.balance != CAST(NEW.balance AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'wallet balance must be non-negative integer TZS');
END;

CREATE TRIGGER IF NOT EXISTS transactions_integer_tzs_amount
BEFORE INSERT ON transactions
WHEN NEW.amount <= 0 OR NEW.amount != CAST(NEW.amount AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'transaction amount must be positive integer TZS');
END;

CREATE TRIGGER IF NOT EXISTS packages_integer_tzs_price_insert
BEFORE INSERT ON packages
WHEN NEW.price <= 0 OR NEW.price != CAST(NEW.price AS INTEGER) OR NEW.duration_hours <= 0 OR NEW.duration_hours != CAST(NEW.duration_hours AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'package price and duration must be positive integers');
END;

CREATE TRIGGER IF NOT EXISTS packages_integer_tzs_price_update
BEFORE UPDATE OF price, duration_hours ON packages
WHEN NEW.price <= 0 OR NEW.price != CAST(NEW.price AS INTEGER) OR NEW.duration_hours <= 0 OR NEW.duration_hours != CAST(NEW.duration_hours AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'package price and duration must be positive integers');
END;
