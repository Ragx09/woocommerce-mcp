#!/usr/bin/env bash
# Removes the local stack. Default keeps the cluster (and data); --all deletes the cluster and all data.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--all" ]; then scripts/cluster-down.sh; else helm uninstall platform -n default || true; echo "release removed; namespaces, Secrets and PVCs kept (helm.sh/resource-policy: keep)"; fi
