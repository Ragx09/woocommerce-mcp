# Progress

## Current phase
Phase 4 — Gateway: multiple upstreams, timeouts, health (Day 3, 2026-10-13)

## Current task
GW-09 Done. Next: GW-10 Failure isolation + health loop

## Recently completed
- 2026-10-13: **GW-09 — timeouts**: `withDeadline()` puts one deadline over connect + call + reconnect (calls 15 s, lists 3 s, connect 2 s; env `UPSTREAM_*_TIMEOUT_MS`, Helm `gateway.upstreamTimeouts`); on expiry the request is aborted (`notifications/cancelled`) and the client gets `upstream_timeout`; timed-out calls are never retried. TC-INT-03 3/3 (5 runs), unit 49/49, int 26/26, chart checks PASS, k3d rev 19 smoke OK (5 tools, `list_orders` ok). Limitation: stateless woo-mcp cannot act on the cancel.
- 2026-10-13: PROGRESS blockers cleaned up (stale BRD-03 line removed; BRD-03 is Done).
- 2026-10-13: **BRD-08 — admin and login branding**: TATVA admin colour scheme (forest menu, sand current item, terracotta counters) registered by the `tatva` theme, default for new users and set by wp-init for the admin user only while on the default scheme; login page with the TATVA wordmark linking to the store. `scripts/admin-screens.sh` 11/11 PASS (desktop + mobile); storefront audit and chart check unchanged. Presentation only, no auth change.
- 2026-10-12: **Phase 9 BRD-01..07 — TATVA V1 storefront**: `tatva` child theme (palette/type from the V1 spec, header/footer, homepage sections in spec order, shop/category/brand/search archives with category/brand/price filters, product page, brand + category directories, concept page), 50-product INR catalogue with 9 placeholder brands imported idempotently by wp-init from the new `store-assets` image (D-016), 49/50 product images + 8 editorial images (CC0/PD only, no on-site credits per user; Openverse + Wikimedia Commons; manifest + `validate_images.py`). Old sample products retired. Verified: 22 page views audited (0 broken images/alt/h-scroll), COD e2e PASS with Indian address, woo-int 7/7, unit 26/26 + 48/48, chart 0 violations, pod-deletion keeps branding. Open: TAT-005 has no image; `/cart/` logs a WooCommerce `undefinedwc/store/v1/cart` 404 (cart works); clean-cluster run with branding not yet repeated.
- 2026-10-12: P0-04 + ARC-15 Done — `GITHUB_MCP_PAT` verified against GitHub remote MCP (46 tools, `get_me` OK, 401 without token), put into Secret `upstream-seed`; D-013 Accepted. `.env` converted from CRLF to LF.
- 2026-10-12: INF-15 — `scripts/up.sh` from a deleted cluster → all Ready in 5m32s (smoke: shop 200, gateway list + call OK); re-run is a no-op after fixing non-reproducible image ids (`--provenance=false --sbom=false` in `build-images.sh`); README "Local setup" written; `checkpoint.md` gitignored. Note: the clean rebuild reset all local data (orders, gateway DB, dev key) — the old demo-pay DB rows are gone with it.
- 2026-10-12: Brand docs → **TATVA as the current working concept (may change)**: D-015 rewritten (Proposed), D-016 points to `docs/v1-brand-ui-theme.md`, BRD-01..07 reference the TATVA docs (5 categories, ~50 proposed products, placeholder brands), **BRD-03 unblocked** (theme material exists). TATVA docs committed; `*:Zone.Identifier` ignored. Sample products still named "Urumi …" until BRD-05.
- 2026-10-12: WC-16 (mock card payment page) **removed**: not in the problem statement (COD satisfies REQ-STORE-02); no code/task/doc left in the repo. The stale k3d DB rows were cleared by the INF-15 clean rebuild: `active_plugins` = woocommerce only, no `urumi_demo` options (checked).
- 2026-10-12: GW-08 — `tools/call` routing: public name → `ToolIndex` (works for hashed names) → forward → result unchanged; `unknown_tool` / `upstream_disabled` JSON-RPC errors; unreachable/timeout/error → readable `isError` results; retry only when the call certainly did not run. Unit 48/48. **Day 2 vertical slice PASS on k3d:** Inspector CLI → gateway → woo-mcp → WooCommerce returns 5 products and 6 orders.
- 2026-10-12: GW-06 — gateway `POST /mcp` (stateless, low-level SDK `Server`): tools/list reloads upstreams from the DB, discovers (GW-05) and returns public names (GW-07); temporary shared `MCP_DEV_KEY` (Secret `gateway-dev-key`, fail closed) until AUTH-08. Unit 40/40; on k3d the Inspector CLI lists the 5 `woo__*` tools through Traefik; 401 without/with wrong key; key absent from logs.
- 2026-10-12: GW-07 — `src/mcp/naming.ts`: `slug__tool`, 64-char limit with sha1 suffix, invalid characters sanitized + hashed, `ToolIndex` for routing (handles unsplittable hashed names, reports duplicates), `[slug]` description prefix capped at 1024. 8 tests (TC-UNIT-01), unit suite 33/33. D-005 addendum.
- 2026-10-12: Roadmap extended (docs only): **Phase 9 — Storefront brand and catalogue** (BRD-01..07, Day 3, P2, D-015/D-016) and **Phase 10 — Security testing: attack and harden** (SEC-01..09, Day 6–7 and ongoing; `docs/SECURITY_TESTING.md`, `SECURITY_FINDINGS.md`, `RED_TEAM_BRIEF.md`; `brand/README.md`). Tracker `idList` now parses `BRD`/`SEC` IDs; tracker regenerated.
- 2026-10-12: GW-05 — `ToolDiscovery` (parallel paginated `listTools`, 3 s deadline per upstream, 60 s stale cache keyed by config version, single-flight, failures isolated and reported); 7 tests, unit suite 25/25. Also fixed `safeReason` prefixes for SDK errors. Not yet wired into `/mcp` (GW-06); k3d check deferred (Docker Desktop was not running).
- 2026-10-12: GW-04 — upstream client pool (lazy connect, credential injection, rebuild on change, reconnect once on stale session, 2 s connect timeout); 7 pool tests with in-process fake upstreams; woo tools listed from the gateway pod. `build-images.sh` now keeps tags of services not rebuilt.
- 2026-10-12: GW-03 — woo upstream seeded at startup (once; admin edits/deletes respected; untouched row follows token rotation), credential AES-256-GCM encrypted (`gateway-secrets`), `app_meta` table, `listUpstreams`/`toPublic` allowlist. 11 unit + 23 integration tests; verified on k3d.
- 2026-10-12: GW-02 — Postgres 16 StatefulSet + PVC (gateway-only NetworkPolicy, `postgres-secrets`); Drizzle `upstreams` table with DB-level CHECK constraints; migrations at startup under an advisory lock; `/readyz` checks the DB; gateway startupProbe. 16 integration tests (`scripts/gateway-db-int.sh`); fresh install, Postgres restart and persistence verified on k3d.
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
- SEC-07 TLS part waits for the VPS / REL-04.
- **VPS not available** (user will provision one) → blocks P0-03, REL-01, REQ-K8S-02. Needed by Day 4–5.
- GitHub repo is **private**. It must be made public (or reviewers added) at submission → REL-17.

## Important decisions
SDK v1 stateless Streamable HTTP (D-002); WooCommerce REST + OAuth1 (D-003); `slug__tool` namespacing (D-005); k3d/k3s + Traefik + nip.io (D-010); own Helm templates with official images (D-011); Groq/OpenRouter via OpenAI-compatible API (D-012).

## Next recommended task
Day 3: GW-10 (health), GW-11, GW-12, GW-13 (everything-mcp), GW-14 (GitHub; PAT in place).

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
