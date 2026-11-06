#!/usr/bin/env python3
"""Money-schema guards: prove the columns enforce what the comments claim.

Migration 0007 rebuilt `wallets` and `transactions`, which had been created as
`balance REAL DEFAULT 0` / `amount REAL` with no foreign key because an earlier
draft already owned those names and `CREATE TABLE IF NOT EXISTS` silently skipped
the strict version. This suite runs the writes that schema is supposed to refuse,
straight against the database (no HTTP, no app code to blame), and checks the
money total before and after so a test cannot quietly corrupt a balance.

One case is a documented limitation rather than a failure: assigning the string
'9999999' to an INTEGER-affinity column converts it to the integer 9999999 before
any BEFORE trigger or CHECK can see the original type, so the schema cannot tell a
hand-written integer apart from a hand-written numeric string. What catches it is
the snapshot diff this suite performs, plus the fact that no endpoint in the app
can produce such a write without a ledger row and an audit event.

    python3 test/money-schema-guards.py
    BASE=http://127.0.0.1:8787 DB=.../flat-coin-isp-db.sqlite3 python3 test/money-schema-guards.py
"""
import json
import os
import subprocess
import sys

BASE = os.environ.get('BASE', 'http://127.0.0.1:8787')
DB_NAME = os.environ.get('DB_NAME', 'flat-coin-isp-db')
failures = []
notes = []


def sql(statement):
    p = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', DB_NAME, '--local', '--json', '--command', statement],
        capture_output=True, text=True, timeout=180,
    )
    try:
        data = json.loads(p.stdout)
    except Exception:
        return {'ok': False, 'error': (p.stdout + p.stderr)[:220]}
    first = data[0] if isinstance(data, list) else data
    if not isinstance(first, dict):
        return {'ok': False, 'error': str(first)[:220]}
    # A refused write comes back as {"error": {"text": ...}} with no success key.
    if first.get('error') or not first.get('success'):
        message = first.get('error') or {}
        return {'ok': False, 'error': str(message.get('text') or message)[:220]}
    return {'ok': True, 'results': first.get('results', [])}


def one(statement):
    res = sql(statement)
    return res['results'][0] if res['ok'] and res['results'] else None


def check(name, condition, detail=''):
    print(f"  {'OK  ' if condition else 'FAIL'} {name}{('  ' + detail) if detail else ''}")
    if not condition:
        failures.append(name + ' ' + detail)


def refused(name, statement):
    res = sql(statement)
    check(name, not res['ok'], ('<- ' + res['error'][:96]) if not res['ok'] else 'THE WRITE LANDED')


print('== the baseline this suite must leave untouched')
snapshot = sql('SELECT user_id, CAST(balance AS INTEGER) AS balance FROM wallets ORDER BY user_id')
if not snapshot['ok']:
    raise SystemExit('cannot read wallets: ' + snapshot['error'])
before = {r['user_id']: r['balance'] for r in snapshot['results']}
head = one('SELECT (SELECT CAST(SUM(balance) AS INTEGER) FROM wallets) AS wallet_sum, '
           '(SELECT COUNT(*) FROM wallets) AS wallet_rows, '
           '(SELECT CAST(SUM(amount) AS INTEGER) FROM transactions) AS ledger_sum, '
           '(SELECT COUNT(*) FROM transactions) AS ledger_rows, '
           '(SELECT COUNT(*) FROM ledger_orphans) AS archived_rows')
print('  ', json.dumps(head))

sample = sorted(before)[0]

print('\n== writes the schema must refuse')
refused('fractional balance', f"UPDATE wallets SET balance = 100.5 WHERE user_id = '{sample}'")
refused('negative balance', f"UPDATE wallets SET balance = -1 WHERE user_id = '{sample}'")
refused('NULL balance', f"UPDATE wallets SET balance = NULL WHERE user_id = '{sample}'")
refused('non-numeric text balance', f"UPDATE wallets SET balance = 'lots' WHERE user_id = '{sample}'")
refused('balance below zero via arithmetic', f"UPDATE wallets SET balance = balance - 99999999 WHERE user_id = '{sample}'")
refused('wallet repointed to another account', f"UPDATE wallets SET user_id = 'someone-else' WHERE user_id = '{sample}'")
refused('wallet for an account that does not exist', "INSERT INTO wallets (user_id, balance) VALUES ('ghost-account', 1000)")
refused('ledger amount rewritten after the fact',
        "UPDATE transactions SET amount = 1 WHERE id = (SELECT id FROM transactions LIMIT 1)")
refused('ledger row moved to another account',
        "UPDATE transactions SET user_id = 'ghost-account' WHERE id = (SELECT id FROM transactions LIMIT 1)")
refused('ledger type erased',
        "UPDATE transactions SET type = NULL WHERE id = (SELECT id FROM transactions LIMIT 1)")
refused('fractional ledger amount',
        "INSERT INTO transactions (id, user_id, type, amount, status) "
        f"SELECT 'atk-frac', '{sample}', 'ADMIN_CREDIT', 50.5, 'success'")
refused('ledger row for a missing account',
        "INSERT INTO transactions (id, user_id, type, amount, status) "
        "VALUES ('atk-orphan', 'ghost-account', 'ADMIN_CREDIT', 100, 'success')")
refused('NULL ledger amount',
        "INSERT INTO transactions (id, user_id, type, amount, status) "
        f"SELECT 'atk-null', '{sample}', 'ADMIN_CREDIT', NULL, 'success'")
refused('nonsense ledger status',
        "INSERT INTO transactions (id, user_id, type, amount, status) "
        f"SELECT 'atk-status', '{sample}', 'ADMIN_CREDIT', 100, 'definitely-not-a-status'")
refused('zero-value ledger amount',
        "INSERT INTO transactions (id, user_id, type, amount, status) "
        f"SELECT 'atk-zero', '{sample}', 'ADMIN_CREDIT', 0, 'success'")

print('\n== the case the schema cannot see (documented limitation)')
res = sql(f"UPDATE wallets SET balance = '9999999' WHERE user_id = '{sample}'")
if res['ok']:
    notes.append('a numeric string overwrote a balance: INTEGER affinity converted it to 9999999 '
                 'before any trigger or CHECK could see the source type')
    drifted = one(f"SELECT CAST(balance AS INTEGER) AS b FROM wallets WHERE user_id = '{sample}'")
    check('   ...but the snapshot diff finds it', drifted and drifted['b'] != before[sample],
          f"{before[sample]} -> {drifted['b'] if drifted else '?'}")
    sql(f"UPDATE wallets SET balance = {before[sample]} WHERE user_id = '{sample}'")
    check('   ...and restoring from the snapshot is exact',
          one(f"SELECT CAST(balance AS INTEGER) AS b FROM wallets WHERE user_id = '{sample}'")['b'] == before[sample])
else:
    check('   numeric string refused after all', True, '<- ' + res['error'][:80])

print('\n== ordinary money still moves')
was = one(f"SELECT CAST(balance AS INTEGER) AS b FROM wallets WHERE user_id = '{sample}'")['b']
check('integer credit accepted', sql(f"UPDATE wallets SET balance = balance + 1000 WHERE user_id = '{sample}'")['ok'])
check('integer debit accepted', sql(f"UPDATE wallets SET balance = balance - 1000 WHERE user_id = '{sample}'")['ok'])
now = one(f"SELECT CAST(balance AS INTEGER) AS b FROM wallets WHERE user_id = '{sample}'")['b']
check('balance unchanged after the round trip', was == now, f'{was} vs {now}')

print('\n== invariants that must hold no matter what the attacks did')
after = {r['user_id']: r['balance'] for r in sql(
    'SELECT user_id, CAST(balance AS INTEGER) AS balance FROM wallets ORDER BY user_id')['results']}
check('every wallet is back to its starting balance', after == before,
      str([(k, before.get(k), after.get(k)) for k in set(before) | set(after) if before.get(k) != after.get(k)][:3]))
tail = one('SELECT (SELECT CAST(SUM(balance) AS INTEGER) FROM wallets) AS wallet_sum, '
           '(SELECT COUNT(*) FROM wallets) AS wallet_rows, '
           '(SELECT CAST(SUM(amount) AS INTEGER) FROM transactions) AS ledger_sum, '
           '(SELECT COUNT(*) FROM transactions) AS ledger_rows, '
           '(SELECT COUNT(*) FROM ledger_orphans) AS archived_rows')
check('money in the system is byte-for-byte what it was', head == tail, f'{head} vs {tail}')
check('no ledger row points at a missing account',
      one('SELECT COUNT(*) AS n FROM transactions WHERE user_id NOT IN (SELECT id FROM users)')['n'] == 0)
check('no wallet points at a missing account',
      one('SELECT COUNT(*) AS n FROM wallets WHERE user_id NOT IN (SELECT id FROM users)')['n'] == 0)
check('every stored balance is a real integer',
      one("SELECT COUNT(*) AS n FROM wallets WHERE typeof(balance) != 'integer'")['n'] == 0)
check('every stored ledger amount is a real integer',
      one("SELECT COUNT(*) AS n FROM transactions WHERE typeof(amount) != 'integer'")['n'] == 0)
check('the foreign keys are declared, not just implied',
      one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('wallets','transactions') "
          "AND sql LIKE '%REFERENCES users%'")['n'] == 2)

check('the portal is still serving plans after all of it',
      one("SELECT COUNT(*) AS n FROM packages WHERE active = 1")['n'] > 0)
p = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', BASE + '/api/packages'],
                   capture_output=True, text=True, timeout=60)
check('GET /api/packages -> 200', p.stdout.strip() == '200', p.stdout.strip())

for note in notes:
    print('\n  NOTE ' + note)
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
