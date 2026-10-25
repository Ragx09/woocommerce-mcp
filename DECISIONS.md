# Architecture Decision Log

Format: each decision has an ID, date, context, options, choice, reasons, trade-offs, and whether it needs revisiting. Status is `Proposed` until validated by an experiment or an implementation, then `Accepted`.

## D-001 — Language and monorepo
- **Date:** 2026-10-11
- **Status:** Proposed
- **Context:** Four codebases (MCP server, gateway, chat agent, dashboard) in 7 days.
- **Options:** TypeScript everywhere; Python backend + React; Go gateway.
- **Choice:** TypeScript on Node 24, npm workspaces (`services/*`, `apps/*`).
- **Why:** One language and toolchain. The official MCP TypeScript SDK covers both the server and client sides, which we need in the same process for the gateway. React needs TS anyway. Node 24 is already installed.
- **Trade-offs:** Node's single thread is fine at this scale.
- **Revisit:** No.

## D-002 — MCP SDK and protocol version
- **Date:** 2026-10-11
- **Status:** Accepted (ARC-13 passed 2026-10-11: `@modelcontextprotocol/sdk@1.32.1`, negotiated protocol 2025-11-25, works with Inspector CLI 2.10.1, Claude Code and the SDK client)
- **Context:** Spec 2026-07-28 (stateless, no `initialize`) is new; TS SDK v2 (`@modelcontextprotocol/server` / `client`) is new. Claude Code, Cursor and Inspector all support 2025-11-25.
- **Options:** SDK v1.x (`@modelcontextprotocol/sdk`) with Streamable HTTP; SDK v2.
- **Choice:** `@modelcontextprotocol/sdk` v1.x, pinned exactly; Streamable HTTP in **stateless** mode (`sessionIdGenerator: undefined`, a new transport per request).
- **Why:** Mature, widely documented, compatible with every client we must demo. Stateless mode removes session affinity, so multiple gateway replicas work.
- **Trade-offs:** No server→client requests or notifications (sampling, list_changed). Clients re-list tools when they reconnect. A move to v2 later would be a contained migration.
- **Findings (ARC-13/15):** Our servers are stateless, but third-party upstreams may be sessionful (server-everything is). The gateway client therefore keeps one connected `Client` per upstream, reconnects once on a session error (stale `Mcp-Session-Id` after an upstream restart), and wraps fetch in its own `AbortSignal` timeout, because the SDK request timeout does not bound the TCP connect.
- **Revisit:** If ARC-13 shows a client incompatibility.
- **Implementation (GW-04, 2026-10-12):** `UpstreamPool` uses the SDK `fetch` option with `undici@8.11.2` (`Agent({connect:{timeout:2000}, bodyTimeout:0})`) so TCP connect is bounded; request budgets use the SDK `timeout` option (GW-09).

## D-003 — WooCommerce integration method
- **Date:** 2026-10-11
- **Status:** Accepted (ARC-14 passed 2026-10-11 against WooCommerce 11.2.1)
- **Context:** woo-mcp must read and write products and orders. The in-cluster call is plain HTTP.
- **Options:** WC REST API with OAuth 1.0a (HTTP); WC REST with Basic auth (HTTPS-only); WP Application Passwords (HTTPS-only); WP-CLI via `kubectl exec`; direct SQL.
- **Choice:** WooCommerce REST API v3 over the internal Service, authenticated with a consumer key/secret using **OAuth 1.0a one-legged HMAC-SHA256** signing.
- **Why:** Versioned, validated, and it runs WooCommerce business logic (stock, totals, hooks). The key is owned by a dedicated service user, so it is revocable and least-privilege. No exec privileges or DB credentials are needed in the MCP server. OAuth1 is the documented method for non-HTTPS.
- **Trade-offs:** The signing code must be correct (unit-tested). The REST round-trip is a bit slower than SQL.
- **Findings (ARC-14):** (1) WooCommerce signs against `get_home_url()` + route, so woo-mcp needs **two URLs**: `WOO_BASE_URL` (where it connects, the internal Service) and `WOO_SIGNING_URL` (the WP home URL, the public store host). (2) WC 11.2.1 sorts raw keys and double-encodes `k=v` pairs. (3) Query-parameter names must stay plain (PHP mangles `+`, spaces, dots). (4) Nonces are single-use within 15 minutes, so each request needs a fresh nonce. (5) The REST key is created with `wp eval` (WP-CLI has no API-key command).
- **Revisit:** No.

## D-004 — Gateway shape
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** One Fastify service hosting `/mcp` (MCP server), the upstream MCP client pool, `/api/*` (dashboard REST) and the chat agent.
- **Why:** The smallest deployable set for 7 days. Modules (`mcp/`, `upstreams/`, `auth/`, `audit/`, `chat/`, `api/`) keep the boundaries clear.
- **Trade-offs:** Chat load and MCP load share a process. Acceptable here.
- **Revisit:** If scaling becomes a stand-out goal.

## D-005 — Tool-name collision policy
- **Date:** 2026-10-11
- **Status:** Accepted (GW-07 implemented and unit-tested 2026-10-12)
- **Choice:** Always expose `<slug>__<tool>`. Slug: `^[a-z0-9-]{1,20}$`, unique, immutable after creation. The final name must match `^[a-zA-Z0-9_-]{1,64}$`. If it is too long, use the first 55 characters + `_` + 8 hex characters of sha1 (deterministic). Routing splits on the first `__`. **Addendum 2026-10-12 (GW-07):** upstream names with characters outside `[a-zA-Z0-9_-]` (MCP allows `.`) get the same hash form after replacing those characters with `_`; because hashed names cannot be split back, `tools/call` resolves the public name through an index built from the discovered tools (`ToolIndex`), and a duplicate public name keeps the first tool and is logged.
- **Why:** Collision-free by construction and deterministic across replicas. Compatible with Claude/OpenAI tool-name rules. Shows the user which server a tool comes from.
- **Trade-offs:** Longer names. Upstream tool names containing `__` still work because we split on the first occurrence and slugs cannot contain `_`.

## D-006 — Gateway database
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** PostgreSQL 16 (official image, StatefulSet + PVC), Drizzle ORM with SQL migrations.
- **Why:** Multi-replica safe, real constraints. Separate from the store's MariaDB (isolation of failure and credentials).
- **Trade-offs:** One more stateful workload.
- **Implementation (GW-02, 2026-10-12):** `postgres:16.15-alpine3.24` StatefulSet (uid 70, read-only root FS, PVC). drizzle-orm 0.45.4 + drizzle-kit 0.31.11; SQL migrations committed under `services/gateway/drizzle/`, applied at gateway startup under `pg_advisory_lock` (safe with replicas). Invariants are CHECK constraints in the DB, not only API validation.

## D-007 — Dashboard authentication
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** Email + password (argon2id). Server-side sessions in Postgres, with the ID in an httpOnly, Secure (prod), SameSite=Strict cookie. Mutating requests check `Origin`. The first admin is seeded from a Secret. Members join via one-time invite tokens (stored hashed, 72 h expiry).
- **Why:** Simple, standard, and keeps tokens out of JS.
- **Trade-offs:** No SSO/OAuth (stand-out item 3).
- **Implementation (AUTH-01/02, 2026-10-13):** `@node-rs/argon2` (prebuilt, incl. musl) with OWASP parameters m=19456 KiB, t=2, p=1; sessions keyed by SHA-256 of a 32-byte cookie token (a DB dump holds no usable session); login throttled per IP+email and per IP in memory per replica; one 401 for every login failure. Needs real client IPs at the ingress (Traefik `externalTrafficPolicy: Local` on the VPS).

## D-008 — Gateway API keys
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** `mgw_` + 32 bytes of CSPRNG output, base62. The DB stores `sha256(key)` (unique index) + `prefix` (first 12 characters) + owner + `revoked_at` + `last_used_at`. The key is shown once. Validation on every request does a DB lookup (no cache), so revocation is immediate.
- **Why:** For high-entropy random secrets a fast hash is sufficient; a slow KDF only protects low-entropy passwords. Lookup by hash avoids timing leaks.
- **Trade-offs:** One DB read per MCP request (indexed, cheap).
- **Implementation (AUTH-06..09, 2026-10-13):** 43 base62 characters from 32 CSPRNG bytes; `key_hash` unique + DB CHECKs; the lookup also requires the owner to be enabled; `last_used_at` written at most once a minute (no write per request); max 20 active keys per user; revoking someone else's key as a member → 404. The temporary shared dev key was removed; scripts create and revoke short-lived keys through the API.

## D-009 — Upstream credential storage
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** AES-256-GCM encryption with a 32-byte key from the K8s Secret `gateway-secrets.CREDENTIALS_KEY`. Stored as `{iv, ciphertext, tag}`. The API field is write-only (responses show `hasCredential: true` + header name only).
- **Why:** A DB dump alone doesn't leak upstream tokens. Credentials never reach the browser.
- **Implementation (GW-03, 2026-10-12):** `{v:1, iv, ciphertext, tag}` in `upstreams.credential_enc` (jsonb); the upstream slug is bound as GCM associated data, so a ciphertext copied to another row does not decrypt. Key: `gateway-secrets/credentials-key` (64 hex chars) from `scripts/make-secrets.sh`.

## D-010 — Local cluster, ingress and domains
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** k3d (k3s in Docker) locally, k3s on the VPS. Bundled Traefik ingress and the `local-path` StorageClass on both. Hosts `store.127.0.0.1.nip.io` / `app.127.0.0.1.nip.io` locally.
- **Why:** Local == prod distribution, so the values diff is minimal. ingress-nginx was retired in March 2026, and Traefik is k3s's default. nip.io needs no hosts-file edits from WSL or Windows.
- **Trade-offs:** nip.io depends on public DNS (fallback: a hosts-file entry, documented).

## D-011 — Store deployment without Bitnami
- **Date:** 2026-10-11
- **Status:** Accepted (implemented and verified 2026-10-11: WC-01…05)
- **Choice:** Our own templates in one chart, `charts/platform`, with a folder per component and `enabled` toggles: official `mariadb:11.8.9` StatefulSet, official `wordpress:7.1.3-php8.3-apache` Deployment with a PVC for `/var/www/html`, and a `wordpress:cli-2.12.0` Job that installs core + WooCommerce 11.2.1, enables COD, creates sample products and registers the REST key for a `mcp-service` user.
- **Why:** Bitnami's free catalog is deprecated and limited to `latest`; `bitnamilegacy` gets no updates.
- **Changes during implementation:** (1) One chart instead of subcharts: less indirection, and the environment diff is still values-only. (2) The REST key is generated by `scripts/make-secrets.sh` and *registered* by the Job (hash stored), so the Job needs no Kubernetes API access to write a Secret. (3) The Job is a regular revisioned Job (`wp-init-<revision>`), not a post-install hook: a hook runs only after `helm --wait`, which itself waits for woo-mcp readiness, which needs the installed store — a deadlock.
- **Trade-offs:** We own more YAML and an idempotent init script. WordPress runs Apache as root-then-www-data (capabilities trimmed to 7), so the namespace enforces Pod Security `baseline`, not `restricted`.

## D-012 — Chat agent LLM provider
- **Date:** 2026-10-11
- **Status:** Accepted (UI-13, 2026-10-15: Groq wired through values + Secret `llm-secrets`; OpenRouter switch is values-only, not re-tested without a key)
- **Choice:** An OpenAI-compatible chat-completions client (plain `fetch`, no SDK) with `baseUrl`, `model` and `apiKey` from values and a Secret. Default Groq (`https://api.groq.com/openai/v1`); OpenRouter (`https://openrouter.ai/api/v1`) is the alternative.
- **Why:** Free tiers with tool calling; switching providers is a values change.
- **Trade-offs:** Free-tier rate limits during rehearsals; small models may choose tools badly. Mitigated with a clear system prompt and a tool-count cap.

## D-013 — Additional upstream MCP servers
- **Date:** 2026-10-11
- **Status:** Accepted (ARC-15 passed 2026-10-12: server-everything 13 tools; GitHub remote 46 tools with PAT, 401 without; both sessionful)
- **Choice:** (1) `@modelcontextprotocol/server-everything` in-cluster, Streamable HTTP mode. (2) GitHub's remote MCP server (`https://api.githubcopilot.com/mcp/`) with a fine-grained PAT as a bearer credential.
- **Why:** (1) gives us an in-cluster pod to kill and generic tool names. (2) demonstrates server-side credential injection and a realistic cross-server prompt (orders → GitHub issue).
- **Trade-offs:** GitHub depends on internet access and the PAT. Fallback: DeepWiki (no auth).


## D-015 — Store concept: TATVA (current working concept)
- **Date:** 2026-10-12 (updated 2026-10-12)
- **Status:** Proposed — current working concept, may change
- **Choice:** For now the demo store is **TATVA**, a curated multi-brand Indian lifestyle store (primary line "The Essence of Good Design.", campaign line "Discover brands with meaning."). 5 categories with Home & Living as the hero; a proposed starter catalogue of about 50 products with illustrative ₹ prices and **placeholder brand names**. Details: [`brand/tatva/tatva-brand-and-products.md`](brand/tatva/tatva-brand-and-products.md), UI/theme: [`brand/tatva/v1-brand-ui-theme.md`](brand/tatva/v1-brand-ui-theme.md), images: [`docs/PRODUCT_IMAGES.md`](docs/PRODUCT_IMAGES.md). Replaces the earlier Urumi idea (7 categories, real brand names from a mockup).
- **Why:** A concrete, good-looking store makes the demo more convincing than generic sample products. Keeping the concept in docs (not in task text) means a later rename only touches those docs, the theme tokens and the catalogue data.
- **Trade-offs:** Placeholder brand names avoid most trademark risk, but names, product claims and image licences still need a check before the repo goes public or the video is recorded (REL-16/17). Brand work is P2 and the first thing cut if behind. Today's seeded sample products still carry "Urumi" names until BRD-05 replaces them.

## D-016 — Storefront theme and asset delivery
- **Date:** 2026-10-12
- **Status:** Accepted (BRD-03/06 implemented and verified 2026-10-12)
- **Choice:** A `tatva` child theme of Twenty Twenty-Five (block theme + WooCommerce blocks), following [`brand/tatva/v1-brand-ui-theme.md`](brand/tatva/v1-brand-ui-theme.md). Theme, catalogue (`catalogue.json`), images and importer ship as a files-only `store-assets` image; the wp-init Job copies it in through an initContainer, swaps the theme in and runs an idempotent WP-CLI importer that uses the normal WooCommerce data model and media library. Product images: CC0 / Public Domain only (no attribution required, so no credits on the storefront — user decision), sourced via the Openverse and Wikimedia Commons APIs, recorded in `images/manifest.json`.
- **Why:** Reproducible on k3d and the VPS with the same chart; images exceed the 1 MiB ConfigMap limit; one source of truth in git; no hand-made WordPress state. A child of the bundled default theme keeps WooCommerce block templates and checkout markup stable.
- **Trade-offs:** One more image to build and push (REL-03). CC0/PD-only narrows image choice (one product without a suitable image, some originals only ~1024 px). A full-site-editing change made in wp-admin would be overwritten by the next deploy for theme files (content pages are patterns, so text lives in git).

## D-017 — Dashboard delivery: static SPA on the gateway's host
- **Date:** 2026-10-14
- **Status:** Accepted (UI-01/02/03/20 implemented and verified 2026-10-14)
- **Choice:** Vite + React SPA built to static files and served by `nginx-unprivileged` from its own Deployment, at `app.<domain>/` on the same host as the gateway (`/api`, `/mcp`). The browser calls only relative `/api/...` URLs with the session cookie; no tokens in JavaScript or storage. nginx sets a strict CSP (`default-src 'self'`, no inline script/style, `frame-ancestors 'none'`); the build inlines no `data:` assets so no CSP exceptions are needed. Both gateway Ingress paths are `Prefix`.
- **Why:** One origin keeps `SameSite=Strict` cookies working and removes CORS entirely. A static image has no runtime secrets and almost no attack surface; the gateway stays the single place where authorization happens (the UI only hides links). A separate Deployment lets the UI ship without restarting the gateway.
- **Trade-offs:** One more image (REL-03) and pod (~16 MiB). Traefik does not follow the Ingress rule that `Exact` beats `Prefix`; it orders routers by rule length, so an `Exact` `/mcp` was shadowed by `/` and MCP clients got nginx — `/mcp` is now `Prefix` (paths under `/mcp/` reach the gateway and get 404). Security headers for the dashboard come from nginx; the gateway's own JSON responses still rely on SEC-07 (Traefik middleware).

## D-018 — Chat agent authentication to /mcp: per-process HMAC token over loopback
- **Date:** 2026-10-15
- **Status:** Accepted (UI-15 implemented and verified 2026-10-15)
- **Choice:** The chat agent calls the gateway's own `/mcp` at `127.0.0.1` with a short-lived token `itk_<payload>.<HMAC-SHA256>` (`sub`, `src=chat`, `exp` ≤ 5 min). The HMAC key is 32 random bytes generated at process start and kept only in memory. `/mcp` accepts `itk_` tokens only when the TCP peer is loopback, and still looks the user up on every request.
- **Why:** The chat then goes through exactly the same auth, routing, timeout and audit path as external clients (REQ-GW-11), attributed to the signed-in user with `source=chat` (REQ-CHAT-03), without minting a real API key per conversation. A per-process key needs no Secret, no rotation and works with any number of replicas, because a token is only ever verified by the process that minted it.
- **Trade-offs:** A token dies with its pod (a chat request in flight during a rollout fails once; the user retries). Loopback-only means the agent cannot be split into its own Deployment without switching to a shared key from a Secret. A leaked token is useless through the Ingress, and within 5 min at most inside the pod.

## D-019 — Many tools in the chat: relevance budget + find_tools
- **Date:** 2026-10-15
- **Status:** Accepted (UI-14, verified on k3d with Groq 2026-10-15)
- **Choice:** The chat agent does not send every tool to the LLM. It offers the tools that best match the user's last turns (keyword score on name and description; ties in registry order) within a 6000-character budget, plus a local meta-tool `find_tools` that searches the user's full tool list by keywords or exact names; the best 8 matches become callable in the next round and further names are returned. Tool descriptions are cut to 400 characters for the model and results to 4 KB.
- **Why:** Found on k3d: the 64 tools of three servers are ≈ 16.7k tokens, more than the Groq free tier's 8k tokens per minute, so every chat request failed with HTTP 413. The approach also covers stand-out item 4 (handling many tools) and keeps working as servers are added. Calls still go to `/mcp` by their real names, so authorization, routing and audit are unchanged; `find_tools` never sees anything the user's own `tools/list` did not return.
- **Trade-offs:** Keyword matching misses synonyms (the model may need a second search); one extra LLM round when a tool must be found first. On the free tier about two questions per minute fit; heavier use needs a paid tier or another provider (values change). External MCP clients still receive the full list.

## D-020 — Chat: retry a schema-refused tool call once, with the reason
- **Date:** 2026-10-16
- **Status:** Accepted (UI-16, verified on k3d with Groq 2026-10-16)
- **Choice:** When the LLM provider refuses a completion with `tool_use_failed` (Groq validates tool-call arguments against the tool's JSON schema), the LLM client repeats the request once with an extra system message carrying the provider's validation message (e.g. "`/per_page`: maximum: got 100, want 50"). The message is scrubbed of the API key and credential-shaped strings, capped at 400 characters, and never logged or returned to the browser. Other 4xx errors and a second refusal are not retried.
- **Why:** Found in TC-UI-16-1: gpt-oss-120b asked `woo__list_orders` for 100 orders per page (our maximum is 50) in 3 of 5 tries, so the plain "today's orders" demo question failed with 502 more often than not. A blind retry failed the same way; with the reason it recovered every time. It fixes the whole class (any strict schema, including GitHub's 46 tools) rather than one parameter.
- **Trade-offs:** A refused round costs its tokens twice (free tier 8k TPM). Raising `per_page` to WooCommerce's own limit of 100 would remove this one case too, but changes the woo-mcp contract and leaves the others; not done.

## D-021 — Tool permissions: a member rule per server, enforced in /mcp
- **Date:** 2026-10-24
- **Status:** Accepted (BON-01, verified on k3d 2026-10-24)
- **Choice:** Each upstream row carries `member_access` (`all` · `none` · `selected`) and `member_tools` (upstream tool names). Admins always get every tool. `/mcp` applies the rule per request from the registry rows it already reads: `tools/list` leaves out what the caller's role may not use, `tools/call` refuses it with `tool_forbidden` (JSON-RPC -32602, audited as `rejected` under the user) **before** contacting the upstream, and checks the resolved tool name a second time. The dashboard's server list and tool list apply the same functions (`src/authz/tool-access.ts`). The chart seeds woo with members read-only (`gateway.seed.woo.memberTools`), on first creation only.
- **Why:** Stand-out item 2 (REQ-SO-02) with its own example (members read orders, only admins create products or change order status). Putting the rule in `/mcp` covers API keys, the chat (internal token → same `/mcp`) and any future client in one place; per server is how admins already think about upstreams, and it needs no new table or join. A refusal does not say whether the tool exists, so a member cannot probe hidden tools, and it happens before "disabled" or "unknown tool".
- **Trade-offs:** Per role (admin/member), not per user: enough for the two roles we have; a per-user override would be a second table. A tool added later to a `selected` server is hidden from members until an admin ticks it (safe default); with `all` it appears at once. Changing the rule bumps `updated_at`, which rebuilds that upstream's pooled connection once.

## D-022 — Replicas: limits and the chat lock in Postgres
- **Date:** 2026-10-24
- **Status:** Accepted (BON-04, verified on k3d with 2 replicas 2026-10-24)
- **Choice:** The gateway runs 2 replicas. Budgets that must hold for the whole team live in Postgres: `rate_limits` (one row per bucket, one atomic `INSERT … ON CONFLICT DO UPDATE` per counted request; the window starts at the bucket's first hit) and `leases` (exclusive holds with an expiry; released by the holder only). Used for `/mcp` per API key and per user (tools/call + tools/list, 120/240 per minute by default) and for the chat (one request per user at a time, 30 per 10 min). The dashboard chat's own `/mcp` requests are not counted against the user's API budget. Pods: rolling update without unavailability, PodDisruptionBudget `minAvailable: 1`, `preStop` sleep 5 s before SIGTERM.
- **Why:** Stand-out item 7. In-memory limits give N replicas N× the budget, and the chat lock would let a user run one chat per replica. Postgres is already a hard dependency of every `/mcp` request (key lookup), so this adds one small query, not a new component (no Redis). A window anchored at the first hit cannot reset at a clock boundary in the middle of a burst. The preStop pause was found necessary on k3d: without it a request could reach a terminating pod (1 of 40 calls → 502).
- **Trade-offs:** One extra DB round trip per counted request; fixed windows allow a burst of up to 2× at a window edge. The login limiter stays in memory per replica (2 replicas → 2× the failed-login budget, still far too little for guessing; T-13). Health status and the discovery cache are per replica (each converges within one health interval).

## D-023 — VPS images: streamed into k3s's containerd, no registry
- **Date:** 2026-10-24
- **Status:** Accepted (scripted in `vps-setup/up.sh`; not yet run on the VPS)
- **Choice:** `vps-setup/up.sh` builds the same content-addressed tags as local (`NO_K3D=1 scripts/build-images.sh`), tags them with the values-prod prefix (`ghcr.io/ragx09/<svc>:sha-…`) and streams them over SSH into k3s's containerd (`docker save | gzip | ssh … k3s ctr -n k8s.io images import -`). With `imagePullPolicy: IfNotPresent` the kubelet uses them without contacting GHCR. An image already present on the node is skipped. The registry prefix stays in values-prod, so pushing to GHCR later needs no chart change.
- **Why:** The VM lives for hours (created per recording/presentation session, then destroyed; `vps-setup/VPS.md`). A registry would need a PAT with `write:packages` on the laptop and either public packages or a pull Secret on every fresh cluster, i.e. one more credential to manage for no gain on a single node. Same tags as k3d means the VPS runs byte-identical images to the ones tested locally.
- **Trade-offs:** Upload time depends on the laptop's upload speed (images ≈ 0.5 GB compressed in total, uploaded once per VM). Works for a single node only; a multi-node cluster or CI-driven deploy would push to GHCR instead. amd64 only (`up.sh` refuses another arch).

## D-024 — Security patches may be younger than the 2-week dependency age rule
- **Date:** 2026-10-24
- **Status:** Accepted (BON-05, F-INF-1)
- **Choice:** We normally pick dependency versions at least two weeks old (supply-chain caution: a hijacked release is usually caught within days). A patch release that fixes a CVE affecting us may be taken earlier when it is from the same maintainers, is a patch-level bump, and its changelog is only the fix. Taken on 2026-10-24: undici 8.12.2 (9 days; DoS by a malformed upstream response — the gateway uses undici for every upstream), body-parser 2.4.0 (2 days) with qs 6.16.1 (10 days), nginx-unprivileged 1.30.6 (5 days; three nginx CVEs not reachable with our config, taken to keep the image at 0 HIGH). Separately, runtime Node images no longer contain npm/npx/corepack, which removed most of the findings without any version change.
- **Why:** A known, exploitable CVE outweighs the small risk of a very new patch from an established maintainer; waiting two weeks would leave a known hole open.
- **Trade-offs:** Less time for the community to spot a bad release; mitigated by patch-only bumps, a lockfile, and re-running all suites (unit, int, E2E, browser) after the bump.

## D-025 — Third-party images pinned by digest
- **Date:** 2026-10-25
- **Status:** Accepted (SEC-06, F-INF-6, F-INF-5)
- **Choice:** wordpress, wordpress:cli, mariadb and postgres are referenced as `tag@sha256:<digest>` in `values.yaml`: the tag says which version, the digest fixes the exact build that Trivy scanned. Docker Official Images rebuild the same tag for OS patches (wordpress 7.1.3 was rebuilt on 2026-10-21: 78 → 1 fixable HIGH), so a tag alone means different bits on k3d (cached) and on a fresh VPS. To take a rebuild: pull, run `scripts/sec/k8s-scan.sh trivy`, update the digest. Rebuilds younger than two weeks are taken under D-024 (OS security patches). The gosu binary in the mariadb/postgres images (Go stdlib CVEs, no newer upstream build) is accepted: it only runs when a container starts as root, and ours start as uid 999/70.
- **Why:** Reproducible installs across k3d and the VPS, and the scanned image is the one that runs.
- **Trade-offs:** Security rebuilds are no longer picked up automatically; updating the digest is a manual step (documented in `docs/SECURITY_TESTING.md` / this entry).

## D-026 — Multi-store: a provisioner running Helm, desired state in Postgres
- **Date:** 2026-10-25
- **Status:** Accepted (design; built in BON-09..15)
- **Choice:** One store = one Helm release of a new chart `charts/store` in namespace `store-<slug>`; the default TATVA store uses the same chart as a dependency of the platform chart. A separate `provisioner` service is the only component with Kubernetes rights: ClusterRole for namespaces + RoleBindings with `bind` limited to ClusterRole `store-manager` (only the kinds the store chart renders), plus a ValidatingAdmissionPolicy that refuses any namespace or RoleBinding outside labelled `store-*` namespaces. The gateway writes desired state (`stores`, `store_members`) to Postgres; the provisioner reconciles it (idempotent by request id, timeout → Failed with reason, a restart resumes from DB + Helm release state) and reports Ready/Deleted to a signed internal gateway endpoint, where the gateway encrypts the store's woo-mcp token and registers upstream `woo-<slug>`. Access to a store's tools: owner and admins all, shared members a per-store rule (default read-only), others none — enforced in the gateway's tool-access layer for `/mcp` and the chat.
- **Why:** Helm reuses the hardened store templates exactly (one source for k3d, VPS and every provisioned store) and gives install/uninstall/status for free; a separate provisioner keeps cluster rights out of the internet-facing gateway; RBAC alone cannot restrict `create` by name, the admission policy closes that; Postgres desired state makes create retry-safe and restart-safe across replicas.
- **Trade-offs:** A Helm binary inside the provisioner image (pinned, scanned); one more service and DB role; the store-template move touches the working default store (guarded by the full regression before anything else is built).

## D-027 — OAuth for /mcp: the gateway is its own authorization server
- **Date:** 2026-10-25
- **Status:** Accepted (BON-08)
- **Choice:** Implement the MCP authorization spec (2025-11-25, the SDK 1.32 protocol version) in the gateway itself: RFC 9728 protected-resource metadata (named by `WWW-Authenticate` on every 401 from `/mcp`), RFC 8414 server metadata, RFC 7591 dynamic registration for **public clients only**, authorization code + **PKCE S256 only**, exact redirect-URI match (https, loopback http, or reverse-domain private-use schemes), consent in the dashboard (`/connect`) with the normal session, opaque random tokens stored as SHA-256 (code 2 min single use, access 1 h, refresh 30 days rotated on every use), tokens bound to the resource `<origin>/mcp` (RFC 8707), `iss` in the authorization response (RFC 9207). A grant (user × client) is the unit users and admins revoke; replaying a used code or refresh token revokes the whole grant. Calls are audited with `source=oauth`. OAuth is on only when `PUBLIC_ORIGIN` is set (issuer and resource need the public URL); API keys are unchanged.
- **Why:** No extra service, no external identity provider to run or trust, and the user identity is already the gateway's; opaque tokens looked up on every request give immediate revocation and disable (same model as API keys, D-008) with no signing keys to manage. Consent through the existing session reuses the hardened login, rate limits and CSRF defences (SameSite=Strict + Origin check).
- **Trade-offs:** One DB lookup per `/mcp` request (as with API keys); no JWT for other resource servers (not needed: the gateway is the only resource); client-ID metadata documents (CIMD, newer spec option) not implemented — DCR is what Claude Code and MCP Inspector use.

## D-028 — Store access: owner, access list, per-store tool rule
- **Date:** 2026-10-25
- **Status:** Accepted (BON-12, BON-14)
- **Choice:** A created store's MCP server is visible and callable per person, not per role: admins and the owner get every tool; people the owner put on the store's access list get the server's existing member rule (BON-01 `memberAccess`/`memberTools`, default read-only, editable per store); everyone else gets nothing. The decision is a pure function (`roleFor`) fed by one query for the caller's stores, run on every `/mcp` and `/api/upstreams` request. The API answers 404 for stores the caller cannot see. The store row holds the owner and the list; the rule lives on the store's upstream row, so BON-01's enforcement code is reused unchanged. Caps are counted in one transaction under an advisory lock. A deleted store's name can be reused (its row is removed on the next create; audit rows keep the slug). The wp-admin password is handed out by a locked read-wipe in one transaction.
- **Why:** Reusing the member rule keeps one enforcement path for API keys, OAuth tokens and the chat; deciding per request from the DB gives the same "next request" semantics as BON-01 and BON-11 revocation; a lock beats optimistic checks for a three-line cap.
- **Trade-offs:** One extra query per `/mcp` request when a store exists (indexed on owner and member); the shared member rule is per store, not per person; resetting the wp-admin password from the dashboard is not built (needs a provisioner action) — the store's own "Lost your password?" flow is the fallback.
