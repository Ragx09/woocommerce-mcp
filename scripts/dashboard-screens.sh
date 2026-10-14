#!/usr/bin/env bash
# Dashboard browser checks + screenshots in the official Playwright image (scripts in tests/e2e):
#   auth     TC-UI-03-1 sign-in / invite flow (creates a throwaway member carol-<ts>@example.invalid)
#   servers  TC-UI-04-1 server status; scales everything-mcp to 0 and back while the page is open
#            (creates a throwaway member dora-<ts>@example.invalid)
# Usage: scripts/dashboard-screens.sh [auth|servers|all] (default all). The admin credentials come from
# the K8s Secret into the container env; they are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out/screens}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
ADMIN_EMAIL="$(kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-email}' | base64 -d)"
ADMIN_PASSWORD="$(kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
export ADMIN_EMAIL ADMIN_PASSWORD
run() { # run <script.mjs>
  docker run --rm --ipc=host \
    --add-host "app.127.0.0.1.nip.io:host-gateway" \
    -v "$PWD/tests/e2e:/e2e:ro" -v "$OUT:/out" -v "$HOME/.cache/pw-runner:/runner" -w /runner \
    -e APP_URL="${APP_URL:-http://app.127.0.0.1.nip.io}" -e ADMIN_EMAIL -e ADMIN_PASSWORD \
    mcr.microsoft.com/playwright:v1.64.0-noble \
    sh -c '[ -d node_modules/playwright ] || npm i --silent --no-audit --no-fund playwright@1.64.0 >/dev/null; cp /e2e/*.mjs . && node "$0"' "$1"
}

# The servers check asks for the pod to be killed / restored through marker files in $OUT.
scaler() {
  local want
  for want in kill restore; do
    until [ -e "$OUT/.want-$want" ]; do sleep 1; done
    if [ "$want" = kill ]; then kubectl -n platform scale deploy/everything-mcp --replicas=0 >/dev/null; echo "host: everything-mcp scaled to 0"
    else kubectl -n platform scale deploy/everything-mcp --replicas=1 >/dev/null; echo "host: everything-mcp scaled to 1"; fi
  done
}

rc=0
case "${1:-all}" in auth|all) run dashboard-auth.mjs || rc=1 ;; esac
case "${1:-all}" in servers|all)
  rm -f "$OUT/.want-kill" "$OUT/.want-restore"
  scaler & spid=$!
  run dashboard-servers.mjs || rc=1
  kill "$spid" 2>/dev/null || true
  kubectl -n platform scale deploy/everything-mcp --replicas=1 >/dev/null   # whatever happened, put it back
  rm -f "$OUT/.want-kill" "$OUT/.want-restore" ;;
esac
exit $rc
