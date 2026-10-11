# Deployment

> Status: **draft**. Commands become real as Phase 2 tasks land; until then they are the *planned* interface.

## 1. Prerequisites (local)
| Tool | Version | Status (2026-10-11) |
|---|---|---|
| Docker Desktop (WSL2) | 29.x | installed |
| kubectl | 1.36 | installed |
| helm | 3.x | **to install (P0-02)** |
| k3d | 5.x | **to install (P0-02)** |
| Node.js / npm | 24 / 11 | installed |

The repo lives on the Linux filesystem (`~/projects/woocommerce-mcp`), because builds on `/mnt/c` are much slower.

## 2. Topology
| Namespace | Workload | Kind | Storage | Exposure |
|---|---|---|---|---|
| store | mariadb | StatefulSet | PVC 2Gi | internal (wordpress, wp-init only) |
| store | wordpress | Deployment | PVC 2Gi (`/var/www/html`) | Ingress `store.<domain>` |
| store | wp-init | Job (Helm hook) | — | — |
| store | woo-mcp | Deployment | — | internal (gateway only) |
| platform | postgres | StatefulSet | PVC 1Gi | internal (gateway only) |
| platform | gateway | Deployment | — | Ingress `app.<domain>/api`, `/mcp` |
| platform | dashboard | Deployment | — | Ingress `app.<domain>/` |
| platform | everything-mcp | Deployment | — | internal (gateway only) |

## 3. Local (k3d) — planned commands
```bash
scripts/cluster-up.sh          # k3d cluster create mcp --config k3d/cluster.yaml (ports 80/443)
cp .env.example .env && $EDITOR .env
scripts/make-secrets.sh        # creates K8s Secrets from .env + random values (idempotent)
scripts/build-images.sh        # docker build + k3d image import
helm upgrade --install platform charts/platform -f charts/platform/values-local.yaml --wait
```
Local domains: `http://store.127.0.0.1.nip.io`, `http://app.127.0.0.1.nip.io`. nip.io resolves `*.127.0.0.1.nip.io` to 127.0.0.1, so no hosts-file edits are needed. Fallback: add both hosts to `/etc/hosts` and `C:\Windows\System32\drivers\etc\hosts`.

## 4. Secrets
Never in git or values files. `scripts/make-secrets.sh` creates:
- `store/mariadb-secrets` (root and user passwords), `store/wordpress-admin`, `store/woo-api` (created by the wp-init Job)
- `platform/postgres-secrets`, `platform/gateway-secrets` (`CREDENTIALS_KEY`, `SESSION_SECRET`, `INTERNAL_TOKEN_SECRET`), `platform/gateway-admin` (seed admin email and password), `platform/llm-secrets` (`LLM_API_KEY`), `platform/upstream-seed` (GitHub PAT)

## 5. VPS (k3s) — planned
1. VPS ≥4 GB RAM, Ubuntu LTS, ports 22/80/443 open.
2. `curl -sfL https://get.k3s.io | sh -` (Traefik + local-path included).
3. Copy the kubeconfig (via an SSH tunnel or with the server address rewritten) → context `vps`.
4. Images: `ghcr.io/ragx09/{woo-mcp,gateway,dashboard}:<tag>` (multi-arch if the VPS is arm64).
5. `scripts/make-secrets.sh --context vps`, then `helm upgrade --install platform charts/platform -f values-prod.yaml --kube-context vps`.
6. Optional TLS: cert-manager + Let's Encrypt (REL-04).

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
