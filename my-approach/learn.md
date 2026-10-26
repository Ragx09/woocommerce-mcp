# learn.md — my project notebook

A record of my questions about this project and the answers. The overview and glossary
come first. The Q&A log below grows with each question.
Detailed concept notes already exist in [`knowledge/`](../knowledge/CONCEPTS_INDEX.md). This file
links to them and does not repeat them.

---

## 1. Project overview (the big picture)

**What we are building** (source: [`problem-statement.md`](../problem-statement.md)):
a WooCommerce store on Kubernetes, plus a **team MCP gateway**. An admin connects MCP servers
once in a dashboard. After that, every team member can use all of those servers' tools through
**one MCP endpoint**, either from their own client (Claude Code, Cursor, Inspector) or from a
chat agent inside the dashboard.

### The four layers
| # | Layer | What it is in this repo | Code |
|---|---|---|---|
| 1 | **Store** | WordPress + WooCommerce + MariaDB, running in the cluster with persistent volumes | `charts/platform` (wordpress, mariadb, wp-init Job) |
| 2 | **WooCommerce MCP server** | Our own MCP server. It exposes products and orders as tools and talks to the WooCommerce REST API (`/wp-json/wc/v3`) with OAuth 1.0a signing | `services/woo-mcp` |
| 3 | **Gateway + dashboard** | Gateway (Fastify, Node): an MCP *client* to every upstream server and an MCP *server* toward users. It also handles auth, API keys, audit log and the REST API. The dashboard is a React UI with no secrets | `services/gateway`, `apps/dashboard` |
| 4 | **Chat agent** | An LLM tool loop inside the gateway. It calls the gateway's own `/mcp` as the logged-in user | `services/gateway` (chat module) |

Extra upstreams, needed because there must be at least 3: `everything-mcp` (in the cluster) and GitHub remote MCP (on the internet).

### How one request flows
```
MCP client (Bearer mgw_… key)
   └─► Traefik Ingress  app.<domain>/mcp
         └─► gateway  ── check key hash in Postgres, find the user and role
               ├─ split the tool name "woo__list_orders" → slug "woo" + tool "list_orders"
               ├─ inject the upstream's own credential (the client never sees it)
               └─► woo-mcp (internal only) ─► WooCommerce REST ─► MariaDB
         ◄── result, plus one audit_log row (who, server, tool, duration, outcome)
```

### Ground rules (the "why" behind most design choices)
- Everything goes through the gateway `/mcp`. Nothing else calls an upstream directly.
- API keys are stored only as hashes. Upstream credentials are encrypted at rest and never returned to anyone.
- Authorization is enforced on the server, never only in the UI.
- Every workload has probes, requests and limits. Internal services are locked down with NetworkPolicy.
- The same Helm chart is used for local k3d and the k3s VPS. Only the values files differ.

### Where to read more
| Topic | File |
|---|---|
| Requirements (authoritative) | `problem-statement.md`, `SPEC.md` |
| Components and flows | `ARCHITECTURE.md`, `docs/SYSTEM_DESIGN.md` |
| Why things were chosen | `DECISIONS.md` (D-NNN) |
| Security | `THREAT_MODEL.md` |
| Progress | `docs/PROGRESS.md`, `TASKS.md` |
| Concepts | `knowledge/*.md` |

---

## 2. Glossary
(This list grows as new terms come up in the questions.)

| Term | Meaning, and how this project uses it |
|---|---|
| **MCP** (Model Context Protocol) | A standard protocol that lets AI apps (hosts or clients) call *tools* provided by *servers*. Messages are JSON-RPC (`tools/list`, `tools/call`). |
| **Streamable HTTP** | The MCP transport over plain HTTP POST. We use it in *stateless* mode, which means no server-side session, so any replica can answer any request. |
| **Upstream** | An MCP server that the gateway connects to (woo, everything, github). |
| **Tool namespacing** | Public tool name = `<server_slug>__<tool>`, e.g. `woo__list_orders`. This avoids name collisions between servers. |
| **k3d / k3s** | k3s is a lightweight Kubernetes distribution (we use it on the VPS). k3d runs k3s inside Docker containers (we use it locally). |
| **Helm** | A templating and package manager for Kubernetes YAML. One chart plus `values-local.yaml` / `values-prod.yaml`. |
| **Ingress / Traefik** | Routes outside HTTP traffic by host and path to Services in the cluster. Traefik is the ingress controller that ships with k3s. |
| **NetworkPolicy** | A firewall rule between pods. Example: only gateway pods may reach woo-mcp. |
| **Probes** | Liveness probe: "restart me if this fails". Readiness probe: "don't send me traffic until this passes". |
| **API key hashing** | We store only SHA-256(key). Even if the database leaks, nobody can recover the keys. |
| **Audit log** | One row per tool call: user, server, tool, time, duration, outcome. Arguments are never stored. |

---

## 3. Q&A log

<!-- Each entry: ### Q<n> — <question>, then the answer, then a "Files" line. -->

### Q1 — Make one detailed study guide: every feature and page, business use, Demo/Technical switch, beginner → master

**Answer:** built as a single page: [`learn.html`](learn.html) (published as a private artifact, see the chat for the link).
- Starts in **Demo** mode (plain, business-facing). **Technical** shows the engineering detail, with a boxed explainer the first time each concept appears (about 45 concepts: JSON-RPC, AES-GCM, HMAC, SSRF, NetworkPolicy, probes, PDB, keyset pagination…). The glossary links to every box.
- Order: why it exists → building blocks → system map → store → woo-mcp tools → every dashboard page (login, invite, overview, servers, server form, chat, keys, members, audit, roles) → external clients → one request end to end → naming/aggregation → failure handling → chat internals → security (T-01…T-25) → scaling and ops → local vs VPS → test evidence and demo script → selling (personas, prompts, objections, honest roadmap) → feature recipes with exact files → 23 likely questions → decision log D-001…D-024 → glossary.
- Not built yet, so call it roadmap: VPS + TLS run (BON-07 blocked), OAuth (BON-08), hosted servers (BON-10), multi-store (BON-11…15). BON-05 hardening is in progress.

**Files:** `ARCHITECTURE.md`, `docs/MCP_DESIGN.md`, `docs/API_CONTRACTS.md`, `THREAT_MODEL.md`, `DECISIONS.md`, `services/woo-mcp/src/tools.ts`, `services/gateway/src/{auth/access.ts,chat/agent.ts,ratelimit.ts}`, `apps/dashboard/src/App.tsx`, `charts/platform/values*.yaml`.

### Q2 — Explain the chat agent loop in simple words

**Answer:** the agent is a helper that keeps asking the AI "what next?" until the AI gives a plain answer.
1. **Get the menu.** The agent connects to the gateway's own `/mcp` *as you* and calls `tools/list`, so it sees only the tools you are allowed to use. It picks the ones that best match your last 3 messages and fit a 6,000-character budget, then adds a `find_tools` search tool for anything left out (D-019).
2. **Ask the AI.** It sends the AI the instructions, the conversation and the tool menu.
3. **Look at the reply.** If the AI wrote text, that is the answer and the loop ends. If it asked for tools, the agent checks each request (valid JSON object? a real tool name?), calls it through `/mcp` (normal permission check and audit row), cuts the result to 4 KB, and adds it to the conversation.
4. **Repeat** from step 2 with the new results.

Safety stops: 8 rounds, 16 tool calls, 150 s for the whole message. One chat at a time per user (`chat_busy` 429). Tool output is treated as data, not orders (T-07). Replies that leak the system prompt are swapped for a refusal. If the LLM provider rejects bad tool arguments, it retries once with the reason (D-020).
Analogy: a manager (the AI) tells an assistant (the agent) "fetch me X". The assistant fetches it through the front desk (the gateway, which checks your badge and logs it), brings it back, and the manager either asks for more or answers you.

**Files:** `services/gateway/src/chat/agent.ts` (`runAgent`, `runTool`, `selectTools`), `chat/llm.ts` (schema retry), `chat/routes.ts` (lock, 429s).
