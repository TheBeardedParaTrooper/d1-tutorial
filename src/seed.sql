-- Flat Coin ISP — initial seed
-- Idempotent: safe to run twice.

INSERT OR IGNORE INTO packages (id, name, duration_hours, price) VALUES
  ('day-24h',  '24 Hour Pass',  24,  1000),
  ('week-168h','Weekly Pass',  168,  5000),
  ('month-720h','Monthly Pass', 720, 15000);

INSERT OR IGNORE INTO gateways (id, name, location, active) VALUES
  ('gw-1', 'Main Hotspot', 'Dar es Salaam', 1),
  ('gw-2', 'Backup Hotspot', 'Arusha', 1);
