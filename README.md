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
_To be written in INF-15 / REL-12._

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
