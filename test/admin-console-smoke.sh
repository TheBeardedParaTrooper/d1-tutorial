#!/usr/bin/env bash
# Admin console smoke test: staff sign-in, every read panel, every write verb,
# and the visible effect each write has on the customer portal.
#
# Requires a local `wrangler dev` with the flat-coin-isp-db binding and the
# AUTH_SECRET / PORTAL_ORIGIN / ADMIN_SECRET vars this repo uses for dev.
# It writes test data (a throwaway tier, a throwaway listing, a throwaway staff
# account) and never touches the demo listings. The customer/staff credentials it
# uses are the local fixtures created by the portal's own register API.
#   bash test/admin-console-smoke.sh
set -u
BASE=${BASE:-http://127.0.0.1:8787}
ORIGIN=${ORIGIN:-$BASE}
ADMIN_SECRET=${ADMIN_SECRET:-local-admin-secret-value-0123456789abcdef}
TMP=${TMP:-.tmp-admin-smoke-}
PASS=0; FAIL=0

step() { # step "name" expected_status actual body
  local name="$1" expected="$2" actual="$3" body="$4"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS+1)); printf 'ok   %-58s %s\n' "$name" "$actual"
  else
    FAIL=$((FAIL+1)); printf 'FAIL %-58s got %s want %s :: %s\n' "$name" "$actual" "$expected" "$(echo "$body" | head -c 220)"
  fi
}

code() { curl -s -o "${TMP}last-body.json" -w '%{http_code}' "$@"; }
body() { cat "${TMP}last-body.json"; }

JAR="${TMP}admin-cookies.txt"
USER_JAR="${TMP}user-cookies.txt"
rm -f "$JAR" "$USER_JAR"

# ---------- gate ----------
S=$(code $BASE/admin); step "GET /admin unauthenticated redirects" "302" "$S" "$(body)"
S=$(code -L $BASE/admin); B=$(body)
echo "$B" | grep -q 'Staff Console' && step "login page renders" "200" "200" "" || step "login page renders" "200" "MISSING" "$B"
echo "$B" | grep -q 'cdn.tailwindcss.com' && step "login page has no CDN scripts" "clean" "CDN FOUND" "$B" || step "login page has no CDN scripts" "clean" "clean" ""
echo "$B" | grep -q 'id="identifier"' && step "login page asks for a username" "200" "200" "" || step "login page asks for a username" "200" "MISSING" ""

# ---------- sign-in ----------
S=$(code -X POST $BASE/api/admin/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"identifier":"admin","password":"wrong"}')
step "wrong staff password rejected" "401" "$S" "$(body)"
S=$(code -X POST $BASE/api/admin/auth/login -H 'Content-Type: application/json' -d '{"identifier":"admin","password":"admin"}')
step "login without Origin refused" "403" "$S" "$(body)"
S=$(code -c "$JAR" -X POST $BASE/api/admin/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"identifier":"admin","password":"admin"}')
step "admin/admin signs in" "200" "$S" "$(body)"
grep -q 'super_admin' ${TMP}last-body.json && step "session reports super_admin role" "yes" "yes" "" || step "session reports super_admin role" "yes" "no" "$(body)"
S=$(code -b "$JAR" $BASE/admin); step "GET /admin with cookie" "200" "$S" "$(body)"
S=$(code $BASE/api/admin/overview); step "console API refuses anonymous" "401" "$S" "$(body)"

# ---------- reads ----------
for path in overview users tiers orders sessions marketplace ledger staff audit/events; do
  S=$(code -b "$JAR" "$BASE/api/admin/$path")
  step "GET /api/admin/$path" "200" "$S" "$(body)"
done
S=$(code -b "$JAR" "$BASE/api/admin/audit/events?limit=3")
python3 -c "import json;d=json.load(open('${TMP}last-body.json'));print(len(d['events']))" >/dev/null && step "audit payload parses" "ok" "ok" "" || step "audit payload parses" "ok" "broken" ""
S=$(code -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE/api/admin/audit/events?limit=2")
step "audit export with machine secret" "200" "$S" "$(body)"
S=$(code -H "X-Admin-Secret: wrong-secret" "$BASE/api/admin/audit/events?limit=2")
step "audit export with wrong secret" "401" "$S" "$(body)"

# ---------- find the seeded customers ----------
S=$(code -b "$JAR" "$BASE/api/admin/users?q=maria")
MARIA=$(python3 -c "
import json;d=json.load(open('${TMP}last-body.json'));u=[x for x in d['users'] if x.get('username')=='maria']
print(u[0]['id'] if u else '')")
S=$(code -b "$JAR" "$BASE/api/admin/users?q=G")
G=$(python3 -c "
import json;d=json.load(open('${TMP}last-body.json'));u=[x for x in d['users'] if (x.get('username') or '').lower()=='g']
print(u[0]['id'] if u else '')")
[ -n "$MARIA" ] && step "console finds @maria" "yes" "yes" "" || step "console finds @maria" "yes" "no" "$(body)"
[ -n "$G" ] && step "console finds @g" "yes" "yes" "" || step "console finds @g" "yes" "no" "$(body)"
S=$(code -b "$JAR" "$BASE/api/admin/users/@maria")
step "user detail by @handle" "200" "$S" "$(body)"
S=$(code -b "$JAR" "$BASE/api/admin/users/does-not-exist")
step "unknown customer 404" "404" "$S" "$(body)"

# ---------- wallet writes ----------
KEY1="smoke-credit-$(date +%s)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/wallet/credit -H "Origin: $ORIGIN" -H "Idempotency-Key: $KEY1" -H 'Content-Type: application/json' -d "{\"user\":\"@maria\",\"amount\":1000,\"note\":\"smoke credit\"}")
step "credit @maria 1,000" "201" "$S" "$(body)"
BAL=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['credit']['balance'])" 2>/dev/null)
S=$(code -b "$JAR" -X POST $BASE/api/admin/wallet/credit -H "Origin: $ORIGIN" -H "Idempotency-Key: $KEY1" -H 'Content-Type: application/json' -d "{\"user\":\"@maria\",\"amount\":1000,\"note\":\"smoke credit\"}")
step "same key cannot pay twice" "409" "$S" "$(body)"
# A refused replay must leave no trace on the balance, so re-read it from the console.
code -b "$JAR" "$BASE/api/admin/users/$MARIA" >/dev/null
BAL2=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['user']['balance'])" 2>/dev/null)
[ "$BAL" = "$BAL2" ] && step "replay left the balance alone" "same" "same" "balance $BAL" || step "replay left the balance alone" "same" "$BAL vs $BAL2" ""
S=$(code -b "$JAR" -X POST $BASE/api/admin/wallet/credit -H "Origin: $ORIGIN" -H "Idempotency-Key: smoke-$(date +%s)-a" -H 'Content-Type: application/json' -d '{"user":"@maria","amount":0}')
step "zero credit refused" "400" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/wallet/credit -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"user":"@maria","amount":500}')
step "credit without Idempotency-Key refused" "400" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/wallet/debit -H "Origin: $ORIGIN" -H "Idempotency-Key: smoke-debit-$(date +%s)" -H 'Content-Type: application/json' -d '{"user":"@maria","amount":999999999,"note":"too big"}')
step "over-debit refused as 400 not 500" "400" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/wallet/debit -H "Origin: $ORIGIN" -H "Idempotency-Key: smoke-debit-ok-$(date +%s)" -H 'Content-Type: application/json' -d '{"user":"@maria","amount":500,"note":"correction"}')
step "correct wallet by 500" "201" "$S" "$(body)"
DBAL=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['debit']['balance'])" 2>/dev/null)

# ---------- portal sees the money ----------
S=$(code -b "$JAR" -X POST "$BASE/api/admin/users/$MARIA/password" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"password":"short"}')
step "short customer password refused" "400" "$S" "$(body)"
S=$(code -b "$JAR" -X POST "$BASE/api/admin/users/$MARIA/password" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"password":"MariaTest1234"}')
step "console sets a customer password" "200" "$S" "$(body)"
S=$(code -c "$USER_JAR" -X POST $BASE/api/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"identifier":"maria","password":"MariaTest1234"}')
step "@maria can sign in with it" "200" "$S" "$(body)"
code -b "$USER_JAR" "$BASE/api/wallet/$MARIA" >/dev/null
WAL=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['wallet']['balance'])" 2>/dev/null)
step "portal wallet shows the console's maths" "$DBAL" "$WAL" "console $DBAL portal $WAL"

# ---------- tiers drive the Plans tab ----------
BEFORE=$(curl -s $BASE/api/packages | python3 -c "import json,sys;print(len(json.load(sys.stdin)['packages']))")
S=$(code -b "$JAR" -X POST $BASE/api/admin/tiers -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"name":"Smoke 3h trial","duration_hours":3,"price":900}')
step "create tier" "201" "$S" "$(body)"
TIER=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['tier']['id'])" 2>/dev/null)
AFTER=$(curl -s $BASE/api/packages | python3 -c "import json,sys;print(len(json.load(sys.stdin)['packages']))")
step "new tier appears in /api/packages" "$((BEFORE+1))" "$AFTER" "before $BEFORE after $AFTER"
S=$(code -b "$JAR" -X PATCH "$BASE/api/admin/tiers/$TIER" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"active":false}')
step "hide tier from the portal" "200" "$S" "$(body)"
HIDDEN=$(curl -s $BASE/api/packages | python3 -c "import json,sys;print(len(json.load(sys.stdin)['packages']))")
step "hidden tier leaves /api/packages" "$BEFORE" "$HIDDEN" "expect $BEFORE got $HIDDEN"
S=$(code -b "$JAR" -X POST $BASE/api/session/buy -H "Origin: $ORIGIN" -H "Idempotency-Key: dead-tier-$(date +%s)" -H 'Content-Type: application/json' -d "{\"package_id\":\"$TIER\",\"mac_address\":\"AA:BB:CC:DD:EE:01\"}" -c "$USER_JAR" -b "$USER_JAR")
step "archived tier cannot be bought" "404" "$S" "$(body)"
S=$(code -b "$JAR" -X PATCH "$BASE/api/admin/tiers/$TIER" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"active":true,"price":1200}')
step "tier back on sale with a new price" "200" "$S" "$(body)"
PRICE=$(curl -s $BASE/api/packages | python3 -c "
import json,sys
pkgs=json.load(sys.stdin)['packages']
match=[p for p in pkgs if p['id']=='$TIER']
print(match[0]['price'] if match else 'gone')")
step "portal shows the repriced tier" "1200" "$PRICE" "portal price $PRICE"
S=$(code -b "$JAR" -X DELETE "$BASE/api/admin/tiers/$TIER" -H "Origin: $ORIGIN")
step "archive tier with DELETE" "200" "$S" "$(body)"
S=$(code -b "$JAR" -X DELETE "$BASE/api/admin/tiers/$TIER" -H "Origin: $ORIGIN")
step "archiving twice reports 404" "404" "$S" "$(body)"

# ---------- suspension reaches the portal ----------
S=$(code -b "$USER_JAR" $BASE/api/auth/me)
step "suspension test pre-check: session alive" "200" "$S" "$(body)"
S=$(code -b "$JAR" -X POST "$BASE/api/admin/users/$MARIA/status" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"active":false,"reason":"smoke suspension"}')
step "suspend @maria" "200" "$S" "$(body)"
S=$(code -b "$USER_JAR" $BASE/api/auth/me)
step "her live portal session dies at once" "401" "$S" "$(body)"
S=$(code -X POST $BASE/api/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"identifier":"maria","password":"MariaTest1234"}')
step "suspended customer cannot sign in" "403" "$S" "$(body)"
S=$(code -b "$JAR" -X POST "$BASE/api/admin/users/$MARIA/status" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"active":true,"reason":"smoke reinstatement"}')
step "reinstate @maria" "200" "$S" "$(body)"
S=$(code -c "$USER_JAR" -X POST $BASE/api/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"identifier":"maria","password":"MariaTest1234"}')
step "she can sign in again" "200" "$S" "$(body)"

# ---------- hotspot pass ----------
PKG=$(curl -s $BASE/api/packages | python3 -c "import json,sys;print(json.load(sys.stdin)['packages'][0]['id'])")
S=$(code -b "$JAR" -X POST $BASE/api/admin/passes/issue -H "Origin: $ORIGIN" -H "Idempotency-Key: pass-$(date +%s)" -H 'Content-Type: application/json' -d "{\"user\":\"@maria\",\"package_id\":\"$PKG\",\"mac_address\":\"AA:BB:CC:DD:EE:FF\",\"charge_wallet\":true}")
step "issue a pass for a walk-in" "201" "$S" "$(body)"
TOKEN=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['session']['radius_token'])" 2>/dev/null)
S=$(code -X POST $BASE/api/radius/authorize -H 'Content-Type: application/json' -H 'X-RADIUS-Secret: ' -d "{\"User-Name\":\"$TOKEN\",\"Calling-Station-Id\":\"aa:bb:cc:dd:ee:ff\"}")
step "radius lookup answers (secret unset = 503 or 401)" "503" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/passes/issue -H "Origin: $ORIGIN" -H "Idempotency-Key: pass-bad-$(date +%s)" -H 'Content-Type: application/json' -d "{\"user\":\"@maria\",\"package_id\":\"$PKG\",\"mac_address\":\"nonsense\"}")
step "pass with a bad MAC refused" "400" "$S" "$(body)"

# ---------- orders ----------
S=$(code -b "$USER_JAR" -c "$USER_JAR" -X POST $BASE/api/payments/orders -H "Origin: $ORIGIN" -H "Idempotency-Key: order-$(date +%s)" -H 'Content-Type: application/json' -d "{\"package_id\":\"$PKG\",\"phone_number\":\"+255765455654\"}")
step "@maria opens an AzamPay order" "201" "$S" "$(body)"
MERCHANT=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['order']['merchant_id'])" 2>/dev/null)
S=$(code -b "$JAR" "$BASE/api/admin/orders?status=pending")
echo "$(body)" | grep -q "$MERCHANT" && step "console lists the pending order" "yes" "yes" "" || step "console lists the pending order" "yes" "no" "$(body)"
WAS=$( { code -b "$USER_JAR" "$BASE/api/wallet/$MARIA" >/dev/null; python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['wallet']['balance'])"; } )
S=$(code -b "$JAR" -X POST "$BASE/api/admin/orders/$MERCHANT/settle" -H "Origin: $ORIGIN" -H "Idempotency-Key: settle-$(date +%s)" -H 'Content-Type: application/json' -d '{"reference":"cash at shop"}')
step "settle the order by hand" "201" "$S" "$(body)"
S=$(code -b "$JAR" -X POST "$BASE/api/admin/orders/$MERCHANT/settle" -H "Origin: $ORIGIN" -H "Idempotency-Key: settle2-$(date +%s)" -H 'Content-Type: application/json' -d '{}')
step "a settled order cannot settle twice" "409" "$S" "$(body)"
NOW=$( { code -b "$USER_JAR" "$BASE/api/wallet/$MARIA" >/dev/null; python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['wallet']['balance'])"; } )
AMT=$(curl -s $BASE/api/packages | python3 -c "
import json,sys
pkgs=json.load(sys.stdin)['packages']
print(next(p['price'] for p in pkgs if p['id']=='$PKG'))")
step "settlement credited the wallet by the order price" "$((WAS+AMT))" "$NOW" "was $WAS now $NOW (price $AMT)"

# ---------- marketplace moderation ----------
# Moderate a listing this run created, never a demo listing the user asked for.
G_JAR="${TMP}g-cookies.txt"
rm -f "$G_JAR"
S=$(code -c "$G_JAR" -X POST $BASE/api/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"identifier":"g","password":"GiftPortal2026Pass"}')
step "seller G signs in for the moderation test" "200" "$S" "$(body)"
S=$(code -b "$G_JAR" -c "$G_JAR" -X POST $BASE/api/marketplace/items -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"kind\":\"product\",\"title\":\"Smoke throwaway $(date +%s)\",\"price\":1500,\"description\":\"created by the admin smoke test\"}")
step "seller drafts a listing" "201" "$S" "$(body)"
ITEM=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['item']['id'])" 2>/dev/null)
S=$(code -b "$G_JAR" -X POST "$BASE/api/marketplace/items/$ITEM/publish" -H "Origin: $ORIGIN")
step "seller publishes it" "200" "$S" "$(body)"
S=$(code -b "$JAR" "$BASE/api/admin/marketplace")
echo "$(body)" | grep -q "$ITEM" && step "console sees the live listing" "yes" "yes" "" || step "console sees the live listing" "yes" "no" ""
PUBLIC_BEFORE=$(curl -s "$BASE/api/marketplace/items" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")
S=$(code -b "$JAR" -X POST "$BASE/api/admin/marketplace/items/$ITEM/takedown" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"reason":"smoke moderation"}')
step "take a listing down" "200" "$S" "$(body)"
PUBLIC_AFTER=$(curl -s "$BASE/api/marketplace/items" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")
step "portal marketplace shrinks by one" "$((PUBLIC_BEFORE-1))" "$PUBLIC_AFTER" "before $PUBLIC_BEFORE after $PUBLIC_AFTER"
S=$(code -b "$JAR" -X POST "$BASE/api/admin/marketplace/items/$ITEM/takedown" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}')
step "a cancelled listing cannot be removed twice" "400" "$S" "$(body)"

# ---------- staff admin + own credentials ----------
VUSER="view_smoke_$(date +%H%M%S)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/staff -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"username\":\"$VUSER\",\"full_name\":\"Smoke viewer\",\"role\":\"viewer\",\"password\":\"viewerpass123\"}")
step "create a viewer account" "201" "$S" "$(body)"
VIEWER=$(python3 -c "import json;print(json.load(open('${TMP}last-body.json'))['staff']['id'])" 2>/dev/null)
S=$(code -X POST $BASE/api/admin/auth/login -c "${TMP}viewer.txt" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"identifier\":\"$VUSER\",\"password\":\"viewerpass123\"}")
step "viewer signs in" "200" "$S" "$(body)"
S=$(code -b "${TMP}viewer.txt" $BASE/api/admin/overview)
step "viewer can read the console" "200" "$S" "$(body)"
S=$(code -b "${TMP}viewer.txt" -X POST $BASE/api/admin/wallet/credit -H "Origin: $ORIGIN" -H "Idempotency-Key: viewer-$(date +%s)" -H 'Content-Type: application/json' -d '{"user":"@maria","amount":10}')
step "viewer cannot move money" "403" "$S" "$(body)"
S=$(code -b "${TMP}viewer.txt" -X POST $BASE/api/admin/staff -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"username":"another","role":"operator","password":"operatorpass123"}')
step "viewer cannot create staff" "403" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/staff -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"username\":\"$VUSER\",\"role\":\"viewer\",\"password\":\"anotherpass123\"}")
step "duplicate staff username refused" "409" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/staff -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"username":"Bad Name","role":"operator","password":"operatorpass123"}')
step "bad staff username refused" "400" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/staff -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"username":"shortpw","role":"operator","password":"abc"}')
step "weak staff password refused" "400" "$S" "$(body)"
S=$(code -b "$JAR" -X POST "$BASE/api/admin/staff/$VIEWER/status" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"active":false}')
step "disable the viewer" "200" "$S" "$(body)"
S=$(code -b "${TMP}viewer.txt" $BASE/api/admin/overview)
step "disabled staff loses access at once" "401" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/settings/password -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"current_password":"admin","new_password":"admin"}')
step "refuses to keep the seeded default" "400" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/settings/password -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"current_password":"nope","new_password":"rotatedpass123"}')
step "wrong current password refused" "401" "$S" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/settings/username -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}')
step "self-username save is idempotent" "200" "$S" "$(body)"

# ---------- audit covers the console ----------
S=$(code -b "$JAR" "$BASE/api/admin/audit/events?event_type=admin.wallet_credit&limit=20")
python3 -c "
import json;d=json.load(open('${TMP}last-body.json'))
rows=[e for e in d['events'] if e['actor_admin_id']]
assert rows, 'no staff-attributed credit events'
print('ok', len(rows))" >/dev/null 2>&1 && step "credits are attributed to the staff account" "yes" "yes" "" || step "credits are attributed to the staff account" "yes" "no" "$(body)"
S=$(code -b "$JAR" "$BASE/api/admin/staff")
python3 -c "
import json;d=json.load(open('${TMP}last-body.json'))
live=[s for s in d['sessions'] if not s['revoked_at']]
print(len(live))" | grep -qE '^[1-9]' && step "staff sessions are recorded" "yes" "yes" "" || step "staff sessions are recorded" "yes" "no" "$(body)"
S=$(code -b "$JAR" -X POST $BASE/api/admin/auth/logout)
step "staff sign-out" "200" "$S" "$(body)"
S=$(code -b "$JAR" $BASE/api/admin/overview)
step "cookie is dead after logout" "401" "$S" "$(body)"

rm -f "$TMP"*.txt "${TMP}last-body.json" "$G_JAR" "${TMP}viewer.txt" 2>/dev/null
printf '\n==== admin smoke: %d passed, %d failed ====\n' "$PASS" "$FAIL"
