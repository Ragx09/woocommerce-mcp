#!/usr/bin/env bash
# Runs the woo-mcp integration tests against the cluster: port-forward + token from the Secret.
set -euo pipefail
cd "$(dirname "$0")/.."
kubectl -n store port-forward svc/woo-mcp 18090:80 >/dev/null 2>&1 & PF=$!
trap 'kill $PF 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null localhost:18090/healthz && break; sleep 1; done
WOO_MCP_TOKEN="$(kubectl -n store get secret woo-mcp-auth -o jsonpath='{.data.token}' | base64 -d)" \
  npm run test:int -w services/woo-mcp -- "$@"
