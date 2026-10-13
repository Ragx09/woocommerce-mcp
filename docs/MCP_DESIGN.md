# MCP Design

> Status: **draft design**, to be validated by ARC-13/15 and implemented in Phase 4.

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
- Protocol version 2025-11-25, negotiated during `initialize`. We use stateless mode (no `Mcp-Session-Id`): each POST is self-contained, so any gateway replica can serve it.
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
3. On success: update the cache `{version, tools, fetchedAt}` (`version` = URL/auth/credential/`updated_at`). On failure: serve the cached list marked `stale` if it is at most 60 s old and the version is unchanged; otherwise omit the upstream and report it (`failed[]`, safe message). The extra "health status is Connected" condition arrives with GW-10.
4. Map to public names and return the concatenated list.
Implemented in `services/gateway/src/upstreams/discovery.ts` (GW-05).

## 5. Routing `tools/call`
1. Parse the public name → (slug, rest) (`parsePublicName`). Malformed or unknown slug → JSON-RPC `-32602`, `data.code = unknown_tool`.
2. Upstream disabled → `-32602`, `data.code = upstream_disabled`. (Health-based fast fail arrives with GW-10.)
3. Resolve the upstream tool name through a `ToolIndex` over `ToolDiscovery.toolsFor(row)` (cached list if ≤ 60 s old and the config is unchanged, otherwise refreshed). Not found → `unknown_tool`. This makes shortened (hashed) names routable.
4. Forward `callTool({name: tool, arguments})` with a 15 s timeout → return the upstream result as-is (`isError` preserved). A transport failure is retried once **only** if the call certainly did not run (`isSafeCallRetry`: HTTP 404 stale session, `ECONNREFUSED`).
5. Failures reaching the upstream become `isError` results the model can read: `upstream_unreachable: …`, `upstream_timeout: …`, `upstream_error: …` (no URLs, no credentials).
6. Log `tools/call {upstream, tool, outcome, ms}` (never arguments or results); the audit row (§9) comes with Phase 5.
Implemented in `services/gateway/src/mcp/route.ts` (GW-08).

## 6. Timeouts and errors
| Stage | Budget | Error code (in the JSON-RPC error `data.code`, or an `isError` tool result) |
|---|---|---|
| connect | 2 s | `upstream_unreachable` |
| list per upstream | 3 s | (omitted from the list, logged) |
| call | 15 s | `upstream_timeout` |
| upstream returned an error | — | passed through as `isError: true` |
| auth failure | — | HTTP 401 (no JSON-RPC body processing) |
Error messages are human-readable and never include credentials, URLs with secrets, or stack traces.

Implemented in GW-09 (`withDeadline` in `services/gateway/src/upstreams/pool.ts`):
- Budgets are set gateway-wide by `UPSTREAM_CONNECT_TIMEOUT_MS` / `UPSTREAM_LIST_TIMEOUT_MS` / `UPSTREAM_CALL_TIMEOUT_MS` (Helm `gateway.upstreamTimeouts`). A per-upstream override is deferred until the admin API exists.
- One deadline covers connect + request + the pool's single reconnect, so the budget is the real upper bound for the client. Resolving the tool name in `tools/call` uses the cached list or a fresh list under the list budget.
- On expiry the SDK request is aborted, which sends `notifications/cancelled`. A sessionful upstream can stop the work; a stateless one only sees its HTTP request aborted.
- A timed-out call is never retried (it may have run).

## 7. Credential injection
- Stored per upstream: `auth_type` (none | bearer | header), `auth_header` (e.g. `X-API-Key`), `credential_enc` (AES-256-GCM).
- On connect: decrypt and build `requestInit.headers` for the SDK transport. The inbound client `Authorization` is **never** copied (T-04).
- The API exposes `{authType, authHeader, hasCredential}` only.

## 8. External client authentication
- `Authorization: Bearer mgw_<…>` → sha256 → `api_keys` lookup → `revoked_at IS NULL` and the user is not disabled → context `{userId, keyId, source:'mcp'}`.
- Internal chat token: `Authorization: Bearer itk_<payload>.<hmac>` → verify the HMAC + expiry → context `{userId, source:'chat'}`.
- Failure → 401 `{"error":"invalid_api_key"}`. The attempt is audited with outcome `denied`.

## 9. Audit events
`audit_log`: `id, ts, request_id, user_id (nullable for denied), api_key_id, source (mcp|chat), method (tools/call|tools/list), upstream_id, upstream_slug, tool, duration_ms, outcome (ok|error|timeout|denied|unreachable), error_code`. Arguments and results are not stored (privacy). tools/list is audited as one row per request (`tool = NULL`).

## 10. Chat agent loop
1. `POST /api/chat {messages}` (session cookie).
2. Mint an internal token for the user (5 min).
3. MCP client → `http://127.0.0.1:<port>/mcp` → `listTools()` → convert to OpenAI `tools` (name, description, inputSchema as parameters).
4. Loop (max 8): chat-completions → for each `tool_call`: `callTool` → append the `tool` message (result text truncated to 8 KB) → repeat.
5. Return `{reply, toolCalls:[{name, server, args, ok, ms, resultPreview}]}`.

## 11. Disable / remove semantics
- Disable: `enabled=false` → excluded from the list immediately (DB read per request); the pool connection is closed; calls → `upstream_disabled`.
- Remove: the row is deleted (audit rows keep `upstream_slug` text); the pool entry is closed.
- Clients learn about changes on their next `tools/list`. Stateless mode means no `list_changed` notification. Documented as a trade-off.
