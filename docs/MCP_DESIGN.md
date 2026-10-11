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
- Descriptions get a prefix: `[woo] …`. Descriptions are capped at 1024 characters (T-07).

## 4. Discovery and aggregation
1. On `tools/list`: load enabled upstreams from the DB (so replicas always agree).
2. For each one in parallel (`Promise.allSettled`) with a 3 s timeout: `client.listTools()` (follow `nextCursor`).
3. On success: update the cache `{tools, fetchedAt}`. On failure: use the cached list if it is younger than 60 s and the health status is Connected; otherwise omit the upstream.
4. Map to public names and return the concatenated list.

## 5. Routing `tools/call`
1. Parse the public name → (slug, tool). Unknown slug → error `unknown_tool`.
2. Upstream disabled → `upstream_disabled`. Health Unreachable → try once with the connect timeout, then `upstream_unreachable`.
3. Forward `callTool({name: tool, arguments})` with a 15 s timeout → return the upstream result as-is (`isError` preserved).
4. Write the audit row (§9).

## 6. Timeouts and errors
| Stage | Budget | Error code (in the JSON-RPC error `data.code`, or an `isError` tool result) |
|---|---|---|
| connect | 2 s | `upstream_unreachable` |
| list per upstream | 3 s | (omitted from the list, logged) |
| call | 15 s (configurable per upstream) | `upstream_timeout` |
| upstream returned an error | — | passed through as `isError: true` |
| auth failure | — | HTTP 401 (no JSON-RPC body processing) |
Error messages are human-readable and never include credentials, URLs with secrets, or stack traces.

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
