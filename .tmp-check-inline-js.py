import re, subprocess, sys, http.cookiejar, urllib.request, json, tempfile, os
B='http://127.0.0.1:8787'
def opener():
    cj=http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
def post(op, path, payload):
    req=urllib.request.Request(B+path, data=json.dumps(payload).encode(), headers={'Content-Type':'application/json','Origin':B})
    try:
        return json.loads(op.open(req).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())
def get(op, path):
    try:
        return op.open(urllib.request.Request(B+path, headers={'Accept':'text/html'})).read().decode()
    except urllib.error.HTTPError as e:
        return e.read().decode()
def scripts(html):
    out=[]
    for m in re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S):
        s=m.group(1)
        if 'BOOT' in s or 'function' in s or 'const' in s or 'async' in s: out.append(s)
    return out
def check(name, html):
    ss=scripts(html)
    if not ss: print(f'{name:22} no inline script'); return
    for i,s in enumerate(ss):
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
            f.write(s); p=f.name
        r=subprocess.run(['node','--check',p], capture_output=True, text=True)
        status='OK ' if r.returncode==0 else 'FAIL'
        print(f'{name:22} script{i+1} len={len(s):6} {status}')
        if r.returncode: print('   ', r.stderr.strip().splitlines()[0] if r.stderr else '')
        os.unlink(p)
op=opener()
check('/account', get(op,'/account'))
check('/', get(op,'/'))
check('/admin/login', get(op,'/admin/login'))
r=post(op,'/api/auth/login', {'identifier':'g','password':'GiftPortal2026Pass'})
print('login probe ->', str(r)[:120])
me=get(op,'/api/auth/me')
check('/wallet (authed)', get(op,'/wallet'))
