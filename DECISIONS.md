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
- **Status:** Proposed (validate in ARC-13)
- **Context:** Spec 2026-07-28 (stateless, no `initialize`) is new; TS SDK v2 (`@modelcontextprotocol/server` / `client`) is new. Claude Code, Cursor and Inspector all support 2025-11-25.
- **Options:** SDK v1.x (`@modelcontextprotocol/sdk`) with Streamable HTTP; SDK v2.
- **Choice:** `@modelcontextprotocol/sdk` v1.x, pinned exactly; Streamable HTTP in **stateless** mode (`sessionIdGenerator: undefined`, a new transport per request).
- **Why:** Mature, widely documented, compatible with every client we must demo. Stateless mode removes session affinity, so multiple gateway replicas work.
- **Trade-offs:** No server→client requests or notifications (sampling, list_changed). Clients re-list tools when they reconnect. A move to v2 later would be a contained migration.
- **Revisit:** If ARC-13 shows a client incompatibility.

## D-003 — WooCommerce integration method
- **Date:** 2026-10-11
- **Status:** Proposed (validate in ARC-14)
- **Context:** woo-mcp must read and write products and orders. The in-cluster call is plain HTTP.
- **Options:** WC REST API with OAuth 1.0a (HTTP); WC REST with Basic auth (HTTPS-only); WP Application Passwords (HTTPS-only); WP-CLI via `kubectl exec`; direct SQL.
- **Choice:** WooCommerce REST API v3 over the internal Service, authenticated with a consumer key/secret using **OAuth 1.0a one-legged HMAC-SHA256** signing.
- **Why:** Versioned, validated, and it runs WooCommerce business logic (stock, totals, hooks). The key is owned by a dedicated service user, so it is revocable and least-privilege. No exec privileges or DB credentials are needed in the MCP server. OAuth1 is the documented method for non-HTTPS.
- **Trade-offs:** The signing code must be correct (unit-tested). The REST round-trip is a bit slower than SQL.
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
- **Status:** Proposed
- **Choice:** Always expose `<slug>__<tool>`. Slug: `^[a-z0-9-]{1,20}$`, unique, immutable after creation. The final name must match `^[a-zA-Z0-9_-]{1,64}$`. If it is too long, use the first 55 characters + `_` + 8 hex characters of sha1 (deterministic). Routing splits on the first `__`.
- **Why:** Collision-free by construction and deterministic across replicas. Compatible with Claude/OpenAI tool-name rules. Shows the user which server a tool comes from.
- **Trade-offs:** Longer names. Upstream tool names containing `__` still work because we split on the first occurrence and slugs cannot contain `_`.

## D-006 — Gateway database
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** PostgreSQL 16 (official image, StatefulSet + PVC), Drizzle ORM with SQL migrations.
- **Why:** Multi-replica safe, real constraints. Separate from the store's MariaDB (isolation of failure and credentials).
- **Trade-offs:** One more stateful workload.

## D-007 — Dashboard authentication
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** Email + password (argon2id). Server-side sessions in Postgres, with the ID in an httpOnly, Secure (prod), SameSite=Strict cookie. Mutating requests check `Origin`. The first admin is seeded from a Secret. Members join via one-time invite tokens (stored hashed, 72 h expiry).
- **Why:** Simple, standard, and keeps tokens out of JS.
- **Trade-offs:** No SSO/OAuth (stand-out item 3).

## D-008 — Gateway API keys
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** `mgw_` + 32 bytes of CSPRNG output, base62. The DB stores `sha256(key)` (unique index) + `prefix` (first 12 characters) + owner + `revoked_at` + `last_used_at`. The key is shown once. Validation on every request does a DB lookup (no cache), so revocation is immediate.
- **Why:** For high-entropy random secrets a fast hash is sufficient; a slow KDF only protects low-entropy passwords. Lookup by hash avoids timing leaks.
- **Trade-offs:** One DB read per MCP request (indexed, cheap).

## D-009 — Upstream credential storage
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** AES-256-GCM encryption with a 32-byte key from the K8s Secret `gateway-secrets.CREDENTIALS_KEY`. Stored as `{iv, ciphertext, tag}`. The API field is write-only (responses show `hasCredential: true` + header name only).
- **Why:** A DB dump alone doesn't leak upstream tokens. Credentials never reach the browser.

## D-010 — Local cluster, ingress and domains
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** k3d (k3s in Docker) locally, k3s on the VPS. Bundled Traefik ingress and the `local-path` StorageClass on both. Hosts `store.127.0.0.1.nip.io` / `app.127.0.0.1.nip.io` locally.
- **Why:** Local == prod distribution, so the values diff is minimal. ingress-nginx was retired in March 2026, and Traefik is k3s's default. nip.io needs no hosts-file edits from WSL or Windows.
- **Trade-offs:** nip.io depends on public DNS (fallback: a hosts-file entry, documented).

## D-011 — Store deployment without Bitnami
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** Our own templates: official `mariadb:11` StatefulSet, official `wordpress:6-php8.3-apache` Deployment with a PVC for `/var/www/html`, and a `wordpress:cli` Helm post-install Job that installs core + WooCommerce, enables COD, creates sample products, creates the REST key for a `mcp-service` user, and writes it to a Secret.
- **Why:** Bitnami's free catalog is deprecated and limited to `latest`; `bitnamilegacy` gets no updates.
- **Trade-offs:** We own more YAML and an idempotent init script.

## D-012 — Chat agent LLM provider
- **Date:** 2026-10-11
- **Status:** Proposed
- **Choice:** An OpenAI-compatible chat-completions client (plain `fetch`, no SDK) with `baseUrl`, `model` and `apiKey` from values and a Secret. Default Groq (`https://api.groq.com/openai/v1`); OpenRouter (`https://openrouter.ai/api/v1`) is the alternative.
- **Why:** Free tiers with tool calling; switching providers is a values change.
- **Trade-offs:** Free-tier rate limits during rehearsals; small models may choose tools badly. Mitigated with a clear system prompt and a tool-count cap.

## D-013 — Additional upstream MCP servers
- **Date:** 2026-10-11
- **Status:** Proposed (validate in ARC-15)
- **Choice:** (1) `@modelcontextprotocol/server-everything` in-cluster, Streamable HTTP mode. (2) GitHub's remote MCP server (`https://api.githubcopilot.com/mcp/`) with a fine-grained PAT as a bearer credential.
- **Why:** (1) gives us an in-cluster pod to kill and generic tool names. (2) demonstrates server-side credential injection and a realistic cross-server prompt (orders → GitHub issue).
- **Trade-offs:** GitHub depends on internet access and the PAT. Fallback: DeepWiki (no auth).
