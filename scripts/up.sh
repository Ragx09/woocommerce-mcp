#!/usr/bin/env bash
# One command from nothing to a running local stack (INF-15).
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/cluster-up.sh
scripts/make-secrets.sh
scripts/build-images.sh
scripts/deploy.sh local
kubectl wait --for=condition=Ready pod -l 'app.kubernetes.io/part-of=platform,app!=wp-init' -A --timeout=300s
echo
echo "Store:      http://store.127.0.0.1.nip.io"
echo "WP admin:   http://store.127.0.0.1.nip.io/wp-admin  (user: admin; password:"
echo "            kubectl -n store get secret wordpress-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
echo "Gateway:    http://app.127.0.0.1.nip.io/mcp  (Bearer key until AUTH-08:"
echo "            kubectl -n platform get secret gateway-dev-key -o jsonpath='{.data.key}' | base64 -d)"
