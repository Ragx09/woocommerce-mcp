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
4. Map to public names and return the concatenated list.
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
| response body > 4 MiB (`UPSTREAM_MAX_RESPONSE_BYTES`) | — | refused: `upstream_error: upstream response larger than … bytes` (T-08) |
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
- Failure → 401 `{"error":"invalid_api_key"}`. The attempt is audited with outcome `denied`.

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
