#!/usr/bin/env bash
# SEC-03: OWASP ZAP (zaproxy/zap-stable, pinned).
#   baseline  passive scan (spider + passive rules, no attacks) of the store and the dashboard on k3d
#   api       authenticated ZAP API scan (active) of /api and /mcp from tests/security/zap/openapi.json, once as
#             admin and once as member, against a THROWAWAY gateway (Docker: own Postgres, everything-mcp
#             upstream, random secrets), never the demo install: an active scan creates junk data.
# Gate: no High alert (unless a verified false positive with a findings row); every Medium alert triaged in
# tests/security/zap/triage.tsv (plugin id → reason); api: no unexpected 5xx from the gateway (its own logs; the
# only expected one is 503 chat_disabled: the throwaway has no LLM key).
# Reports: docs/evidence/sec-03/ (HTML, JSON, summary). Usage: scripts/sec/zap.sh [all|baseline|store|api]
set -uo pipefail
cd "$(dirname "$0")/../.."
ZAP=zaproxy/zap-stable:2.16.1
OUT=docs/evidence/sec-03; mkdir -p "$OUT"
STORE_HOST=store.127.0.0.1.nip.io APP_HOST=app.127.0.0.1.nip.io
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }
WRK="$(mktemp -d)"; chmod 777 "$WRK"   # ZAP runs as uid 1000 (zap) and writes its reports here
cleanup() { rm -rf "$WRK"; [ -n "${NET:-}" ] && { docker rm -f zap-gw zap-pg zap-ev >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }; }
trap cleanup EXIT

# summarize <name>: alerts by risk from $WRK/<name>.json → $OUT/<name>.txt; FAIL on High or untriaged Medium.
summarize() {
  # Full reports for the baselines; the API scans' (1+ MB each, thousands of fuzzed requests) stay summaries only.
  if [ "$(stat -c %s "$WRK/$1.html" 2>/dev/null || echo 0)" -lt 500000 ]; then cp "$WRK/$1.html" "$WRK/$1.json" "$OUT/" 2>/dev/null; fi
  node -e '
    const fs = require("fs");
    const triage = Object.fromEntries(fs.readFileSync("tests/security/zap/triage.tsv", "utf8").split("\n")
      .filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")).map(([id, reason]) => [id, reason]));
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const risk = ["Info", "Low", "Medium", "High"];
    let bad = 0;
    for (const site of r.site ?? []) for (const a of site.alerts ?? []) {
      // A High passes only as a verified false positive with a findings-table row ("False positive (F-…").
      const rc = Number(a.riskcode), why = triage[a.pluginid];
      const ok = rc === 3 ? /^False positive \(F-/.test(why ?? "") : Boolean(why);
      const verdict = rc >= 2 ? (ok ? "TRIAGED" : "FAIL   ") : "       ";
      if (verdict.startsWith("FAIL")) bad++;
      console.log(`${verdict} ${risk[rc].padEnd(6)} ${a.pluginid.padStart(6)} ${a.alert} (${a.count} url(s), ${site["@name"]})${why && rc >= 2 ? "\n          " + why : ""}`);
    }
    console.log(bad ? `${bad} untriaged` : "no High, every Medium triaged");
  ' "$WRK/$1.json" | tee "$OUT/$1.txt"
  grep -q 'no High, every Medium triaged' "$OUT/$1.txt" && pass "$2" || fail "$2"
}

baseline() {
  local name url
  for name in ${ONLY:-store dashboard}; do
    url="http://$([ $name = store ] && echo $STORE_HOST || echo $APP_HOST)/"
    docker run --rm --add-host "$STORE_HOST:host-gateway" --add-host "$APP_HOST:host-gateway" -v "$WRK:/zap/wrk:rw" "$ZAP" \
      zap-baseline.py -t "$url" -m 2 -I -r "$name-baseline.html" -J "$name-baseline.json" >"$OUT/$name-baseline.log" 2>&1
    summarize "$name-baseline" "TC-SEC-03-1 ZAP baseline $url"
  done
}

api() {
  [ -f .images.env ] && . ./.images.env
  local gw="gateway:${gateway_tag:?run scripts/build-images.sh first}" ev="everything-mcp:${everything_mcp_tag:?}"
  local pg; pg=$(awk '/image: postgres:/{print $2; exit}' charts/platform/values.yaml)
  local pgpw admpw ckey origin=http://gateway:8080
  pgpw=$(openssl rand -hex 16); admpw=$(openssl rand -hex 16); ckey=$(openssl rand -hex 32)
  NET="zap-$RANDOM"; docker network create "$NET" >/dev/null
  docker run -d --name zap-pg --network "$NET" --network-alias pg -e POSTGRES_USER=gateway -e POSTGRES_DB=gateway \
    -e POSTGRES_PASSWORD="$pgpw" "$pg" >/dev/null
  docker run -d --name zap-ev --network "$NET" --network-alias everything "$ev" >/dev/null
  docker run -d --name zap-gw --network "$NET" --network-alias gateway -p 127.0.0.1:18080:8080 \
    -e PGHOST=pg -e PGPASSWORD="$pgpw" -e CREDENTIALS_KEY="$ckey" -e PUBLIC_ORIGIN="$origin" -e TRUST_PROXY_HOPS=0 \
    -e ADMIN_EMAIL=zap-admin@example.invalid -e ADMIN_PASSWORD="$admpw" -e SEED_EVERYTHING_URL=http://everything:8080/mcp \
    -e LOG_LEVEL=info "$gw" >/dev/null
  local i; for i in $(seq 1 60); do curl -sf http://127.0.0.1:18080/readyz >/dev/null && break; sleep 1; done
  curl -sf http://127.0.0.1:18080/readyz >/dev/null || { fail "throwaway gateway not ready"; docker logs zap-gw 2>&1 | tail -5; return; }
  # Sessions: the seeded admin, and a member created through the invite flow.
  local G=http://127.0.0.1:18080 H=(-H 'content-type: application/json' -H "origin: $origin")
  login() { curl -s -D - -o /dev/null "${H[@]}" --data "{\"email\":\"$1\",\"password\":\"$2\"}" "$G/api/auth/login" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(sid=[^;]*\).*/\1/p'; }
  local admin member token mpw; admin=$(login zap-admin@example.invalid "$admpw"); mpw=$(openssl rand -hex 16)
  token=$(curl -s "${H[@]}" -H "cookie: $admin" --data '{"email":"zap-member@example.invalid"}' "$G/api/invites" | node -pe 'new URL(JSON.parse(require("fs").readFileSync(0)).inviteUrl).hash.slice(1)')
  curl -s -o /dev/null "${H[@]}" --data "{\"token\":\"$token\",\"name\":\"zap member\",\"password\":\"$mpw\"}" "$G/api/invites/accept"
  member=$(login zap-member@example.invalid "$mpw")
  [ -n "$admin" ] && [ -n "$member" ] || { fail "could not create the scan sessions"; return; }
  cp tests/security/zap/openapi.json "$WRK/"
  local role cookie
  for role in member admin; do
    cookie=$([ $role = admin ] && echo "$admin" || echo "$member")
    # Every request carries the session cookie and our Origin (CSRF check), via ZAP's replacer rules.
    docker run --rm --network "$NET" -v "$WRK:/zap/wrk:rw" "$ZAP" zap-api-scan.py -t /zap/wrk/openapi.json -f openapi \
      -I -r "api-$role.html" -J "api-$role.json" -z "\
-config replacer.full_list(0).description=session -config replacer.full_list(0).enabled=true -config replacer.full_list(0).matchtype=REQ_HEADER \
-config replacer.full_list(0).matchstr=Cookie -config replacer.full_list(0).regex=false -config replacer.full_list(0).replacement=$cookie \
-config replacer.full_list(1).description=origin -config replacer.full_list(1).enabled=true -config replacer.full_list(1).matchtype=REQ_HEADER \
-config replacer.full_list(1).matchstr=Origin -config replacer.full_list(1).regex=false -config replacer.full_list(1).replacement=$origin" \
      >"$OUT/api-$role.log" 2>&1
    summarize "api-$role" "TC-SEC-03-2 ZAP API scan as $role"
  done
  # TC-SEC-03-2: no 5xx (a 5xx would be an unhandled error), and no stack trace or internal message in any answer.
  local logs n5 req; logs=$(docker logs zap-gw 2>&1)
  read -r req n5 < <(node -e '
    const urls = new Map(); let req = 0; const bad = [];
    for (const l of require("fs").readFileSync(0, "utf8").split("\n")) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.msg === "incoming request") urls.set(j.reqId, `${j.req?.method} ${j.req?.url}`);
      if (j.msg !== "request completed") continue;
      req++;
      const code = j.res?.statusCode, url = urls.get(j.reqId) ?? "?";
      if (code >= 500 && !(code === 503 && /^POST \/api\/chat/.test(url))) bad.push(`${code} ${url}`.slice(0, 200));
    }
    for (const b of bad.slice(0, 5)) console.error(b);
    console.log(req, bad.length);' <<<"$logs")
  echo "throwaway gateway answered $req requests, $n5 unexpected 5xx (503 chat_disabled on /api/chat expected)" | tee -a "$OUT/api-admin.txt"
  [ "$n5" = 0 ] && pass "TC-SEC-03-2 no unexpected 5xx during the API scans ($req requests)" || fail "TC-SEC-03-2 $n5 unexpected 5xx"
  ! grep -qE 'at [A-Za-z.]+ \(/app/|node_modules/' "$WRK"/api-*.json && pass "TC-SEC-03-2 no stack trace in any recorded answer" || fail "TC-SEC-03-2 stack trace in a ZAP finding"
}

case "${1:-all}" in
  baseline) baseline ;; api) api ;;
  store) ONLY=store baseline ;;
  all) baseline; api ;;
  *) echo "usage: $0 all|baseline|api"; exit 2 ;;
esac
echo "failures: $fails"
exit $(( fails > 0 ))
