"""Try to break the database rules from the outside — straight SQL, no app code.

Every statement below MUST be rejected by a trigger or CHECK. Anything that
succeeds is a hole. Every statement here fails on purpose, so nothing is
written; run it against the local dev database only.

  python3 test/schema-guards.py
"""
import json
import os
import subprocess

DB = os.environ.get('DB', 'flat-coin-isp-db')

CASES = [
    ('fractional wallet balance',
     "UPDATE wallets SET balance = balance + 0.5 WHERE user_id = (SELECT id FROM users LIMIT 1)"),
    ('negative wallet balance',
     "UPDATE wallets SET balance = -1 WHERE user_id = (SELECT id FROM users LIMIT 1)"),
    ('zero/negative ledger amount',
     "INSERT INTO transactions (id, user_id, type, amount, status) VALUES ('hole-test', (SELECT id FROM users LIMIT 1), 'DEPOSIT_MANUAL', -5, 'success')"),
    ('audit row deleted',
     "DELETE FROM audit_outbox WHERE event_id = (SELECT MIN(event_id) FROM audit_outbox)"),
    ('audit row rewritten',
     "UPDATE audit_outbox SET event_type = 'nothing.happened' WHERE event_id = (SELECT MAX(event_id) FROM audit_outbox)"),
    ('audit details not json',
     "INSERT INTO audit_outbox (event_type, target_id, details_json) VALUES ('hole.test', 'x', 'not json')"),
    ('paid order pushed back to pending',
     "UPDATE payment_orders SET status = 'pending' WHERE status = 'paid'"),
    ('order status that is not in the list',
     "UPDATE payment_orders SET status = 'completed' WHERE merchant_id = (SELECT merchant_id FROM payment_orders LIMIT 1)"),
    ('sold listing reopened',
     "UPDATE marketplace_items SET status = 'active' WHERE status = 'sold'"),
    ('quote paid then edited',
     "UPDATE marketplace_quotes SET status = 'pending' WHERE status = 'paid'"),
    ('staff row deleted',
     "DELETE FROM admin_users WHERE username = 'admin'"),
    ('staff session token swapped',
     "UPDATE admin_sessions SET token_hash = 'x' WHERE rowid = (SELECT MIN(rowid) FROM admin_sessions)"),
    ('two staff accounts that differ only in case',
     "INSERT INTO admin_users (id, username, full_name, password_hash, role, active) VALUES ('hole-1','ADMIN','x','pbkdf2-sha256$100000$c2FzZQ$aGV4aXN0aW5n','viewer',1)"),
    ('staff role that is not in the list',
     "INSERT INTO admin_users (id, username, full_name, password_hash, role, active) VALUES ('hole-2','hole2','x','pbkdf2-sha256$100000$c2FzZQ$aGV4aXN0aW5n','superuser',1)"),
    ('suspended staff re-enabled by deleting history',
     "DELETE FROM admin_sessions"),
]


def run(sql):
    p = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', DB, '--local', '--command', sql, '--json'],
        capture_output=True, text=True, timeout=180,
    )
    try:
        data = json.loads(p.stdout)
    except Exception:
        return False, (p.stdout + p.stderr)[:200]
    first = data[0] if isinstance(data, list) and data else data
    if not isinstance(first, dict):
        return False, str(first)[:200]
    message = first.get('error') or (first.get('meta') or {}).get('error') or json.dumps(first)[:160]
    return bool(first.get('success')), str(message)[:200]


holes = 0
for label, sql in CASES:
    ok, err = run(sql)
    if ok:
        holes += 1
        print(f'HOLE  {label}: the database ACCEPTED it')
    else:
        print(f'guard {label}: {err}')

print(f'\n==== {holes} of {len(CASES)} database-level attacks succeeded ====')
raise SystemExit(1 if holes else 0)
