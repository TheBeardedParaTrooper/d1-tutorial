-- 0005_admin_console.sql
-- Staff console: operator accounts, their sessions, and the flags the console
-- needs to drive the portal (tier availability, account suspension).
-- Additive only: nothing here drops or rewrites existing tables or rows.

-- 1. Flags the console writes and the portal reads.
-- SQLite refuses CURRENT_TIMESTAMP as an ALTER TABLE default, so these are
-- nullable and backfilled below instead.
ALTER TABLE packages ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE packages ADD COLUMN created_at DATETIME;
ALTER TABLE packages ADD COLUMN updated_at DATETIME;
UPDATE packages SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
                   updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP);

-- Suspended accounts keep their wallet and history but can no longer sign in.
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN suspended_at DATETIME;

-- The audit outbox so far only knows about customers. Staff events carry the
-- acting admin here while actor_user_id keeps meaning "the customer affected".
ALTER TABLE audit_outbox ADD COLUMN actor_admin_id TEXT;

CREATE INDEX IF NOT EXISTS idx_packages_active
  ON packages(active, price ASC);
CREATE INDEX IF NOT EXISTS idx_audit_outbox_admin
  ON audit_outbox(actor_admin_id, event_id);

-- 2. Operator accounts.
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (length(username) BETWEEN 1 AND 30),
  email TEXT UNIQUE CHECK (email IS NULL OR length(email) BETWEEN 3 AND 120),
  full_name TEXT CHECK (full_name IS NULL OR length(full_name) <= 80),
  password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 20 AND 400),
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('super_admin', 'operator', 'viewer')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Seeded credentials must be rotated before the console is trusted.
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(lower(username));

-- Staff can be disabled but never erased: sessions and audit rows point here.
CREATE TRIGGER IF NOT EXISTS admin_users_no_delete
BEFORE DELETE ON admin_users
BEGIN
  SELECT RAISE(ABORT, 'admin accounts are disabled with active = 0, never deleted');
END;

CREATE TRIGGER IF NOT EXISTS admin_users_username_case_unique
BEFORE UPDATE OF username ON admin_users
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM admin_users a WHERE lower(a.username) = lower(NEW.username) AND a.id != OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'admin username already taken');
END;

-- 3. Console sessions: only the HMAC of the cookie is stored, and revocation is
-- a timestamp rather than a delete so the sign-in trail survives.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME,
  FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_created
  ON admin_sessions(admin_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS admin_sessions_no_delete
BEFORE DELETE ON admin_sessions
BEGIN
  SELECT RAISE(ABORT, 'admin sessions are revoked, never deleted');
END;

CREATE TRIGGER IF NOT EXISTS admin_sessions_token_immutable
BEFORE UPDATE OF token_hash, admin_id ON admin_sessions
BEGIN
  SELECT RAISE(ABORT, 'admin session identity is immutable');
END;

-- 4. Replay protection for console writes. The customer table has a foreign key
-- to users(id), so staff keys need their own table.
CREATE TABLE IF NOT EXISTS admin_idempotency_keys (
  admin_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (admin_id, idempotency_key),
  FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE RESTRICT
);

-- 5. Bootstrap operator. Password is "admin" under the same PBKDF2-SHA256
-- (100k iterations) scheme as customer accounts, and the console insists it is
-- rotated from Admin settings before anything else is trusted.
INSERT OR IGNORE INTO admin_users
  (id, username, email, full_name, password_hash, role, active, must_change_password)
VALUES (
  'admin-root-00000000-0000-4000-8000-000000000001',
  'admin',
  NULL,
  'Flat Coin operator',
  'pbkdf2-sha256$100000$LNcpGXtNEFxf60oTbP4OAQ$NmDFuHJhj6v-0QQoIQINCz1VMPPE4TZaYqKS5z70l_4',
  'super_admin',
  1,
  1
);

INSERT OR IGNORE INTO audit_outbox (actor_admin_id, event_type, target_id, details_json)
VALUES (
  'admin-root-00000000-0000-4000-8000-000000000001',
  'admin.bootstrap',
  'admin-root-00000000-0000-4000-8000-000000000001',
  '{"username":"admin","role":"super_admin","seeded_by_migration":true,"password_is_default":true}'
);
