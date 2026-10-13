#!/usr/bin/env bash
# Cluster checks with explicit PASS/FAIL lines. Usage: scripts/k8s-checks.sh netpol|ingress|all
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

case "${1:-all}" in
  netpol) netpol ;;
  ingress) ingress ;;
  all) ingress; netpol ;;
  *) echo "usage: $0 netpol|ingress|all" >&2; exit 2 ;;
esac
echo "failures: $fails"
exit $((fails > 0))
