#!/usr/bin/env bash
# SEC-02: web scanners against the storefront (pinned Docker images, nothing installed on the host).
#   WPScan  — core/theme/plugin versions, user enumeration (no API token: versions only, no vuln DB)
#   nuclei  — WordPress/WooCommerce CVE, exposure and misconfiguration templates (intrusive/dos/fuzz excluded)
#   nikto   — classic misconfiguration checks (built from the 2.5.0 tag, scripts/sec/nikto.Dockerfile)
#   curl    — TC-SEC-02-x: the exact exposures from findings F-WEB-1..5 stay closed
# Reports: docs/evidence/sec-02/. Exit 1 on a failed TC or a medium+ nuclei finding.
# Usage: scripts/sec/wp-scan.sh [all|wpscan|nuclei|nikto|curl]   Env: STORE_HOST (default store.127.0.0.1.nip.io)
set -uo pipefail
cd "$(dirname "$0")/../.."
HOST="${STORE_HOST:-store.127.0.0.1.nip.io}" URL="http://${STORE_HOST:-store.127.0.0.1.nip.io}"
OUT=docs/evidence/sec-02; mkdir -p "$OUT"
ADD=(--add-host "$HOST:host-gateway")
WPSCAN=wpscanteam/wpscan:v3.8.28 NUCLEI=projectdiscovery/nuclei:v3.4.10 NUCLEI_TEMPLATES=v10.5.0 NIKTO=local/nikto:2.5.0
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }

wpscan() {
  docker run --rm "${ADD[@]}" "$WPSCAN" --url "$URL/" --no-banner --disable-tls-checks --random-user-agent \
    --enumerate vp,vt,u1-10,cb,dbe --plugins-detection mixed --format cli-no-colour >"$OUT/wpscan.txt" 2>&1
  local users
  users=$(sed -n '/User(s) Identified/,/^\[+\] Finished/p' "$OUT/wpscan.txt" | grep -cE '^\[\+\] [a-z0-9_-]+$')
  [ "$users" = 0 ] && pass "TC-SEC-02-3 WPScan identified no users" || fail "TC-SEC-02-3 WPScan identified $users user(s)"
  grep -qiE 'XML-RPC seems to be enabled' "$OUT/wpscan.txt" && fail "WPScan: XML-RPC enabled" || pass "WPScan: XML-RPC not reported"
  grep -E '^\[\+\] (WordPress version|WordPress theme in use|[a-z0-9-]+$)|Version: ' "$OUT/wpscan.txt" | head -20 | sed 's/^/      /'
}

nuclei() {
  # Templates pinned to a release (D-002 age rule) in a Docker volume, cloned once. -ni: no out-of-band
  # callbacks to the public interactsh service (third-party hosts are out of scope).
  local vol="nuclei-templates-$NUCLEI_TEMPLATES"
  docker run --rm -v "$vol:/t" alpine/git:v2.49.1 -C /t rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || docker run --rm -v "$vol:/t" alpine/git:v2.49.1 clone -q --depth 1 --branch "$NUCLEI_TEMPLATES" https://github.com/projectdiscovery/nuclei-templates.git /t
  docker run --rm "${ADD[@]}" -v "$PWD/$OUT:/out" -v "$vol:/templates:ro" "$NUCLEI" -u "$URL" -nc -duc -ni -rl 20 -c 10 \
    -t /templates -tags wordpress,wp,wp-plugin,wp-theme,woocommerce,exposure,misconfig,config,disclosure,panel \
    -etags dos,intrusive,fuzz,bruteforce -jsonl -o /out/nuclei.jsonl >"$OUT/nuclei.log" 2>&1
  local n bad loaded
  loaded=$(grep -oE 'Templates loaded for current scan: [0-9]+' "$OUT/nuclei.log" | grep -oE '[0-9]+$')
  n=$(wc -l <"$OUT/nuclei.jsonl" 2>/dev/null || echo 0)
  bad=$(grep -cE '"severity":"(medium|high|critical)"' "$OUT/nuclei.jsonl" 2>/dev/null)
  node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)) { const j=JSON.parse(l); console.log(`      ${j.info.severity.padEnd(8)} ${j["template-id"]}  ${j["matched-at"]}`) }' "$OUT/nuclei.jsonl" 2>/dev/null
  [ "${loaded:-0}" -gt 0 ] || { fail "TC-SEC-02-4 nuclei loaded no templates (see $OUT/nuclei.log)"; return; }
  [ "${bad:-0}" = 0 ] && pass "TC-SEC-02-4 nuclei: $loaded templates, $n result(s), none medium+" || fail "TC-SEC-02-4 nuclei: $bad medium+ result(s)"
}

nikto() {
  docker run --rm "${ADD[@]}" "$NIKTO" -h "$URL/" -ask no -nointeractive -Tuning 123bde -maxtime 600s >"$OUT/nikto.txt" 2>&1
  grep -E '^\+ ' "$OUT/nikto.txt" | grep -vE 'Target (IP|Hostname|Port)|Start Time|End Time|host\(s\) tested' | sed 's/^/      /' | head -30
  pass "nikto ran ($(grep -cE '^\+ /' "$OUT/nikto.txt") path item(s), reviewed in SEC-02 evidence)"
}

# code <path> [method] [curl args…] → HTTP status of an anonymous request
code() { local p="$1" m="${2:-GET}"; shift; [ $# -gt 0 ] && shift; curl -s -o /dev/null -w '%{http_code}' -X "$m" "$@" "$URL$p"; }
want() { # want <expected-regex> <TC> <path> [method] [curl args…]
  local re="$1" tc="$2"; shift 2; local got; got=$(code "$@")
  [[ "$got" =~ ^($re)$ ]] && pass "$tc ${2:-GET} $1 → $got" || fail "$tc ${2:-GET} $1 → $got (want $re)"
}
curlchecks() {
  want '401|403|404' TC-SEC-02-2  /wp-json/wp/v2/users
  want '401|403|404' TC-SEC-02-2b /wp-json/wp/v2/users/1
  want '401|403|404' TC-SEC-02-2c '/?rest_route=/wp/v2/users'
  want '403'         TC-SEC-02-5  /xmlrpc.php POST -H 'content-type: text/xml' --data '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName></methodCall>'
  want '404'         TC-SEC-02-6  '/?author=1'
  want '404'         TC-SEC-02-6b /author/admin/
  want '404'         TC-SEC-02-6c /wp-sitemap-users-1.xml
  want '403|404'     TC-SEC-02-7  /readme.html
  want '403|404'     TC-SEC-02-7b /license.txt
  want '403|404'     TC-SEC-02-7c /wp-config-sample.php
  want '403|404'     TC-SEC-02-7d /wp-links-opml.php
  local d  # directory listing: Apache's "Index of" page (an empty 200 from WordPress's index.php is fine)
  for d in /wp-content/ /wp-content/uploads/ /wp-content/plugins/ /wp-content/themes/ /wp-includes/; do
    curl -s "$URL$d" | grep -qi '<title>Index of' && fail "TC-SEC-02-8 directory listing at $d" || pass "TC-SEC-02-8 no directory listing at $d"
  done
  want '404'         TC-SEC-02-9  /wp-content/debug.log
  want '403|404'     TC-SEC-02-9b /.env
  want '403|404'     TC-SEC-02-9c /.git/HEAD
  want '401'         TC-SEC-02-10 /wp-json/wc/v3/orders
  want '401'         TC-SEC-02-10b /wp-json/wc/v3/customers
  want '200'         TC-SEC-02-11 /wp-json/wc/store/v1/products   # public by design: the storefront's own API
  local h; h=$(curl -sI "$URL/" | tr -d '\r')
  grep -qiE '^server: apache$' <<<"$h" && pass "TC-SEC-02-12 Server header without version" || fail "TC-SEC-02-12 Server: $(grep -i '^server:' <<<"$h")"
  grep -qi '^x-powered-by' <<<"$h" && fail "TC-SEC-02-12b X-Powered-By present" || pass "TC-SEC-02-12b no X-Powered-By"
  # Versioned generator tag: WordPress prints <meta name="generator" content="WordPress x.y">.
  curl -s "$URL/" | grep -qiE 'name="generator" content="(WordPress|WooCommerce) [0-9]' \
    && fail "TC-SEC-02-13 generator meta tag discloses versions" || pass "TC-SEC-02-13 no versioned generator meta tag"
  # F-WEB-6/7: the feed's generator and author, oEmbed author, ?ver= with the WordPress version, login and
  # lost-password answers that tell real and unknown accounts apart.
  local feed; feed=$(curl -s "$URL/feed/")
  grep -qi '<generator>' <<<"$feed" && fail "TC-SEC-02-14 feed <generator>" || pass "TC-SEC-02-14 no feed <generator>"
  grep -q '<dc:creator><!\[CDATA\[admin\]\]>' <<<"$feed" && fail "TC-SEC-02-15 feed author = login name" || pass "TC-SEC-02-15 feed author is not a login name"
  local post; post=$(grep -oE '<link>[^<]+</link>' <<<"$feed" | sed -n 2p | sed 's#</\?link>##g')
  if [ -n "$post" ]; then
    curl -s "$URL/wp-json/oembed/1.0/embed?url=$post" | grep -q '"author_name"' && fail "TC-SEC-02-16 oEmbed author_name" || pass "TC-SEC-02-16 no oEmbed author"
  fi
  local wpver; wpver=$(kubectl -n store exec deploy/wordpress -- sh -c "grep -oE \"wp_version = '[^']+'\" /var/www/html/wp-includes/version.php | cut -d\"'\" -f2" 2>/dev/null)
  [ -n "$wpver" ] && { curl -s "$URL/" | grep -q "ver=$wpver" && fail "TC-SEC-02-17 ?ver=$wpver in page assets" || pass "TC-SEC-02-17 WordPress version not in asset URLs"; }
  local m1 m2 c='wordpress_test_cookie=WP+Cookie+check'
  m1=$(curl -s "$URL/wp-login.php" -b "$c" -d 'log=admin&pwd=wrong-pw' | grep -o 'notice-error"><p>[^<]*<[^>]*>[^<]*' )
  m2=$(curl -s "$URL/wp-login.php" -b "$c" -d "log=nobody-$RANDOM&pwd=wrong-pw" | grep -o 'notice-error"><p>[^<]*<[^>]*>[^<]*')
  [ -n "$m1" ] && [ "$m1" = "$m2" ] && pass "TC-SEC-02-18 same login error for real and unknown user" || fail "TC-SEC-02-18 login errors differ: '$m1' vs '$m2'"
  local lp; lp=$(curl -s -o /dev/null -w '%{redirect_url}' "$URL/wp-login.php?action=lostpassword" -d "user_login=nobody-$RANDOM")
  [[ "$lp" == *checkemail=confirm* ]] && pass "TC-SEC-02-19 lost password for an unknown user looks like success" || fail "TC-SEC-02-19 lost password answer: ${lp:-no redirect}"
}

case "${1:-all}" in
  wpscan) wpscan ;; nuclei) nuclei ;; nikto) nikto ;; curl) curlchecks ;;
  all) curlchecks; wpscan; nuclei; nikto ;;
  *) echo "usage: $0 all|wpscan|nuclei|nikto|curl"; exit 2 ;;
esac
echo "failures: $fails"
exit $(( fails > 0 ))
