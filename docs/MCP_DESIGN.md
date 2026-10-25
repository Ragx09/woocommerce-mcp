# MCP Design

> Status: **implemented** (Phases 4–6) and verified end to end on k3d (Phase 7, 2026-10-18). Section numbers are referenced from code comments.

## 1. Roles of each component
| Component | MCP role | Transport |
|---|---|---|
| woo-mcp | server | Streamable HTTP, stateless, `POST /mcp` |
| everything-mcp | server (third-party reference) | Streamable HTTP |
| GitHub remote MCP | server (remote) | Streamable HTTP over HTTPS |
| gateway | **server** to clients (`/mcp`) **and client** to every upstream | Streamable HTTP |
| chat agent | client of the gateway `/mcp` | Streamable HTTP (loopback) |
| Claude Code / Cursor / Inspector | clients of the gateway | Streamable HTTP + `Authorization: Bearer mgw_…` |

## 2. Streamable HTTP (what we rely on)
- A single endpoint. The client POSTs JSON-RPC messages; the server answers with `application/json` or an SSE stream (`text/event-stream`).
- Protocol version negotiated during `initialize` (the SDK supports up to 2025-11-25; e.g. a client asking for 2025-06-18 gets 2025-06-18). We use stateless mode (no `Mcp-Session-Id`): each POST is self-contained, so any gateway replica can serve it.
- SDK: `@modelcontextprotocol/sdk` v1.x (`McpServer`/`Server` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`; `Client` + `StreamableHTTPClientTransport(url, { requestInit: { headers } })`).

## 3. Tool naming and collisions (D-005)
- Public name = `<slug>__<upstreamTool>`, e.g. `woo__list_orders`, `everything__echo`, `github__create_issue`.
- Slug `^[a-z0-9-]{1,20}$`, unique and immutable. The public name must match `^[a-zA-Z0-9_-]{1,64}$`. If it is too long: `name[0..55] + "_" + sha1(full)[0..8]`, with a reverse map kept in memory per upstream.
- Invalid characters (e.g. `.`) are replaced by `_` and the hash suffix is added, so `files.read` and `files_read` never clash.
- Routing resolves public names through `ToolIndex` (built from discovery), not by splitting alone; a duplicate public name keeps the first tool and is reported.
- Descriptions get a prefix: `[woo] …`. Descriptions are capped at 1024 characters (T-07).
- Implemented in `services/gateway/src/mcp/naming.ts` (GW-07).

## 4. Discovery and aggregation
1. On `tools/list`: load enabled upstreams from the DB (so replicas always agree).
2. For each one in parallel (`Promise.allSettled`) with one 3 s deadline (covers connect, the single reconnect and all pages; the request is aborted): `client.listTools()` (follow `nextCursor`, max 20 pages). Concurrent `tools/list` requests share one in-flight upstream request.
3. On success: update the cache `{version, tools, fetchedAt}` (`version` = URL/auth/credential/`updated_at`). On failure: serve the cached list marked `stale` if it is at most 60 s old and the version is unchanged; otherwise omit the upstream and report it (`failed[]`, safe message). An upstream the health monitor has as **unreachable** is not contacted and gets no stale list (GW-10).
4. Keep at most `MAX_TOOLS_PER_UPSTREAM` (default 128) tools per upstream; a longer list is cut and paging stops, with a warning (F-MCP-5, T-26).
5. Map to public names and return the concatenated list.
Implemented in `services/gateway/src/upstreams/discovery.ts` (GW-05).

## 4a. Upstream health (GW-10)
- `HealthMonitor` (`services/gateway/src/upstreams/health.ts`), in memory per replica (runtime state stays out of the DB, see `schema.ts`).
- Loop every `HEALTH_INTERVAL_MS` (10 s): reload the registry from the DB, then `ping` every enabled upstream in parallel (`allSettled`), each under the list budget (3 s) including connect.
- Status per upstream: `connected` · `unreachable` · `disabled` (· `unknown` before the first check), plus `lastError` (safe text, kept after recovery), `lastCheckedAt`, `lastOkAt`. Each change is logged once (`upstream status changed`, warn for unreachable).
- Traffic feeds it too: a successful list or call → connected; could not connect (or no list within its budget) → unreachable at once. A tool call that times out does **not** change health (a slow tool is not a dead server).
- Unreachable → skipped by `tools/list` and `tools/call` returns `upstream_unreachable: <lastError>` without contacting it. Recovery is noticed by the next loop round (≤ 10 s).
- Read by `GET /api/upstreams` (the dashboard's Servers page, UI-04).

## 5. Routing `tools/call`
1. Parse the public name → (slug, rest) (`parsePublicName`). Malformed or unknown slug → JSON-RPC `-32602`, `data.code = unknown_tool`.
2. Upstream disabled → `-32602`, `data.code = upstream_disabled`; the flag is read from the DB on every request, so all replicas apply a disable/enable on their next request and close the pooled connection (`setUpstreamEnabled`, GW-11). `tools/list` order follows the registry (oldest first). Upstream marked unreachable by the health monitor → `isError` result `upstream_unreachable: <lastError>` at once (GW-10, §4a).
3. Resolve the upstream tool name through a `ToolIndex` over `ToolDiscovery.toolsFor(row)` (cached list if ≤ 60 s old and the config is unchanged, otherwise refreshed). Not found → `unknown_tool`. This makes shortened (hashed) names routable.
4. Forward `callTool({name: tool, arguments})` with a 15 s timeout → return the upstream result as-is (`isError` preserved). A transport failure is retried once **only** if the call certainly did not run (`isSafeCallRetry`: HTTP 404 stale session, `ECONNREFUSED`).
5. Failures reaching the upstream become `isError` results the model can read: `upstream_unreachable: …`, `upstream_timeout: …`, `upstream_error: …` (no URLs, no credentials).
6. Log `tools/call {upstream, tool, outcome, ms}` (never arguments or results) and write the audit row (§9).
Implemented in `services/gateway/src/mcp/route.ts` (GW-08).

## 6. Timeouts and errors
| Stage | Budget | Error code (in the JSON-RPC error `data.code`, or an `isError` tool result) |
|---|---|---|
| connect | 2 s | `upstream_unreachable` |
| list per upstream | 3 s | (omitted from the list, logged) |
| call | 15 s | `upstream_timeout` |
| upstream returned an error | — | passed through as `isError: true` |
| response body > 4 MiB (`UPSTREAM_MAX_RESPONSE_BYTES`) | — | refused: `isError` result `upstream_error: upstream <slug> failed: upstream response larger than <n> bytes` (T-08) |
| auth failure | — | HTTP 401 (no JSON-RPC body processing) |
Error messages are human-readable and never include credentials, URLs with secrets, or stack traces.

Implemented in GW-09 (`withDeadline` in `services/gateway/src/upstreams/pool.ts`):
- Budgets are set gateway-wide by `UPSTREAM_CONNECT_TIMEOUT_MS` / `UPSTREAM_LIST_TIMEOUT_MS` / `UPSTREAM_CALL_TIMEOUT_MS` (Helm `gateway.upstreamTimeouts`). A per-upstream override is deferred until the admin API exists.
- One deadline covers connect + request + the pool's single reconnect, so the budget is the real upper bound for the client. Resolving the tool name in `tools/call` uses the cached list or a fresh list under the list budget.
- On expiry the SDK request is aborted, which sends `notifications/cancelled`. A sessionful upstream can stop the work; a stateless one only sees its HTTP request aborted.
- A timed-out call is never retried (it may have run).

## 7. Credential injection
- Stored per upstream: `auth_type` (none | bearer | header), `auth_header` (e.g. `X-API-Key`), `credential_enc` (AES-256-GCM).
- On connect: `upstreamHeaders(key, row)` (`services/gateway/src/upstreams/pool.ts`) decrypts and builds `requestInit.headers` for the SDK transport: `Authorization: Bearer <secret>` or `<auth_header>: <secret>`, plus the gateway user agent. It is built from the row alone, so the inbound client `Authorization` (or any other inbound header) is **never** copied (T-04).
- An undecryptable credential (wrong `CREDENTIALS_KEY`, ciphertext moved to another slug — the slug is the AAD) or a value with CR/LF/control characters → `upstream_unreachable: … stored credential …`, never the value.
- Redirects from an upstream are not followed (`redirect: 'error'`, on top of the SDK's same-origin policy): a 3xx could otherwise carry a custom credential header to another host.
- Key rotation is not supported: changing `CREDENTIALS_KEY` makes stored credentials undecryptable until they are re-entered.
- The API exposes `{authType, authHeader, hasCredential}` only.

## 8. External client authentication
- `Authorization: Bearer mgw_<…>` → sha256 → `api_keys` lookup → `revoked_at IS NULL` and the user is not disabled → context `{userId, keyId, source:'mcp'}`.
- Internal chat token (UI-15, D-018): `Authorization: Bearer itk_<base64url {sub, src:'chat', exp}>.<HMAC-SHA256>` → accepted only when the raw TCP peer is loopback (the agent in the same process; `X-Forwarded-For` is ignored) → verify the HMAC (per-process random key) + expiry (≤ 5 min) → user looked up, must not be disabled → context `{userId, keyId: null, source:'chat'}`.
- OAuth access token (BON-08, D-027): `Authorization: Bearer mat_<…>` → sha256 → `oauth_tokens` (kind access, unexpired) → grant not revoked, issued for `<origin>/mcp`, user not disabled → context `{userId, keyId: null, source:'oauth', grantId}`; the grant has the per-key rate budget. How a client gets one: the 401 names the RFC 9728 metadata → RFC 8414 → dynamic registration → `/oauth/authorize` (PKCE S256) → dashboard consent → `/oauth/token`.
- Failure → 401 `{"error":"invalid_api_key"}` with `WWW-Authenticate: Bearer resource_metadata=…` (OAuth discovery). The attempt is audited with outcome `denied`.

## 9. Audit events
`audit_log`: `id, ts, request_id, user_id (null for denied — enforced by a CHECK), api_key_id, source (mcp|chat), method (tools/call|tools/list|initialize|other), upstream_id, upstream_slug, tool, duration_ms, outcome, error_code` (AUTH-01/12, `drizzle/0002_auth.sql`). Outcomes: `ok`; `tool_error` (the upstream tool returned `isError`); `error` (`upstream_error`); `timeout`; `unreachable`; `rejected` (unknown tool, disabled upstream — the call never left the gateway); `denied` (no valid key). `error_code` is a short machine code (`^[a-z_]{1,40}$`), never upstream text. Arguments and results are not stored (privacy). tools/list is audited as one row per request (`tool = NULL`). A refused request (`denied`) stores no client-supplied names. Implementation: the per-request MCP server receives the caller's context explicitly (`buildServer(deps, log, ctx)`); one `finally` per call logs and audits exactly once; an audit write failure is logged, never returned to the client (AUTH-11/13).

## 10. Chat agent loop
1. `POST /api/chat {messages}` (session cookie). Only `user`/`assistant` turns from the client (the system prompt is server-side); one request per user at a time; 30 per user per 10 min.
2. Mint an internal token for the user (5 min, UI-15).
3. MCP client → `http://127.0.0.1:<port>/mcp` → `listTools()` → convert to OpenAI `tools` (name, description ≤ 400 chars, inputSchema as parameters).
4. Tool selection (D-019): offer the tools that best match the last user turns within a 6000-character budget, plus the local meta-tool `find_tools` (keyword or exact-name search over the same list; the best 8 become callable in the next round, further names are returned).
5. Loop (max 8 rounds, 16 calls, 150 s): chat-completions → for each `tool_call`: `callTool` on `/mcp` → append the `tool` message (result text truncated to 4 KB) → repeat.
6. Return `{reply, toolCalls:[{name, server, args, ok, ms, resultPreview}], stopped: answer|max_steps|deadline}`. LLM errors → `llm_rate_limited` 429 (+Retry-After), `llm_timeout` 504, `llm_unavailable`/`llm_error` 502; tools unreachable → `chat_failed` 502.

## 11. Disable / remove semantics
- Disable: `enabled=false` → excluded from the list immediately (DB read per request); the pool connection is closed; calls → `upstream_disabled`.
- Remove: the row is deleted (audit rows keep `upstream_slug` text); the pool entry is closed.
- Clients learn about changes on their next `tools/list`. Stateless mode means no `list_changed` notification. Documented as a trade-off.

## 12. Upstream URL guard (SSRF, T-06)
Admins choose the URLs the gateway connects to, so the gateway refuses to become a proxy into the cluster or the cloud metadata service (`src/upstreams/ssrf.ts`):
- **Syntax:** `http`/`https` only, no `user:pass@`, ≤ 2048 characters. The WHATWG URL parser normalizes odd IPv4 forms (`2130706433`, `0x7f.1` → `127.0.0.1`) before any check.
- **Addresses:** every DNS answer must be public. Refused: loopback, RFC 1918 (incl. k3s pod `10.42/16` and Service `10.43/16` ranges), CGNAT, `0/8`, multicast/reserved, documentation ranges, IPv6 `::1`, ULA `fc00::/7`, NAT64, IPv4-mapped forms; **always** refused: link-local `169.254/16`, `fe80::/10`, `fd00:ec2::254` (metadata).
- **Allowlist by host name:** `UPSTREAM_ALLOWED_HOSTS` (Helm `gateway.upstreamAllowedHosts`) plus the hosts of the seeded upstreams (woo-mcp, everything-mcp, GitHub). Names, not networks: `postgres.platform.svc.cluster.local` stays blocked although it is internal. An allowlisted name may still not resolve to link-local/metadata.
- **Twice:** when a URL is saved (`POST`/`PATCH /api/upstreams` → 400 `ssrf_blocked` with a reason), and on every connection: the pool's undici agent uses a guarded `lookup` (checks the address actually connected to — DNS rebinding) and literal-IP URLs are checked before the request (Node skips `lookup` for IPs). A row written around the API is refused at connect time and shows as Unreachable with `ssrf_blocked`.
- Redirects are refused (§7), so a 3xx cannot bounce the request to a blocked address either.

## 13. Tool permissions (BON-01, D-021)
- **Rule per server:** `memberAccess` `all` (default) · `none` (members do not see the server) · `selected` (only the upstream tool names in `memberTools`). Admins always see and call everything.
- **Where:** in `/mcp`, from the registry rows read for that request (no cache), so a change applies on every replica's next request. `tools/list` filters before public names are assigned; `tools/call` compares the requested public name with the public names of the allowed tools (works for shortened/hashed names, a crafted name can only match an allowed tool), then checks the resolved tool again.
- **Refusal:** JSON-RPC `-32602` "tool not allowed for your role: <name>" with `data.code = tool_forbidden`; the same answer for a hidden tool, a non-existent one and one on a disabled server, so nothing can be probed. No upstream request is made. Audit row: outcome `rejected`, `error_code = tool_forbidden`, the caller as user.
- **Chat:** the agent calls `/mcp` as the signed-in user (internal token, §10), so it gets the same list and refusals; `find_tools` searches only that list.
- **Dashboard:** members' `GET /api/upstreams` omits `none` servers and counts only allowed tools; `GET /api/upstreams/:id/tools` lists only allowed tools (404 for a hidden server). Admins edit the rule on the server form.

## 14. Metrics (BON-03)
- **Prometheus, per replica:** `GET /metrics` on its own listener (`METRICS_PORT`, chart `gateway.metrics.port` 9464). Not in the Service or the Ingress; NetworkPolicy `gateway-metrics-from-scrapers` admits only pods labelled `platform.io/metrics-scraper: "true"`. Pod annotations `prometheus.io/scrape|port|path` for discovery.
- **Series:** `mcp_tool_calls_total{upstream,outcome,source}`, `mcp_tool_call_duration_seconds{upstream}` (histogram, 25 ms … 30 s), `mcp_tools_list_total{outcome}`, `mcp_requests_denied_total{reason}`, `mcp_upstream_up{upstream,status}` (health monitor, at scrape time). Error rate = `sum(rate(mcp_tool_calls_total{outcome=~"error|timeout|unreachable|tool_error"}[5m])) by (upstream) / sum(rate(mcp_tool_calls_total{outcome!="rejected"}[5m])) by (upstream)`.
- **Same events as the audit log** (one observation per audit event), so metrics and audit never disagree on what happened. Labels are bounded: `upstream` is a registry slug or `unknown` (a name a client made up is never a label); no tool names, users, keys or arguments.
- **Dashboard numbers** (admins, Servers page "Last hour": calls · failed % · p95 · refused) come from the audit log (`src/audit/stats.ts`), so they cover all replicas; failed = error/timeout/unreachable/tool error, refused = rejected by the gateway (unknown, disabled, not allowed) and kept out of the latency.

## 15. Replicas and shared limits (BON-04, D-022)
- Any replica can serve any request: MCP is stateless, sessions, keys, the registry and the audit log are in Postgres. Per replica (converging within one health interval): the health status, the discovery cache, the pooled upstream connections, the metrics.
- `/mcp` budgets per API key and per user count `tools/call` and `tools/list` (not `initialize`/notifications) in Postgres (`rate_limits`); over budget → HTTP 429 + `Retry-After` before the request reaches the MCP server code, audited `rejected/rate_limited`. Requests with the chat's internal token are not counted (the chat route limits per user itself, also in Postgres, plus a self-expiring lease for "one chat at a time").

## 16. Store servers: registration and access (BON-13, BON-14, D-028)
- **Registration:** only the provisioner's signed `POST /internal/stores/:id/ready` creates the upstream `woo-<slug>` (owner-scoped, `storeId` set, the woo-mcp token encrypted like any credential, URL fixed to `http://woo-mcp.store-<slug>.svc.cluster.local/mcp`). No `/api` route can create one for a store; `PATCH /api/upstreams/:id` on a store's server changes only `enabled` and the member rule, `DELETE` is refused (409: delete the store). Tool names are `woo-<slug>__<tool>`.
- **Who may use a store's tools** (`authz/store-access.ts`, decided per request from the DB, no cache): admin → all tools · owner → all tools · a person on the store's access list → the server's member rule (`memberAccess`/`memberTools`, default read-only, changed by the owner with `PATCH /api/stores/:id`) · anyone else → nothing. `tools/list` leaves the server out, `tools/call` answers the same `tool_forbidden` as for any hidden tool (audited `rejected`, no upstream call). The dashboard chat uses the same `/mcp`, so it follows the same rules; `/api/upstreams` and the chat's "unreachable servers" hint apply them too.
- **Changes apply on the next request** on every replica: widening or narrowing the rule, removing a person, deleting the store (the upstream row is removed in the same transaction that flips the store to `deleting`).
- **Teardown:** the upstream is removed first, then the provisioner runs `helm uninstall` and deletes the namespace (volumes and Secrets go with it) and reports `deleted`; a delete that stops half-way is retried by the reconcile loop. Audit rows keep the slug.

## 17. Hosted MCP servers (BON-10, D-029)
- **What:** an admin names a container image (`POST /api/hosted`); the platform runs it and registers it as upstream `<slug>`, so its tools are `<slug>__<tool>` like any server. Delete removes everything.
- **Flow:** the gateway writes a `hosted_servers` row (`provisioning`); the provisioner (read-only DB role on the listed columns) creates namespace `hosted-<slug>` (label `platform.io/hosted`, Pod Security `restricted`), binds `hosted-manager`, creates Secret `server-env` from the admin's secret variables (decrypted with a key derived from the shared signing key; the gateway's credentials key never leaves the gateway), runs `helm upgrade --install` of `charts/hosted`, polls the Deployment and reports to the gateway's signed `/internal/hosted/:id/ready|failed|deleted`. `ready` accepts only `http://server.hosted-<slug>.svc.cluster.local<path>`; the gateway registers the upstream with **no credential and `memberAccess: none`** (members get nothing until an admin allows tools with `PATCH /api/upstreams/:id`). The upstream's address, name and auth cannot be edited, and it cannot be deleted, through `/api/upstreams` (409) — only enabled and the member rule.
- **Image rules (gateway, before anything is created):** fully qualified, lower-case, fixed tag or digest, never `:latest`, no `..` or `//`, from a registry prefix in Helm `provisioner.hosted.imageRegistries` (default `ghcr.io/ragx09`, `registry.k8s.io`). The database CHECK enforces the image shape too.
- **What the workload gets (`charts/hosted`):** forced non-root (`runAsUser 10001`, `runAsNonRoot`), read-only root filesystem (`/tmp` emptyDir 64 Mi), all capabilities dropped, seccomp RuntimeDefault, no ServiceAccount token, no service links, requests/limits, a ResourceQuota (1 CPU / 512 Mi, 3 pods, no volumes, no NodePort/LoadBalancer) and LimitRange, TCP probes (the gateway's health loop judges MCP itself), default-deny NetworkPolicy both ways, ingress only from `app=gateway` in the platform namespace on the server's port, **no egress** unless the admin ticked "allow outbound HTTPS" (then DNS and 443 to the public internet, never private/CGNAT/loopback/metadata ranges). The gateway's own egress rule reaches pods labelled `app=hosted-server` in namespaces labelled `platform.io/hosted` (any port; the namespace admits exactly the server's port).
- **Failures say why:** image pull errors, crash loops (with the exit code), pods refused by quota or Pod Security are reported as the server's `statusReason` after a 90 s grace period; otherwise the 5-minute timeout names that nothing started listening.
- **Secrets:** write-only (names only in responses), encrypted in the database (AES-256-GCM, AAD `upstream:hosted:<slug>`), wiped when the server is deleted, in a Kubernetes Secret only (never in Helm values or the release record, never logged).
- **Limits of the approach:** the image must run as a non-root user with a read-only filesystem; it must speak Streamable HTTP MCP on the given port and path; stdio-only servers need a bridge image.

## 18. Watching what runs: runtime view, vanished namespaces, password reset (BON-12, BON-14, D-030)
- **Runtime view:** about every 30 s the provisioner looks at each Ready store and hosted server: pods Ready/total (finished Jobs not counted) and the namespace quota's CPU/memory limits used vs hard. It reports numbers only (`/internal/.../runtime`); the gateway validates and stores them; only admins see them (dashboard: "Pods 4/4 ready · CPU limits 2.1 of 4 · memory limits 1.5 GiB of 3 GiB").
- **Vanished namespace:** if a Ready row's namespace is gone (someone ran `kubectl delete ns`), three consecutive 404s (a single API hiccup is not enough) make the provisioner call `/missing`. The row becomes Failed with "the namespace was removed outside the platform; delete it here to clean up", its MCP server is unregistered in the same transaction (tools gone on the next request) and the wp-admin password is wiped. Deleting it from the dashboard then finishes the job: the provisioner finds nothing to remove and confirms. Nothing is silently deleted: the row and its audit history stay until a person deletes it.
- **wp-admin password reset (admins):** the gateway generates the password and seals it (AES-GCM, key derived from the signing key with its own label, bound to the store). The provisioner opens it, creates a temporary Secret and a one-off Job in the store's namespace (same wp-cli image, volume, non-root user and NetworkPolicy label as the setup Job) that runs `wp user update` with the password from the Secret's environment (never on the command line), then patches the store's `wordpress-admin` Secret (so a later Helm upgrade does not revert it), deletes the Job and the temporary Secret, and only then reports. The gateway makes the new password viewable once. Cleanup happens before reporting because the row stops being pending once reported; if reporting fails the next pass redoes the (idempotent) reset.
