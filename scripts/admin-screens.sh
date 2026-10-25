#!/usr/bin/env bash
# BRD-08: wp-admin / login branding check in the official Playwright image. Reads the admin
# password from the K8s Secret into the container env; it is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out/screens}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
# BON-11: scripts/admin-screens.sh ridgeline → the Ridgeline store (namespace store-ridgeline).
BRAND="${1:-tatva}"; NS=store; STORE_URL="${STORE_URL:-http://store.127.0.0.1.nip.io}"
if [ "$BRAND" = ridgeline ]; then NS=store-ridgeline; STORE_URL=http://ridgeline.store.127.0.0.1.nip.io; fi
ADMIN_PASSWORD="$(kubectl -n "$NS" get secret wordpress-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
ADMIN_USER="$(kubectl -n "$NS" get secret wordpress-admin -o jsonpath='{.data.admin-user}' | base64 -d)"
STORE_HOST="${STORE_URL#*://}"
export ADMIN_PASSWORD ADMIN_USER BRAND STORE_URL
docker run --rm --ipc=host \
  --add-host "$STORE_HOST:host-gateway" \
  -v "$PWD/tests/e2e:/e2e:ro" -v "$OUT:/out" -v "$HOME/.cache/pw-runner:/runner" -w /runner \
  -e STORE_URL -e ADMIN_PASSWORD -e ADMIN_USER -e BRAND \
  mcr.microsoft.com/playwright:v1.64.0-noble \
  sh -c '[ -d node_modules/playwright ] || npm i --silent --no-audit --no-fund playwright@1.64.0 >/dev/null; cp /e2e/*.mjs . && node admin-screens.mjs'
