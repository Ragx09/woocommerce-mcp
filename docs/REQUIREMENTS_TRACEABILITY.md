# Requirements Traceability

Every mandatory requirement (IDs from [`SPEC.md`](../SPEC.md)) has an implementation component, tasks, tests and evidence. Status values: `Not Started` · `In Progress` · `Verified` · `Blocked`. **Verified** requires evidence (a link to the task evidence in `TASKS.md` or `docs/evidence/`).

| ReqID | Section | Requirement | Component | Tasks | Tests | Status | Evidence |
|---|---|---|---|---|---|---|---|
| REQ-STORE-01 | Problem statement, Store layer | One WooCommerce store on Kubernetes | store chart | WC-01, WC-02, WC-03 | TC-WC-01-1, TC-WC-02-1 | Not Started | — |
| REQ-STORE-02 | DoD Store | Cart + COD checkout | store / wp-init | WC-03, WC-04 | TC-WC-04-1, TC-E2E-01 | Not Started | — |
| REQ-STORE-03 | DoD Store | Order visible in WC admin | store | WC-04 | TC-WC-04-1, TC-E2E-02 | Not Started | — |
| REQ-MCP-01 | Req. WooCommerce MCP | Written by us, no existing server | woo-mcp | WC-06 | code review | Not Started | — |
| REQ-MCP-02 | Req. WooCommerce MCP | Streamable HTTP | woo-mcp | ARC-13, WC-07 | TC-ARC-13-1, TC-WC-07-1 | Not Started | — |
| REQ-MCP-03 | Req. WooCommerce MCP | list products tool | woo-mcp | WC-08 | TC-WC-08-1, TC-INT-01 | Not Started | — |
| REQ-MCP-04 | Req. WooCommerce MCP | create product tool | woo-mcp | WC-09 | TC-WC-09-1, TC-INT-01 | Not Started | — |
| REQ-MCP-05 | Req. WooCommerce MCP | list orders tool | woo-mcp | WC-10 | TC-WC-10-1, TC-INT-01 | Not Started | — |
| REQ-MCP-06 | Req. WooCommerce MCP | get order tool | woo-mcp | WC-11 | TC-WC-11-1, TC-INT-01 | Not Started | — |
| REQ-MCP-07 | Req. WooCommerce MCP | update order status tool | woo-mcp | WC-12 | TC-WC-12-1, TC-INT-01 | Not Started | — |
| REQ-MCP-08 | Req. WooCommerce MCP | Internal only; gateway-only access | NetworkPolicy | ARC-02, WC-14 | TC-SEC-02, TC-SEC-03 | Not Started | — |
| REQ-MCP-09 | Req. WooCommerce MCP | Document store integration + why | docs | ARC-14, WC-06 | TC-ARC-14-1, TC-UNIT-03 | In Progress | D-003 drafted |
| REQ-GW-01 | Req. Gateway | Admin add/edit/disable/remove upstreams with optional credential | gateway API + dashboard | GW-02, GW-11, GW-12, UI-05, UI-06, UI-07 | TC-UI-05-1, TC-UI-06-1, TC-UI-07-1, TC-INT-05 | Done | 2026-10-14: `POST/PATCH/DELETE /api/upstreams` (TC-UI-05/06/07-API in `upstreams-admin.int.test.ts`, credential write-only + encrypted, SSRF guard); dashboard add/edit/disable/delete in a browser on k3d with `/mcp` following each step (`dashboard-screens.sh admin` 16/16); GW-11 TC-INT-05; GW-12 credentials |
| REQ-GW-02 | Req. Gateway | One endpoint; list returns all enabled tools | gateway /mcp | GW-04, GW-05, GW-06 | TC-GW-05-1..7, TC-GW-06-1, TC-INT-02 | In Progress | GW-04..07 Done; TC-GW-06-1 PASS on k3d (5 woo tools via Inspector CLI, TASKS.md GW-06); TC-INT-02 with 3 upstreams pending GW-13/14 |
| REQ-GW-03 | Req. Gateway | Calls routed to the right server | gateway router | GW-08 | TC-GW-08-1, TC-UNIT-01 | Verified | TASKS.md GW-08: Inspector CLI → gateway → woo-mcp → WooCommerce returns products/orders on k3d; unit TC-GW-08-1..8 |
| REQ-GW-04 | Req. Gateway | Documented collision scheme | gateway naming | ARC-06, GW-07 | TC-UNIT-01, TC-INT-02 | In Progress | D-005 Accepted; TC-UNIT-01 8/8 PASS (GW-07); TC-INT-02 pending GW-06 |
| REQ-GW-05 | Req. Gateway | Slow/dead upstream does not break others | gateway | GW-10, GW-16 | TC-INT-03, TC-INT-04, TC-GW-16-1 | Done | TC-INT-03 PASS (GW-09: slow/hung upstream left out of the list and timed out on calls while the others answer); TC-INT-04 PASS (GW-10: dead/hung upstream marked Unreachable, skipped without waiting, recovers); TC-GW-16-1/2 PASS on k3d (GW-16: everything-mcp scaled to 0 or deleted → woo + github listed in < 1 s, calls to everything fail fast, Connected 7 s after Ready) |
| REQ-GW-06 | Req. Gateway | Timeouts + clear error | gateway | GW-09, UI-18 | TC-INT-03 | In Progress | GW-09 Done: TC-INT-03 PASS (slow call → `upstream_timeout` in 0.6 s budget, others unaffected; TASKS.md GW-09); showing the error in the UI pending UI-18 |
| REQ-GW-07 | Req. Gateway | Upstream credentials server-side only | gateway | GW-12, AUTH-15 | TC-INT-06, TC-AUTH-04 | In Progress | GW-12 Done: TC-INT-06 PASS (stored credential on every upstream request, client key never forwarded, no secret in DB/responses/logs; TASKS.md GW-12); GW-14: GitHub PAT absent from `/mcp` responses, logs and the DB column (exact-value scan); TC-AUTH-04 PASS (AUTH-15: every /api route + /mcp scanned for the upstream token and all other secrets, responses and debug logs; mutation-checked) |
| REQ-GW-08 | Req. Gateway | ≥3 upstreams (woo + 2) | gateway + charts | ARC-15, GW-13, GW-14 | TC-GW-13-1, TC-GW-14-1 | Done | TC-GW-13-1 + TC-GW-14-1 PASS on k3d: one `tools/list` through Traefik → 64 tools (woo 5, everything 13, github 46); calls to each upstream OK (TASKS.md GW-13/14) |
| REQ-GW-09 | User story admin 1 | Server list with status + tools | dashboard | GW-10, UI-04 | TC-UI-04-1 | Done | 2026-10-14: `GET /api/upstreams` + `/:id/tools` (TC-UI-04-API 6/6, real Postgres); Servers page on k3d: 3 servers Connected with tool counts and expandable tools; everything-mcp scaled to 0 → Unreachable in 9 s and back to Connected in 10 s without reload (`scripts/dashboard-screens.sh servers` 16/16) |
| REQ-GW-10 | User story admin 2 | WooCommerce server pre-registered | gateway seed | GW-03, UI-04 | TC-GW-03-1 | Done | GW-03 seeds WooCommerce on first start (TC-GW-03-1); 2026-10-14 the dashboard lists it first, Connected, 5 tools (UI-04) |
| REQ-GW-11 | Problem statement | Only the gateway talks to upstreams | gateway + chat + NetworkPolicy | ARC-10, UI-15, WC-14 | TC-INT-07, TC-SEC-02 | Not Started | — |
| REQ-GW-12 | User story member 2 | One URL + key shows all tools | gateway /mcp | GW-06, AUTH-08, E2E-01 | TC-EXT-01, TC-EXT-02 | In Progress | One URL works with a temporary shared dev key (GW-06); per-user keys in AUTH-08 |
| REQ-AUTH-01 | Req. Team | Admin and member roles | gateway auth | AUTH-01, AUTH-10, ARC-03 | TC-AUTH-02 | In Progress | AUTH-01: `users.role` admin\|member enforced by a DB CHECK (TC-AUTH-01-1); AUTH-02: first admin seeded from `gateway-admin`, login with argon2id (TC-AUTH-02-1..4, k3d); AUTH-10: TC-AUTH-02 PASS — default-deny router, member → 403 on every admin route (table over registered routes) |
| REQ-AUTH-02 | User story admin 4 | Invite team members | gateway + dashboard | AUTH-04, AUTH-05, UI-09 | TC-AUTH-03, TC-UI-09-1 | In Progress | AUTH-04/05 Done: TC-AUTH-03 + TC-AUTH-05-1 PASS (single use incl. concurrent accepts, 72 h expiry, admin-only creation); k3d invite → accept → login OK; dashboard page pending UI-09 |
| REQ-AUTH-03 | Req. Team / story member 1 | Own API key; self-generate | gateway + dashboard | AUTH-06, AUTH-08, UI-11 | TC-AUTH-06-1, TC-UI-11-1 | In Progress | AUTH-06/08 Done: TC-AUTH-06-1 PASS (member generates own key, works on /mcp; k3d: Inspector with Bob's key → 64 tools); dashboard page pending UI-11 |
| REQ-AUTH-04 | Req. Team | Keys revocable | gateway | AUTH-09, UI-10 | TC-AUTH-01, TC-AUTH-09-1 | In Progress | AUTH-06/09 Done: admin issues and revokes any key, TC-AUTH-09-1 PASS (revoked → next call 401; k3d too); TC-AUTH-01 PASS incl. audit `denied` rows (AUTH-13) |
| REQ-AUTH-05 | Req. Team | Keys stored hashed | gateway | AUTH-07 | TC-UNIT-02, TC-AUTH-07-1 | Done | TC-UNIT-02 + TC-AUTH-07-1 PASS: only SHA-256 + 12-char prefix stored, the DB refuses plaintext (TC-AUTH-01-1) |
| REQ-AUTH-06 | Req. Team | Audit every call (user, server, tool, ts, duration, outcome) | gateway audit | AUTH-12, AUTH-13 | TC-AUTH-05 | In Progress | AUTH-12/13 Done: every tools/call, tools/list and refused request audited with user, key, server, tool, timestamp, duration, outcome (TC-AUTH-05, TC-AUTH-11-1 PASS; k3d rows attributed to Bob and admin); query API pending AUTH-14 |
| REQ-AUTH-07 | Req. Team | Audit visible in dashboard | dashboard | AUTH-14, UI-12 | TC-UI-12-1 | In Progress | AUTH-14 Done: `GET /api/audit` admin-only with filters + cursor pagination (k3d verified); dashboard page pending UI-12 |
| REQ-CHAT-01 | Req. Chat | Chat uses LLM + tools via gateway | gateway chat | UI-14 | TC-INT-07, TC-UI-14-1 | Not Started | — |
| REQ-CHAT-02 | Req. Chat | Shows tools called | dashboard chat | UI-16 | TC-UI-16-1 | Not Started | — |
| REQ-CHAT-03 | Req. Chat | Acts as logged-in user; audited | gateway chat | UI-15, UI-17 | TC-UI-15-1, TC-UI-17-1 | Not Started | — |
| REQ-CHAT-04 | Req. Chat | LLM keys as secrets | chart + gateway | UI-13, INF-06 | TC-SEC-05 | Not Started | — |
| REQ-K8S-01 | Req. K8s | Local K8s | k3d | P0-02, INF-02 | TC-INF-02-1 | Not Started | — |
| REQ-K8S-02 | Req. K8s | VPS with same charts | k3s | REL-01, REL-03 | TC-VPS-01 | Blocked | No VPS yet (P0-03) |
| REQ-K8S-03 | Req. K8s | Helm + values-local/prod | charts | INF-03, INF-04 | TC-K8S-01 | Not Started | — |
| REQ-K8S-04 | Req. K8s | Everything in cluster | charts | INF-05, UI-20 | TC-K8S-04 | Done | 2026-10-14: store, DBs, woo-mcp, gateway, everything-mcp and the dashboard all run in k3d from one chart; `curl app.127.0.0.1.nip.io` → dashboard index |
| REQ-K8S-05 | Req. K8s | Persistent storage for DB + WP | charts | INF-12, WC-05 | TC-PER-01 | Not Started | — |
| REQ-K8S-06 | Req. K8s | Ingress stable URLs; local domain documented | charts + docs | INF-11 | TC-K8S-04 | Done | 2026-10-14: `store.<domain>` and `app.<domain>` (`/` dashboard, `/api` + `/mcp` gateway); TC-INF-11-1 via `k8s-checks.sh ingress`; nip.io documented |
| REQ-K8S-07 | Req. K8s | Readiness + liveness everywhere | charts | INF-09, REL-10 | TC-K8S-02 | Not Started | — |
| REQ-K8S-08 | Req. K8s | Requests + limits everywhere | charts | INF-08, REL-10 | TC-K8S-02 | Not Started | — |
| REQ-K8S-09 | Req. K8s | No hardcoded secrets; K8s Secrets | charts + scripts | INF-06, GW-17 | TC-SEC-04, TC-INF-06-2, TC-UNIT-06 | In Progress | GW-17 Done: TC-UNIT-06 PASS (field + value redaction, no tool args at info; mutation-checked); TC-AUTH-04 PASS (AUTH-15 end-to-end scan); k3d gateway log holds 0 occurrences of the PAT and woo token; TC-SEC-04 repo scan pending |
| REQ-DOD-01 | DoD Store | Storefront checkout COD | store | WC-04, E2E-12 | TC-E2E-01 | Not Started | — |
| REQ-DOD-02 | DoD Store | Order in WC admin | store | WC-04, E2E-12 | TC-E2E-02 | Not Started | — |
| REQ-DOD-03 | DoD Chat A | Chat creates product → storefront | chat + woo-mcp | UI-19, E2E-11 | TC-E2E-03 | Not Started | — |
| REQ-DOD-04 | DoD Chat A | Chat returns today's orders | chat + woo-mcp | UI-19, E2E-13 | TC-E2E-04 | Not Started | — |
| REQ-DOD-05 | DoD External B | External client with URL + key only | gateway | E2E-04 | TC-EXT-02, TC-E2E-05 | Not Started | — |
| REQ-DOD-06 | DoD External B | Sees all enabled tools; orders question | gateway | E2E-04, E2E-05 | TC-E2E-06 | Not Started | — |
| REQ-DOD-07 | DoD External B | Prompt using two upstreams | gateway | GW-15, E2E-06 | TC-E2E-07 | In Progress | GW-15: `scripts/cross-server.mjs` dry run OK (woo orders read through the gateway); issue creation waits for the throwaway repo name |
| REQ-DOD-08 | DoD Team | Revoke B → rejected | gateway | AUTH-09, E2E-07 | TC-E2E-08 | Not Started | — |
| REQ-DOD-09 | DoD Team | Disable upstream → tools gone (chat + external) | gateway | GW-11, E2E-08 | TC-E2E-09 | In Progress | GW-11: external `/mcp` hides a disabled upstream's tools and rejects calls with `upstream_disabled` (TC-INT-05, k3d check in TASKS.md GW-11); 2026-10-14 UI-07: disable in the dashboard → tools gone from `/mcp` (TC-UI-07-1); chat path pending E2E-08 |
| REQ-DOD-10 | DoD Team | Kill pod → others OK, Unreachable shown | gateway + dashboard | GW-16, E2E-09 | TC-E2E-10 | In Progress | GW-16 Done: `scripts/k8s-checks.sh killpod` 13/13 (scale 0 and pod delete → others OK in < 1 s, Unreachable logged, recovered 7 s after Ready); 2026-10-14 UI-04: the dashboard shows the killed server as Unreachable within ~10 s and the others Connected (TC-UI-04-1); final E2E-09 pending |
| REQ-DOD-11 | DoD Team | All calls in audit, correct user | audit | AUTH-13, E2E-10 | TC-E2E-11 | Not Started | — |
| REQ-DOD-12 | DoD | Demo with two users end to end | all | E2E-03, E2E-14, REL-15 | TC-E2E-12 | Not Started | — |
| REQ-DEL-01 | Deliverables | README local setup | docs | INF-15, REL-12 | TC-REL-12-1 | In Progress | README "Local setup" + `scripts/up.sh` verified from a deleted cluster (TASKS.md INF-15); final pass in REL-12 |
| REQ-DEL-02 | Deliverables | README VPS setup | docs | REL-12 | TC-REL-12-1 | Not Started | — |
| REQ-DEL-03 | Deliverables | README order / client / chat usage | docs | E2E-02, REL-12 | TC-EXT-02 | Not Started | — |
| REQ-DEL-04 | Deliverables | Source code for all components | repo | INF-01, WC-06, GW-01, UI-01 | TC-INF-01-1 | Not Started | — |
| REQ-DEL-05 | Deliverables | Helm charts + values files | charts | INF-03, INF-04 | TC-K8S-01 | Not Started | — |
| REQ-DEL-06 | Deliverables | System design & trade-offs note | docs | ARC-01, REL-13 | checklist | In Progress | ARCHITECTURE.md draft |
| REQ-DEL-07 | Deliverables | Threat model note (4 questions) | docs | REL-14 | checklist | In Progress | THREAT_MODEL.md draft |
| REQ-DEL-08 | Deliverables | List of bonus items attempted | docs | REL-12 | checklist | Not Started | — |
| REQ-DEL-09 | Submission | Demo video (6 topics) | video | REL-15, REL-16 | checklist | Not Started | — |
| REQ-DEL-10 | Submission | Submit form with video + repo | user | P0-01, REL-17 | user confirmation | Not Started | — |
