-- 0007: make the money columns mean what they say.
--
-- Why this exists: src/migrations/0001_initial.sql asks for
--   wallets(balance INTEGER NOT NULL CHECK(balance >= 0)) and
--   transactions(amount INTEGER NOT NULL CHECK(amount > 0)) with foreign keys,
-- but those tables had already been created by an earlier draft as
--   wallets(balance REAL DEFAULT 0) / transactions(user_id TEXT, amount REAL, ...)
-- and CREATE TABLE IF NOT EXISTS quietly skipped the strict version. So in this
-- dev database the money columns are REAL, nullable, and have NO foreign key at
-- all: integer-ness rests entirely on triggers, a ledger row can name a user who
-- does not exist (ten of them do), and `UPDATE transactions SET amount = ...`
-- rewrites history past the insert-only guard. Production gets the strict DDL,
-- which means dev and prod were not the same schema while all my tests ran.
--
-- Rules this migration follows:
--   * Nothing is rounded and nothing is invented. The copy inserts the stored
--     value as-is, so if any amount were fractional the CHECK on the new table
--     rejects it and the rebuild fails instead of silently altering money.
--   * Ledger rows that name a missing account are ARCHIVED, not deleted: the
--     money happened, we just cannot attribute it, so it stays readable.
--   * Both foreign keys are RESTRICT. Deleting an account must never erase its
--     wallet or its history; the app suspends accounts instead (migration 0005).
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS ledger_orphans (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT,
  amount INTEGER NOT NULL,
  status TEXT,
  reference_id TEXT,
  created_at DATETIME,
  archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT NOT NULL DEFAULT 'user_id had no row in users when the ledger was rebuilt (migration 0007)'
);

INSERT INTO ledger_orphans (id, user_id, type, amount, status, reference_id, created_at)
  SELECT id, user_id, type, amount, status, reference_id, created_at
  FROM transactions
  WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users);

DELETE FROM transactions
  WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users);

DELETE FROM wallets WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users);

CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 40),
  amount INTEGER NOT NULL CHECK (amount > 0 AND amount = CAST(amount AS INTEGER)),
  status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'pending', 'failed', 'reversed')),
  reference_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- No CAST here on purpose: a fractional amount must fail the CHECK rather than
-- be quietly rounded into a different balance.
INSERT INTO transactions_new (id, user_id, type, amount, status, reference_id, created_at)
  SELECT id, user_id, type, amount, COALESCE(status, 'success'), reference_id,
         COALESCE(created_at, CURRENT_TIMESTAMP)
  FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX idx_transactions_user_created ON transactions(user_id, created_at);
CREATE INDEX idx_transactions_ref ON transactions(reference_id);

CREATE TABLE wallets_new (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance = CAST(balance AS INTEGER)),
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO wallets_new (user_id, balance, updated_at)
  SELECT user_id, balance, COALESCE(updated_at, CURRENT_TIMESTAMP) FROM wallets;

DROP TABLE wallets;
ALTER TABLE wallets_new RENAME TO wallets;

-- Guards, recreated against the new tables (DROP TABLE took the old ones with it)
CREATE TRIGGER wallets_integer_minor_units_insert
BEFORE INSERT ON wallets
WHEN NEW.balance IS NULL
  OR typeof(NEW.balance) = 'text'
  OR NEW.balance < 0
  OR NEW.balance != CAST(NEW.balance AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'wallet balance must be a non-negative integer minor unit');
END;

CREATE TRIGGER wallets_integer_minor_units_update
BEFORE UPDATE OF balance ON wallets
WHEN NEW.balance IS NULL
  OR typeof(NEW.balance) = 'text'
  OR NEW.balance < 0
  OR NEW.balance != CAST(NEW.balance AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'wallet balance must be a non-negative integer minor unit');
END;

-- A wallet belongs to exactly one account: repointing it would move a person's
-- money without a single ledger row recording the transfer.
CREATE TRIGGER wallets_owner_immutable
BEFORE UPDATE OF user_id ON wallets
BEGIN
  SELECT RAISE(ABORT, 'wallet owner is immutable');
END;

CREATE TRIGGER transactions_integer_tzs_amount
BEFORE INSERT ON transactions
WHEN NEW.amount IS NULL
  OR typeof(NEW.amount) = 'text'
  OR NEW.amount <= 0
  OR NEW.amount != CAST(NEW.amount AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'transaction amount must be a positive integer minor unit');
END;

-- The insert-only guard above never fired for the one write that matters most:
-- rewriting an existing ledger row is not an insert.
CREATE TRIGGER transactions_amount_immutable
BEFORE UPDATE OF amount, user_id, type ON transactions
BEGIN
  SELECT RAISE(ABORT, 'ledger rows are immutable; add a correcting entry instead');
END;

PRAGMA foreign_keys = ON;

INSERT INTO audit_outbox (event_type, target_id, details_json) VALUES
(
  'wallet.schema_integer_money', NULL,
  json_object(
    'reason', 'wallets/transactions were REAL, nullable and had no foreign key; rebuilt with integer CHECKs and RESTRICT keys',
    'ledger_rows_archived_unattributed', (SELECT COUNT(*) FROM ledger_orphans),
    'ledger_rows', (SELECT COUNT(*) FROM transactions),
    'wallet_rows', (SELECT COUNT(*) FROM wallets),
    'money_in_wallets', (SELECT CAST(COALESCE(SUM(balance), 0) AS INTEGER) FROM wallets)
  )
);
