#!/usr/bin/env bash
# Checks that a VPS can run the full stack (P0-03). Read-only: prints facts, changes nothing.
# Usage: ssh <alias> 'bash -s' < scripts/vps-preflight.sh
set -u
fail=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
arch=$(uname -m)
. /etc/os-release 2>/dev/null || true

echo "os=${PRETTY_NAME:-unknown} arch=$arch cpus=$(nproc) mem_mb=$mem_mb disk_free_gb=$disk_gb"
# 3.8 GB, not 4: "4 GB" plans report slightly less usable memory.
check "RAM >= 3.8 GB (WordPress + MariaDB + Postgres + 4 services)" "[ $mem_mb -ge 3800 ]"
check "CPU >= 2" "[ $(nproc) -ge 2 ]"
check "free disk >= 20 GB" "[ ${disk_gb:-0} -ge 20 ]"
check "arch amd64 or arm64" "[ $arch = x86_64 ] || [ $arch = aarch64 ]"
check "systemd present (k3s installer needs it)" "command -v systemctl >/dev/null"
check "ports 80/443 not already bound" "! (ss -ltn 2>/dev/null | awk '{print \$4}' | grep -qE ':(80|443)\$')"
check "outbound HTTPS (get.k3s.io)" "curl -fsS -m 10 -o /dev/null https://get.k3s.io"
[ "$arch" = aarch64 ] && echo "NOTE  arm64 host: images must be built multi-arch (linux/amd64,linux/arm64)."
echo "NOTE  also open TCP 80/443 in the provider firewall / security list (not visible from inside the VM)."
exit $fail
