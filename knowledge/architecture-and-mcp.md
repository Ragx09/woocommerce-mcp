# Architecture & MCP — learning notes

Each concept follows the same structure: what, why it exists, why we need it, how it works, where it appears in our code, alternatives, debugging, and a self-test.

## MCP basics
1. **What:** The Model Context Protocol is a JSON-RPC 2.0 protocol that lets an AI application (the *host*, e.g. Claude Code) use external capabilities through *servers*. The host runs one *client* per server connection. Servers expose **tools** (functions the model may call), resources and prompts.
2. **Why it exists:** Before MCP, every AI app needed custom integrations for every service (N×M). MCP standardises the interface (N+M).
3. **Why we need it:** The brief is about MCP: our WooCommerce server is an MCP server, and the gateway is both an MCP server (for clients) and an MCP client (for upstreams).
4. **How it works:** `initialize` (capabilities and version negotiation) → `tools/list` (name, description, JSON Schema `inputSchema`) → `tools/call` (`{name, arguments}` → `{content:[…], isError?}`).
5. **Where:** `services/woo-mcp` (server), `services/gateway/src/mcp` (server + client pool), `services/gateway/src/chat` (client).
6. **Alternatives:** Plain REST/OpenAPI tools per client; vendor-specific function plugins. MCP wins on client support.
7. **Debugging:** MCP Inspector (`npx @modelcontextprotocol/inspector`) shows raw messages. Check `initialize` succeeds before anything else. `isError: true` is a tool-level error, while a JSON-RPC `error` is a protocol-level one.
8. **Self-test:** (a) What is the difference between a host, a client and a server? (b) Where does the model see a tool's parameters? (c) What's the difference between a JSON-RPC error and `isError`?

## Streamable HTTP
1. **What:** The MCP transport for remote servers. One HTTP endpoint; the client POSTs JSON-RPC; the server replies with JSON or an SSE stream.
2. **Why:** It replaces the older two-endpoint HTTP+SSE transport and works through normal proxies and load balancers.
3. **Why we need it:** The brief mandates it for woo-mcp and for upstreams; it's how external clients reach the gateway.
4. **How:** `POST /mcp` with `Accept: application/json, text/event-stream`. In *sessionful* mode the server issues `Mcp-Session-Id`; in *stateless* mode (our choice, D-002) every request stands alone. The 2026-07-28 spec makes stateless the default; we use SDK v1 (protocol 2025-11-25) in stateless mode, which is compatible with today's clients.
5. **Where:** `StreamableHTTPServerTransport({sessionIdGenerator: undefined})` in woo-mcp and the gateway; `StreamableHTTPClientTransport` in the gateway pool and the chat agent.
6. **Alternatives:** stdio (local processes only: can't run behind a K8s Service), sessionful HTTP (needs sticky sessions across replicas).
7. **Debugging:** `curl -X POST -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' …` A 406 means the Accept header is wrong; 401 means auth; 404 means a wrong path or Ingress rule.
8. **Self-test:** Why does stateless mode make multiple gateway replicas easy? What do we lose?

## Gateway aggregation
1. **What:** One MCP endpoint that merges the tool lists of many upstream servers and routes each call to the owner.
2. **Why:** Members configure one URL and one key; the admin manages credentials centrally; every call is audited.
3. **Why we need it:** It is the core of the brief (REQ-GW-*).
4. **How:** Fan-out `listTools` to enabled upstreams → rename to `slug__tool` → union. A call parses the slug and forwards the call (D-005, MCP_DESIGN §3–5).
5. **Where:** `services/gateway/src/upstreams/discovery.ts` (done), `services/gateway/src/mcp/{naming,aggregate,router}.ts` (planned).
6. **Alternatives:** Collision policies: first-wins (non-deterministic across restarts), prefix-only-on-conflict (names change when a server is added), always-prefix (**chosen**: stable and explicit).
   Discovery (GW-05) keeps the last good list per upstream for 60 s, so a slow upstream (> 3 s) still shows its tools (marked stale) instead of vanishing; a cached list is never served after the upstream's URL or credential changes.
7. **Debugging:** Compare `tools/list` from the gateway with the upstream directly (port-forward). Check the health status and `last_error` in `/api/upstreams`.
8. **Self-test:** Two servers both expose `search`. What names does the client see, and how does the gateway route `github__search`?
