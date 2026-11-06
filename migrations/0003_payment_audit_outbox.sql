-- Additive D1 schema for pending payment orders and immutable audit export.
-- Apply after the existing users, packages, and idempotency_keys tables exist.

CREATE TABLE IF NOT EXISTS payment_orders (
  merchant_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  duration_hours INTEGER NOT NULL CHECK (duration_hours BETWEEN 1 AND 8760),
  phone_number TEXT NOT NULL CHECK (length(phone_number) BETWEEN 3 AND 16 AND substr(phone_number, 1, 1) = '+'),
  mac_address TEXT,
  expected_amount INTEGER NOT NULL CHECK (expected_amount > 0 AND expected_amount = CAST(expected_amount AS INTEGER)),
  currency TEXT NOT NULL CHECK (currency = 'TZS'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  provider_reference TEXT,
  provider_state TEXT NOT NULL DEFAULT 'unconfigured',
  idempotency_key TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_created
  ON payment_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status_created
  ON payment_orders(status, created_at);

CREATE TRIGGER IF NOT EXISTS payment_orders_status_forward_only
BEFORE UPDATE OF status ON payment_orders
WHEN NEW.status != OLD.status
  AND NOT (OLD.status = 'pending' AND NEW.status IN ('paid', 'failed', 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'invalid payment order status transition');
END;

CREATE TABLE IF NOT EXISTS audit_outbox (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  target_id TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_outbox_actor_event
  ON audit_outbox(actor_user_id, event_id);

-- Consumers pull by event_id and maintain their own cursor. Events are never acknowledged or pruned here.
CREATE TRIGGER IF NOT EXISTS audit_outbox_no_update
BEFORE UPDATE ON audit_outbox
BEGIN
  SELECT RAISE(ABORT, 'audit_outbox is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_outbox_no_delete
BEFORE DELETE ON audit_outbox
BEGIN
  SELECT RAISE(ABORT, 'audit_outbox is append-only');
END;
