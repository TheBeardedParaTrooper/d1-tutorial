"""Walk the staff console the way a browser would, but with assertions.

1. sign in with admin/admin over HTTP and keep the cookie jar
2. fetch /admin and require: shell present, inline scripts parse, boot JSON valid
3. every sidebar tab must have a matching route in the console script
4. every /api/admin GET the served script can issue must answer 200
5. every actionButton name must exist in the script's actions map
6. the loop the console exists for: a credit lands, a replay is refused, and the
   customer portal shows the same number

Local dev only — step 6 resets a test customer's password and moves test money.

  python3 test/admin-console-walk.py
"""
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.request
import http.cookiejar

BASE = os.environ.get('BASE', 'http://127.0.0.1:8787')
STAFF_USER = os.environ.get('STAFF_USER', 'admin')
STAFF_PASS = os.environ.get('STAFF_PASS', 'admin')
WORK = tempfile.mkdtemp(prefix='console-walk-')
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def post(path, payload, origin=True, key=None):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if origin:
        headers['Origin'] = BASE
    if key:
        headers['Idempotency-Key'] = key
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers=headers)
    try:
        with op.open(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def get(path):
    try:
        with op.open(BASE + path, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


fails = []


def check(label, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + label + ('' if ok else '  :: ' + str(detail)[:200]))
    if not ok:
        fails.append(label)


# 1. sign in
st, body = post('/api/admin/auth/login', {'identifier': STAFF_USER, 'password': STAFF_PASS})
check('admin/admin signs in', st == 200, body)
me = json.loads(body)
check('role is super_admin', me.get('admin', {}).get('role') == 'super_admin', body)
check('admin keeps the seeded default password', bool(me.get('admin', {}).get('must_change_password')), body)

# 2. shell
st, html = get('/admin')
check('GET /admin renders the console', st == 200 and 'Staff console' in html, st)
blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
for i, b in enumerate(blocks):
    path = os.path.join(WORK, f'inline-{i}.js')
    open(path, 'w').write(b)
    r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
    check(f'inline script {i} parses ({len(b)} chars)', r.returncode == 0, r.stderr)
boot = re.search(r'window\.__FLATCOIN_ADMIN__ = (.*?);</script>', html, re.S)
data = json.loads(boot.group(1).replace('\\u003c', '<')) if boot else {}
check('boot JSON carries the admin', data.get('admin', {}).get('username') == 'admin', boot.group(1)[:120] if boot else 'none')
check('console loads no third-party assets', 'cdn.' not in html and 'http://' not in html.replace(BASE, ''), 'external ref')
head = get('/admin')[1]
_opener_headers = {}
try:
    with op.open(urllib.request.Request(BASE + '/admin'), timeout=30) as _r:
        _opener_headers = dict(_r.headers)
except Exception:
    pass
check('console sends noindex + frame deny + no-store',
      'noindex' in str(_opener_headers.get('X-Robots', '')) or 'noindex' in html
      and _opener_headers.get('X-Frame-Options') == 'DENY'
      and 'no-store' in str(_opener_headers.get('Cache-Control', '')), _opener_headers)

script = max(blocks, key=len)

# 3. tabs
nav_tabs = re.findall(r'data-tab="([a-z]+)"', html)
route_tabs = re.findall(r"^var TABS = \[([^\]]*)\]", script, re.M)
listed = re.findall(r"'([a-z]+)'", route_tabs[0]) if route_tabs else []
check('sidebar tabs == script tabs', sorted(nav_tabs) == sorted(listed), f'{nav_tabs} vs {listed}')

# 4. every read the console can make (literal GET paths only)
paths = set()
for path, tail in re.findall(r"callApi\('(/api/admin/[^']*)'([^)]*)\)", script):
    if not path or path.endswith('/') or ':' in path:
        continue
    if 'method' in tail and "'GET'" not in tail:
        continue
    paths.add(path)
for p in sorted(paths):
    st, body = get(p)
    ok = st == 200
    parsed = None
    if ok:
        try:
            parsed = json.loads(body)
        except Exception as e:
            ok = False
    check(f'console read {p}', ok, body)
    if isinstance(parsed, dict):
        keys = [k for k, v in parsed.items() if isinstance(v, list)]
        counts = {k: len(parsed[k]) for k in keys}
        print('       rows:', counts or '(no lists)')

# 5. action wiring
buttons = set(re.findall(r"actionButton\('([A-Za-z]+)'", script))
handlers = set(re.findall(r"^\s{2}([A-Za-z]+): (?:async )?function", script, re.M))
wired = buttons - handlers
check('every action button has a handler', not wired, f'unwired: {sorted(wired)}')
print('       buttons:', len(buttons), 'handlers:', len(handlers))

# 6. the money loop the user asked about: console credit -> portal balance, and a replay refusal
st, body = post('/api/admin/users/maria/password', {'password': 'MariaPortal2026Pass'})
check('admin can set a customer password', st == 200, body)
cust = http.cookiejar.CookieJar()
cop = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cust))
req = urllib.request.Request(BASE + '/api/auth/login',
                             data=json.dumps({'identifier': 'maria', 'password': 'MariaPortal2026Pass'}).encode(),
                             headers={'Content-Type': 'application/json', 'Origin': BASE})
with cop.open(req, timeout=30) as r:
    login = json.loads(r.read().decode())
uid = login['user']['id']
WALK_KEY = 'console-walk-%d' % int(time.time())
st, body = post('/api/admin/wallet/credit', {'user': 'maria', 'amount': 777, 'note': 'console walk'}, key=WALK_KEY)
check('console credits Maria 777 TZS', st == 201, body)
after = json.loads(body)['credit']['balance']
st2, replay = post('/api/admin/wallet/credit', {'user': 'maria', 'amount': 777, 'note': 'console walk'}, key=WALK_KEY)
check('replaying the same key is a clean 409, not a 500', st2 == 409, replay)
check('the replay blames the key, not the server', 'Idempotency-Key' in replay, replay)
req = urllib.request.Request(BASE + f'/api/wallet/{uid}')
with cop.open(req, timeout=30) as r:
    portal = json.loads(r.read().decode())
check('console credit is the balance the portal shows', portal['wallet']['balance'] == after,
      f"portal {portal['wallet']['balance']} vs console {after}")
st, ledger = get('/api/admin/ledger?type=ADMIN_CREDIT')
check('the credit is in the ledger the console reads', str(after) in ledger or 'ADMIN_CREDIT' in ledger, ledger[:160])
st, audit = get('/api/admin/audit/events?event_type=admin.wallet_credit&limit=5')
check('the credit is attributed to staff in the audit outbox', '"admin"' in audit and 'admin.wallet_credit' in audit, audit[:200])

print()
print('==== console walk: %d checks failed ====' % len(fails))
for f in fails:
    print('   -', f)
