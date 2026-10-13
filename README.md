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
`up.sh` is safe to re-run: existing Secrets are kept, and unchanged code gives the same image tag, so nothing restarts. After code changes: `SERVICES=gateway scripts/build-images.sh && scripts/deploy.sh local`.

| What | URL |
|---|---|
| Storefront | http://store.127.0.0.1.nip.io |
| WP admin (user `admin`) | http://store.127.0.0.1.nip.io/wp-admin — password: `kubectl -n store get secret wordpress-admin -o jsonpath='{.data.admin-password}' \| base64 -d` |
| Gateway MCP endpoint | http://app.127.0.0.1.nip.io/mcp — personal API key: `node scripts/lib/gateway-key.mjs create my-laptop` (prints `<id> <key>`; see docs/DEPLOYMENT.md) |

More detail: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Full instructions are finished in REL-12.

## VPS (k3s) setup
_To be written in REL-12._

## Using the system
_Placing an order, connecting Claude Code / Cursor / MCP Inspector, using the chat agent: to be written in E2E-02 / REL-12._

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
