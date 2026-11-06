-- Gateways / Network Interfaces
CREATE TABLE IF NOT EXISTS gateways (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    active INTEGER DEFAULT 1
);

-- Internet Packages / Subscriptions
CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    duration_hours INTEGER NOT NULL,
    bandwidth_limit_mb INTEGER
);

-- Store Items / Accessories
CREATE TABLE IF NOT EXISTS store_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    price REAL NOT NULL,
    category TEXT NOT NULL,
    stock INTEGER DEFAULT 0
);

-- Seed initial gateways
INSERT OR IGNORE INTO gateways (id, name, location) VALUES 
('gw-01', 'Arusha Hotspot Main', 'Arusha Town'),
('gw-02', 'Singisi Wireless Node', 'Singisi');
