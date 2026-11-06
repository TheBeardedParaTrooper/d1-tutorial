-- 0004_marketplace_uploads.sql
-- Real marketplace: seller listings with uploads (product photos + files),
-- wallet-to-wallet settlement, negotiated quotations, and usernames for login.
-- Additive only: nothing here drops or rewrites existing tables.

-- 1. Usernames so users can sign in with @handle instead of the MSISDN.
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN username_updated_at DATETIME;

CREATE UNIQUE INDEX idx_users_username_lower
  ON users(lower(username))
  WHERE username IS NOT NULL;

-- 2. Marketplace listings.
CREATE TABLE IF NOT EXISTS marketplace_items (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'file')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  price INTEGER NOT NULL CHECK (price > 0 AND price = CAST(price AS INTEGER) AND price <= 2000000000),
  currency TEXT NOT NULL DEFAULT 'TZS' CHECK (currency = 'TZS'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'sold', 'cancelled')),
  negotiable INTEGER NOT NULL DEFAULT 1 CHECK (negotiable IN (0, 1)),
  pay_wallet INTEGER NOT NULL DEFAULT 1 CHECK (pay_wallet IN (0, 1)),
  pay_mobile_money INTEGER NOT NULL DEFAULT 0 CHECK (pay_mobile_money IN (0, 1)),
  payment_notes TEXT NOT NULL DEFAULT '' CHECK (length(payment_notes) <= 300),
  item_condition TEXT CHECK (item_condition IS NULL OR item_condition IN ('new', 'used', 'refurbished')),
  location TEXT CHECK (location IS NULL OR length(location) <= 80),
  contact_phone TEXT CHECK (contact_phone IS NULL OR length(contact_phone) <= 20),
  asset_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  sold_at DATETIME,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marketplace_items_status_created
  ON marketplace_items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_seller
  ON marketplace_items(seller_id, created_at DESC);

-- A listing can never be repriced once money has moved against it.
CREATE TRIGGER IF NOT EXISTS marketplace_items_price_frozen
BEFORE UPDATE OF price, currency ON marketplace_items
WHEN OLD.status IN ('sold', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'sold or cancelled listings are immutable');
END;

CREATE TRIGGER IF NOT EXISTS marketplace_items_status_forward_only
BEFORE UPDATE OF status ON marketplace_items
WHEN NEW.status != OLD.status
  AND NOT (OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled'))
  AND NOT (OLD.status = 'active' AND NEW.status IN ('sold', 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'invalid marketplace listing status transition');
END;

-- 3. Uploaded bytes, stored in D1 as base64 chunks (no R2 bucket required).
CREATE TABLE IF NOT EXISTS marketplace_assets (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('image', 'file')),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 140),
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes = CAST(size_bytes AS INTEGER)),
  sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES marketplace_items(id) ON DELETE CASCADE,
  FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marketplace_assets_item ON marketplace_assets(item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_asset_chunks (
  asset_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data_b64 TEXT NOT NULL,
  PRIMARY KEY (asset_id, seq),
  FOREIGN KEY (asset_id) REFERENCES marketplace_assets(id) ON DELETE CASCADE
);

-- Uploads are write-once: re-writing a chunk would let a file change after review.
CREATE TRIGGER IF NOT EXISTS marketplace_asset_chunks_no_update
BEFORE UPDATE ON marketplace_asset_chunks
BEGIN
  SELECT RAISE(ABORT, 'asset chunks are immutable');
END;

-- 4. Quotation requests: buyer offers a price, seller accepts/declines, buyer pays.
CREATE TABLE IF NOT EXISTS marketplace_quotes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  requested_price INTEGER NOT NULL CHECK (requested_price > 0 AND requested_price = CAST(requested_price AS INTEGER)),
  message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 500),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'paid', 'expired')),
  accepted_price INTEGER CHECK (accepted_price IS NULL OR (accepted_price > 0 AND accepted_price = CAST(accepted_price AS INTEGER))),
  seller_note TEXT CHECK (seller_note IS NULL OR length(seller_note) <= 300),
  buyer_txn_id TEXT,
  seller_txn_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME,
  paid_at DATETIME,
  expires_at DATETIME,
  FOREIGN KEY (item_id) REFERENCES marketplace_items(id) ON DELETE CASCADE,
  FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marketplace_quotes_buyer ON marketplace_quotes(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_quotes_seller ON marketplace_quotes(seller_id, status, created_at DESC);

-- One live quote per buyer per item; a closed quote does not block a new one.
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_quotes_one_open_per_buyer
  ON marketplace_quotes(item_id, buyer_id)
  WHERE status IN ('pending', 'accepted');

CREATE TRIGGER IF NOT EXISTS marketplace_quotes_status_forward_only
BEFORE UPDATE OF status ON marketplace_quotes
WHEN NEW.status != OLD.status
  AND NOT (OLD.status = 'pending' AND NEW.status IN ('accepted', 'declined', 'withdrawn', 'expired'))
  AND NOT (OLD.status = 'accepted' AND NEW.status IN ('paid', 'withdrawn', 'expired'))
BEGIN
  SELECT RAISE(ABORT, 'invalid quotation status transition');
END;

CREATE TRIGGER IF NOT EXISTS marketplace_quotes_paid_immutable
BEFORE UPDATE ON marketplace_quotes
WHEN OLD.status = 'paid'
BEGIN
  SELECT RAISE(ABORT, 'paid quotations are immutable');
END;

-- 5. Fold any rows from the old tutorial table into the real listings table.
INSERT OR IGNORE INTO marketplace_items
  (id, seller_id, kind, title, description, price, status, published_at, created_at)
SELECT
  l.id,
  l.seller_id,
  'product',
  COALESCE(NULLIF(TRIM(l.title), ''), 'Untitled listing'),
  COALESCE(l.description, ''),
  CAST(l.price AS INTEGER),
  'active',
  l.created_at,
  l.created_at
FROM marketplace_listings l
WHERE l.seller_id IS NOT NULL
  AND l.price >= 1
  AND length(TRIM(COALESCE(l.title, ''))) >= 3;
