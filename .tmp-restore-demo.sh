#!/usr/bin/env bash
# Restore the demo data the smoke runs consume: known customer passwords and a
# live marketplace for the portal. Everything goes through the public API so the
# data is shaped exactly the way a real customer would have made it.
set -u
BASE=http://127.0.0.1:8787
ORIGIN=http://127.0.0.1:8787
AJAR=.tmp-admin-cookies.txt
GJAR=.tmp-g-cookies.txt
MJAR=.tmp-m-cookies.txt

# staff session for the password reset
curl -s -c "$AJAR" -X POST $BASE/api/admin/auth/login -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' -d '{"identifier":"admin","password":"admin"}' >/dev/null

setpass() { # setpass <handle> <password>
  curl -s -b "$AJAR" -X POST "$BASE/api/admin/users/$1/password" -H "Origin: $ORIGIN" \
    -H 'Content-Type: application/json' -d "{\"password\":\"$2\"}" | head -c 160; echo
}
echo "-- credentials back to the demo values"
setpass maria MariaPortal2026Pass
setpass g GiftPortal2026Pass

echo "-- sign the sellers back in"
curl -s -c "$GJAR" -X POST $BASE/api/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"identifier":"g","password":"GiftPortal2026Pass"}' | head -c 120; echo
curl -s -c "$MJAR" -X POST $BASE/api/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"identifier":"maria","password":"MariaPortal2026Pass"}' | head -c 120; echo

mkitem() { # mkitem <jar> <json>
  curl -s -b "$1" -c "$1" -X POST $BASE/api/marketplace/items -H "Origin: $ORIGIN" \
    -H 'Content-Type: application/json' -d "$2"
}
publish() { curl -s -b "$1" -X POST "$BASE/api/marketplace/items/$2/publish" -H "Origin: $ORIGIN"; echo; }
attach() { # attach <jar> <item> <file> <mime>
  curl -s -b "$1" -X POST "$BASE/api/marketplace/items/$2/asset" -H "Origin: $ORIGIN" \
    -H "Content-Type: $4" --data-binary "@$3" -H "X-File-Name: $(basename "$3")"
}

echo "-- G lists the mini pc again (no photo, 300,000 TZS, wallet + mobile money)"
RESP=$(mkitem "$GJAR" '{"kind":"product","title":"mini pc","description":"Refurbished mini PC, 8GB RAM / 256GB SSD, boots fine, comes with a power brick. Cash or wallet.","price":300000,"negotiable":true,"pay_wallet":true,"pay_mobile_money":true,"payment_notes":"Wallet transfer is instant; Tigo/Airtel money works too.","condition":"used","location":"Dar es Salaam","contact_phone":"+255712234432"}')
MINI=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['item']['id'])" 2>/dev/null)
echo "mini pc -> $MINI"
[ -n "$MINI" ] && publish "$GJAR" "$MINI"

echo "-- and the switch with its photo, plus a tariff file"
RESP=$(mkitem "$GJAR" '{"kind":"product","title":"5-port managed mini switch","description":"Rack-mount 5-port managed switch, PoE capable.","price":45000,"negotiable":true,"pay_wallet":true,"pay_mobile_money":true,"condition":"used","location":"Dar es Salaam","contact_phone":"+255712234432"}')
SW=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['item']['id'])" 2>/dev/null)
echo "switch -> $SW"
if [ -n "$SW" ]; then
  attach "$GJAR" "$SW" .tmp-fixtures/mini-switch-photo.png image/png | head -c 200; echo
  publish "$GJAR" "$SW"
fi
RESP=$(mkitem "$GJAR" '{"kind":"file","title":"Wholesale bandwidth tariff sheet","description":"Current wholesale IP transit rates as a CSV.","price":2000,"negotiable":false,"pay_wallet":true,"pay_mobile_money":false,"condition":"new","location":"Dar es Salaam","contact_phone":"+255712234432"}')
TAR=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['item']['id'])" 2>/dev/null)
echo "tariff -> $TAR"
if [ -n "$TAR" ]; then
  attach "$GJAR" "$TAR" .tmp-fixtures/tariff-sheet.csv text/csv | head -c 200; echo
  publish "$GJAR" "$TAR"
fi

echo "-- Maria asks for a quotation on the mini pc so the console has something to moderate"
curl -s -b "$MJAR" -X POST "$BASE/api/marketplace/items/$MINI/quotes" -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' -d '{"offered_price":270000,"message":"Can you do 270,000? I can pay from my wallet today."}' | head -c 260; echo

echo "-- portal view after restore"
curl -s "$BASE/api/marketplace/items" | python3 -c "
import json,sys
d=json.load(sys.stdin)['items']
print(len(d),'public listings')
for i in d: print(' ', i['kind'], '|', i['title'], '|', i['price'], '|', ('photo' if i.get('has_asset') else 'no asset'))"
curl -s -b "$AJAR" "$BASE/api/admin/marketplace" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(len(d['items']),'console items /',len(d['quotes']),'quotes')
for q in d['quotes'][:5]: print(' ', q['status'], q.get('item_title'), q['requested_price'])"
