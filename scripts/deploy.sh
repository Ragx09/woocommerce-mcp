#!/usr/bin/env bash
# helm upgrade --install with the right values file. Usage: scripts/deploy.sh local|prod [helm args]
set -euo pipefail
cd "$(dirname "$0")/.."
env="${1:?usage: deploy.sh local|prod}"; shift
args=()
if [ -f .images.env ]; then . ./.images.env; args+=(--set "wooMcp.image.tag=${woo_mcp_tag}")
  if [ -n "${gateway_tag:-}" ]; then args+=(--set "gateway.image.tag=${gateway_tag}"); fi
fi
helm upgrade --install platform charts/platform -n default -f "charts/platform/values-$env.yaml" \
  "${args[@]}" --wait --wait-for-jobs --timeout 15m "$@"
