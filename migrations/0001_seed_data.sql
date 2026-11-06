PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_hours INTEGER NOT NULL,
  price REAL NOT NULL
);

INSERT OR REPLACE INTO gateways (id, name, location, active) VALUES
('gw_arusha_main', 'Arusha Central Hub', 'Arusha Town Centre', 1),
('gw_singisi_node', ' Hill Node', 'Sing''isi / Usa River', 1),
('gw_holili_border', 'Commercial Gateway', 'Holili Border', 1);

INSERT OR REPLACE INTO packages (id, name, duration_hours, price) VALUES
('pkg_1h', '1 Hour Express Pass', 1, 500.0),
('pkg_3h', '3 Hours Standard Pass', 3, 1000.0),
('pkg_12h', '12 Hours Day Pass', 12, 2500.0),
('pkg_24h', '24 Hours Full Day Unlimited', 24, 4000.0),
('pkg_168h', '7 Days Weekly Saver', 168, 20000.0);

PRAGMA foreign_keys = ON;
