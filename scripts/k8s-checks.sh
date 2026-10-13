#!/usr/bin/env bash
# Cluster checks with explicit PASS/FAIL lines. Usage: scripts/k8s-checks.sh netpol|ingress|killpod|all
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
}

ingress() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/"); [ "$code" = 200 ] && pass "store.$DOMAIN / → 200" || fail "store.$DOMAIN / → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/shop/"); [ "$code" = 200 ] && pass "store.$DOMAIN /shop/ → 200" || fail "store.$DOMAIN /shop/ → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://store.$DOMAIN/wp-json/wc/v3/products"); [ "$code" = 401 ] && pass "unauthenticated WC REST → 401" || fail "unauthenticated WC REST → $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://woo-mcp.$DOMAIN/mcp"); [ "$code" = 404 ] && pass "no public route to woo-mcp → 404" || fail "woo-mcp public route → $code"
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

case "${1:-all}" in
  netpol) netpol ;;
  ingress) ingress ;;
  killpod) killpod ;;
  all) ingress; netpol ;;
  *) echo "usage: $0 netpol|ingress|killpod|all" >&2; exit 2 ;;
esac
echo "failures: $fails"
exit $((fails > 0))
