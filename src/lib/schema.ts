/**
 * Future-endpoint DDL (device challenges, NAS leases).
 * Prefer adding to migrations/ before enabling those endpoints.
 */
export const EXTRA_TABLES = [
  `CREATE TABLE IF NOT EXISTS device_challenges (
    id TEXT PRIMARY KEY,
    short_code TEXT UNIQUE NOT NULL,
    mac_address TEXT NOT NULL,
    client_ip TEXT,
    gateway_id TEXT,
    link_login TEXT,
    package_id TEXT,
    phone_number TEXT,
    provider TEXT,
    payment_ref TEXT UNIQUE,
    login_token TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','paid','expired','failed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_challenges_mac ON device_challenges(mac_address, status)`,
  `CREATE INDEX IF NOT EXISTS idx_challenges_short ON device_challenges(short_code)`,
  `CREATE TABLE IF NOT EXISTS nas_leases (
    gateway_id TEXT NOT NULL,
    client_ip TEXT NOT NULL,
    mac_address TEXT NOT NULL,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (gateway_id, client_ip)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leases_seen ON nas_leases(seen_at)`,
]
