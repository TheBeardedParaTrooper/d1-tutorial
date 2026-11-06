#!/usr/bin/env bash
# Backend walk-through: register -> seed -> listing -> upload -> quote -> pay -> traces
set -uo pipefail
B=${B:-http://127.0.0.1:8787}
O="Origin: $B"
ROOT=/home/g/d1-tutorial
D=$ROOT/.tmp-fixtures
G_JAR=$ROOT/.tmp-smoke/g.jar
M_JAR=$ROOT/.tmp-smoke/m.jar
mkdir -p "$ROOT/.tmp-smoke"
rm -f "$G_JAR" "$M_JAR"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
j() { python3 -c "import sys,json;d=sys.stdin.read()
try: print(json.dumps(json.loads(d),indent=1)[:800])
except Exception: print(d[:300])"; }
sql() { (cd "$ROOT" && npx wrangler d1 execute flat-coin-isp-db --local --command "$1" 2>&1 | grep -E 'error|Error|executed' | head -2); }

say "0. reset test state (idempotent re-run)"
sql "DELETE FROM marketplace_quotes; DELETE FROM marketplace_asset_chunks; DELETE FROM marketplace_assets;
     DELETE FROM marketplace_items; DELETE FROM idempotency_keys;
     DELETE FROM transactions WHERE type LIKE 'MARKETPLACE%' OR reference_id = 'fixture:test-funds';
     DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE phone_number IN ('+255712234432','+255765455654'));
     DELETE FROM wallets WHERE user_id IN (SELECT id FROM users WHERE phone_number IN ('+255712234432','+255765455654'));
     DELETE FROM users WHERE phone_number IN ('+255712234432','+255765455654');"

say "1. register G (+255712234432, username G) - auto-signs in"
REG=$(curl -s -X POST "$B/api/auth/register" -H 'Content-Type: application/json' -H "$O" -c "$G_JAR" \
  -d '{"phone_number":"0712234432","full_name":"G","username":"G","password":"GiftPortal2026Pass"}')
echo "$REG" | j
G_ID=$(echo "$REG" | python3 -c "import sys,json;print(json.load(sys.stdin)['user']['id'])")

say "2. register Maria (+255765455654)"
REG2=$(curl -s -X POST "$B/api/auth/register" -H 'Content-Type: application/json' -H "$O" -c "$M_JAR" \
  -d '{"phone_number":"+255765455654","full_name":"Maria","username":"maria","password":"MariaPortal2026Pass"}')
echo "$REG2" | j
M_ID=$(echo "$REG2" | python3 -c "import sys,json;print(json.load(sys.stdin)['user']['id'])")
echo "  G=$G_ID Maria=$M_ID"

say "3. seed test funds (G 7,200,000 / Maria 3,000) through the ledger, not a silent UPDATE"
sql "UPDATE wallets SET balance = 7200000, updated_at = CURRENT_TIMESTAMP WHERE user_id = '$G_ID';
     UPDATE wallets SET balance = 3000, updated_at = CURRENT_TIMESTAMP WHERE user_id = '$M_ID';
     INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES ('tx-g-seed-1', '$G_ID', 'ADMIN_CREDIT', 7200000, 'success', 'fixture:test-funds');
     INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES ('tx-m-seed-1', '$M_ID', 'ADMIN_CREDIT', 3000, 'success', 'fixture:test-funds');
     INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES ('$G_ID', 'wallet.admin_credit', '$G_ID', '{\"amount\":7200000,\"currency\":\"TZS\",\"reason\":\"fixture:test-funds\"}');
     INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES ('$M_ID', 'wallet.admin_credit', '$M_ID', '{\"amount\":3000,\"currency\":\"TZS\",\"reason\":\"fixture:test-funds\"}');"

say "4. sign in as G with the username only"
curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -H "$O" -c "$G_JAR" \
  -d '{"identifier":"g","password":"GiftPortal2026Pass"}' | j

say "5. wrong password is refused"
curl -s -o /dev/null -w '  HTTP=%{http_code}\n' -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -H "$O" \
  -d '{"identifier":"g","password":"totally-wrong-password"}'

say "6. reserved username is refused at sign-up"
curl -s -X POST "$B/api/auth/register" -H 'Content-Type: application/json' -H "$O" \
  -d '{"phone_number":"0788112233","full_name":"Evil","username":"admin","password":"ReservedNameTest1"}' -w ' HTTP=%{http_code}\n'

say "7. who am I (cookie from step 4)"
curl -s -b "$G_JAR" "$B/api/auth/me" | j

say "8. G creates the mini pc listing (300,000 TZS, no picture)"
ITEM=$(curl -s -X POST "$B/api/marketplace/items" -H 'Content-Type: application/json' -H "$O" -b "$G_JAR" \
  -d '{"kind":"product","title":"mini pc","description":"Mikrotik-ready edge box, 8GB RAM, silent","price":300000,"negotiable":true,"pay_wallet":true,"pay_mobile_money":true,"payment_notes":"Wallet settles instantly. M-Pesa/Tigo Pesa/Airtel Money via AzamPay on request.","condition":"used","location":"Dar es Salaam"}')
echo "$ITEM" | j
ITEM_ID=$(echo "$ITEM" | python3 -c "import sys,json;print(json.load(sys.stdin)['item']['id'])")

say "9. publish it without any upload"
curl -s -X POST "$B/api/marketplace/items/$ITEM_ID/publish" -H "$O" -b "$G_JAR" | j

say "10. product WITH a photo: create -> upload png -> publish"
SW=$(curl -s -X POST "$B/api/marketplace/items" -H 'Content-Type: application/json' -H "$O" -b "$G_JAR" \
  -d '{"kind":"product","title":"5-port managed mini switch","description":"Refurbished, tested","price":45000,"negotiable":true,"pay_wallet":true}')
SW_ID=$(echo "$SW" | python3 -c "import sys,json;print(json.load(sys.stdin)['item']['id'])")
curl -s -X POST "$B/api/marketplace/items/$SW_ID/asset" -H "$O" -b "$G_JAR" \
  -H 'Content-Type: image/png' -H "X-File-Name: mini-switch-photo.png" \
  --data-binary "@$D/mini-switch-photo.png" | j
curl -s -X POST "$B/api/marketplace/items/$SW_ID/publish" -H "$O" -b "$G_JAR" >/dev/null

say "11. digital FILE listing: create -> upload csv -> publish (icon must show the type)"
CSV=$(curl -s -X POST "$B/api/marketplace/items" -H 'Content-Type: application/json' -H "$O" -b "$G_JAR" \
  -d '{"kind":"file","title":"Wholesale bandwidth tariff sheet","description":"Rate card for resellers","price":2000,"negotiable":false,"pay_wallet":true}')
CSV_ID=$(echo "$CSV" | python3 -c "import sys,json;print(json.load(sys.stdin)['item']['id'])")
curl -s -X POST "$B/api/marketplace/items/$CSV_ID/asset" -H "$O" -b "$G_JAR" \
  -H 'Content-Type: text/csv' -H "X-File-Name: tariff-sheet.csv" --data-binary "@$D/tariff-sheet.csv" | j
curl -s -X POST "$B/api/marketplace/items/$CSV_ID/publish" -H "$O" -b "$G_JAR" >/dev/null

say "12. PDF listing (file type icon only)"
PDF=$(curl -s -X POST "$B/api/marketplace/items" -H 'Content-Type: application/json' -H "$O" -b "$G_JAR" \
  -d '{"kind":"file","title":"RB931GS datasheet","description":"Vendor sheet for the CPE we sell","price":500,"negotiable":false,"pay_wallet":true}')
PDF_ID=$(echo "$PDF" | python3 -c "import sys,json;print(json.load(sys.stdin)['item']['id'])")
curl -s -X POST "$B/api/marketplace/items/$PDF_ID/asset" -H "$O" -b "$G_JAR" \
  -H 'Content-Type: application/pdf' -H "X-File-Name: rb931gs-datasheet.pdf" --data-binary "@$D/rb931gs-datasheet.pdf" | j
curl -s -X POST "$B/api/marketplace/items/$PDF_ID/publish" -H "$O" -b "$G_JAR" >/dev/null

say "13. an HTML upload must be rejected"
printf '<script>alert(1)</script>' > "$ROOT/.tmp-smoke/evil.html"
curl -s -X POST "$B/api/marketplace/items/$CSV_ID/asset" -H "$O" -b "$G_JAR" \
  -H 'Content-Type: text/html' --data-binary "@$ROOT/.tmp-smoke/evil.html" -w ' HTTP=%{http_code}\n'

say "14. someone else cannot upload to G's listing"
curl -s -X POST "$B/api/marketplace/items/$CSV_ID/asset" -H "$O" -b "$M_JAR" \
  -H 'Content-Type: text/csv' --data-binary "@$D/tariff-sheet.csv" -w ' HTTP=%{http_code}\n'

say "15. public listing feed (icon rule: photo vs file type)"
curl -s "$B/api/marketplace/items" | python3 -c "
import sys,json
for it in json.load(sys.stdin)['items']:
    a=it.get('asset') or {}
    print(f\"  {it['kind']:8} {it['title'][:34]:34} {it['price']:>8} img={'yes' if it['image_url'] else 'no '} icon={a.get('icon_label') or '-':5} methods={','.join(it['payment_methods'])} seller=@{(it['seller'] or {}).get('username')}\")"

say "16. served bytes match the original file exactly"
curl -s "$B/api/marketplace/items/$CSV_ID/asset" -o "$ROOT/.tmp-smoke/downloaded.csv" -D "$ROOT/.tmp-smoke/headers.txt"
grep -iE 'content-type|content-disposition|content-security|x-content|etag' "$ROOT/.tmp-smoke/headers.txt" | sed 's/^/  /'
echo "  sha256 original  : $(sha256sum "$D/tariff-sheet.csv" | cut -c1-64)"
echo "  sha256 downloaded: $(sha256sum "$ROOT/.tmp-smoke/downloaded.csv" | cut -c1-64)"

say "17. Maria requests a quotation on the mini pc"
Q=$(curl -s -X POST "$B/api/marketplace/items/$ITEM_ID/quotes" -H 'Content-Type: application/json' -H "$O" -b "$M_JAR" \
  -d '{"offered_price":280000,"message":"I can pay today from my wallet, please hold it for me"}')
echo "$Q" | j
QUOTE_ID=$(echo "$Q" | python3 -c "import sys,json;print(json.load(sys.stdin)['quote']['id'])")

say "18. duplicate open quote on the same listing is blocked"
curl -s -X POST "$B/api/marketplace/items/$ITEM_ID/quotes" -H 'Content-Type: application/json' -H "$O" -b "$M_JAR" \
  -d '{"offered_price":200000}' -w ' HTTP=%{http_code}\n'

say "19. G sees the incoming quote with Maria's wallet balance"
curl -s -b "$G_JAR" "$B/api/marketplace/quotes/incoming" | j

say "20. G accepts at a counter price of 295,000"
curl -s -X POST "$B/api/marketplace/quotes/$QUOTE_ID/respond" -H 'Content-Type: application/json' -H "$O" -b "$G_JAR" \
  -d '{"decision":"accept","counter_price":295000,"note":"295k and I ship today"}' | j

say "21. Maria has only 3,000 - payment must fail and move nothing"
curl -s -X POST "$B/api/marketplace/quotes/$QUOTE_ID/pay" -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: shortfunds-$(date +%s)" -w ' HTTP=%{http_code}\n'
(cd "$ROOT" && npx wrangler d1 execute flat-coin-isp-db --local --command \
  "SELECT q.status AS quote_status, i.status AS item_status, w.balance AS maria_balance FROM marketplace_quotes q JOIN marketplace_items i ON i.id=q.item_id JOIN wallets w ON w.user_id=q.buyer_id WHERE q.id='$QUOTE_ID'" --json 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('  state after the failed attempt:',d[0]['results'])")

say "22. a seller cannot pay their own quote, and cannot answer twice"
curl -s -X POST "$B/api/marketplace/quotes/$QUOTE_ID/pay" -H "$O" -b "$G_JAR" -H "Idempotency-Key: sellerpay$(date +%s)" -w ' HTTP=%{http_code}\n'
curl -s -X POST "$B/api/marketplace/quotes/$QUOTE_ID/respond" -H 'Content-Type: application/json' -H "$O" -b "$G_JAR" -d '{"decision":"decline"}' -w ' HTTP=%{http_code}\n'

say "23. fund Maria +300,000 TZS (test fixture, mirrors an admin credit)"
sql "UPDATE wallets SET balance = balance + 300000, updated_at = CURRENT_TIMESTAMP WHERE user_id = '$M_ID';
     INSERT INTO transactions (id, user_id, type, amount, status, reference_id) VALUES ('tx-m-seed-2', '$M_ID', 'ADMIN_CREDIT', 300000, 'success', 'fixture:test-funds');
     INSERT INTO audit_outbox (actor_user_id, event_type, target_id, details_json) VALUES ('$M_ID', 'wallet.admin_credit', '$M_ID', '{\"amount\":300000,\"currency\":\"TZS\",\"reason\":\"fixture:test-funds\"}');"

say "24. Maria pays the accepted quotation from her wallet"
curl -s -X POST "$B/api/marketplace/quotes/$QUOTE_ID/pay" -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: payquote-$(date +%s%N)" | j

say "25. replaying the same settlement is refused"
curl -s -X POST "$B/api/marketplace/quotes/$QUOTE_ID/pay" -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: payquote-replay-$(date +%s%N)" -w ' HTTP=%{http_code}\n'

say "26. buy the 2,000 TZS file listing outright (instant wallet transfer)"
curl -s -X POST "$B/api/marketplace/buy" -H 'Content-Type: application/json' -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: buycsv-$(date +%s%N)" -d "{\"item_id\":\"$CSV_ID\"}" | j

say "27. a listing that is already sold cannot be bought again"
curl -s -X POST "$B/api/marketplace/buy" -H 'Content-Type: application/json' -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: buycsv2-$(date +%s%N)" -d "{\"item_id\":\"$CSV_ID\"}" -w ' HTTP=%{http_code}\n'

say "28. G cannot buy his own listing"
curl -s -X POST "$B/api/marketplace/buy" -H 'Content-Type: application/json' -H "$O" -b "$G_JAR" \
  -H "Idempotency-Key: selfbuy-$(date +%s%N)" -d "{\"item_id\":\"$SW_ID\"}" -w ' HTTP=%{http_code}\n'

say "29. Maria buys a 500 TZS time pass with what is left"
PKG=$(curl -s "$B/api/packages" | python3 -c "import sys,json;print(json.load(sys.stdin)['packages'][0]['id'])")
curl -s -X POST "$B/api/session/buy" -H 'Content-Type: application/json' -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: pass-$(date +%s%N)" -d "{\"package_id\":\"$PKG\",\"mac_address\":\"AAC222333444\"}" | j

say "30. Maria sends 1,000 TZS to @g (username transfer, no UUID needed)"
curl -s -X POST "$B/api/transfer" -H 'Content-Type: application/json' -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: handle-$(date +%s%N)" -d '{"recipient_id":"@g","amount":1000}' | j

say "31. transfer to an unknown handle is a clean 404"
curl -s -X POST "$B/api/transfer" -H 'Content-Type: application/json' -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: bogus-$(date +%s%N)" -d '{"recipient_id":"@nosuchuser","amount":1000}' -w ' HTTP=%{http_code}\n'

say "32. a time pass she cannot afford is a clean 400 (not a 500)"
BIG=$(curl -s "$B/api/packages" | python3 -c "
import sys,json
pk=json.load(sys.stdin)['packages']
print(sorted(pk, key=lambda p: -p['price'])[0]['id'])")
curl -s -X POST "$B/api/session/buy" -H 'Content-Type: application/json' -H "$O" -b "$M_JAR" \
  -H "Idempotency-Key: big-$(date +%s%N)" -d "{\"package_id\":\"$BIG\",\"mac_address\":\"AAC222333444\"}" -w ' HTTP=%{http_code}\n'

say "33. traces: wallets, ledger, audit"
(cd "$ROOT" && npx wrangler d1 execute flat-coin-isp-db --local --command \
  "SELECT u.username, u.full_name, w.balance FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.phone_number IN ('+255712234432','+255765455654')" --json 2>/dev/null \
  | python3 -c "import sys,json;[print('  ',r) for r in json.load(sys.stdin)[0]['results']]")
(cd "$ROOT" && npx wrangler d1 execute flat-coin-isp-db --local --command \
  "SELECT u.username, t.type, t.amount, t.status, t.reference_id FROM transactions t JOIN users u ON u.id=t.user_id WHERE u.phone_number IN ('+255712234432','+255765455654') AND (t.type LIKE 'MARKETPLACE%' OR t.reference_id LIKE 'quote:%' OR t.reference_id LIKE 'transfer:%') ORDER BY t.created_at" --json 2>/dev/null \
  | python3 -c "import sys,json;[print('  ',r) for r in json.load(sys.stdin)[0]['results']]")
(cd "$ROOT" && npx wrangler d1 execute flat-coin-isp-db --local --command \
  "SELECT event_type, target_id, details_json FROM audit_outbox WHERE event_type LIKE 'marketplace.%' OR event_type LIKE 'user.%' ORDER BY event_id DESC LIMIT 12" --json 2>/dev/null \
  | python3 -c "import sys,json;[print('  ',r['event_type'],'|',(r['details_json'] or '')[:110]) for r in json.load(sys.stdin)[0]['results']]")
(cd "$ROOT" && npx wrangler d1 execute flat-coin-isp-db --local --command \
  "SELECT title, kind, price, status FROM marketplace_items ORDER BY created_at" --json 2>/dev/null \
  | python3 -c "import sys,json;[print('  ',r) for r in json.load(sys.stdin)[0]['results']]")

echo "$G_ID" > "$ROOT/.tmp-smoke/g.id"; echo "$M_ID" > "$ROOT/.tmp-smoke/m.id"
echo "$ITEM_ID" > "$ROOT/.tmp-smoke/item.id"; echo "$SW_ID" > "$ROOT/.tmp-smoke/sw.id"
echo "$CSV_ID" > "$ROOT/.tmp-smoke/csv.id"; echo "$PDF_ID" > "$ROOT/.tmp-smoke/pdf.id"
echo "$QUOTE_ID" > "$ROOT/.tmp-smoke/quote.id"
say "ids written to .tmp-smoke"
