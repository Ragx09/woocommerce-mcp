#!/usr/bin/env bash
# BRD-08: wp-admin / login branding check in the official Playwright image. Reads the admin
# password from the K8s Secret into the container env; it is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out/screens}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
ADMIN_PASSWORD="$(kubectl -n store get secret wordpress-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
export ADMIN_PASSWORD
docker run --rm --ipc=host \
  --add-host "store.127.0.0.1.nip.io:host-gateway" \
  -v "$PWD/tests/e2e:/e2e:ro" -v "$OUT:/out" -v "$HOME/.cache/pw-runner:/runner" -w /runner \
  -e STORE_URL="${STORE_URL:-http://store.127.0.0.1.nip.io}" -e ADMIN_PASSWORD \
  mcr.microsoft.com/playwright:v1.64.0-noble \
  sh -c '[ -d node_modules/playwright ] || npm i --silent --no-audit --no-fund playwright@1.64.0 >/dev/null; cp /e2e/*.mjs . && node admin-screens.mjs'
