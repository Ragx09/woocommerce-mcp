# SPEC — WooCommerce Hosting + Team MCP Gateway

> The source of truth is [`problem-statement.md`](problem-statement.md). This spec restates it with requirement IDs so every requirement can be traced to tasks, tests and evidence (`docs/REQUIREMENTS_TRACEABILITY.md`). If the two ever disagree, `problem-statement.md` wins.

## 1. Problem
A team wants to use many MCP servers (starting with their WooCommerce store) from AI clients without each member configuring every server or holding its credentials. An admin registers MCP servers once. Members then reach all of them through **one gateway endpoint** (with a personal API key) or through a **chat agent in the dashboard**. Every call is attributed and audited. The whole system runs on Kubernetes, from the same Helm charts locally and on a k3s VPS.

## 2. Users and roles
| Role | Can | Cannot |
|---|---|---|
| **Admin** | Manage upstream MCP servers (add/edit/disable/remove, set credentials), invite members, issue and revoke any key, view the audit log, use tools and chat | Read upstream credentials back in plaintext after saving |
| **Member** | Generate and revoke their own keys, use tools through the gateway and the chat, see the server list and tools (read-only) | Manage servers or members, see upstream credentials, use or revoke other users' keys |

## 3. Workflows
**Admin:** log in → see servers + status (Connected / Unreachable / Disabled) + tools → the WooCommerce server is already registered → add a server (URL + optional header/bearer credential) → edit, disable or remove it → invite a member (one-time link) → issue or revoke keys → review the audit log.
**Member:** accept the invite and set a password → generate an API key (shown once) → add the gateway URL + key to Claude Code, Cursor or Inspector → use the tools of every enabled server → or ask the dashboard chat, which shows the tools it called.

## 4. Functional requirements

### Store
- **REQ-STORE-01** One WooCommerce store (WordPress + WooCommerce) runs on Kubernetes.
- **REQ-STORE-02** A shopper can add a product to the cart and check out with a test-friendly method (COD or a dummy gateway).
- **REQ-STORE-03** Orders are visible in WooCommerce admin.

### WooCommerce MCP server
- **REQ-MCP-01** Written by us; no existing WooCommerce MCP server or plugin is installed.
- **REQ-MCP-02** Speaks MCP over Streamable HTTP.
- **REQ-MCP-03** Tool: list products.
- **REQ-MCP-04** Tool: create product.
- **REQ-MCP-05** Tool: list orders.
- **REQ-MCP-06** Tool: get order.
- **REQ-MCP-07** Tool: update order status.
- **REQ-MCP-08** Not reachable from outside the cluster; only the gateway can call it.
- **REQ-MCP-09** How it talks to the store, and why, is documented.

### Gateway
- **REQ-GW-01** Admins can add, edit, disable and remove upstream MCP servers (Streamable HTTP), each with an optional static credential (header or bearer).
- **REQ-GW-02** One MCP endpoint; `tools/list` returns the tools of every enabled server.
- **REQ-GW-03** `tools/call` is routed to the right upstream server.
- **REQ-GW-04** Tool-name collisions are handled with a documented scheme.
- **REQ-GW-05** A slow or dead upstream does not break listing or calls to other servers.
- **REQ-GW-06** Upstream calls have timeouts and return a clear error.
- **REQ-GW-07** Upstream credentials stay server-side; they never reach the browser or an MCP client.
- **REQ-GW-08** At least three upstreams are connected: the WooCommerce server plus two others.
- **REQ-GW-09** The dashboard shows registered servers with status (Connected / Unreachable / Disabled) and the tools each one exposes.
- **REQ-GW-10** The WooCommerce MCP server is pre-registered as the first server.
- **REQ-GW-11** Nothing except the gateway talks to upstream servers (the chat agent and external clients both go through it).
- **REQ-GW-12** A member adds one gateway URL + their key to an MCP client and sees the tools of every enabled server without configuring them.

### Team and access
- **REQ-AUTH-01** At least two roles: admin (manages servers and members) and member (uses tools).
- **REQ-AUTH-02** Admins can invite team members.
- **REQ-AUTH-03** Each user has their own gateway API key; members can generate their own in the dashboard.
- **REQ-AUTH-04** Admins can issue and revoke keys; revoked keys are rejected.
- **REQ-AUTH-05** Keys are stored hashed.
- **REQ-AUTH-06** Every tool call is written to an audit log with user, server, tool, timestamp, duration and outcome.
- **REQ-AUTH-07** The audit log is visible in the dashboard.

### Chat agent
- **REQ-CHAT-01** A chat in the dashboard uses an LLM to call tools through the gateway.
- **REQ-CHAT-02** It shows which tools it called.
- **REQ-CHAT-03** It acts as the logged-in user; its calls appear in the audit log under that user.
- **REQ-CHAT-04** LLM API keys are handled like every other secret (K8s Secret, never in code or the browser).

## 5. Non-functional and deployment requirements
- **REQ-K8S-01** Runs on local Kubernetes (k3d chosen).
- **REQ-K8S-02** Deployable to a production-like VPS (k3s) with the same Helm charts.
- **REQ-K8S-03** Helm only (no Kustomize). Local and production differences live in `values-local.yaml` / `values-prod.yaml`.
- **REQ-K8S-04** Everything runs in the cluster: store, database, WooCommerce MCP server, gateway backend, dashboard.
- **REQ-K8S-05** The store database and WordPress content use persistent storage.
- **REQ-K8S-06** Storefront and dashboard are exposed through Ingress with stable URLs; the local domain approach is documented.
- **REQ-K8S-07** Readiness and liveness probes on every workload.
- **REQ-K8S-08** Resource requests and limits on every workload.
- **REQ-K8S-09** No hardcoded secrets in source; credentials live in Kubernetes Secrets.

## 6. Mandatory acceptance criteria (Definition of Done, demoed with two users)
- **REQ-DOD-01** Storefront: add a product to the cart and check out with COD.
- **REQ-DOD-02** The order is visible in WooCommerce admin.
- **REQ-DOD-03** User A (chat): "create a product with name X and price Y" → it appears on the storefront.
- **REQ-DOD-04** User A places an order for it by hand, then asks the chat "what orders came in today" → the order is returned.
- **REQ-DOD-05** User B connects Claude Code, Cursor or Inspector using only the gateway URL + B's API key.
- **REQ-DOD-06** User B sees the tools of every enabled server and asks the same orders question successfully.
- **REQ-DOD-07** User B runs one prompt that needs tools from two different upstreams.
- **REQ-DOD-08** Revoke B's key → B's next call is rejected.
- **REQ-DOD-09** Disable one upstream → its tools disappear from both the chat agent and the external client.
- **REQ-DOD-10** Kill one upstream pod → the other servers keep working and the dashboard shows the dead one as Unreachable.
- **REQ-DOD-11** Every call above appears in the audit log, attributed to the right user.
- **REQ-DOD-12** The demo shows this flow end to end with two different users.

## 7. Mandatory deliverables
- **REQ-DEL-01** README: local setup instructions.
- **REQ-DEL-02** README: VPS / production-like setup instructions (k3s).
- **REQ-DEL-03** README: how to place an order, connect an external MCP client, and use the chat agent.
- **REQ-DEL-04** Source code: dashboard, backend + gateway, WooCommerce MCP server, chat agent.
- **REQ-DEL-05** Helm charts + values files (local and production).
- **REQ-DEL-06** "System design and tradeoffs" note: architecture choices; tool aggregation, routing and failure handling; what changes for production (DNS, ingress, storage class, secrets).
- **REQ-DEL-07** Threat model note: shared upstream credentials (what a member can do with a credential they never see); why client tokens are not passed through upstream; untrusted upstreams (manipulative tool descriptions); what one team member can do to another.
- **REQ-DEL-08** List of attempted bonus or stand-out items and where to find them.
- **REQ-DEL-09** Demo video covering: system design and DoD flow live with two users; Kubernetes (namespaces, Secrets, volumes, Ingress, requests/limits, probes, public vs internal and how it is enforced); MCP internals (connections, call path, collisions, timeouts, dead upstream); security posture (key and credential storage, member limits, malicious MCP server); chat tool loop and user attribution; local → VPS story (values, ingress, domains, storage, secrets, upgrade and rollback).
- **REQ-DEL-10** Submission through the form (demo video + GitHub repo): https://forms.gle/nftwgyNeenSDmiRb6

## 8. Bonus and stand-out requirements (required since 2026-10-24, A-10)
The problem statement marks these optional; the user made them required. Built after the core passes (Phase 11, BON-*).

Bonus: multi-store provisioning
- **REQ-BON-01** Dashboard creates and deletes stores and lists them with status (Provisioning / Ready / Failed), URL and created time; several stores can be provisioned at once.
- **REQ-BON-02** Each store is provisioned through Helm or the Kubernetes API in its own namespace, with its own database, Secrets, persistent volumes and Ingress host.
- **REQ-BON-03** Each new store gets its own WooCommerce MCP server, registered in the gateway without manual steps; tool names show which store a tool acts on.
- **REQ-BON-04** Deleting a store removes its namespace, volumes, Secrets and MCP registration.
- **REQ-BON-05** One store's MCP server cannot reach another store's database or WordPress (NetworkPolicies).
- **REQ-BON-06** ResourceQuota and LimitRange per store namespace, a maximum number of stores per user, and a provisioning timeout.
- **REQ-BON-07** Creating a store is safe to retry; if the provisioning component restarts mid-provisioning the store completes or fails cleanly with a clear reason.
- **REQ-BON-08** Test: the chat compares today's orders across two stores; one store is deleted and its tools and resources are gone.

Other ways to stand out
- **REQ-SO-01** Same charts deployed on a VPS (k3s) and shown working; changes through Helm values documented (domain, ingress, storage, secrets); TLS with cert-manager.
- **REQ-SO-02** Per-role or per-user control over allowed servers and tools; restricted tools hidden from the list and rejected if called directly.
- **REQ-SO-03** OAuth flow from the MCP authorization specification on the gateway, so clients can connect with a browser login (API keys stay).
- **REQ-SO-04** Many-tools handling: tools that search for and then execute other tools.
- **REQ-SO-05** Hosted MCP servers: an admin adds a server by container image; the platform deploys it with its own Secret, limits and NetworkPolicy and removes it cleanly.
- **REQ-SO-06** Security hardening: SSRF protection on admin-added URLs, least-privilege RBAC for components that talk to the Kubernetes API, deny-by-default NetworkPolicies, non-root containers, upstream credentials encrypted at rest.
- **REQ-SO-07** Scaling: more than one gateway replica with MCP and upstream connections working; rate limits per user or per key.
- **REQ-SO-08** Observability: metrics (tool calls, error rate, latency per server) and clear reasons why an upstream is unreachable or a call failed.
- **REQ-SO-09** Upgrades and rollback of the store, the MCP server and the gateway with Helm.

## 9. Assumptions
- **A-01** The chat agent's LLM is Groq (free tier) by default; OpenRouter free models are also supported. Both use the OpenAI-compatible chat-completions API with tool calling.
- **A-02** The two additional upstreams are `@modelcontextprotocol/server-everything` (in-cluster, Streamable HTTP) and GitHub's remote MCP server (PAT bearer credential).
- **A-03** Invites are one-time links shown to the admin; no email is sent.
- **A-04** "Today" for orders means the store's timezone (configured in WooCommerce; Asia/Kolkata since the TATVA storefront, values `store.init.timezone`).
- **A-05** Dashboard login is email + password; external MCP clients use API keys (`Authorization: Bearer <key>`).
- **A-06** The VPS is not available yet. Development is local on k3d (k3s in Docker) so the VPS step is values-only.
- **A-07** Storefront brand (Phase 9, not part of the problem statement's requirements): the current working concept is TATVA (D-015). Where `docs/PRODUCT_IMAGES.md` says "16 products", the catalogue in `docs/tatva-brand-and-products.md` (50 products) is authoritative, so images were sourced for all 50.
- **A-08** Storefront photos are used as the mock products' own images without on-site credits (user decision 2026-10-12); therefore only CC0 / Public Domain images are used. Source and licence records stay in `services/store-assets/images/manifest.json`.
- **A-09** Prices are never rounded: the store keeps two decimals (`woocommerce_price_num_decimals` = 2), so a product priced 12.50 is shown and charged ₹12.50; the tatva theme hides a zero fraction, so whole prices read ₹1,299 (not ₹1,299.00). (Before 2026-10-18 the brand import set 0 decimals and 12.50 became ₹13.)
- **A-10** The bonus (multi-store provisioning) and all nine "Other ways to stand out" items, including TLS, are required for this project (user decision 2026-10-24), although the problem statement marks them optional. They are REQ-BON-* and REQ-SO-* (§8) and Phase 11 in TASKS.md. The problem statement itself is unchanged.

## 10. Open questions
- **Q-01** VPS provider and size (needs ≥4 GB RAM). Tracked as a blocker for REL-01.
