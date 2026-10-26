#!/usr/bin/env bash
# BRD-07: storefront screenshots + image/console audit in the official Playwright image.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out/screens}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
# Any store (BON-11/17): STORE_URL=http://<slug>.store.127.0.0.1.nip.io scripts/storefront-screens.sh
STORE_URL="${STORE_URL:-http://store.127.0.0.1.nip.io}"; STORE_HOST="${STORE_URL#*://}"; STORE_HOST="${STORE_HOST%%/*}"
docker run --rm --ipc=host \
  --add-host "$STORE_HOST:host-gateway" \
  -v "$PWD/tests/e2e:/e2e:ro" -v "$OUT:/out" -v "$HOME/.cache/pw-runner:/runner" -w /runner \
  -e STORE_URL="$STORE_URL" -e PAGES="${PAGES:-}" \
  mcr.microsoft.com/playwright:v1.64.0-noble \
  sh -c '[ -d node_modules/playwright ] || npm i --silent --no-audit --no-fund playwright@1.64.0 >/dev/null; cp /e2e/*.mjs . && node screens.mjs'
