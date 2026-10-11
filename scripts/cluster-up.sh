#!/usr/bin/env bash
# Creates the local k3d cluster (idempotent) and waits for Traefik.
set -euo pipefail
cd "$(dirname "$0")/.."
if k3d cluster list mcp >/dev/null 2>&1; then
  echo "cluster 'mcp' exists"; k3d cluster start mcp >/dev/null
else
  k3d cluster create --config k3d/cluster.yaml
fi
kubectl config use-context k3d-mcp >/dev/null
for _ in $(seq 1 60); do kubectl -n kube-system get deploy traefik >/dev/null 2>&1 && break; sleep 3; done
kubectl -n kube-system rollout status deploy/traefik --timeout=180s
echo "cluster ready: $(kubectl get nodes --no-headers | awk '{print $1, $2, $5}')"
