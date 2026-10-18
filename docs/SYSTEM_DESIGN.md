# System design and trade-offs

A short note for reviewers (REQ-DEL-06). Details: [ARCHITECTURE.md](../ARCHITECTURE.md), [MCP_DESIGN.md](MCP_DESIGN.md), [DECISIONS.md](../DECISIONS.md), [DEPLOYMENT.md](DEPLOYMENT.md), [THREAT_MODEL.md](../THREAT_MODEL.md).

## 1. What runs where
| Namespace | Workload | Role | Exposed |
|---|---|---|---|
| `store` | `wordpress` (Apache, www-data, PVC) + `mariadb` (StatefulSet, PVC) + `wp-init` Job | WooCommerce store, TATVA theme and catalogue, COD checkout | `store.<domain>` |
| `store` | `woo-mcp` (Node, own code) | MCP server: 5 tools over WooCommerce REST `/wc/v3` (OAuth 1.0a) | no — gateway only |
| `platform` | `gateway` (Fastify, own code) | MCP server for clients **and** MCP client to every upstream; REST API for the dashboard; sessions, API keys, audit; chat agent | `app.<domain>/api`, `/mcp` |
| `platform` | `dashboard` (nginx, static React) | UI only, no secrets, no egress | `app.<domain>/` |
| `platform` | `postgres` (StatefulSet, PVC) | users, sessions, invites, API key hashes, upstream registry (credentials AES-256-GCM), audit log | no — gateway only |
| `platform` | `everything-mcp` | reference third-party MCP server (no secrets, no egress) | no — gateway only |
| internet | GitHub remote MCP | third upstream, PAT injected by the gateway | — |

Public vs internal is enforced twice: every Service is `ClusterIP` (Traefik is the only entry), and both namespaces are default-deny with one NetworkPolicy per allowed path (e.g. woo-mcp ← gateway only, mariadb ← wordpress only, postgres ← gateway only). Checked with real probe pods: `scripts/k8s-checks.sh netpol`. Every container runs non-root with a read-only root filesystem and no capabilities; the namespaces enforce Pod Security `restricted`.

## 2. Architecture choices (and what they cost)
| Choice | Why | Trade-off |
|---|---|---|
| One gateway deployable for `/mcp`, `/api` and the chat (D-004) | Fewest moving parts in 7 days; one auth and audit path | Scales as one unit |
| MCP SDK v1, Streamable HTTP, **stateless** (D-002) | Any replica can answer any request; no session affinity; works through a plain Ingress | No server-initiated notifications (`list_changed`): clients see changes on their next `tools/list` |
| Registry and enabled flags read from Postgres on every request | All replicas agree at once (disable/enable, delete) without a message bus | One small query per request |
| Chat agent calls the gateway's own `/mcp` as the user (D-018) | The chat gets exactly the same routing, authorization and audit as an external client; nothing else talks to upstreams | One loopback hop; a per-process HMAC token accepted only from loopback |
| woo-mcp uses WooCommerce REST with OAuth 1.0a in-cluster (D-003) | Official API, works over plain HTTP inside the cluster; no plugin code | Signing code to maintain |
| Own Helm templates with official images (D-011) | Bitnami images are deprecated; full control over security contexts | More YAML |
| API keys as SHA-256 hashes, credentials encrypted with a key from a Secret (D-008/009) | A DB dump yields neither usable keys nor upstream credentials | Keys shown once; no key rotation for the encryption key yet |
| LLM over an OpenAI-compatible API, Groq by default (D-012) | Free tier, provider is a values change | Free tier ≈ 8k tokens/min; the chat offers only the most relevant tools plus `find_tools` (D-019) |

## 3. Tool aggregation, routing and failure handling
**Naming.** Every tool is published as `<slug>__<tool>` (`woo__list_orders`, `github__get_me`). Slugs are unique and immutable, so two servers can both have `search` without a clash. Names longer than 64 characters or with invalid characters are shortened with a hash suffix; routing goes through an index built from discovery, so even shortened names route back. Descriptions get a `[slug]` prefix and a length cap.

**`tools/list`.** Fan out to every enabled, not-unreachable upstream in parallel (`Promise.allSettled`), one 3 s deadline each (connect + pages). A failing upstream is left out; the others are returned. A last-good list ≤ 60 s old is reused while the config is unchanged. Result: 64 tools from 3 servers in one list.

**`tools/call`.** Name → upstream (unknown → `unknown_tool`; disabled → `upstream_disabled`, never forwarded) → the upstream's own credential is injected (the client's `Authorization` is never forwarded) → 15 s deadline → result returned unchanged, `isError` preserved. A transport error is retried once only when the call certainly did not run; a timed-out call is never retried (it may have run). Every call writes one audit row (user, key, source `mcp`/`chat`, upstream, tool, duration, outcome — never arguments).

**Dead or slow upstreams.** A health loop pings every enabled upstream every 10 s and also learns from traffic. Unreachable upstreams are skipped by `tools/list`, and calls to them fail in milliseconds (`upstream_unreachable: <reason>`) instead of waiting. The dashboard's Servers page shows Connected/Unreachable/Disabled and the last error. Verified by scaling `everything-mcp` to 0: Unreachable within 5–10 s, woo and GitHub calls unaffected, recovery within one loop after the pod is Ready (`scripts/e2e.sh killpod`, `k8s-checks.sh killpod`).

**Untrusted upstreams.** Upstream URLs pass an SSRF guard on save and on every connect (no private, loopback, link-local or metadata addresses unless the host name is allowlisted; DNS-rebinding safe; redirects refused). Tool output goes to the model as data, with caps on rounds, calls and result size, and every call is visible in the chat transcript and audit log.

## 4. Local → production
The same chart deploys both; `scripts/check-chart.sh` fails if anything other than the expected keys differ.

| Concern | Local (k3d) | VPS (k3s) |
|---|---|---|
| DNS | `*.127.0.0.1.nip.io` (no hosts file) | `*.<ip>.sslip.io` or a real domain with a wildcard/two A records; `--set global.domain=…` (render fails on the placeholder) |
| Ingress | Traefik bundled with k3d/k3s, `app.` and `store.` hosts | same Traefik; `externalTrafficPolicy: Local` so the login rate limit sees real client IPs |
| TLS | off (http, cookies without `Secure`) | `global.tls` adds the cert-manager annotation and a TLS section to both Ingresses (cert-manager + Let's Encrypt issuer installed on the VPS, REL-04); `scheme: https` turns on `Secure` cookies and the https Origin check |
| Images | built locally, `k3d image import`, `pullPolicy: Never` | content-tagged images in `ghcr.io/ragx09/*`, optional `imagePullSecrets` |
| Storage | `local-path` PVCs | `local-path` on the VPS disk, larger sizes; PVCs survive `helm uninstall` (`resource-policy: keep`). A multi-node cluster would need a networked StorageClass and backups |
| Secrets | `scripts/make-secrets.sh` from the gitignored `.env` into K8s Secrets | same script against the VPS context; nothing secret in values files or git. Production would add a secret manager (External Secrets / SOPS) and encryption at rest for etcd |
| Resources | small requests/limits | larger MariaDB/WordPress requests and limits |
| Upgrade / rollback | `scripts/deploy.sh local` = one Helm revision; `helm rollback` | same; migrations are forward-only and additive (DEPLOYMENT.md §6, verified on k3d) |

What we would change for a real production deployment, beyond the VPS: more than one gateway replica behind the same Service (the design is stateless and disable/enable was tested with two replicas on one Postgres, TC-INT-05; chat limits, login limits and health state are per replica today), managed Postgres/MariaDB with backups, metrics per upstream (calls, errors, latency), per-role tool permissions, and rotation of the credential-encryption key.
