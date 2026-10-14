# API Contracts

> Status: **draft**. Base path `https://app.<domain>`. JSON everywhere. Errors use `{ "error": "<code>", "message": "<human text>" }`. The session cookie is `sid` (httpOnly, SameSite=Strict). Mutating `/api` requests (POST/PUT/PATCH/DELETE) from a browser must carry `Origin` equal to the public origin (or `Sec-Fetch-Site: same-origin`), otherwise 403 `forbidden` "cross-origin request refused" (AUTH-03). Every response carries `X-Request-Id` (a server-generated UUID; a client-sent one is ignored), which appears on every gateway log line of that request — quote it when reporting a problem.

## Route table
| Method | Path | Auth | Role | Purpose |
|---|---|---|---|---|
| POST | `/api/auth/login` | — | — | `{email,password}` → 200 `{user:{id,email,name,role}}` + cookie `sid` (HttpOnly, SameSite=Strict, Secure on https, 12 h). 401 `invalid_credentials` (same for unknown email, wrong password, disabled user); 429 `rate_limited` + `Retry-After` after 5 failures per IP+email or 20 per IP in 15 min; 400 on unknown fields |
| POST | `/api/auth/logout` | cookie (optional) | any | Deletes the session row and clears the cookie; always 204 |
| GET | `/api/me` | session | any | `{id,email,name,role}`; 401 `unauthenticated` without a valid session (expired, logged out, user disabled) |
| GET | `/api/upstreams` | session | any | Registry order (oldest first) with this replica's health: `status` (`unknown` before the first check · `connected` · `unreachable` · `disabled`), `lastError` (safe text, kept after recovery), `lastCheckedAt`, `lastOkAt`, `toolCount` (null when disabled/unreachable; from the ≤ 60 s discovery cache, else one live list within 3 s). Admin also gets `url`, `authType`, `authHeader`, `hasCredential`, `createdAt`, `updatedAt`; never a credential (UI-04) |
| GET | `/api/upstreams/:id/tools` | session | any | `[{publicName,name,title,description,params:[{name,required}]}]` (required first); 404 unknown id, 409 `upstream_disabled`, 502 `upstream_unreachable` (safe message), 400 non-uuid id |
| POST | `/api/upstreams` | session | admin | `{name,slug,url,authType,authHeader?,credential?}` → 201 upstream object (admin view). `slug` `^[a-z0-9-]{1,20}$`, immutable; `authType` none\|bearer\|header; header needs `authHeader` (not a reserved header such as Host/Authorization/Cookie); bearer/header need `credential` (printable ASCII ≤ 4096, write-only, stored AES-GCM-encrypted); none forbids it. URL → SSRF guard (MCP_DESIGN §12): 400 `ssrf_blocked`. 409 `conflict` duplicate slug; 400 `validation_failed` (unknown fields too) |
| PATCH | `/api/upstreams/:id` | session | admin | Partial `{name?,url?,authType?,authHeader?,credential?,enabled?}` (no `slug` → 400); `credential` omitted = keep, string = replace, `null` = remove (400 if the auth type still needs one); `authType: none` clears the credential; a changed URL passes the SSRF guard. → 200 upstream object; 404 unknown id. Takes effect on every replica's next request |
| DELETE | `/api/upstreams/:id` | session | admin | Remove → 204; 404 unknown id. Its tools leave `/mcp` on the next request; audit rows stay (slug + id kept) |
| GET | `/api/users` | session | admin | `[{id,email,name,role,disabledAt,createdAt,activeKeys,lastKeyUseAt}]` oldest first; never a password hash (UI-09) |
| PATCH | `/api/users/:id` | session | admin | `{disabled?, role?}` (at least one) → updated user. Disabling deletes the user's sessions; their session and API keys are refused from the next request (keys are suspended, not revoked: enabling restores them). 409 `conflict`: yourself, or the last active admin (checked under a row lock); 403 if the caller lost admin meanwhile; 404 unknown |
| POST | `/api/invites` | session | admin | `{email, role?}` → 201 `{id,email,role,expiresAt,inviteUrl}`; `inviteUrl` = `<origin>/invite#<token>` (shown once; the token is in the fragment so it never reaches a server log). A new invite replaces open ones for the email; existing user → 409 |
| GET | `/api/invites` | session | admin | Open invites `[{id,email,role,createdAt,expiresAt}]` (no tokens) |
| DELETE | `/api/invites/:id` | session | admin | Withdraw an open invite → 204; its link answers 404 from then on; used/unknown → 404 |
| POST | `/api/invites/check` | — | — | `{token}` → `{email,role,expiresAt}`; 404 unknown, 410 `invite_used` / `invite_expired` |
| POST | `/api/invites/accept` | — | — | `{token,name,password}` → 201 `{user}` + session cookie; consumes the token (single use, 72 h); 410 on reuse/expiry; 400 weak password (< 12) |
| GET | `/api/keys` | session | any | Own keys (admin: `?all=1` for everyone's; member → 403) `[{id,name,prefix,createdAt,lastUsedAt,revokedAt,owner:{id,email,name}}]` — never the key or its hash |
| POST | `/api/keys` | session | any | `{name}` → 201 `{id,name,prefix,createdAt,key}` (plaintext once; `mgw_` + 43 base62); 409 over 20 active keys |
| POST | `/api/users/:id/keys` | session | admin | `{name}` → 201, same shape, key for that user; 404 unknown/disabled user |
| DELETE | `/api/keys/:id` | session | owner or admin | Revoke → 204 (idempotent); someone else's key → 404; effective on the next `/mcp` request |
| GET | `/api/audit` | session | admin | Filters `user` (uuid), `upstream` (slug), `outcome`, `source`, `from`/`to` (ISO), `limit` 1..200 (50), `cursor` → `{items:[{id,ts,requestId,source,method,upstream,tool,durationMs,outcome,errorCode,keyPrefix,user:{id,email,name}\|null}], nextCursor}` newest first (keyset pagination); 400 on bad filters |
| POST | `/api/chat` | session | any | `{messages:[{role,content}]}` → `{reply, toolCalls[]}` |
| POST | `/mcp` | `Authorization: Bearer mgw_…` (per-user API key, AUTH-08; internal chat token with UI-15) | any | MCP Streamable HTTP endpoint, stateless JSON responses. 401 `{"error":"invalid_api_key"}` + `WWW-Authenticate: Bearer`; GET/DELETE → 405 `Allow: POST` |
| GET | `/healthz`, `/readyz` | — | — | Probes (not exposed via Ingress; on `app.<domain>` these paths reach the dashboard) |
| GET | everything else on `app.<domain>` | — | — | Dashboard SPA (nginx): `index.html` for any client route (`/login`, `/invite`, `/servers` …), `/assets/*` immutable; CSP `default-src 'self'; frame-ancestors 'none'` |

Every `/api` route declares its access (`public`, `session`, `admin`) in code; the guard runs before the body is parsed, so an anonymous request gets 401 and a member on an admin route 403 regardless of the body (AUTH-10).

## Error codes
`unauthenticated` (401), `invalid_credentials` (401, login), `forbidden` (403), `not_found` (404), `validation_failed` (400, with `issues`), `conflict` (409, e.g. duplicate slug), `ssrf_blocked` (400), `invite_used` / `invite_expired` (410), `rate_limited` (429), `internal` (500).

`/mcp` (JSON-RPC, GW-08): `tools/call` with an unknown or malformed name → error `-32602` with `data.code = "unknown_tool"`; disabled upstream → `-32602`, `data.code = "upstream_disabled"`; registry (DB) failure → `-32603 "upstream registry unavailable"`. Upstream problems are returned as a tool result with `isError: true` and text `upstream_unreachable: …` / `upstream_timeout: …` / `upstream_error: …`; an upstream's own `isError` result is passed through unchanged.

## Upstream object (response)
```json
{ "id": "uuid", "name": "WooCommerce", "slug": "woo", "enabled": true,
  "status": "connected", "lastError": null, "lastCheckedAt": "…", "lastOkAt": "…", "toolCount": 5,
  // admin only:
  "url": "http://woo-mcp.store.svc.cluster.local/mcp", "authType": "bearer", "authHeader": null, "hasCredential": true,
  "createdAt": "…", "updatedAt": "…" }
```

## woo-mcp tools (input schemas)
| Tool | Input | Output (text JSON) |
|---|---|---|
| `list_products` | `{search?: string, page?: int≥1, per_page?: 1..50}` | `[{id,name,price,status,stock_status,permalink}]` |
| `create_product` | `{name: string(1..200), regular_price: "^\d+(\.\d{1,2})?$", description?: string, status?: "publish"\|"draft"}` | `{id,name,price,permalink}` |
| `list_orders` | `{date?: "today", after?: ISO, before?: ISO, status?: enum, page?, per_page?: 1..50}` | `[{id,number,status,total,currency,date_created,customer,items}]` |
| `get_order` | `{order_id: int}` | Order detail (no payment secrets) |
| `update_order_status` | `{order_id: int, status: enum}` | `{id,status}` |
