# VPS — specs, setup and log

Living document for the k3s VPS (P0-03, REL-01..06, BON-07). Add to it whenever something about the VPS changes:
update **§3 Facts** in place and add a dated entry to **§7 Log**. No secrets here (no passwords, tokens or kubeconfig
contents). The provider and plan, the public IP, the SSH alias and the arch are fine to record.
Generic install steps live in [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) §5. This file records what was actually done on *our* VPS.

### Files in `vps-setup/`
| File | What it does |
|---|---|
| `up.sh` | One command, idempotent: create/resume the JarvisLabs VM → preflight → k3s → kubeconfig + SSH tunnel → images → cert-manager + issuers → Secrets → Helm (values-prod) → certificates → demo users. `--no-vm` skips the `jl` step. |
| `down.sh` | Destroy the VM (asks you to type its name; `--yes` skips) or `--pause` it. Closes the tunnel. |
| `ssh.sh` | Shell or command on the VM; `tunnel` re-opens the kubectl tunnel; `status` shows VM, tunnel, node. |
| `lib.sh` | Shared settings (size, region, key, tunnel port) and helpers. Overridable from `.env` (`VPS_VCPUS`, `VPS_RAM`, `VPS_REGION`, `VPS_DOMAIN`, `DUCKDNS_DOMAIN`/`DUCKDNS_TOKEN`, `TLS_ISSUER`, `ACME_EMAIL`). |
| `preflight.sh` | Read-only capability check (RAM, CPU, disk, arch, systemd, free 80/443, outbound HTTPS). |
| `install-k3s.sh` | k3s pinned to the local k3d version, Traefik `externalTrafficPolicy: Local`. Runs on the VM. |
| `cert-manager-values.yaml` | requests/limits for cert-manager's pods. |
| `.state` | (gitignored) machine id, IP, domain of the current VM. |

## 1. Status
| Item | State |
|---|---|
| VPS obtained (P0-03) | ✗ not yet |
| Preflight passes | — |
| k3s + kubeconfig over SSH tunnel (REL-01) | — |
| Images in k3s containerd (REL-03, D-023) | — |
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

`preflight.sh` checks only the minimum (≥3.8 GB, ≥2 CPU, ≥20 GB free). Since 2026-10-24 the bonus items are required, so **aim for the recommended tier**.

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
- **Create a CPU VM:** `jl ssh-key add ~/.ssh/<key>.pub --name laptop` then `jl create --vm --cpu --vcpus 4 --ram 16 --storage 100 --region IN2 --name woo-mcp-vps --yes --json`. A VM needs ≥1 SSH key and **≥100 GB storage** (auto-bumped). `jl get <id>` shows the public IP. SSH user is `cloud`.
- **Dashboard prices (INR, seen 2026-10-24, region IN2/IN1, fixed 1:4 tiers only):** 2 vCPU/8 GB ₹4.02/h · 4 vCPU/16 GB ₹8.04/h · 8/32 ₹16.07/h (16+ unavailable). 100 GB storage ₹1.296/h. So **2 vCPU/8 GB + 100 GB = ₹5.32/h ≈ ₹128/day ≈ ₹3,880/month**; 4 vCPU/16 GB ≈ ₹9.34/h ≈ ₹6,800/month. Reserved IP ₹475/month. Commitments: 30 d −5 %, 90 d −10 %, 180 d −15 %. GST not shown. Launch needs credits and an SSH key in account settings.
- **SSH key:** dedicated key `~/.ssh/jarvis_vps` (ed25519, comment `woo-mcp-vps`), private half never leaves the laptop.
- **Rate formula (USD page):** $0.012/vCPU-h + $0.0032/GB-RAM-h, storage $0.10/GB-month. (4 vCPU / 8 GB is **not** offered: the dashboard has fixed 1:4 tiers only.)
- **All ports open by default.** Attach a Security Group (dashboard → Security Groups, region-scoped, allow-only): inbound SSH 22 from my IP, TCP 80 + 443 from Anywhere, nothing else (6443 stays closed). Rules apply instantly and survive pause/resume.
- **Pause is risky for us:** the public IP changes on resume (sslip.io domain + certificate break) unless a **Reserved IP** ($5/mo) is attached; the docs also say only the home directory is guaranteed to persist across pause. k3s keeps its state in `/var/lib/rancher` → **do not pause the VM**; keep it running or destroy it.

### Usage plan: on only for evidence, recording and presenting (decided 2026-10-24)
- **Size: 4 vCPU / 16 GB, 100 GB.** Billed per hour, so the bigger size costs only ~₹4/h more and leaves room for every bonus item: the default store + 2–3 extra stores (≈0.5 CPU / 0.9 GiB requested each, CPU-heavy wp-init on create), hosted servers, provisioner, cert-manager, k3s. 2 vCPU / 8 GB would run out of CPU requests at about 2 extra stores, and live store creation would be slow on camera.
- **Between sessions: destroy, not pause** (default). Cost between sessions is ₹0, and nothing depends on whether a paused VM keeps `/var/lib/rancher`. A fresh bring-up is scripted (create VM → k3s → secrets → Helm → TLS → seed) and takes ~20–30 min, so start it well before a recording or a presentation.
- **Pause only for a short gap** (e.g. recording today, presenting tomorrow): compute stops, the 100 GB disk keeps costing ₹1.30/h (≈₹31/day). Only after a test pause/resume showed that k3s and its data survive (first session), and with a Reserved IP (₹475/month) or a redeploy with the new `<ip>.sslip.io` domain.
- **Sessions planned:** (1) bring-up + BON-07 evidence (`e2e.sh all` over https) + pause test, ~4–6 h; (2) video recording, ~3 h; (3) presentation, ~2 h. ≈ 10–12 h × ₹9.34/h ≈ **₹100–150 in total**, plus the Reserved IP if one is used.

## 3. Facts (fill in once the VPS exists)
| Field | Value |
|---|---|
| Provider / plan | JarvisLabs CPU VM, 4 vCPU / 16 GB, on-demand |
| Region | IN2 (default in `lib.sh`) |
| vCPU / RAM / disk | 4 / 16 GB / 100 GB SSD |
| Arch | (from preflight) |
| OS | (from preflight) |
| Public IPv4 | (changes per VM unless a Reserved IP is attached) |
| Domain | `<ip>.sslip.io` by default, or `<name>.duckdns.org` → `app.`, `store.`, … |
| SSH | `vps-setup/ssh.sh` (user `cloud`, key `~/.ssh/jarvis_vps`, known hosts `~/.ssh/known_hosts_vps`) |
| k3s version | must match the local `k3d version` (script default `v1.35.5+k3s1`) |
| kube context / file | `vps` / `~/.kube/vps.yaml` (never committed), API via `127.0.0.1:16443` tunnel |
| cert-manager | chart v1.19.1, issuers `letsencrypt-staging`, `letsencrypt-prod` |

## 4. Setup plan
One-time (no cost):
1. ✓ CLI installed: `uv tool install jarvislabs` (jl 0.2.17, 2026-10-24).
2. ✓ SSH key `~/.ssh/jarvis_vps` created. **To do:** add the public key to JarvisLabs (`jl ssh-key add ~/.ssh/jarvis_vps.pub --name woo-mcp-vps` or dashboard → Settings).
3. ✓ `jl setup` done (2026-10-24; `jl status` shows the account). **To do (user):** add credits (balance ₹0.00).
4. **To do:** Security Group in IN2 (dashboard → Security Groups; see §5). Attach it to the VM right after creation.
5. Optional: DuckDNS name (free, on the Public Suffix List → own Let's Encrypt limit): `DUCKDNS_DOMAIN`, `DUCKDNS_TOKEN` in `.env`.

Each session (billing runs from step 1 to `down.sh`):
1. `vps-setup/up.sh` — first run ~20–30 min (image upload depends on the laptop's upload speed). Use `TLS_ISSUER=letsencrypt-staging` the very first time, then re-run without it.
2. Attach the Security Group if the script warns that 6443 is reachable.
3. Checks: `kubectl --context vps get pods -A`, `curl -sI https://app.<domain>`, then
   `APP_ORIGIN=https://app.<domain> STORE_ORIGIN=https://store.<domain> KUBECTL_CONTEXT=vps KUBECONFIG=~/.kube/vps.yaml scripts/e2e.sh all` (BON-07),
   persistence (REL-05: delete the MariaDB/WordPress/Postgres pods, data still there).
4. Record / present.
5. `vps-setup/down.sh` (destroy) or `vps-setup/down.sh --pause`. Add a line to §7.

## 5. Hardening checklist
- [ ] **Security Group** (JarvisLabs VMs are open on every port by default): inbound SSH 22 from my current IP, TCP 80 and 443 from Anywhere, Ping from my IP; outbound all. Nothing else, so 6443 and the kubelet (10250) stay closed. `up.sh` warns if 6443 answers from the laptop.
- [ ] No ufw on the VM: the Security Group filters at the network port, and ufw needs extra k3s CIDR rules (`10.42.0.0/16`, `10.43.0.0/16`) to avoid breaking pod networking.
- [ ] SSH key login only (JarvisLabs default: user `cloud`, no password).
- [ ] VM lifetime is hours, so `unattended-upgrades` and fail2ban are not needed; for a long-lived VM, enable both.

## 6. Gotchas
- `values-prod.yaml` refuses to render while `global.domain` is `CHANGE-ME`; `up.sh` always passes `--set global.domain=…`.
- An arm64 VM with amd64-only images gives `exec format error`; `up.sh` stops if the VM is not x86_64.
- **sslip.io is not on the Public Suffix List** (checked 2026-10-24), so Let's Encrypt's 50 certificates / week per registered domain is shared by every sslip.io user and may be used up. If `up.sh` stops at "certificates not Ready" with a rate-limit error in `kubectl get challenge,order -A`, use DuckDNS (on the PSL) or a real domain.
- HTTP-01 needs Traefik → solver pod on 8089; the chart's `acme-solver-from-ingress` NetworkPolicy allows exactly that in `store` and `platform`.
- Traefik `externalTrafficPolicy: Local` (set by `install-k3s.sh`) is what lets the gateway see real client IPs for its login rate limit.
- New VM = new host key: `up.sh` removes the old entry from `~/.ssh/known_hosts_vps`.
- The laptop sleeping kills the tunnel: `vps-setup/ssh.sh tunnel`.

## 7. Log
Newest at the bottom. Format: `- YYYY-MM-DD — what was done → result/evidence`.

- 2026-10-24 — Created this file. Specs computed from the prod render: 0.63 CPU / 1.3 GiB requested, 3.2 GiB at the limits, 11 GiB PVC. Recommended tier 4 vCPU / 8 GB / 80 GB because of the required bonus items. VPS not yet obtained (P0-03 Blocked).
- 2026-10-24 — Compared E2E Networks and JarvisLabs (table in §2). E2E C3.8GB recommended.
- 2026-10-24 — Chose JarvisLabs. Explored its docs: no MCP, `jl` CLI supports CPU VMs, security groups, reserved IP (details in §2). Dashboard not yet viewed (Chrome site permission for jarvislabs.ai pending).
- 2026-10-24 — Decided on-demand use (§2 Usage plan): 4 vCPU / 16 GB, destroy between sessions, pause only for short gaps after a pause test.
- 2026-10-24 — Moved everything VPS-related into `vps-setup/` (this file, `preflight.sh`, `install-k3s.sh`) and wrote `up.sh`/`down.sh`/`ssh.sh`. Installed `jl` 0.2.17, created `~/.ssh/jarvis_vps`. Chart: `acme-solver-from-ingress` NetworkPolicy. Found sslip.io is not on the PSL (Let's Encrypt limit shared). Not run yet: no credits.
- 2026-10-24 — Signed in the `jl` CLI with `jl setup` (token in `~/.config/jl/config.toml`) → `jl status`: account OK, balance ₹0.00, 0 running, 0 paused. `jl ssh-key list`: no keys yet.
