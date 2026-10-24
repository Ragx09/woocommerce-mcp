# Shared helpers for vps-setup/*.sh (sourced, not run). JarvisLabs CPU VM via the `jl` CLI.
# State of the current VM lives in vps-setup/.state (gitignored): MACHINE_ID, IP, DOMAIN.
set -euo pipefail
VPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$VPS_DIR/.." && pwd)"
STATE="$VPS_DIR/.state"

# Defaults; override in .env or the environment.
[ -f "$REPO/.env" ] && set -a && . "$REPO/.env" && set +a
VM_NAME="${VPS_VM_NAME:-woo-mcp-vps}"
VM_VCPUS="${VPS_VCPUS:-4}" VM_RAM="${VPS_RAM:-16}" VM_STORAGE="${VPS_STORAGE:-100}" VM_REGION="${VPS_REGION:-IN2}"
SSH_KEY="${VPS_SSH_KEY:-$HOME/.ssh/jarvis_vps}"
SSH_USER="${VPS_SSH_USER:-cloud}"
KNOWN_HOSTS="$HOME/.ssh/known_hosts_vps"
TUNNEL_PORT="${VPS_TUNNEL_PORT:-16443}"
TUNNEL_SOCK="$HOME/.ssh/vps-tunnel.sock"
export KUBECONFIG="$HOME/.kube/vps.yaml"   # never the repo; context name "vps"
CTX=vps

log() { printf '\n== %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
need() { for c in "$@"; do command -v "$c" >/dev/null || die "missing command: $c"; done; }

load_state() { [ -f "$STATE" ] && . "$STATE" || true; }
save_state() { umask 077; printf 'MACHINE_ID=%s\nIP=%s\nDOMAIN=%s\n' "${MACHINE_ID:-}" "${IP:-}" "${DOMAIN:-}" > "$STATE"; }

# The VM with our name, as JSON (empty when there is none).
vm_json() { jl list --json 2>/dev/null | jq -c --arg n "$VM_NAME" '[.[] | select(.name == $n)] | first // empty'; }

SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new
          -o ConnectTimeout=10 -o ServerAliveInterval=30)
vssh() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "$@"; }
vscp() { scp "${SSH_OPTS[@]}" "$@"; }

tunnel_up() {
  if ssh -S "$TUNNEL_SOCK" -O check "$SSH_USER@$IP" 2>/dev/null; then return; fi
  ssh "${SSH_OPTS[@]}" -f -N -M -S "$TUNNEL_SOCK" -L "127.0.0.1:$TUNNEL_PORT:127.0.0.1:6443" "$SSH_USER@$IP"
}
tunnel_down() { ssh -S "$TUNNEL_SOCK" -O exit "$SSH_USER@${IP:-x}" 2>/dev/null || true; }
