#!/usr/bin/env bash
# Shell on the VM, a command on it, or the kubectl tunnel again (e.g. after the laptop slept).
#   vps-setup/ssh.sh                 interactive shell
#   vps-setup/ssh.sh <command…>      run a command (e.g. vps-setup/ssh.sh free -h)
#   vps-setup/ssh.sh tunnel          (re)open the 127.0.0.1:16443 → 6443 tunnel for kubectl
#   vps-setup/ssh.sh status          VM status from jl, tunnel and node
. "$(dirname "$0")/lib.sh"
load_state
case "${1:-}" in
  tunnel) [ -n "${IP:-}" ] || die "no VM IP in $STATE"; tunnel_up; kubectl --context "$CTX" get nodes ;;
  status)
    vm_json | jq '{machine_id, name, status, public_ip, cores, ram, storage_gb, cost}' 2>/dev/null || echo "jl: no VM"
    if [ -n "${IP:-}" ] && ssh -S "$TUNNEL_SOCK" -O check "$SSH_USER@$IP" 2>/dev/null; then
      kubectl --context "$CTX" get nodes; else echo "tunnel: down"; fi ;;
  *) [ -n "${IP:-}" ] || die "no VM IP in $STATE"; vssh "$@" ;;
esac
