#!/usr/bin/env bash
# One command from nothing to the full stack on a JarvisLabs CPU VM over https (REL-01/03/04/06, BON-07).
# Idempotent: re-running reuses the VM, k3s, Secrets and images that already exist and only upgrades.
#   vps-setup/up.sh            create/resume the VM → preflight → k3s → tunnel → images → cert-manager
#                              → Secrets → helm (values-prod) → certificates → demo users
#   vps-setup/up.sh --no-vm    skip the jl step (VM already running, IP in vps-setup/.state)
# Env / .env: VPS_VCPUS/VPS_RAM (4/16), VPS_REGION (IN2), VPS_DOMAIN (default <ip>.sslip.io),
#   DUCKDNS_DOMAIN + DUCKDNS_TOKEN (optional: point <name>.duckdns.org at the VM and use it as the domain),
#   TLS_ISSUER (letsencrypt-prod | letsencrypt-staging), ACME_EMAIL (optional).
# Creating a VM starts billing (vps-setup/VPS.md §2). Stop it with vps-setup/down.sh.
. "$(dirname "$0")/lib.sh"
need jl jq ssh scp kubectl helm docker node curl
CM_VERSION=v1.19.1                       # cert-manager chart (oci://quay.io/jetstack/charts)
TLS_ISSUER="${TLS_ISSUER:-letsencrypt-prod}"
[ -f "$SSH_KEY" ] || die "SSH key $SSH_KEY missing (ssh-keygen -t ed25519 -f $SSH_KEY)"
load_state

# 1. VM ----------------------------------------------------------------------------------------------
if [ "${1:-}" != "--no-vm" ]; then
  log "VM $VM_NAME (${VM_VCPUS} vCPU / ${VM_RAM} GB / ${VM_STORAGE} GB, $VM_REGION)"
  vm="$(vm_json)"
  if [ -z "$vm" ]; then
    jl status >/dev/null || die "jl is not signed in: run 'jl setup'"
    echo "creating — billing starts now"
    vm="$(jl create --vm --cpu --vcpus "$VM_VCPUS" --ram "$VM_RAM" --storage "$VM_STORAGE" \
            --region "$VM_REGION" --name "$VM_NAME" --yes --json)"
  elif [ "$(jq -r .status <<<"$vm")" = Paused ]; then
    echo "resuming paused VM $(jq -r .machine_id <<<"$vm")"
    vm="$(jl resume "$(jq -r .machine_id <<<"$vm")" --yes --json)"
  fi
  MACHINE_ID="$(jq -r .machine_id <<<"$vm")"
  # create/resume block until Running; read the instance again for its public IP.
  vm="$(jl get "$MACHINE_ID" --json)"
  [ "$(jq -r .status <<<"$vm")" = Running ] || die "VM $MACHINE_ID is $(jq -r .status <<<"$vm")"
  NEW_IP="$(jq -r '.public_ip // empty' <<<"$vm")"
  [ -n "$NEW_IP" ] || die "VM $MACHINE_ID has no public IP yet (jl get $MACHINE_ID)"
  # A new VM (or a resumed one with a new address) brings a new host key.
  if [ "$NEW_IP" != "${IP:-}" ]; then ssh-keygen -R "$NEW_IP" -f "$KNOWN_HOSTS" >/dev/null 2>&1 || true; fi
  IP="$NEW_IP"
fi
[ -n "${IP:-}" ] || die "no VM IP (run without --no-vm first)"

if [ -n "${DUCKDNS_DOMAIN:-}" ] && [ -n "${DUCKDNS_TOKEN:-}" ]; then
  # Token via curl's config on stdin, not argv (DuckDNS only takes it in the query string).
  printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=%s"\n' "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN" "$IP" \
    | curl -fsS -K - | grep -qx OK || die "DuckDNS update failed"
  DOMAIN="$DUCKDNS_DOMAIN.duckdns.org"
else
  DOMAIN="${VPS_DOMAIN:-$IP.sslip.io}"
fi
save_state
echo "machine ${MACHINE_ID:-?}  ip $IP  domain $DOMAIN"

log "waiting for SSH"
for i in $(seq 1 30); do vssh true 2>/dev/null && break; [ "$i" = 30 ] && die "no SSH to $IP"; sleep 5; done

# 2. Preflight + k3s ---------------------------------------------------------------------------------
ARCH="$(vssh uname -m)"
[ "$ARCH" = x86_64 ] || die "VM is $ARCH: images are built for amd64 only (multi-arch build needed)"

log "k3s"
if vssh 'command -v k3s >/dev/null && sudo k3s kubectl get nodes >/dev/null 2>&1'; then
  echo "k3s already running: $(vssh 'k3s --version | head -1')"
else
  # Preflight only before k3s: afterwards Traefik owns 80/443 and the port check would fail.
  log "preflight (read-only)"
  vssh 'bash -s' < "$VPS_DIR/preflight.sh"
  vscp "$VPS_DIR/install-k3s.sh" "$SSH_USER@$IP:install-k3s.sh"
  vssh 'sudo bash install-k3s.sh'
fi

log "kubeconfig + tunnel (6443 stays closed; API via 127.0.0.1:$TUNNEL_PORT)"
mkdir -p "$HOME/.kube"
( umask 077
  vssh 'sudo cat /etc/rancher/k3s/k3s.yaml' \
    | sed "s#https://127.0.0.1:6443#https://127.0.0.1:$TUNNEL_PORT#; s#: default\$#: $CTX#" > "$KUBECONFIG" )
tunnel_up
kubectl --context "$CTX" get nodes -o wide
if timeout 5 bash -c "</dev/tcp/$IP/6443" 2>/dev/null; then
  echo "WARNING: $IP:6443 is reachable from here — attach the Security Group (vps-setup/VPS.md §5)"
fi

# 3. Images: built locally, streamed into k3s's containerd (no registry; tags match values-prod) ----
log "images"
NO_K3D=1 "$REPO/scripts/build-images.sh"
. "$REPO/.images.env"
REGISTRY="$(sed -n 's/^  imageRegistry: *//p' "$REPO/charts/platform/values-prod.yaml")"
for svc in woo-mcp gateway store-assets everything-mcp dashboard; do
  var="${svc//-/_}_tag"; tag="${!var}"; ref="$REGISTRY$svc:$tag"
  if vssh "sudo k3s ctr -n k8s.io images ls -q name==$ref" | grep -q .; then echo "image $ref present"; continue; fi
  docker tag "$svc:$tag" "$ref"
  docker save "$ref" | gzip -1 | vssh 'gunzip | sudo k3s ctr -n k8s.io images import - >/dev/null'
  echo "image $ref loaded"
done

# 4. cert-manager + issuers (REL-04) -----------------------------------------------------------------
log "cert-manager $CM_VERSION"
helm upgrade --install cert-manager oci://quay.io/jetstack/charts/cert-manager --version "$CM_VERSION" \
  --kube-context "$CTX" -n cert-manager --create-namespace --set crds.enabled=true \
  -f "$VPS_DIR/cert-manager-values.yaml" --wait --timeout 10m
for env in staging prod; do
  server=https://acme-v02.api.letsencrypt.org/directory
  [ "$env" = staging ] && server=https://acme-staging-v02.api.letsencrypt.org/directory
  kubectl --context "$CTX" apply -f - <<YAML
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-$env
spec:
  acme:
    server: $server
    ${ACME_EMAIL:+email: $ACME_EMAIL}
    privateKeySecretRef: { name: letsencrypt-$env-account }
    solvers:
      - http01: { ingress: { ingressClassName: traefik } }
YAML
done

# 5. Secrets + Helm (same chart as k3d, values-prod) -------------------------------------------------
log "secrets"
"$REPO/scripts/make-secrets.sh" --context "$CTX"
log "helm upgrade --install (values-prod, domain $DOMAIN, issuer $TLS_ISSUER)"
"$REPO/scripts/deploy.sh" prod --kube-context "$CTX" \
  --set "global.domain=$DOMAIN" --set "global.tls.clusterIssuer=$TLS_ISSUER"

log "certificates"
kubectl --context "$CTX" wait --for=condition=Ready certificate --all -A --timeout=10m \
  || { kubectl --context "$CTX" get certificate,challenge -A; die "certificates not Ready"; }

# 6. Demo users (needs a publicly trusted certificate) -----------------------------------------------
export APP_ORIGIN="https://app.$DOMAIN" STORE_ORIGIN="https://store.$DOMAIN" KUBECTL_CONTEXT="$CTX"
if [ "$TLS_ISSUER" = letsencrypt-prod ]; then
  log "demo users"; node "$REPO/scripts/seed-demo-users.mjs"
else
  echo "staging certificate: skipped demo users (Node does not trust the staging CA)"
fi

log "ready"
echo "Store:     $STORE_ORIGIN"
echo "Dashboard: $APP_ORIGIN      (admin: kubectl --context $CTX -n platform get secret gateway-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
echo "MCP:       $APP_ORIGIN/mcp"
echo "kubectl:   export KUBECONFIG=$KUBECONFIG   (tunnel: vps-setup/ssh.sh tunnel)"
echo "E2E:       APP_ORIGIN=$APP_ORIGIN STORE_ORIGIN=$STORE_ORIGIN KUBECTL_CONTEXT=$CTX KUBECONFIG=$KUBECONFIG scripts/e2e.sh all"
echo "Stop billing: vps-setup/down.sh   (destroy)   or   vps-setup/down.sh --pause"
