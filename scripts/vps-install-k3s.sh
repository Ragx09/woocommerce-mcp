#!/usr/bin/env bash
# Installs k3s on the VPS, pinned to the same version k3d runs locally (REL-01).
# Run ON the VPS: sudo bash vps-install-k3s.sh
# The API server (6443) stays closed to the internet; kubectl reaches it through an SSH tunnel.
set -euo pipefail
K3S_VERSION="${K3S_VERSION:-v1.35.5+k3s1}"   # keep in sync with `k3d version` (local k3s)

# Traefik and local-path stay enabled: the charts rely on both, exactly as on k3d.
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
  --write-kubeconfig-mode 600

k3s kubectl wait --for=condition=Ready node --all --timeout=180s
k3s kubectl get nodes -o wide
k3s kubectl get storageclass
echo
echo "Next, on your workstation (keep the kubeconfig out of git):"
echo "  ssh <alias> sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/vps.yaml && chmod 600 ~/.kube/vps.yaml"
echo "  ssh -fN -L 16443:127.0.0.1:6443 <alias>"
echo "  sed -i 's#127.0.0.1:6443#127.0.0.1:16443#' ~/.kube/vps.yaml"
echo "  KUBECONFIG=~/.kube/vps.yaml kubectl get nodes"
