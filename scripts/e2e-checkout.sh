#!/usr/bin/env bash
# Runs tests/e2e/checkout.mjs in the official Playwright image (no local browser deps needed).
# The container resolves the nip.io hosts to the Docker host, where k3d publishes port 80.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
docker run --rm --ipc=host \
  --add-host "store.127.0.0.1.nip.io:host-gateway" --add-host "app.127.0.0.1.nip.io:host-gateway" \
  -v "$PWD/tests/e2e:/e2e:ro" -v "$OUT:/out" -v "$HOME/.cache/pw-runner:/runner" -w /runner \
  -e STORE_URL="${STORE_URL:-http://store.127.0.0.1.nip.io}" -e PRODUCT_SLUG \
  mcr.microsoft.com/playwright:v1.64.0-noble \
  sh -c '[ -d node_modules/playwright ] || npm i --silent --no-audit --no-fund playwright@1.64.0 >/dev/null; cp /e2e/*.mjs . && node checkout.mjs'
