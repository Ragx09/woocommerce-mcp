# API Contracts

> Status: **draft**. Base path `https://app.<domain>`. JSON everywhere. Errors use `{ "error": "<code>", "message": "<human text>" }`. The session cookie is `sid` (httpOnly, SameSite=Strict). Mutating requests require a matching `Origin`.

## Route table
| Method | Path | Auth | Role | Purpose |
|---|---|---|---|---|
| POST | `/api/auth/login` | — | — | `{email,password}` → sets cookie, `{user}` |
| POST | `/api/auth/logout` | session | any | Clears the session |
| GET | `/api/me` | session | any | `{id,email,name,role}` |
| GET | `/api/upstreams` | session | any | List with `status`, `lastError`, `toolCount`; never credentials |
| GET | `/api/upstreams/:id/tools` | session | any | `[{publicName,name,description}]` |
| POST | `/api/upstreams` | session | admin | `{name,slug,url,authType,authHeader?,credential?}` |
| PATCH | `/api/upstreams/:id` | session | admin | Partial; `credential` omitted = unchanged, `null` = clear |
| DELETE | `/api/upstreams/:id` | session | admin | Remove |
| GET | `/api/users` | session | admin | Members list |
| PATCH | `/api/users/:id` | session | admin | `{disabled?, role?}` |
| POST | `/api/invites` | session | admin | `{email, role}` → `{inviteUrl, expiresAt}` (shown once) |
| GET | `/api/invites/:token` | — | — | Validate the invite (email, role) |
| POST | `/api/invites/:token/accept` | — | — | `{name,password}` → creates the user, consumes the token |
| GET | `/api/keys` | session | any | Own keys (admin: `?all=1` for everyone's) `[{id,prefix,name,createdAt,lastUsedAt,revokedAt,owner}]` |
| POST | `/api/keys` | session | any | `{name}` → `{id, key}` (plaintext once) |
| POST | `/api/users/:id/keys` | session | admin | Issue a key for a user → `{id,key}` |
| DELETE | `/api/keys/:id` | session | owner or admin | Revoke |
| GET | `/api/audit` | session | admin | Filters `user, upstream, outcome, source, from, to, limit, cursor` |
| POST | `/api/chat` | session | any | `{messages:[{role,content}]}` → `{reply, toolCalls[]}` |
| POST | `/mcp` | Bearer API key or internal token (**until AUTH-08: temporary shared `MCP_DEV_KEY`**) | any | MCP Streamable HTTP endpoint, stateless JSON responses. 401 `{"error":"invalid_api_key"}` + `WWW-Authenticate: Bearer`; GET/DELETE → 405 `Allow: POST` |
| GET | `/healthz`, `/readyz` | — | — | Probes (not exposed via Ingress) |

## Error codes
`unauthenticated` (401), `forbidden` (403), `not_found` (404), `validation_failed` (400, with `issues`), `conflict` (409, e.g. duplicate slug), `ssrf_blocked` (400), `invite_used` (410), `rate_limited` (429), `internal` (500).

`/mcp` (JSON-RPC, GW-08): `tools/call` with an unknown or malformed name → error `-32602` with `data.code = "unknown_tool"`; disabled upstream → `-32602`, `data.code = "upstream_disabled"`; registry (DB) failure → `-32603 "upstream registry unavailable"`. Upstream problems are returned as a tool result with `isError: true` and text `upstream_unreachable: …` / `upstream_timeout: …` / `upstream_error: …`; an upstream's own `isError` result is passed through unchanged.

## Upstream object (response)
```json
{ "id": "uuid", "name": "WooCommerce", "slug": "woo", "url": "http://woo-mcp.store.svc.cluster.local/mcp",
  "enabled": true, "authType": "header", "authHeader": "X-Internal-Token", "hasCredential": true,
  "status": "connected", "lastError": null, "lastCheckedAt": "…", "toolCount": 5 }
```

## woo-mcp tools (input schemas)
| Tool | Input | Output (text JSON) |
|---|---|---|
| `list_products` | `{search?: string, page?: int≥1, per_page?: 1..50}` | `[{id,name,price,status,stock_status,permalink}]` |
| `create_product` | `{name: string(1..200), regular_price: "^\d+(\.\d{1,2})?$", description?: string, status?: "publish"\|"draft"}` | `{id,name,price,permalink}` |
| `list_orders` | `{date?: "today", after?: ISO, before?: ISO, status?: enum, page?, per_page?: 1..50}` | `[{id,number,status,total,currency,date_created,customer,items}]` |
| `get_order` | `{order_id: int}` | Order detail (no payment secrets) |
| `update_order_status` | `{order_id: int, status: enum}` | `{id,status}` |
