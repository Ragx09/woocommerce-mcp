#!/usr/bin/env bash
# SEC-07 (local part): security headers on the store, the dashboard and the gateway; cookie flags.
# TC-SEC-07-1 headers on every response type (HTML, static file, JSON, error), TC-SEC-07-2 cookie flags.
# On https (VPS) it also wants HSTS and the Secure flag. testssl.sh (TC-SEC-07-3) runs on the VPS only.
# Usage: scripts/sec/headers.sh   Env: STORE_URL, APP_URL (default the local nip.io hosts)
set -uo pipefail
cd "$(dirname "$0")/../.."
STORE="${STORE_URL:-http://store.127.0.0.1.nip.io}" APP="${APP_URL:-http://app.127.0.0.1.nip.io}"
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }

# check <label> <curl args…>: the response's headers must carry every protection.
check() {
  local label="$1"; shift
  local h; h=$(curl -s -o /dev/null -D - "$@" | tr -d '\r' | tr 'A-Z' 'a-z')
  local miss=()
  grep -q '^x-content-type-options: nosniff' <<<"$h" || miss+=(nosniff)
  grep -qE '^x-frame-options: (deny|sameorigin)|^content-security-policy:.*frame-ancestors' <<<"$h" || miss+=(frame-protection)
  grep -q '^referrer-policy:' <<<"$h" || miss+=(referrer-policy)
  grep -q '^content-security-policy:' <<<"$h" || miss+=(csp)
  if [[ "$STORE$APP" == *https://* ]]; then grep -q '^strict-transport-security: max-age=' <<<"$h" || miss+=(hsts); fi
  grep -qE '^(x-powered-by|server: .*[0-9])' <<<"$h" && miss+=(version-banner)
  [ ${#miss[@]} = 0 ] && pass "TC-SEC-07-1 $label" || fail "TC-SEC-07-1 $label: missing ${miss[*]}"
}

check "store /"                    "$STORE/"
check "store /shop/"               "$STORE/shop/"
check "store /wp-login.php"        "$STORE/wp-login.php"
check "store static file"          "$STORE/wp-includes/images/blank.gif"
check "store Store API JSON"       "$STORE/wp-json/wc/store/v1/products?per_page=1"
check "store 404"                  "$STORE/no-such-page-$RANDOM/"
check "dashboard /"                "$APP/"
check "dashboard /login"           "$APP/login"
asset=$(curl -s "$APP/" | grep -oE '/assets/[^"]+\.js' | head -1)
[ -n "$asset" ] && check "dashboard asset $asset" "$APP$asset"
check "gateway /api/me (401)"      "$APP/api/me"
check "gateway /api/auth/login (400)" -X POST -H 'content-type: application/json' --data '{}' "$APP/api/auth/login"
check "gateway /mcp (401)"         -X POST -H 'content-type: application/json' --data '{}' "$APP/mcp"
no_store=$(curl -s -o /dev/null -D - "$APP/api/me" | tr -d '\r' | grep -ci '^cache-control: no-store')
[ "$no_store" = 1 ] && pass "TC-SEC-07-1b gateway JSON is Cache-Control: no-store" || fail "TC-SEC-07-1b gateway JSON may be cached"

# TC-SEC-07-2: cookie flags. Dashboard session (login as the seeded admin, password from the Secret, not printed).
pw=$(kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-password}' | base64 -d)
em=$(kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-email}' | base64 -d)
sid=$(curl -s -o /dev/null -D - -X POST -H 'content-type: application/json' -H "origin: $APP" \
  --data "$(node -e 'console.log(JSON.stringify({email:process.argv[1],password:process.argv[2]}))' "$em" "$pw")" "$APP/api/auth/login" \
  | tr -d '\r' | grep -i '^set-cookie: sid=')
cookie_flags() { # <label> <set-cookie line>
  local miss=() l; l=$(tr 'A-Z' 'a-z' <<<"$2")
  grep -q 'httponly' <<<"$l" || miss+=(HttpOnly)
  grep -qE 'samesite=(strict|lax)' <<<"$l" || miss+=(SameSite)
  if [[ "$APP" == https://* ]]; then grep -q 'secure' <<<"$l" || miss+=(Secure); fi
  [ -n "$2" ] && [ ${#miss[@]} = 0 ] && pass "TC-SEC-07-2 $1 cookie flags" || fail "TC-SEC-07-2 $1 cookie: ${2:-not set} (missing ${miss[*]:-cookie})"
}
cookie_flags "dashboard sid" "$sid"
s=$(sed -n 's/^set-cookie: \(sid=[^;]*\).*/\1/Ip' <<<"$sid")
[ -n "$s" ] && curl -s -o /dev/null -X POST -H "origin: $APP" -H "cookie: $s" "$APP/api/auth/logout"
# WooCommerce guest session cookie (set when something goes into the cart).
ct=$(curl -s -D - -o /dev/null "$STORE/wp-json/wc/store/v1/cart" | tr -d '\r' | grep -i '^nonce:' | awk '{print $2}')
wc=$(curl -s -D - -o /dev/null -X POST -H "nonce: $ct" -H 'content-type: application/json' --data '{"id":95,"quantity":1}' \
  "$STORE/wp-json/wc/store/v1/cart/add-item" | tr -d '\r' | grep -i '^set-cookie: wp_woocommerce_session_' | head -1)
cookie_flags "WooCommerce session" "$wc"
echo "failures: $fails"
exit $(( fails > 0 ))
