#!/usr/bin/env bash
# Runs tests/e2e/checkout.mjs in the official Playwright image (no local browser deps needed).
# The container resolves the nip.io hosts to the Docker host, where k3d publishes port 80.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-$PWD/tests/e2e/out}"; mkdir -p "$OUT" "$HOME/.cache/pw-runner"
# The wp-admin password (Secret store/wordpress-admin) lets the test confirm the order in WooCommerce admin; never printed.
# BON-11: any store — STORE_URL=http://<slug>.store.127.0.0.1.nip.io STORE_NS=store-<slug> scripts/e2e-checkout.sh
# On the VPS, e2e.sh exports STORE_ORIGIN (https://store.<domain>) and KUBECTL_CONTEXT; use both.
STORE_URL="${STORE_URL:-${STORE_ORIGIN:-http://store.127.0.0.1.nip.io}}"; STORE_HOST="${STORE_URL#*://}"; STORE_HOST="${STORE_HOST%%/*}"
kubectl() { command kubectl ${KUBECTL_CONTEXT:+--context "$KUBECTL_CONTEXT"} "$@"; }
# Only local k3d hosts need resolving to the Docker host; public hosts use normal DNS.
HOSTS=(); case "$STORE_HOST" in *.nip.io|*.localhost) HOSTS=(--add-host "$STORE_HOST:host-gateway" --add-host "app.127.0.0.1.nip.io:host-gateway");; esac
ADMIN_PASSWORD="$(kubectl -n "${STORE_NS:-store}" get secret wordpress-admin -o jsonpath='{.data.admin-password}' 2>/dev/null | base64 -d || true)"
ADMIN_USER="$(kubectl -n "${STORE_NS:-store}" get secret wordpress-admin -o jsonpath='{.data.admin-user}' 2>/dev/null | base64 -d || echo admin)"
export ADMIN_PASSWORD ADMIN_USER STORE_URL
docker run --rm --ipc=host "${HOSTS[@]}" \
  -v "$PWD/tests/e2e:/e2e:ro" -v "$OUT:/out" -v "$HOME/.cache/pw-runner:/runner" -w /runner \
  -e STORE_URL -e PRODUCT_SLUG -e ADMIN_PASSWORD -e ADMIN_USER \
  mcr.microsoft.com/playwright:v1.64.0-noble \
  sh -c '[ -d node_modules/playwright ] || npm i --silent --no-audit --no-fund playwright@1.64.0 >/dev/null; cp /e2e/*.mjs . && node checkout.mjs'
