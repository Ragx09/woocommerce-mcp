# Deployment

> Status: **draft**. Commands become real as Phase 2 tasks land; until then they are the *planned* interface.

## 1. Prerequisites (local)
| Tool | Version | Status (2026-10-11) |
|---|---|---|
| Docker Desktop (WSL2) | 29.x | installed |
| kubectl | 1.36 | installed |
| helm | v3.22.0 (`~/.local/bin`, sha256-verified) | installed (P0-02) |
| k3d | v5.9.0 → k3s v1.35.5+k3s1 (`~/.local/bin`, sha256-verified) | installed (P0-02) |
| Node.js / npm | 24 / 11 | installed |

The repo lives on the Linux filesystem (`~/projects/woocommerce-mcp`), because builds on `/mnt/c` are much slower.

## 2. Topology
| Namespace | Workload | Kind | Storage | Exposure |
|---|---|---|---|---|
| store | mariadb | StatefulSet | PVC 2Gi | internal (wordpress, wp-init only) |
| store | wordpress | Deployment | PVC 2Gi (`/var/www/html`) | Ingress `store.<domain>` |
| store | wp-init-<revision> | Job (one per Helm revision, idempotent) | — | — |
| store | woo-mcp | Deployment | — | internal (gateway only) |
| platform | postgres | StatefulSet | PVC 1Gi | internal (gateway only) |
| platform | gateway | Deployment | — | Ingress `app.<domain>/api`, `/mcp` |
| platform | dashboard | Deployment | — | Ingress `app.<domain>/` |
| platform | everything-mcp | Deployment | — | internal (gateway only) |

## 3. Local (k3d)
```bash
scripts/up.sh                  # cluster-up → make-secrets → build-images → deploy local → wait
```
which runs, step by step (each script is idempotent and can be rerun on its own):
```bash
scripts/cluster-up.sh          # k3d cluster create --config k3d/cluster.yaml (host ports 80/443)
scripts/make-secrets.sh        # K8s Secrets from random values + .env (never overwrites, never prints)
scripts/build-images.sh        # docker build, content-addressed tag, k3d image import → .images.env
scripts/deploy.sh local        # helm upgrade --install … -f values-local.yaml --wait --wait-for-jobs
```
Gateway `/mcp` needs a personal API key (AUTH-08). Until the dashboard exists (UI-11), create one for the seeded admin from the shell; the key is printed once, keep it out of history and files:
```bash
read -r KID KEY < <(node scripts/lib/gateway-key.mjs create my-laptop)
npx @modelcontextprotocol/inspector@2.10.1 --cli http://app.127.0.0.1.nip.io/mcp --transport http \
  --header "Authorization: Bearer $KEY" --method tools/list
node scripts/lib/gateway-key.mjs revoke "$KID"; unset KEY KID   # when done
```
Storefront (TATVA, D-016): `scripts/build-images.sh` also builds `store-assets` (theme, catalogue, images); every deploy's wp-init Job installs the theme and imports `services/store-assets/catalogue/catalogue.json` (idempotent; log line `catalogue: 50 products (… unchanged)`). To change products or copy: edit the catalogue/theme, then `SERVICES=store-assets scripts/build-images.sh && scripts/deploy.sh local`. `store.init.brand.enabled=false` gives the plain store. Visual check: `scripts/storefront-screens.sh` (screenshots in `tests/e2e/out/screens`).

Upstreams (GW-13/14): the gateway seeds `woo`, `everything` (in-cluster `everything-mcp`, `everythingMcp.enabled`) and `github` (`gateway.seed.github`, PAT from `upstream-seed` key `github-pat`; empty → skipped with a log warning) on first start; rows an admin edited are never overwritten. A PAT added later: put it in `.env`, `scripts/make-secrets.sh --rotate platform/upstream-seed`, restart the gateway.

Checks: `scripts/check-chart.sh` (lint, kubeconform, policy), `scripts/k8s-checks.sh all` (Ingress + NetworkPolicy), `scripts/woo-int.sh` (woo-mcp against the real store), `scripts/e2e-checkout.sh` (browser checkout with COD).

Local domains: `http://store.127.0.0.1.nip.io`, `http://app.127.0.0.1.nip.io`. nip.io resolves `*.127.0.0.1.nip.io` to 127.0.0.1, so no hosts-file edits are needed. Fallback: add both hosts to `/etc/hosts` and `C:\Windows\System32\drivers\etc\hosts`.

WordPress admin: `http://store.127.0.0.1.nip.io/wp-admin`, user `admin`, password via `kubectl -n store get secret wordpress-admin -o jsonpath='{.data.admin-password}' | base64 -d`.

Teardown: `scripts/down.sh` removes the release but keeps namespaces, Secrets and PVCs; `scripts/down.sh --all` deletes the cluster and all data.

## 4. Secrets
Never in git or values files. `scripts/make-secrets.sh` creates:
- `store/mariadb-secrets` (root and user passwords), `store/wordpress-admin`, `store/woo-api` (consumer key/secret; the wp-init Job registers its hash in WooCommerce), `store/woo-mcp-auth` (token the gateway presents to woo-mcp)
- `platform/postgres-secrets`, `platform/gateway-secrets` (`CREDENTIALS_KEY`, `SESSION_SECRET`, `INTERNAL_TOKEN_SECRET`), `platform/gateway-admin` (`admin-email`, default `admin@example.invalid` or `GATEWAY_ADMIN_EMAIL`; random `admin-password` — the first dashboard admin, created only while the DB has no admin), `platform/llm-secrets` (`LLM_API_KEY`), `platform/upstream-seed` (`woo-token` = same value as `woo-mcp-auth`, `github-pat` from `.env`)

## 5. VPS (k3s) — planned
**Choosing a VPS (P0-03).** Needs ≥4 GB RAM, ≥2 vCPU, ≥20 GB disk, Ubuntu LTS.
- Free option: Oracle Cloud *Always Free* Ampere A1 is the only common free tier with enough RAM. It is **arm64**, so images must be built multi-arch (R6), and A1 capacity is often unavailable in busy regions.
- AWS, GCP and Azure free tiers give about 1 GB of RAM, which is too small for WordPress + MariaDB + Postgres + 4 services.
- Otherwise use any small paid 4 GB amd64 VPS.

Steps:
1. Open TCP 22/80/443 in the provider firewall. Keep 6443 closed.
2. Preflight (read-only): `ssh <alias> 'bash -s' < scripts/vps-preflight.sh` must exit 0.
3. Install k3s, pinned to the local k3d version (the script also sets Traefik `externalTrafficPolicy: Local`, so the gateway sees real client IPs for its login rate limit): `scp scripts/vps-install-k3s.sh <alias>: && ssh <alias> sudo bash vps-install-k3s.sh` (Traefik + local-path included).
4. Kubeconfig over an SSH tunnel (the script prints the exact commands) → `~/.kube/vps.yaml`, never committed.
5. Images: `ghcr.io/ragx09/{woo-mcp,gateway,dashboard,store-assets,everything-mcp}:<tag>` (multi-arch if the VPS is arm64).
6. `scripts/make-secrets.sh --context vps`, then `helm upgrade --install platform charts/platform -f values-prod.yaml --kube-context vps`.
7. Optional TLS: cert-manager + Let's Encrypt (REL-04).

## 6. Upgrade and rollback (planned)
`helm upgrade platform … --set gateway.image.tag=<new>` → `helm history platform` → `helm rollback platform <rev>`. DB migrations are forward-only and additive, so a rollback of the app image stays compatible.

## 7. Troubleshooting (to grow)
| Symptom | Check |
|---|---|
| WordPress redirect loop | `WP_HOME`/`WP_SITEURL` vs Ingress host; `X-Forwarded-Proto` |
| woo-mcp 401 from WooCommerce | OAuth1 signature / key in `woo-api` Secret |
| Gateway shows upstream Unreachable | `kubectl -n store get pods`; NetworkPolicy labels |

## 8. Cleanup
`helm uninstall platform` (PVCs are kept by policy) · `k3d cluster delete mcp`.
