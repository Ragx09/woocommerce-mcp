# Threat Model

> Status: **draft**. Each mitigation is marked *Planned* until a test proves it (then *Verified* + test ID). Do not claim guarantees that are not verified.

## 1. Assets
| Asset | Where | Impact if leaked or abused |
|---|---|---|
| Upstream credentials (GitHub PAT, WooCommerce consumer key/secret) | Postgres (encrypted), K8s Secrets | Direct access to GitHub or the store, bypassing the gateway and audit |
| Gateway API keys | Shown once to the user; stored as SHA-256 | Impersonation of a team member |
| Dashboard sessions / passwords | Postgres (argon2id / session IDs) | Account takeover, admin actions |
| LLM provider key | K8s Secret | Cost or quota abuse |
| Credentials encryption key | K8s Secret | Decrypts all stored upstream credentials |
| Store data (orders, customers) | MariaDB | Privacy and business impact |
| Audit log | Postgres | Loss of accountability |

## 2. Trust boundaries
1. Internet → Traefik Ingress (storefront, dashboard, `/api`, `/mcp`).
2. Gateway → upstream MCP servers (in-cluster, or on the internet for GitHub). **Upstreams are untrusted.**
3. Gateway → LLM provider (sends tool schemas and results; untrusted output).
4. Namespaces `store` ↔ `platform` (NetworkPolicy).
5. Admin ↔ member (role boundary enforced in the gateway).

## 3. Threats and mitigations
| ID | Threat | Mitigation | Status |
|---|---|---|---|
| T-01a | Temporary shared `/mcp` dev key (GW-06 → AUTH-08) leaks | Removed in AUTH-08: config, chart, Secret script and the k3d Secret deleted; the old value now gets 401 | Closed (AUTH-08) |
| T-01 | Stolen or leaked API key | Revocation is immediate (DB check on every request, no cache); disabling a user stops all their keys; prefix shown for identification; keys listed per user with `last_used_at`; keys never logged (value scrub `mgw_…`) nor forwarded upstream | Implemented (AUTH-08/09: TC-AUTH-09-1, TC-AUTH-01 key part; k3d revoke → next call 401) |
| T-02 | DB dump reveals keys | Only SHA-256 hashes (256-bit random keys) + 12-char prefix are stored; DB CHECK refuses anything else | Implemented (AUTH-07: TC-AUTH-07-1, TC-AUTH-01-1) |
| T-03 | Upstream credential reaches the browser or client | Write-only API field; credential decrypted only in `upstreamHeaders()` for the server-side upstream transport; response serializer allowlist (`toPublic`); redirects from upstreams are refused (`redirect: 'error'` + SDK same-origin policy) so a custom credential header cannot follow a 3xx to another host; credential values with CR/LF or control characters are rejected (no header injection); tests assert no secret in DB rows, `/mcp` responses or logs | Partial: gateway side implemented (GW-12; TC-INT-06, TC-GW-12-U1..U3, TC-GW-03-U4; AUTH-15 scan finds the upstream token in no response or log); UI-05/06: credential is write-only (create/rotate/remove; never returned; AUTH-15 scan covers create + rotate); UI-04 read API returns only `hasCredential` (admin) — TC-UI-04-API asserts the token and ciphertext are absent, and the AUTH-15 scan now covers `/api/upstreams*` |
| T-04 | Client token forwarded upstream (confused deputy / token passthrough) | The gateway never forwards the inbound `Authorization` header; upstream requests carry only the stored upstream credential | Implemented (GW-04/06/12; TC-GW-04-2, TC-GW-06-U3, TC-INT-06: client `Authorization` and a spoofed `X-Internal-Token` never reach any upstream) |
| T-05 | Member performs admin actions | Role check in the gateway on every `/api` route (not just the UI); tests per route | Implemented for the existing routes (AUTH-10: default-deny router — every /api route declares public/session/admin or startup fails; guard runs before body parsing; TC-AUTH-02 table test over all registered routes, mutation-checked). Upstream/member/audit routes join the table when built |
| T-22 | Chat agent's internal token stolen or forged to act as another user on `/mcp` | HMAC-SHA256 with a per-process random key (never stored/sent), ≤ 5 min expiry, accepted only from a loopback TCP peer (`X-Forwarded-For` ignored), user re-checked (disabled → 401), token value scrubbed from logs, never forwarded upstream (T-04) | Implemented (UI-15: TC-UI-15-U1/U2, TC-UI-15-1/2 mutation-checked; k3d: `itk_` via Ingress → 401) |
| T-23 | One member exhausts the team's shared LLM quota (or floods tools) through the chat | Per user: one chat request at a time and 30 requests per 10 min; per request: 8 LLM rounds, 16 tool calls, 150 s; LLM 429 surfaced with Retry-After; every tool call audited under the user | Implemented (UI-14: TC-UI-14-API busy + window, mutation-checked; in memory per replica, so N replicas allow N×) |
| T-24 | Stored XSS through the chat: a product name, order note or upstream result containing HTML/script is repeated by the model and rendered in the dashboard; or a provider error echoes a credential that is fed back to the model | Replies and tool data are rendered only as React text nodes (Markdown subset parsed to `<strong>`/`<code>` elements, never `innerHTML`); strict CSP without inline script (UI-20); the conversation is kept in memory only. Provider validation messages fed back to the model are scrubbed of the API key and credential-shaped strings (D-020) | Implemented (UI-16: TC-UI-16-1 stubbed `<img onerror>` reply stays text, TC-UI-16-U1/U2 mutation-checked) |
| T-06 | SSRF via admin-supplied upstream URL (e.g. `169.254.169.254`, internal Services) | URL validator: http(s) only, no userinfo; resolve DNS and block private, loopback, link-local and metadata ranges unless the host name is on the allowlist (operator list + seeded hosts; metadata never); re-validated at connect time by the agent's guarded `lookup` (DNS rebinding) and a literal-IP check; redirects refused (MCP_DESIGN §12) | Implemented (UI-05: TC-UNIT-04 5/5, TC-SEC-01 in `upstreams-admin.int.test.ts` incl. connect-time refusal of a row written around the API — both layers mutation-checked; live k3d API: metadata, postgres, mariadb, wordpress, gateway, kubernetes, localhost, ::1, 10.43.0.1 → 400 `ssrf_blocked`; DNS-rebinding against a real resolver pending SEC-05) |
| T-07 | Malicious or compromised upstream returns prompt-injection in tool descriptions or results | Tool descriptions are namespaced and length-capped; the chat system prompt treats tool output as data; the chat agent has an iteration cap; the dashboard shows which server each tool comes from; admins can disable a server instantly. Residual risk: the model may still be manipulated, so the human must review destructive actions | Partial (UI-14: server-side system prompt — clients cannot send `system` turns; descriptions ≤ 400 and results ≤ 4 KB for the model; 8 rounds / 16 calls; the response lists every call; invented tool names refused. Transcript display UI-16: every call shown with server, arguments and result; replies drawn as text, never HTML (T-24); adversarial tests SEC-05) |
| T-08 | Slow or dead upstream causes DoS of the gateway | One deadline per call/list (GW-09), `Promise.allSettled`, health loop with fast fail for unreachable upstreams (GW-10), response-size cap | Partial: timeouts + isolation implemented (TC-INT-03, TC-INT-04); response-size cap planned |
| T-09 | Direct access to woo-mcp / databases from outside or from other pods | ClusterIP only (chart policy) + default-deny NetworkPolicies (woo-mcp ← gateway only; mariadb ← wordpress only; postgres ← gateway only; WordPress ← Traefik + woo-mcp; everything-mcp ← gateway, no egress; dashboard ← Traefik, no egress) | Implemented (WC-14/GW-13/UI-20: `scripts/k8s-checks.sh netpol` 15/15 with real probe pods, re-run 2026-10-18 after the WordPress port change) |
| T-10 | Secrets in logs | pino redaction by field name (headers, `authorization`, `cookie`, `credential`, `token`, `pat`, `apiKey`, `password`, `secret` …, top level and nested) plus a value scrub for credential-shaped strings (Bearer/Basic, GitHub PATs, `mgw_` keys, WooCommerce `ck_/cs_`, LLM keys) in messages, errors and any field; tool arguments/results never logged at info (argument names at debug); errors are sanitized before reaching clients | Implemented (GW-17: TC-UNIT-06; AUTH-15: TC-AUTH-04 end-to-end scan of every /api route and /mcp at debug level, which also catches secrets under unexpected field names; mutation-checked) |
| T-11 | Secrets in git | `.gitignore` for `.env`/`secrets/`; secrets generated by a script into K8s Secrets; a secret scan (`gitleaks` or grep) before submission | Planned |
| T-12 | CSRF on the dashboard API | SameSite=Strict cookie + `Origin` check on mutating requests (`Origin` must equal `PUBLIC_ORIGIN`, else `Sec-Fetch-Site` must be same-origin; refused before any route work; login included — login CSRF) | Implemented (AUTH-03: TC-AUTH-03-2, mutation-checked; k3d evil-origin logout/login → 403) |
| T-21 | Admin lock-out or privilege drift: the last admin is demoted/disabled, or a just-demoted admin finishes an in-flight request | `PATCH /api/users/:id` refuses self-demotion/disable and the last active admin, under `FOR UPDATE` on the active admins; the caller's admin status is re-checked inside that transaction | Implemented (UI-09: TC-UI-09-API incl. two admins demoting each other concurrently → exactly one succeeds, 5 runs) |
| T-13 | Brute force on login | argon2id (19 MiB, t=2); failed logins limited per IP+email (5) and per IP (20) per 15 min → 429; identical 401 and timing for unknown email / wrong password / disabled user; real client IPs on the VPS via Traefik `externalTrafficPolicy: Local` (otherwise all clients share one SNAT address and the limit turns into a lockout anyone can trigger) | Partial (AUTH-02: TC-AUTH-02-1..4; limits are per replica; VPS real-IP check pending REL-01; on k3d all clients share one address) |
| T-14 | Container breakout or privilege | Every container (incl. WordPress/Apache, now www-data on 8080) runs as a non-root numeric user with seccomp RuntimeDefault, `allowPrivilegeEscalation: false`, all capabilities dropped and none added, a read-only root filesystem (emptyDirs for scratch paths), no service-account token; `chart-policy.py` fails the chart on any deviation | Implemented (REL-09: policy 0 violations, mutation-checked; k3d WordPress `uid=33`, `CapEff 0`; kubescape in SEC-06) |
| T-16 | Repudiation: a user denies having called a tool; abuse goes unnoticed | Audit row for every tools/call, tools/list and refused /mcp request with user, key, request id, outcome; rows outlive users and upstreams; failed writes logged | Implemented (AUTH-13: TC-AUTH-05, TC-AUTH-11-1; viewing in AUTH-14/UI-12) |
| T-15 | A third-party upstream leaks its own environment (server-everything has a `get-env` tool) | Upstream pods get no Secrets or env credentials; only non-sensitive config; no ServiceAccount token, no service-link env; no egress (NetworkPolicy) and `GZIP_ALLOWED_DOMAINS=invalid` so its URL-fetching tool cannot be used for SSRF | Implemented (GW-13: `get-env` via the gateway shows no secret; egress probe CLOSED; gzip fetch of an internal URL refused) |
| T-17 | WordPress recon and attack surface: user enumeration (`/wp-json/wp/v2/users`, `?author=`), `xmlrpc.php` brute force, `readme.html` version leak, vulnerable plugins/themes | Disable or restrict the exposed endpoints; pin and scan core, plugins and the brand theme (Phase 9) | Planned (SEC-02) |
| T-18 | Checkout tampering: price, quantity or coupon changed client-side; order marked paid without payment | WooCommerce recalculates totals server-side | Planned (SEC-04) |
| T-19 | Clickjacking, XSS impact or cookie theft from missing security headers / cookie flags | CSP, frame-ancestors, nosniff, Referrer-Policy via Traefik middleware; Secure/HttpOnly/SameSite cookies; HSTS + TLS on the VPS. Dashboard: nginx sends CSP `default-src 'self'` (no inline script/style, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer`; React escapes output; no tokens in JS/storage; `?next=` after login accepts in-app paths only (no open redirect); invite token read from the URL fragment and removed from history | Partial (UI-20/UI-03: headers checked by `k8s-checks.sh ingress`, no CSP console errors and `?next=//evil.example` refused in TC-UI-03-1; gateway JSON + HSTS pending SEC-07) |
| T-20 | Known CVEs in container images | Pinned images, Trivy scan, rebuild on fixable Critical/High | Planned (SEC-06) |

## 4. Required threat-model questions (REQ-DEL-07)
1. **Shared upstream credentials: what can a member do with a credential they never see?** They can make the gateway use it for any tool the upstream allows, within the PAT's or key's scope. The credential itself can't be extracted. Limits: minimal-scope credentials; per-user attribution in the audit log; key revocation; disabling a server. Stand-out item: per-role tool permissions.
2. **Why client tokens are not passed through to upstream servers.** Upstreams would receive a credential meant for the gateway (a token-audience violation). A malicious upstream could replay it against the gateway or other services, and the upstream can't validate it anyway. The MCP authorization spec forbids token passthrough. The gateway is the policy point.
3. **Untrusted upstreams: tool descriptions written to manipulate the model.** See T-07. Detail to be completed in REL-14.
4. **What can one team member do to another?** Members can't see or revoke others' keys, can't read others' chat history, and can't change servers. They can see audit entries only if they are admin. Shared side effects: any member can create or modify store data via tools, which the audit log attributes to them. Detail to be completed in REL-14.

## 5. Security tests
Mapped in `TEST_PLAN.md` § Security (TC-SEC-*).

## 6. Verification by attack (Phase 10)
This model is the **hypothesis**: what could go wrong and how we planned to stop it. Phase 10 (`TASKS.md` SEC-01…09) is the **proof**: we attack each threat and record the result in [`docs/SECURITY_FINDINGS.md`](docs/SECURITY_FINDINGS.md).

| Threat | Attacked in |
|---|---|
| T-01, T-02, T-05, T-12, T-13 | SEC-04 manual auth tests, SEC-03 ZAP API scan |
| T-03, T-04, T-07, T-08, T-15 | SEC-05 MCP/AI tests (hostile upstream, credential exfiltration via chat) |
| T-06 | SEC-05 SSRF set (incl. TC-SEC-01, DNS rebinding) |
| T-09, T-14, T-11, T-20 | SEC-06 rogue-pod matrix, kubescape, Trivy, gitleaks |
| T-10 | SEC-04/05: grep logs after each attack run |
| T-18 | SEC-04 checkout tampering |
| T-17 | SEC-02 WPScan, nuclei, nikto |
| T-19 | SEC-07 headers, cookies, TLS |
| everything | SEC-08 attacker-LLM rounds |

Rules for updating this file:
- A threat moves from `Planned` to `Mitigated (<task>, verified <SEC-xx>)` only after its attack fails and a regression test exists.
- A finding that matches no threat here becomes a **new T-row** (the attack found a gap in the model itself).
- A finding we choose not to fix becomes `Accepted` with the reason, and goes into the residual-risk part of `docs/SECURITY_REPORT.md` (SEC-09).

## 7. Authorization boundary review (REL-07, 2026-10-18)
Every route was compared with the role matrix below; enforcement is in the gateway, never only in the UI.

| Surface | Anonymous | Member | Admin | Enforced by |
|---|---|---|---|---|
| `POST /api/auth/login`, `/logout`, `/api/invites/check`, `/accept` | yes (rate limit; invite token) | yes | yes | `access: 'public'` + Origin check on mutations |
| `GET /api/me`, `GET /api/upstreams`, `GET /api/upstreams/:id/tools`, `POST /api/chat` | 401 | yes (no URLs/auth details in the upstream list) | yes (+ URL, auth type, `hasCredential`) | `access: 'session'`; admin-only fields chosen by role in the serializer |
| `GET /api/keys` | 401 | own keys | own, `?all=1` everyone's | session + role check in the handler (member `?all=1` → 403) |
| `POST /api/keys` | 401 | own key | own key | session; owner = caller |
| `DELETE /api/keys/:id` | 401 | own keys only (others → 404, no existence leak) | any | `revokeApiKey` ownership check |
| users, invites, `POST /api/users/:id/keys`, audit, upstream create/edit/delete | 401 | 403 | yes | `access: 'admin'`; user changes also re-check the caller's admin role under a row lock (T-21) |
| `POST /mcp` | 401 + audit `denied` | every tool of every enabled server, as themselves | same | API key (hash lookup per request; revoked key / disabled user → 401) or the chat's `itk_` token (loopback only) |

How it is enforced: a default-deny router — every `/api` route must declare `public`/`session`/`admin` or the gateway refuses to start; the guard runs before body parsing; objects owned by users (keys) are checked against the caller in the data layer.

Evidence: TC-AUTH-02 walks every registered route (anonymous 401, member 403 on admin routes; int 118/118); live k3d walk `node scripts/authz-live.mjs` → 18/18 PASS (11 admin routes: anonymous 401 and member 403; member revoking the admin's key → 404; 4 session routes anonymous → 401; forged session cookie → 401); E2E-07 revoke → next `/mcp` call 401.

**Gaps found: none in enforcement.** Accepted by design (the problem statement makes per-role tool control a stand-out item, not a requirement): every member can call every tool of every enabled server, including write tools (`woo__create_product`, `woo__update_order_status`, `github__issue_write`) that use the shared upstream credential. Mitigations: minimal-scope upstream credentials, per-user audit of every call, instant key revocation / user disable, and disabling a server.
