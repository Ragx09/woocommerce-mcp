#!/usr/bin/env bash
# Dashboard browser checks + screenshots in the official Playwright image (scripts in tests/e2e):
#   auth     TC-UI-03-1 sign-in / invite flow (creates a throwaway member carol-<ts>@example.invalid)
#   servers  TC-UI-04-1 server status; scales everything-mcp to 0 and back while the page is open
#            (creates a throwaway member dora-<ts>@example.invalid)
#   admin    TC-UI-05..08-1 add / edit / disable / delete a server (a second registration of
#            everything-mcp, removed at the end) + member view (creates erin-<ts>@example.invalid)
#   team     TC-UI-09..12-1 invite, keys, revoke, issue, disable, audit (creates fay-<ts>@example.invalid,
#            revokes its keys)
#   chat     TC-UI-16-1 chat page as the admin with the real LLM (one question; not part of `all`, to
#            save the LLM free-tier budget)
#   chat-create  UI-19 the DoD "create a product" prompt on the Chat page with the real LLM, then its storefront
#            page (creates one product "Demo Mug <stamp>"; not part of `all`)
#   chat-errors  TC-UI-18-1 chat error states: stubbed tool failures, then woo-mcp scaled to 0 and one real
#            question (restored afterwards; not part of `all`)
# Usage: scripts/dashboard-screens.sh [auth|servers|admin|team|chat|chat-create|chat-errors|all] (default all). The admin credentials come from
# the K8s Secret into the container env; they are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out/screens}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
ADMIN_EMAIL="$(kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-email}' | base64 -d)"
ADMIN_PASSWORD="$(kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
export ADMIN_EMAIL ADMIN_PASSWORD
run() { # run <script.mjs>
  docker run --rm --ipc=host \
    --add-host "app.127.0.0.1.nip.io:host-gateway" --add-host "store.127.0.0.1.nip.io:host-gateway" \
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
case "${1:-all}" in team|all) run dashboard-team.mjs || rc=1 ;; esac
case "${1:-all}" in chat) run dashboard-chat.mjs || rc=1 ;; esac
case "${1:-all}" in chat-create) run dashboard-chat-create.mjs || rc=1 ;; esac
case "${1:-all}" in chat-errors)
  kubectl -n store scale deploy/woo-mcp --replicas=0 >/dev/null; echo "host: woo-mcp scaled to 0"
  run dashboard-chat-errors.mjs || rc=1
  kubectl -n store scale deploy/woo-mcp --replicas=1 >/dev/null; echo "host: woo-mcp scaled to 1"   # whatever happened, put it back
  kubectl -n store rollout status deploy/woo-mcp --timeout=120s >/dev/null && echo "host: woo-mcp Ready" ;;
esac
case "${1:-all}" in admin|all) run dashboard-server-admin.mjs || rc=1 ;; esac
case "${1:-all}" in servers|all)
  rm -f "$OUT/.want-kill" "$OUT/.want-restore"
  scaler & spid=$!
  run dashboard-servers.mjs || rc=1
  kill "$spid" 2>/dev/null || true
  kubectl -n platform scale deploy/everything-mcp --replicas=1 >/dev/null   # whatever happened, put it back
  rm -f "$OUT/.want-kill" "$OUT/.want-restore" ;;
esac
# The suites' throwaway members (carol/dora/erin/fay-<ts>@example.invalid) cannot be deleted (audit
# history points at them); disable them and drop their sessions so they hold no access afterwards.
kubectl -n platform exec postgres-0 -- psql -U gateway -qtAc "
  DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email ~ '^(carol|dora|erin|fay)-[0-9]+@example\\.invalid$');
  UPDATE users SET disabled_at = now() WHERE disabled_at IS NULL AND email ~ '^(carol|dora|erin|fay)-[0-9]+@example\\.invalid$';" >/dev/null \
  && echo "test members disabled" || echo "WARN  could not disable test members"
exit $rc
