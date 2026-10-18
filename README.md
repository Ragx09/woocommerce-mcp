# WooCommerce Hosting + Team MCP Gateway

A WooCommerce store on Kubernetes, a self-written WooCommerce MCP server, and a **team MCP gateway**. An admin registers MCP servers once; every team member then uses all of them through one MCP endpoint (with a personal API key) or through a chat agent in the dashboard. Every call is audited.

> **Status:** planning complete, implementation starting (see [`docs/PROGRESS.md`](docs/PROGRESS.md) and the visual tracker at [`tracker/index.html`](tracker/index.html)).
> Requirements: [`problem-statement.md`](problem-statement.md) · Spec: [`SPEC.md`](SPEC.md) · Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Project tracker
```bash
npm run tracker            # regenerate tracker/data.js from the Markdown docs
# then open tracker/index.html in a browser (works from the file system)
```

## Local setup
Prerequisites: Docker (Desktop) running, `kubectl`, `helm` v3, `k3d` v5, Node 24, and a `.env` copied from `.env.example` (gitignored; see the comments in it). From the repository root:

```bash
scripts/up.sh            # create/start the k3d cluster, Secrets, build + import images, helm install, wait (~5–6 min first time, ~1 min after)
k3d cluster stop mcp     # pause (keeps all data); `k3d cluster start mcp` or `scripts/up.sh` to resume
scripts/down.sh          # remove the release, keep cluster, Secrets and data
scripts/down.sh --all    # delete the cluster and ALL data
```
`up.sh` is safe to re-run: existing Secrets are kept, and unchanged code gives the same image tag, so nothing restarts. After code changes: `SERVICES=gateway scripts/build-images.sh && scripts/deploy.sh local` (or `SERVICES=dashboard`, …). Dashboard development with hot reload against k3d: `npm run dev -w apps/dashboard` (proxies `/api` to the cluster).

| What | URL |
|---|---|
| Storefront | http://store.127.0.0.1.nip.io |
| WP admin (user `admin`) | http://store.127.0.0.1.nip.io/wp-admin — password: `kubectl -n store get secret wordpress-admin -o jsonpath='{.data.admin-password}' \| base64 -d` |
| Dashboard | http://app.127.0.0.1.nip.io — admin `admin@example.invalid`, password: `kubectl -n platform get secret gateway-admin -o jsonpath='{.data.admin-password}' \| base64 -d` |
| Gateway MCP endpoint | http://app.127.0.0.1.nip.io/mcp — personal API key: `node scripts/lib/gateway-key.mjs create my-laptop` (prints `<id> <key>`; see docs/DEPLOYMENT.md) |

More detail: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Full instructions are finished in REL-12.

## VPS (k3s) setup
_To be written in REL-12._

## Using the system

### Demo users (A and B)
`node scripts/seed-demo-users.mjs --key` makes sure user **A** (the seeded admin, Secret `platform/gateway-admin`) and user **B** (a member, invited and accepted through the normal flow; password in Secret `platform/demo-users`) exist, and prints a fresh API key for B **once**. Any user can also create their own key in the dashboard → **API keys**. Keys are shown once and stored only as a hash.

### Connect an external MCP client
All a client needs is the gateway URL and a personal key. Local k3d: `http://app.127.0.0.1.nip.io/mcp` (works from WSL and from Windows, nip.io resolves to 127.0.0.1); VPS: `https://app.<domain>/mcp`. Transport: Streamable HTTP. Every tool is named `<server>__<tool>` (e.g. `woo__list_orders`, `github__get_me`).

**Claude Code**
```bash
claude mcp add --transport http mcp-gateway http://app.127.0.0.1.nip.io/mcp \
  --header "Authorization: Bearer mgw_…your key…"
claude mcp list                     # mcp-gateway … ✔ Connected
claude                              # then ask: "What orders came in today in the store?"
```
Or without changing your Claude Code config, with a file (keep it out of git, it holds the key):
```json
{ "mcpServers": { "mcp-gateway": { "type": "http", "url": "http://app.127.0.0.1.nip.io/mcp",
    "headers": { "Authorization": "Bearer mgw_…your key…" } } } }
```
`claude --mcp-config gateway.json --strict-mcp-config`

**Cursor** — `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), then Settings → MCP shows the tools:
```json
{ "mcpServers": { "mcp-gateway": { "url": "http://app.127.0.0.1.nip.io/mcp",
    "headers": { "Authorization": "Bearer mgw_…your key…" } } } }
```

**MCP Inspector**
```bash
# UI: choose Transport "Streamable HTTP", URL as above, add header Authorization: Bearer mgw_…
npx @modelcontextprotocol/inspector@2.10.1
# CLI:
npx @modelcontextprotocol/inspector@2.10.1 --cli http://app.127.0.0.1.nip.io/mcp --transport http \
  --header "Authorization: Bearer mgw_…" --method tools/list
npx @modelcontextprotocol/inspector@2.10.1 --cli http://app.127.0.0.1.nip.io/mcp --transport http \
  --header "Authorization: Bearer mgw_…" --method tools/call --tool-name woo__list_orders --tool-arg date=today
```
Without a key, or with a revoked key, `/mcp` answers 401. Disabled servers' tools are not listed. Every call is in the dashboard → **Audit log** under your name.

### Chat agent
Dashboard → **Chat** (signed in as any user). Try "Create a product called Demo Mug priced 499" and "What orders came in today?". The chat uses the same gateway `/mcp` with your identity; its calls are audited with source `chat`.

### Acceptance checks
`scripts/e2e.sh all` runs every automatable Definition-of-Done check (chat flow with the real LLM, A/B users, external key, revoke, disable, kill pod, audit attribution) and prints PASS/FAIL lines; `GITHUB_REPO=owner/repo` adds the cross-server GitHub issue. Manual steps: [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md).

## Documentation
| Doc | Purpose |
|---|---|
| [SPEC.md](SPEC.md) | requirements with IDs |
| [ARCHITECTURE.md](ARCHITECTURE.md) | components and flows |
| [DECISIONS.md](DECISIONS.md) | decision log |
| [THREAT_MODEL.md](THREAT_MODEL.md) | security model |
| [TEST_PLAN.md](TEST_PLAN.md) | test strategy |
| [TASKS.md](TASKS.md) | roadmap and status |
| [docs/](docs) | MCP design, API contracts, deployment, demo runbook, traceability, security testing ([rules](docs/SECURITY_TESTING.md), [findings](docs/SECURITY_FINDINGS.md), [red-team brief](docs/RED_TEAM_BRIEF.md)) |
| [brand/](brand) | Storefront brand material (current working concept: TATVA) |
| [knowledge/](knowledge) | learning notes |

## Bonus / stand-out items attempted
_None yet._
