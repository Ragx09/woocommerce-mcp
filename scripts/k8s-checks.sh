#!/usr/bin/env bash
# Cluster checks with explicit PASS/FAIL lines. Usage: scripts/k8s-checks.sh netpol|ingress|killpod|metrics|replicas|all
set -uo pipefail
STORE=store PLATFORM=platform DOMAIN="${DOMAIN:-127.0.0.1.nip.io}"
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }

# probe <namespace> <labels> <host> <port> → prints OPEN or CLOSED (TCP connect, 4 s timeout).
# The pod waits 3 s first: k3s's policy controller needs a moment to add a new pod's IP to the
# allow rules, and connecting immediately can give a false CLOSED. One retry on a lost result.
probe() {
  local i out
  for i in 1 2; do
    out=$(kubectl -n "$1" run "probe-$RANDOM$RANDOM" --rm -i --restart=Never --quiet --image=busybox:1.36 --labels="$2" \
      --overrides='{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"probe","image":"busybox:1.36","command":["sh","-c","sleep 3; nc -z -w 4 '"$3 $4"' && echo OPEN || echo CLOSED"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' \
      2>/dev/null | grep -E '^(OPEN|CLOSED)$' | tail -1)
    [ -n "$out" ] && { echo "$out"; return; }
  done
}
expect() { # expect <OPEN|CLOSED> <description> <probe args...>
  local want="$1" desc="$2"; shift 2
  local got; got="$(probe "$@")"
  [ "$got" = "$want" ] && pass "$desc → $got" || fail "$desc → ${got:-no result} (want $want)"
}

netpol() {
  local woo="woo-mcp.$STORE.svc.cluster.local" db="mariadb.$STORE.svc.cluster.local" wp="wordpress.$STORE.svc.cluster.local"
  # TC-SEC-02: upstream MCP server reachable only from the gateway.
  expect CLOSED "TC-SEC-02a woo-mcp from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$woo" 80
  expect CLOSED "TC-SEC-02b woo-mcp from a random pod in $STORE" "$STORE" app=intruder "$woo" 80
  expect CLOSED "TC-SEC-02c woo-mcp from default namespace" default app=gateway "$woo" 80
  expect OPEN   "TC-SEC-02d woo-mcp from app=gateway in $PLATFORM" "$PLATFORM" app=gateway "$woo" 80
  # TC-SEC-03: database reachable only from WordPress.
  expect CLOSED "TC-SEC-03a mariadb from a random pod in $STORE" "$STORE" app=intruder "$db" 3306
  expect CLOSED "TC-SEC-03b mariadb from the gateway" "$PLATFORM" app=gateway "$db" 3306
  expect OPEN   "TC-SEC-03c mariadb from app=wordpress" "$STORE" app=wordpress "$db" 3306
  # WordPress itself is public only through Traefik.
  expect CLOSED "wordpress from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$wp" 80
  # GW-13: everything-mcp ← the gateway only, and it cannot open connections itself (gzip tool SSRF).
  local ev="everything-mcp.$PLATFORM.svc.cluster.local"
  expect CLOSED "TC-GW-13-2a everything-mcp from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$ev" 80
  expect CLOSED "TC-GW-13-2b everything-mcp from $STORE" "$STORE" app=gateway "$ev" 80
  expect OPEN   "TC-GW-13-2c everything-mcp from app=gateway in $PLATFORM" "$PLATFORM" app=gateway "$ev" 80
  local out
  # Raw TCP connect to the API server's ClusterIP (the gateway, with open egress, gets OPEN here).
  out=$(kubectl -n "$PLATFORM" exec deploy/everything-mcp -- node -e \
    "const s=require('net').connect(443,'$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}')');s.setTimeout(4000);s.on('connect',()=>{console.log('OPEN');s.destroy()});s.on('timeout',()=>{console.log('CLOSED');s.destroy()});s.on('error',()=>console.log('CLOSED'))" 2>/dev/null)
  [ "$out" = CLOSED ] && pass "TC-GW-13-2d everything-mcp egress (API server by IP) → CLOSED" || fail "TC-GW-13-2d everything-mcp egress → ${out:-no result} (want CLOSED)"
  # UI-20: the dashboard (static nginx) accepts only Traefik and opens no connections itself.
  local dash="dashboard.$PLATFORM.svc.cluster.local"
  expect CLOSED "TC-UI-20-1a dashboard from a random pod in $PLATFORM" "$PLATFORM" app=intruder "$dash" 80
  expect CLOSED "TC-UI-20-1b dashboard from app=gateway in $PLATFORM" "$PLATFORM" app=gateway "$dash" 80
  out=$(kubectl -n "$PLATFORM" exec deploy/dashboard -- sh -c \
    "nc -z -w 4 $(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}') 443 && echo OPEN || echo CLOSED" 2>/dev/null)
  [ "$out" = CLOSED ] && pass "TC-UI-20-1c dashboard egress (API server by IP) → CLOSED" || fail "TC-UI-20-1c dashboard egress → ${out:-no result} (want CLOSED)"
}

ingress() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/"); [ "$code" = 200 ] && pass "store.$DOMAIN / → 200" || fail "store.$DOMAIN / → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/shop/"); [ "$code" = 200 ] && pass "store.$DOMAIN /shop/ → 200" || fail "store.$DOMAIN /shop/ → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/wp-json/wc/v3/products"); [ "$code" = 401 ] && pass "unauthenticated WC REST → 401" || fail "unauthenticated WC REST → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://woo-mcp.$DOMAIN/mcp"); [ "$code" = 404 ] && pass "no public route to woo-mcp → 404" || fail "woo-mcp public route → $code"
  # INF-11 / UI-20: app.<domain> splits between dashboard (/) and gateway (/api, /mcp). The gateway
  # sets x-request-id on every answer; nginx never does, so the header tells who answered.
  local app="http://app.$DOMAIN" got
  route() { # <label> <want: gateway|dashboard> <want code> <curl args…>
    local label="$1" want="$2" wcode="$3"; shift 3
    local h; h=$(curl -s -o /dev/null -D - "$@" | tr -d '\r')
    local c; c=$(echo "$h" | awk 'NR==1{print $2}')
    local who=dashboard; echo "$h" | grep -qi '^x-request-id:' && who=gateway
    [ "$who $c" = "$want $wcode" ] && pass "TC-INF-11-1 $label → $who $c" || fail "TC-INF-11-1 $label → $who $c (want $want $wcode)"
  }
  route "GET  /"            dashboard 200 "$app/"
  route "GET  /servers"     dashboard 200 "$app/servers"
  route "POST /mcp"         gateway 401 -X POST -H 'content-type: application/json' --data '{}' "$app/mcp"
  route "GET  /mcp"         gateway 401 "$app/mcp"          # auth first, then 405 for a key holder
  route "GET  /mcp/x"       gateway 404 "$app/mcp/x"        # Prefix route: still the gateway, not the SPA
  route "GET  /api/me"      gateway 401 "$app/api/me"
  route "GET  /healthz"     dashboard 200 "$app/healthz"   # SPA fallback: the gateway probe is not public
  got=$(curl -s "$app/" | grep -c '<div id="root"'); [ "$got" = 1 ] && pass "TC-K8S-04 dashboard index served" || fail "TC-K8S-04 no <div id=\"root\"> at $app/"
  got=$(curl -sI "$app/" | grep -ci '^content-security-policy:.*frame-ancestors .none.'); [ "$got" = 1 ] && pass "dashboard CSP header present" || fail "dashboard CSP header missing"
}

# --- GW-16: kill the everything-mcp pod; the gateway must keep serving woo + github ---------------
GW_URL="http://app.$DOMAIN/mcp"
# rpc <json-body> → "<seconds> <body>" (stateless /mcp: no initialize needed)
rpc() {
  curl -s -m 20 -w '\n%{time_total}' -X POST "$GW_URL" -H "Authorization: Bearer $MCP_KEY" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$1"
}
# list_check <label> <everything yes|no|any>: list must answer in < 3 s with woo + github.
list_check() {
  local out secs slugs
  out="$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"; secs="$(tail -1 <<<"$out")"
  slugs="$(head -n -1 <<<"$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c={};for(const t of JSON.parse(s).result.tools){const k=t.name.split("__")[0];c[k]=(c[k]||0)+1}console.log(Object.entries(c).map(([k,v])=>k+":"+v).join(" "))}catch{console.log("unparseable")}})')"
  local ok=1
  awk -v t="$secs" 'BEGIN{exit !(t<3)}' || ok=0
  grep -q 'woo:' <<<"$slugs" && grep -q 'github:' <<<"$slugs" || ok=0
  case "$2" in
    yes) grep -q 'everything:' <<<"$slugs" || ok=0 ;;
    no) grep -q 'everything:' <<<"$slugs" && ok=0 ;;
  esac
  [ $ok = 1 ] && pass "$1 → ${secs}s [$slugs]" || fail "$1 → ${secs}s [$slugs] (want < 3 s, woo + github, everything=$2)"
}
call_text() { # call_text <tool> <args-json> → first text content
  rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | head -n -1 |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(r.result?(r.result.isError?"ERROR ":"")+r.result.content[0].text:"RPCERR "+r.error.message)}catch{console.log("unparseable")}})'
}
# wait_status <from-time> <status> <timeout-s> → seconds until the gateway logs everything → <status>
wait_status() {
  local i
  for ((i = 0; i < $3; i++)); do
    kubectl -n "$PLATFORM" logs -l app=gateway --since-time="$1" --tail=-1 2>/dev/null |
      grep '"upstream status changed"' | grep '"upstream":"everything"' | grep -q "\"to\":\"$2\"" && { echo "$i"; return 0; }
    sleep 1
  done
  return 1
}
killpod() {
  # A temporary admin API key for this run, revoked on exit (AUTH-08: no shared key any more).
  if [ -z "${MCP_KEY:-}" ]; then
    local created; created="$(node "$(dirname "$0")/lib/gateway-key.mjs" create k8s-checks-killpod)" || { fail "could not create a temporary API key"; return; }
    MCP_KEY="${created#* }"; TEMP_KEY_ID="${created%% *}"
    trap 'node "$(dirname "$0")/lib/gateway-key.mjs" revoke "$TEMP_KEY_ID" >/dev/null 2>&1' EXIT
  fi
  local t secs out
  list_check "TC-GW-16-0 baseline list" yes

  # 1. Scale to 0 (the pod is gone, the Service has no endpoints).
  t="$(date -u +%FT%TZ)"
  kubectl -n "$PLATFORM" scale deploy/everything-mcp --replicas=0 >/dev/null
  kubectl -n "$PLATFORM" wait --for=delete pod -l app=everything-mcp --timeout=60s >/dev/null 2>&1
  list_check "TC-GW-16-1a list right after scale 0" no
  secs="$(wait_status "$t" unreachable 30)" && pass "TC-GW-16-1b everything → Unreachable (${secs}s after the pod was gone)" || fail "TC-GW-16-1b no Unreachable status within 30 s"
  list_check "TC-GW-16-1c list while Unreachable" no
  out="$(call_text everything__echo '{"message":"x"}')"
  [[ "$out" == "ERROR upstream_unreachable:"* ]] && pass "TC-GW-16-1d everything__echo → ${out:0:70}" || fail "TC-GW-16-1d everything__echo → ${out:0:120}"
  out="$(call_text woo__list_products '{"per_page":1}')"
  [[ "$out" != ERROR* && "$out" != RPCERR* && "$out" != unparseable ]] && pass "TC-GW-16-1e woo__list_products still works" || fail "TC-GW-16-1e woo__list_products → ${out:0:120}"

  # 2. Scale back to 1 → Connected within 20 s of the pod being Ready.
  t="$(date -u +%FT%TZ)"
  kubectl -n "$PLATFORM" scale deploy/everything-mcp --replicas=1 >/dev/null
  kubectl -n "$PLATFORM" rollout status deploy/everything-mcp --timeout=120s >/dev/null
  secs="$(wait_status "$t" connected 20)" && pass "TC-GW-16-2a everything → Connected ${secs}s after Ready" || fail "TC-GW-16-2a not Connected within 20 s of Ready"
  list_check "TC-GW-16-2b list after recovery" yes
  out="$(call_text everything__echo '{"message":"back"}')"
  [ "$out" = "Echo: back" ] && pass "TC-GW-16-2c everything__echo → $out" || fail "TC-GW-16-2c everything__echo → ${out:0:120}"

  # 3. kubectl delete pod: the Deployment starts a replacement at once, so everything may already be
  # back (or briefly missing) when we look; woo + github must be there either way. The old MCP
  # session dies with the pod, so the gateway must reconnect to the new one.
  kubectl -n "$PLATFORM" delete pod -l app=everything-mcp --wait=true >/dev/null
  list_check "TC-GW-16-3a list right after the pod was deleted" any
  kubectl -n "$PLATFORM" rollout status deploy/everything-mcp --timeout=120s >/dev/null
  kubectl -n "$PLATFORM" wait --for=condition=Ready pod -l app=everything-mcp --timeout=120s >/dev/null
  local i
  for ((i = 0; i < 20; i++)); do
    out="$(call_text everything__echo '{"message":"new pod"}')"; [ "$out" = "Echo: new pod" ] && break; sleep 1
  done
  [ "$out" = "Echo: new pod" ] && pass "TC-GW-16-3b new pod serves everything__echo ${i}s after Ready (new session)" || fail "TC-GW-16-3b everything__echo → ${out:0:120}"
  list_check "TC-GW-16-3c list after the new pod" yes
}

# --- BON-03: gateway /metrics — internal port only, scraper label only, counts follow real calls -----
# scrape <namespace> <labels> <url> → the body (busybox wget, 5 s timeout), or nothing.
scrape() {
  kubectl -n "$1" run "scrape-$RANDOM$RANDOM" --rm -i --restart=Never --quiet --image=busybox:1.36 --labels="$2" \
    --overrides='{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"scrape","image":"busybox:1.36","command":["sh","-c","sleep 3; wget -q -T 5 -O- '"$3"' || echo SCRAPE-FAILED"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' \
    2>/dev/null
}
metric() { # metric <body> <series> → value or 0
  awk -v s="$2" '$1 == s { print $2; found=1 } END { if (!found) print 0 }' <<<"$1"
}
metrics() {
  if [ -z "${MCP_KEY:-}" ]; then
    local created; created="$(node "$(dirname "$0")/lib/gateway-key.mjs" create k8s-checks-metrics)" || { fail "could not create a temporary API key"; return; }
    MCP_KEY="${created#* }"; TEMP_KEY_ID="${created%% *}"
    trap 'node "$(dirname "$0")/lib/gateway-key.mjs" revoke "$TEMP_KEY_ID" >/dev/null 2>&1' EXIT
  fi
  local ip url before after body series='mcp_tool_calls_total{upstream="woo",outcome="ok",source="mcp"}'
  ip="$(kubectl -n "$PLATFORM" get pod -l app=gateway -o jsonpath='{.items[0].status.podIP}')"
  url="http://$ip:9464/metrics"
  local pub; pub="$(curl -s -m 10 "http://app.$DOMAIN/metrics")"
  grep -q 'mcp_tool_calls_total' <<<"$pub" && fail "TC-BON-03-2a /metrics through the Ingress exposes gateway metrics" \
    || pass "TC-BON-03-2a /metrics through the Ingress → no gateway metrics (dashboard SPA)"
  expect CLOSED "TC-BON-03-2b metrics port from an unlabelled pod in $PLATFORM" "$PLATFORM" app=intruder "$ip" 9464
  expect CLOSED "TC-BON-03-2c metrics port from an unlabelled pod in $STORE" "$STORE" app=intruder "$ip" 9464
  body="$(scrape "$PLATFORM" platform.io/metrics-scraper=true "$url")"
  before="$(metric "$body" "$series")"
  grep -q '^# TYPE mcp_tool_call_duration_seconds histogram' <<<"$body" && grep -q '^mcp_upstream_up{upstream="woo",status="connected"} 1' <<<"$body" \
    && pass "TC-BON-03-2d labelled scraper gets /metrics (histogram + mcp_upstream_up woo=1; woo ok calls so far: $before)" \
    || fail "TC-BON-03-2d labelled scraper → $(head -c 200 <<<"$body")"
  local out; out="$(call_text woo__list_orders '{"per_page":1}')"; out="$(call_text woo__list_orders '{"per_page":1}')"
  body="$(scrape "$PLATFORM" platform.io/metrics-scraper=true "$url")"
  after="$(metric "$body" "$series")"
  [ "$after" = "$((before + 2))" ] && pass "TC-BON-03-2e two woo__list_orders calls → counter $before → $after" \
    || fail "TC-BON-03-2e counter $before → $after (want +2; last call: ${out:0:80})"
  grep -qE 'mgw_|list_orders|@' <<<"$body" && fail "TC-BON-03-2f metrics contain a key, tool name or e-mail" \
    || pass "TC-BON-03-2f no keys, tool names or e-mails in the metrics"
  local stats; stats="$(node --input-type=module -e '
    import { adminSession } from "./scripts/lib/gateway-key.mjs";
    const origin = process.env.APP_ORIGIN ?? "http://app.127.0.0.1.nip.io";
    const r = await fetch(`${origin}/api/upstreams`, { headers: { cookie: await adminSession() } });
    const woo = (await r.json()).find((u) => u.slug === "woo");
    console.log(JSON.stringify(woo.stats));' stats)"   # an argv[1], so gateway-key.mjs does not run as a CLI
  node -e 'const s=JSON.parse(process.argv[1]); process.exit(s && s.calls >= 2 && s.p95Ms !== null ? 0 : 1)' "$stats" \
    && pass "TC-BON-03-3b dashboard API woo stats (last hour, all replicas): $stats" || fail "TC-BON-03-3b dashboard stats: $stats"
}

# --- BON-04: two gateway replicas — spread, sessions anywhere, a pod kill under load, shared per-key limit ---
replicas() {
  if [ -z "${MCP_KEY:-}" ]; then
    local created; created="$(node "$(dirname "$0")/lib/gateway-key.mjs" create k8s-checks-replicas)" || { fail "could not create a temporary API key"; return; }
    MCP_KEY="${created#* }"; TEMP_KEY_ID="${created%% *}"
    trap 'node "$(dirname "$0")/lib/gateway-key.mjs" revoke "$TEMP_KEY_ID" >/dev/null 2>&1' EXIT
  fi
  local ready pods since i n0 n1
  ready="$(kubectl -n "$PLATFORM" get deploy gateway -o jsonpath='{.status.readyReplicas}')"
  [ "${ready:-0}" -ge 2 ] && pass "TC-BON-04-2a gateway has $ready ready replicas" || fail "TC-BON-04-2a gateway ready replicas: ${ready:-0} (want ≥ 2)"
  [ "$(kubectl -n "$PLATFORM" get pdb gateway -o jsonpath='{.spec.minAvailable}' 2>/dev/null)" = 1 ] \
    && pass "TC-BON-04-2b PodDisruptionBudget gateway minAvailable=1" || fail "TC-BON-04-2b no PodDisruptionBudget"

  # Spread: Traefik balances over both pods; each pod logs the tools/list it served.
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; sleep 1
  for i in $(seq 20); do rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' >/dev/null; done
  read -r -a pods <<<"$(kubectl -n "$PLATFORM" get pods -l app=gateway -o jsonpath='{.items[*].metadata.name}')"
  n0="$(kubectl -n "$PLATFORM" logs "${pods[0]}" --since-time="$since" | grep -c '"msg":"tools/list"')"
  n1="$(kubectl -n "$PLATFORM" logs "${pods[1]}" --since-time="$since" | grep -c '"msg":"tools/list"')"
  [ "$n0" -gt 0 ] && [ "$n1" -gt 0 ] && [ $((n0 + n1)) -eq 20 ] && pass "TC-BON-04-2c 20 tools/list spread over both pods ($n0 + $n1)" \
    || fail "TC-BON-04-2c tools/list per pod: $n0 + $n1 (want both > 0, total 20)"

  # Dashboard session created on one replica works on the other (sessions in Postgres).
  local ok; ok="$(node --input-type=module -e '
    import { adminSession } from "./scripts/lib/gateway-key.mjs";
    const origin = process.env.APP_ORIGIN ?? "http://app.127.0.0.1.nip.io";
    const cookie = await adminSession(); let ok = 0;
    for (let i = 0; i < 10; i++) if ((await fetch(`${origin}/api/me`, { headers: { cookie } })).status === 200) ok++;
    console.log(ok);' session)"
  [ "$ok" = 10 ] && pass "TC-BON-04-2d one dashboard session, 10 × /api/me over both replicas → 10 × 200" || fail "TC-BON-04-2d /api/me ok $ok/10"

  # Kill one pod while a client keeps calling: no failed request (graceful shutdown + endpoint removal).
  local results="$(mktemp)" bad total
  ( for i in $(seq 40); do
      out="$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"woo__list_orders","arguments":{"per_page":1}}}' | head -n -1)"
      grep -q '"result"' <<<"$out" && grep -qv '"isError":true' <<<"$out" && echo ok >>"$results" || echo "bad ${out:0:100}" >>"$results"
      sleep 0.25
    done ) &
  local loop=$!
  sleep 2; kubectl -n "$PLATFORM" delete pod "${pods[0]}" --wait=false >/dev/null
  wait $loop
  total="$(wc -l <"$results")"; bad="$(grep -c '^bad' "$results")"
  [ "$total" = 40 ] && [ "$bad" = 0 ] && pass "TC-BON-04-2e pod ${pods[0]} deleted during 40 woo__list_orders calls → 0 failed" \
    || fail "TC-BON-04-2e $bad of $total calls failed while a pod was deleted: $(grep -m1 '^bad' "$results")"
  rm -f "$results"
  kubectl -n "$PLATFORM" rollout status deploy/gateway --timeout=120s >/dev/null && pass "TC-BON-04-2f replacement pod Ready" || fail "TC-BON-04-2f rollout"

  # Shared per-key limit through the Ingress (both replicas): limit + 20 requests, 20 at a time, so they all
  # land in one window (sequential calls can take longer than the window). At most `limit` may succeed.
  local limit codes ok429 ok200 retry
  limit="$(kubectl -n "$PLATFORM" get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MCP_RATE_LIMIT_PER_APIKEY")].value}')"
  codes="$(seq $((limit + 20)) | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code}\n' -m 20 -X POST "$GW_URL" -H "Authorization: Bearer $MCP_KEY" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  ok200="$(grep -c '^200$' <<<"$codes")"; ok429="$(grep -c '^429$' <<<"$codes")"
  retry="$(curl -s -D - -o /dev/null -m 10 -X POST "$GW_URL" -H "Authorization: Bearer $MCP_KEY" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tr -d '\r' | awk -F': ' 'tolower($1)=="retry-after"{print $2}')"
  [ "$ok200" -le "$limit" ] && [ "$ok429" -ge 20 ] && [ $((ok200 + ok429)) -eq $((limit + 20)) ] && [ "${retry:-0}" -gt 0 ] \
    && pass "TC-BON-04-2g per-key limit $limit/min across both replicas: $((limit + 20)) parallel requests → $ok200 × 200, $ok429 × 429, Retry-After ${retry} s" \
    || fail "TC-BON-04-2g $((limit + 20)) requests → $ok200 × 200, $ok429 × 429 (want ≤ $limit and ≥ 20), Retry-After '${retry}'"
}

case "${1:-all}" in
  netpol) netpol ;;
  ingress) ingress ;;
  killpod) killpod ;;
  metrics) metrics ;;
  replicas) replicas ;;
  all) ingress; netpol ;;
  *) echo "usage: $0 netpol|ingress|killpod|metrics|replicas|all" >&2; exit 2 ;;
esac
echo "failures: $fails"
exit $((fails > 0))
