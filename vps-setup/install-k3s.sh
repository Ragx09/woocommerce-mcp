#!/usr/bin/env bash
# Installs k3s on the VPS, pinned to the same version k3d runs locally (REL-01).
# Run ON the VPS: sudo bash install-k3s.sh   (vps-setup/up.sh copies and runs it for you)
# The API server (6443) stays closed to the internet; kubectl reaches it through an SSH tunnel.
set -euo pipefail
K3S_VERSION="${K3S_VERSION:-v1.35.5+k3s1}"   # keep in sync with `k3d version` (local k3s)

# Keep the real client IP (AUTH-02): with the default externalTrafficPolicy=Cluster, k3s's service
# load balancer SNATs every request, so Traefik and the gateway see one node IP for all clients and the
# per-IP login limit becomes global (anyone could lock the admin out). Local keeps the source address;
# fine on a single node. Traefik replaces any client-sent X-Forwarded-For, and the gateway trusts exactly
# one proxy hop. k3s applies this file when it starts.
install -d -m 700 /var/lib/rancher/k3s/server/manifests
cat > /var/lib/rancher/k3s/server/manifests/traefik-config.yaml <<'YAML'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      spec:
        externalTrafficPolicy: Local
YAML

# Traefik and local-path stay enabled: the charts rely on both, exactly as on k3d.
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
  --write-kubeconfig-mode 600

# `wait` fails with "no matching resources" if the node has not registered yet, so wait for it first.
for _ in $(seq 1 60); do k3s kubectl get nodes -o name 2>/dev/null | grep -q . && break; sleep 3; done
k3s kubectl wait --for=condition=Ready node --all --timeout=180s
k3s kubectl get nodes -o wide
k3s kubectl get storageclass
echo
echo "Next, on your workstation (keep the kubeconfig out of git):"
echo "  ssh <alias> sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/vps.yaml && chmod 600 ~/.kube/vps.yaml"
echo "  ssh -fN -L 16443:127.0.0.1:6443 <alias>"
echo "  sed -i 's#127.0.0.1:6443#127.0.0.1:16443#' ~/.kube/vps.yaml"
echo "  KUBECONFIG=~/.kube/vps.yaml kubectl get nodes"
