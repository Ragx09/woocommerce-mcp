# Progress

## Current phase
Phase 0 — Repository assessment and requirements (Day 1, 2026-10-11)

## Current task
P0-12 — Plan review checkpoint (waiting on user: GitHub repo visibility, credentials, go-ahead for tool installs)

## Recently completed
- 2026-10-11: Converted the brief to `problem-statement.md`; repo created at `~/projects/woocommerce-mcp` (git initialised, no remote yet).
- 2026-10-11: Research (MCP spec/SDK status, Bitnami deprecation, ingress-nginx retirement, WooCommerce auth over HTTP, free LLM tiers) → decisions D-001…D-013 (Proposed).
- 2026-10-11: Project tracker (`tracker/build.mjs` + `tracker/index.html`), verified headlessly at desktop and mobile widths.
- 2026-10-11: Docs: CLAUDE.md, SPEC.md (66 requirement IDs), ARCHITECTURE.md, TASKS.md (full roadmap), TEST_PLAN.md, DECISIONS.md, THREAT_MODEL.md, docs/*, knowledge/*.

## Verification evidence
- Environment checks (read-only): Docker 29.6.2 running, 12 CPU / ~15 GB RAM; kubectl 1.36.1; Node 24.19; helm, k3d, kind and minikube missing; no kubeconfig; no LLM keys in env.

## Blockers
- **VPS not available** (user will provision one) → blocks P0-03, REL-01, REQ-K8S-02. Needed by Day 4–5.
- **Credentials needed from user**: Groq API key (+ optional OpenRouter), GitHub fine-grained PAT → P0-04.
- **GitHub repo creation** needs user confirmation (public or private) → P0-01.

## Important decisions
SDK v1 stateless Streamable HTTP (D-002); WooCommerce REST + OAuth1 (D-003); `slug__tool` namespacing (D-005); k3d/k3s + Traefik + nip.io (D-010); own Helm templates with official images (D-011); Groq/OpenRouter via OpenAI-compatible API (D-012).

## Next recommended task
P0-02 (install helm + k3d), then ARC-13 / ARC-14 experiments.

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
| R7 | NetworkPolicy not enforced locally | Verify with a curl-pod deny test | WC-14 |
