#!/usr/bin/env bash
# UI-03: dashboard auth flow (TC-UI-03-1) + screenshots, in the official Playwright image. The admin
# credentials come from the K8s Secret into the container env; they are never printed. Each run
# creates one throwaway member (carol-<timestamp>@example.invalid).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out/screens}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
ADMIN_EMAIL="$(kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-email}' | base64 -d)"
ADMIN_PASSWORD="$(kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
export ADMIN_EMAIL ADMIN_PASSWORD
docker run --rm --ipc=host \
  --add-host "app.127.0.0.1.nip.io:host-gateway" \
  -v "$PWD/tests/e2e:/e2e:ro" -v "$OUT:/out" -v "$HOME/.cache/pw-runner:/runner" -w /runner \
  -e APP_URL="${APP_URL:-http://app.127.0.0.1.nip.io}" -e ADMIN_EMAIL -e ADMIN_PASSWORD \
  mcr.microsoft.com/playwright:v1.64.0-noble \
  sh -c '[ -d node_modules/playwright ] || npm i --silent --no-audit --no-fund playwright@1.64.0 >/dev/null; cp /e2e/*.mjs . && node dashboard-auth.mjs'
