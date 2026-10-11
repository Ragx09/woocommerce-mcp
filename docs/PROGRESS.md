# Progress

## Current phase
Phase 2 — Gateway core (Day 2, 2026-10-11)

## Current task
GW-02 — Postgres + upstream model

## Recently completed
- 2026-10-11: GW-01 — `services/gateway` (Fastify 5.12.5): env config, pino redaction, `/healthz` `/readyz` (named readiness checks), JSON error shape, Dockerfile; chart: gateway Deployment/Service, `app.<domain>` Ingress (`/api`, `/mcp`), platform default-deny + gateway-from-Traefik NetworkPolicy. 7 unit tests; deployed on k3d.
- 2026-10-11: INF-02..14, WC-01..05/14 committed (`41bf045`): platform Helm chart, k3d cluster config, image build, `scripts/check-chart.sh`. INF-11 still open for the dashboard `/` route (UI-20); INF-15 not started.
- 2026-10-11: P0-04 (partial) — Groq key verified, tool calling works with `openai/gpt-oss-120b` (`scripts/llm-smoke.mjs`).
- 2026-10-11: P0-12 plan review checkpoint — user go-ahead.
- 2026-10-11: P0-03 prep — `scripts/vps-preflight.sh`, `scripts/vps-install-k3s.sh` (k3s v1.35.5+k3s1, API via SSH tunnel); VPS itself still blocked.
- 2026-10-11: P0-02 — helm v3.22.0 + k3d v5.9.0 installed (checksums verified); smoke cluster, nip.io Ingress and NetworkPolicy enforcement verified, cluster deleted.
- 2026-10-11: P0-01 — private GitHub repo https://github.com/Ragx09/woocommerce-mcp, `main` pushed.
- 2026-10-11: Converted the brief to `problem-statement.md`; repo created at `~/projects/woocommerce-mcp` (git initialised, no remote yet).
- 2026-10-11: Research (MCP spec/SDK status, Bitnami deprecation, ingress-nginx retirement, WooCommerce auth over HTTP, free LLM tiers) → decisions D-001…D-013 (Proposed).
- 2026-10-11: Project tracker (`tracker/build.mjs` + `tracker/index.html`), verified headlessly at desktop and mobile widths.
- 2026-10-11: Docs: CLAUDE.md, SPEC.md (66 requirement IDs), ARCHITECTURE.md, TASKS.md (full roadmap), TEST_PLAN.md, DECISIONS.md, THREAT_MODEL.md, docs/*, knowledge/*.

## Verification evidence
- P0-02 smoke cluster: node Ready (k3s v1.35.5+k3s1), `local-path` default StorageClass, `curl http://smoke.127.0.0.1.nip.io:18080/` → whoami pod; NetworkPolicy: unlabelled pod BLOCKED, allowed pod REACHABLE.
- P0-01: `git status -sb` → `## main...origin/main`; `git check-ignore -v .env` → ignored; pre-push secret scan clean.
- Environment checks (read-only): Docker 29.6.2 running, 12 CPU / ~15 GB RAM; kubectl 1.36.1; Node 24.19; helm, k3d, kind and minikube missing; no kubeconfig; no LLM keys in env.

## Blockers
- **VPS not available** (user will provision one) → blocks P0-03, REL-01, REQ-K8S-02. Needed by Day 4–5.
- **GitHub fine-grained PAT** still needed in `.env` (`GITHUB_MCP_PAT`) → P0-04, blocks ARC-15. Groq key verified 2026-10-11; OpenRouter key optional.
- GitHub repo is **private**. It must be made public (or reviewers added) at submission → REL-17.

## Important decisions
SDK v1 stateless Streamable HTTP (D-002); WooCommerce REST + OAuth1 (D-003); `slug__tool` namespacing (D-005); k3d/k3s + Traefik + nip.io (D-010); own Helm templates with official images (D-011); Groq/OpenRouter via OpenAI-compatible API (D-012).

## Next recommended task
GW-02 (Postgres in chart + upstream table/migrations), then GW-03/04. ARC-15 and GW-14 still need `GITHUB_MCP_PAT`.

## Remaining mandatory acceptance criteria
All 12 DoD checks (REQ-DOD-01…12): not started.

## Risks
| # | Risk | Mitigation | Owner task |
|---|---|---|---|
| R1 | MCP SDK/protocol churn breaks client compatibility | Pin SDK v1; test with real Claude Code + Inspector on Day 1 | ARC-13 |
| R2 | WooCommerce REST auth over in-cluster HTTP fails | OAuth1 signing experiment | ARC-14 |
| R3 | WordPress siteurl/Ingress redirect loops | `WP_HOME`/`WP_SITEURL` from values; forwarded-proto handling | WC-02 |
| R4 | Free LLM rate limits or weak tool calling during the demo | Provider-agnostic adapter; Groq + OpenRouter tested; cap tool count | P0-04, UI-14 |
| R5 | VPS arrives late | k3d mirrors k3s; VPS steps scripted; blocker tracked | P0-03, REL-01 |
| R6 | VPS too small or arm64 images | ≥4 GB RAM; multi-arch builds | REL-03 |
| R7 | NetworkPolicy not enforced locally | **Closed 2026-10-11**: deny/allow verified on k3d (P0-02). Policies must also admit Traefik for Ingress-exposed pods | WC-14 |
