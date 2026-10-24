#!/usr/bin/env bash
# Stop paying for the VM (vps-setup/VPS.md §2 Usage plan).
#   vps-setup/down.sh           DESTROY the VM and its disk (all VPS data gone; ₹0 afterwards). Asks first.
#   vps-setup/down.sh --pause   pause: compute billing stops, the disk keeps billing; IP may change on resume.
#   vps-setup/down.sh --yes     destroy without the prompt
. "$(dirname "$0")/lib.sh"
need jl jq
load_state
vm="$(vm_json)"
[ -n "$vm" ] || { echo "no VM named $VM_NAME"; tunnel_down; exit 0; }
MACHINE_ID="$(jq -r .machine_id <<<"$vm")"
echo "VM $VM_NAME  machine $MACHINE_ID  status $(jq -r .status <<<"$vm")  ip ${IP:-?}"
tunnel_down

if [ "${1:-}" = --pause ]; then
  jl pause "$MACHINE_ID" --yes
  echo "paused. Resume + redeploy: vps-setup/up.sh"
  exit 0
fi

if [ "${1:-}" != --yes ]; then
  read -r -p "Destroy $VM_NAME ($MACHINE_ID) and ALL its data? Type the VM name to confirm: " answer
  [ "$answer" = "$VM_NAME" ] || { echo "aborted"; exit 1; }
fi
jl destroy "$MACHINE_ID" --yes
[ -n "${IP:-}" ] && ssh-keygen -R "$IP" -f "$KNOWN_HOSTS" >/dev/null 2>&1 || true
rm -f "$STATE" "$KUBECONFIG"
echo "destroyed. Billing for this VM has stopped (a Reserved IP, if any, is billed separately)."
