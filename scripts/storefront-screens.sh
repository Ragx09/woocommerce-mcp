#!/usr/bin/env bash
# BRD-07: storefront screenshots + image/console audit in the official Playwright image.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out/screens}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
docker run --rm --ipc=host \
  --add-host "store.127.0.0.1.nip.io:host-gateway" \
  -v "$PWD/tests/e2e:/e2e:ro" -v "$OUT:/out" -v "$HOME/.cache/pw-runner:/runner" -w /runner \
  -e STORE_URL="${STORE_URL:-http://store.127.0.0.1.nip.io}" -e PAGES="${PAGES:-}" \
  mcr.microsoft.com/playwright:v1.64.0-noble \
  sh -c '[ -d node_modules/playwright ] || npm i --silent --no-audit --no-fund playwright@1.64.0 >/dev/null; cp /e2e/*.mjs . && node screens.mjs'
