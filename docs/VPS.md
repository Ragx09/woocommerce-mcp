# VPS — specs, setup and log

Living document for the k3s VPS (P0-03, REL-01..06, BON-07). Add to it whenever something about the VPS changes:
update **§3 Facts** in place and add a dated entry to **§7 Log**. No secrets here (no passwords, tokens or kubeconfig
contents). The provider and plan, the public IP, the SSH alias and the arch are fine to record.
Generic install steps live in [`DEPLOYMENT.md`](DEPLOYMENT.md) §5. This file records what was actually done on *our* VPS.

## 1. Status
| Item | State |
|---|---|
| VPS obtained (P0-03) | ✗ not yet |
| Preflight passes | — |
| k3s + kubeconfig over SSH tunnel (REL-01) | — |
| Images on GHCR (REL-03) | — |
| Secrets (REL-06) → Helm install (REL-03) | — |
| TLS with cert-manager (REL-04) | — |
| Persistence checks (REL-05) | — |
| `e2e.sh all` over https (BON-07) | — |

## 2. Specs needed
### What the stack asks for
Computed from `helm template … -f values-prod.yaml` (2026-10-24):

| Workload | Replicas | CPU request | Memory request | Memory limit |
|---|---|---|---|---|
| mariadb | 1 | 200m | 384Mi | 768Mi |
| wordpress | 1 | 200m | 384Mi | 768Mi |
| postgres | 1 | 50m | 128Mi | 384Mi |
| gateway | 2 | 50m each | 128Mi each | 384Mi each |
| woo-mcp | 1 | 50m | 96Mi | 256Mi |
| everything-mcp | 1 | 20m | 64Mi | 192Mi |
| dashboard | 1 | 10m | 16Mi | 64Mi |
| **Total (our workloads)** | | **0.63 CPU** | **1.3 GiB** | **3.2 GiB** |

PVCs: 11 GiB (MariaDB 5, WordPress 5, Postgres 1).

These are not in the table:
- **k3s itself** (server, containerd, CoreDNS, Traefik, local-path, metrics-server): about 0.5–0.8 GiB RAM.
- **cert-manager** (REL-04): about 3 pods and 150–200 MiB.
- **Bonus items (Phase 11)**:
  - Each extra store from BON-11 adds MariaDB + WordPress + woo-mcp: about 0.5 CPU, 0.86 GiB requested, 1.8 GiB at the limits, and 10 GiB of PVC.
  - Hosted MCP servers (BON-10) and the provisioner (BON-09) add a little more.
- **Build/pull headroom**: images are about 0.5 GB per tag set, and old tags accumulate.

### Sizing
| Tier | vCPU | RAM | Disk | Enough for |
|---|---|---|---|---|
| Minimum | 2 | 4 GB | 40 GB SSD | Core system + TLS only. Tight: the memory limits (3.2 GiB) plus k3s add up to more than 4 GB, so it only works if not every pod peaks at once. |
| **Recommended** | **4** | **8 GB** | **80 GB SSD** | Core + TLS + bonus items: the default store plus 2–3 extra stores, hosted servers and the provisioner, with room for rolling updates (a gateway surge pod) |
| Comfortable | 4–8 | 16 GB | 160 GB | Many stores, monitoring stack |

`scripts/vps-preflight.sh` checks only the minimum (≥3.8 GB, ≥2 CPU, ≥20 GB free). Since 2026-10-24 the bonus items are required, so **aim for the recommended tier**.

### Other requirements
- **OS:** Ubuntu 24.04 LTS (22.04 also works). Needs systemd.
- **Arch:** amd64 is preferred: the images build without changes. With arm64 (Oracle A1, Hetzner CAX) every image must be built multi-arch (`linux/amd64,linux/arm64`).
- **Network:** a public IPv4 address, because sslip.io (`<ip>.sslip.io`) and Let's Encrypt HTTP-01 need one. Inbound TCP 22/80/443 open in the provider firewall. **6443 stays closed**: we reach the API through an SSH tunnel.
- **Access:** SSH key login, a sudo user, and a static IP (or one that does not change across reboots).
- **Nice to have:**
  - Provider snapshots or backups.
  - A real domain (sslip.io is enough).
  - Let's Encrypt has rate limits, so test REL-04 with the staging issuer first.

### Provider options
- **Paid amd64, 4 vCPU / 8 GB:** any mainstream VPS provider has a plan in this range. Check the current price before buying.
- **Free:** Oracle Cloud *Always Free* Ampere A1 (arm64, up to 4 OCPU / 24 GB). This is the only free tier big enough, but capacity is often unavailable in busy regions, and it needs multi-arch images plus the OCI security list *and* the instance's iptables opened for 80/443.
- AWS, GCP and Azure free tiers (~1 GB RAM) are too small.

### Candidates checked (2026-10-24, list prices excl. GST — re-check before buying)
| Provider / plan | vCPU / RAM / disk | Price | Notes |
|---|---|---|---|
| **E2E Networks C3.8GB** (pick) | 4 / 8 GB / 100 GB NVMe | $0.049/h ≈ **$35.64/mo** | Normal Linux VPS, India DCs, amd64. Reserved IP $3/mo (optional). Matches the recommended tier. |
| JarvisLabs CPU VM 2 vCPU · 8 GB | 2 / 8 GB / storage extra | $0.05/h ≈ $36/mo + disk $0.10/GB-mo + reserved IP $5/mo ≈ $49/mo | GPU-focused cloud. **All ports open by default** → Security Group/ufw needed. IP changes on resume unless reserved. |
| JarvisLabs CPU VM 4 vCPU · 16 GB | 4 / 16 GB / storage extra | $0.10/h ≈ $73/mo + disk + IP ≈ $86/mo | Same caveats. |

### JarvisLabs specifics (chosen 2026-10-24, from docs.jarvislabs.ai)
- **No MCP server**, but an official agent-friendly CLI `jl` (`uv tool install jarvislabs`, then `jl setup` with an API token from jarvislabs.ai/settings/api-keys; the token lives in `~/.config/jl/config.toml`, never in the repo).
- **Create a CPU VM:** `jl ssh-key add ~/.ssh/<key>.pub --name laptop` then `jl create --vm --cpu --vcpus 4 --ram 8 --storage 100 --region IN2 --name woo-mcp-vps --yes --json`. A VM needs ≥1 SSH key and **≥100 GB storage** (auto-bumped). `jl get <id>` shows the public IP. SSH user is `cloud`.
- **Rate formula:** $0.012/vCPU-h + $0.0032/GB-RAM-h, storage $0.10/GB-month. 4 vCPU / 8 GB ≈ $0.074/h ≈ $54/mo + 100 GB $10 + reserved IP $5 ≈ **$69/mo** if run 24/7 (to be confirmed in the dashboard).
- **All ports open by default.** Attach a Security Group (dashboard → Security Groups, region-scoped, allow-only): inbound SSH 22 from my IP, TCP 80 + 443 from Anywhere, nothing else (6443 stays closed). Rules apply instantly and survive pause/resume.
- **Pause is risky for us:** the public IP changes on resume (sslip.io domain + certificate break) unless a **Reserved IP** ($5/mo) is attached; the docs also say only the home directory is guaranteed to persist across pause. k3s keeps its state in `/var/lib/rancher` → **do not pause the VM**; keep it running or destroy it.

## 3. Facts (fill in once the VPS exists)
| Field | Value |
|---|---|
| Provider / plan | |
| Region | |
| vCPU / RAM / disk | |
| Arch | |
| OS | |
| Public IPv4 | |
| Domain | `<ip>.sslip.io` → `app.`, `store.`, … |
| SSH alias (`~/.ssh/config`) | `vps` |
| k3s version | must match the local `k3d version` (script default `v1.35.5+k3s1`) |
| kube context / file | `vps` / `~/.kube/vps.yaml` (never committed) |

## 4. Setup plan
Work through it top to bottom. After each step, tick it in §1, add evidence to `TASKS.md` and add a line to §7.

1. **Buy/provision** the VPS (recommended tier, Ubuntu 24.04, SSH key). Open 22/80/443 in the provider firewall.
2. **SSH alias** on the laptop:
   ```
   Host vps
     HostName <ip>
     User <user>
     IdentityFile ~/.ssh/<key>
   ```
3. **Preflight** (P0-03): `ssh vps 'bash -s' < scripts/vps-preflight.sh` must exit 0. Paste the output into P0-03.
4. **Base hardening** (see §5).
5. **k3s** (REL-01): `scp scripts/vps-install-k3s.sh vps: && ssh vps sudo bash vps-install-k3s.sh`. Then set up the
   kubeconfig + SSH tunnel with the commands the script prints, and check `kubectl --context vps get nodes` → Ready.
6. **Images** (REL-03): build and push the five images to `ghcr.io/ragx09/…` (multi-arch if arm64). Then either make
   the GHCR packages public or create `ghcr-pull` in `store` and `platform`.
7. **Secrets** (REL-06): `scripts/make-secrets.sh --context vps`.
8. **Install** (REL-03): `scripts/deploy.sh prod` with `--set global.domain=<ip>.sslip.io`.
9. **TLS** (REL-04): install cert-manager, try the staging issuer, then switch to `letsencrypt-prod`.
   Check: `curl -sI https://app.<domain>`.
10. **Checks**:
    - Persistence (REL-05): `scripts/k8s-checks.sh store-data --context vps`
    - E2E (BON-07): `BASE=https://app.<domain> scripts/e2e.sh all`
    - Then the bonus flows on the VPS once they are built.

## 5. Hardening checklist
- [ ] Non-root sudo user. `PermitRootLogin no` and `PasswordAuthentication no` in `sshd_config`.
- [ ] `unattended-upgrades` enabled (security updates).
- [ ] Host firewall: allow 22/80/443 only. If you use **ufw**, also allow the k3s pod/service CIDRs
      (`ufw allow from 10.42.0.0/16`, `ufw allow from 10.43.0.0/16`), or pod DNS and networking break. Never expose 6443.
- [ ] Optional: fail2ban for SSH.
- [ ] Provider snapshot taken after k3s is up and before the first Helm install.

## 6. Gotchas
- `values-prod.yaml` refuses to render while `global.domain` is `CHANGE-ME`. Always pass `--set global.domain=…`.
- An arm64 VPS combined with amd64-only images gives `exec format error` / ImagePullBackOff.
- Private GHCR packages without the `ghcr-pull` Secret give `ImagePullBackOff` (401).
- Traefik `externalTrafficPolicy: Local` (set by the install script) is what lets the gateway see real client IPs for its login rate limit.
- Let's Encrypt prod has rate limits: test with staging first.

## 7. Log
Newest at the bottom. Format: `- YYYY-MM-DD — what was done → result/evidence`.

- 2026-10-24 — Created this file. Specs computed from the prod render: 0.63 CPU / 1.3 GiB requested, 3.2 GiB at the limits, 11 GiB PVC. Recommended tier 4 vCPU / 8 GB / 80 GB because of the required bonus items. VPS not yet obtained (P0-03 Blocked).
- 2026-10-24 — Compared E2E Networks and JarvisLabs (table in §2). E2E C3.8GB recommended.
- 2026-10-24 — Chose JarvisLabs. Explored its docs: no MCP, `jl` CLI supports CPU VMs, security groups, reserved IP (details in §2). Dashboard not yet viewed (Chrome site permission for jarvislabs.ai pending).
