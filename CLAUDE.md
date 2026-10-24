# CLAUDE.md — project instructions

## Mission
Deliver the system in [`problem-statement.md`](problem-statement.md): WooCommerce on Kubernetes, a self-written WooCommerce MCP server, a team MCP gateway (dashboard, API keys, audit) and a chat agent. The same Helm charts must deploy to local k3d and to a k3s VPS.
**Deadline: 7 days, 2026-10-11 → 2026-10-17.** Get a working, secure, demonstrable core done before anything else, then the bonus and stand-out items (required since 2026-10-24).

`problem-statement.md` is the **authoritative** source. Never change or drop its requirements. If something there is ambiguous, write the assumption into `SPEC.md` § Assumptions.

## Start of every session
1. Read `docs/PROGRESS.md` (latest handover), then the relevant phase in `TASKS.md`.
2. Check `git status` before changing anything.
3. Pick the **lowest-numbered task that is Not Started or In Progress and whose dependencies are Done**. P0 tasks come before P1–P3. The bonus and all stand-out items are **required** since 2026-10-24 (user decision, SPEC A-10, Phase 11 `BON-*`); start them after the P0 release tasks up to REL-15.

## Per-task workflow
1. Restate the goal, the concepts involved (explain them briefly; this project is also for learning), the files touched, the acceptance criteria and the test commands.
2. Implement the smallest complete change.
3. Run the task's tests and commands and **read the actual output**. Fix failures.
4. Review the diff for security issues, error handling and side effects.
5. Update `TASKS.md`: set Status and paste **evidence** (command + key output lines). A task is never Done without evidence. If it is blocked, mark it Blocked with the reason.
6. Update affected docs: `docs/REQUIREMENTS_TRACEABILITY.md`, `ARCHITECTURE.md`, `docs/API_CONTRACTS.md`, `docs/MCP_DESIGN.md`, `DECISIONS.md`, `THREAT_MODEL.md`, `knowledge/*`.
7. Update `docs/PROGRESS.md` (current task, next task, blockers).
8. Run `npm run tracker` to regenerate `tracker/data.js`, then commit.
9. Report what changed, what was verified, what is still open, and the next task. Stop at major checkpoints, architecture changes, destructive operations and scope changes.

## Non-negotiable rules
- Never claim something works without evidence. Never invent test results or files.
- No secrets in git, logs, docs, browser bundles or API responses. Secrets live in K8s Secrets and the gitignored `.env`.
- Dashboard chat and external MCP clients **always** go through the gateway `/mcp`. Nothing else calls upstream MCP servers.
- Enforce authorization on the server (gateway/API), never only in the UI.
- Do not weaken auth to make a demo pass.
- API keys are stored as hashes. Upstream credentials are encrypted at rest and never returned or forwarded.
- Every workload has probes, requests and limits. Internal services stay internal (NetworkPolicy).

## Conventions
- Monorepo: `services/woo-mcp`, `services/gateway`, `apps/dashboard`, `charts/`, `scripts/`, `tests/e2e/`. TypeScript, Node 24, npm workspaces, vitest.
- MCP: `@modelcontextprotocol/sdk` v1.x, Streamable HTTP, stateless. Gateway tool names are `<server_slug>__<tool>` (see `docs/MCP_DESIGN.md`).
- Requirement IDs `REQ-*`, task IDs (`P0-`, `ARC-`, `INF-`, `WC-`, `GW-`, `AUTH-`, `UI-`, `E2E-`, `REL-`, `BRD-` storefront brand, `SEC-` security testing, `BON-` bonus and stand-out), test IDs `TC-<task>-<n>`.
- Keep the Markdown formats the tracker parses: task headings `### ID — Title` + `- **Field:** value` bullets, traceability as one table, decisions as `## D-NNN — Title`.

## Document map
| File | Purpose |
|---|---|
| `SPEC.md` | product spec, requirement IDs, assumptions |
| `ARCHITECTURE.md` | components, flows, K8s topology |
| `TASKS.md` | roadmap and task status (source of truth for progress) |
| `TEST_PLAN.md` | test strategy and suites |
| `DECISIONS.md` | architecture decision log |
| `THREAT_MODEL.md` | security model |
| `docs/SECURITY_TESTING.md`, `docs/SECURITY_FINDINGS.md`, `docs/RED_TEAM_BRIEF.md` | Phase 10 rules of engagement, findings log, attacker-LLM brief |
| `brand/` | Storefront brand material (Phase 9; current working concept TATVA, may change) |
| `docs/PROGRESS.md` | latest handover summary |
| `docs/REQUIREMENTS_TRACEABILITY.md` | requirement → task → test → evidence |
| `docs/VPS.md` | VPS specs, facts, setup plan and running log (append on every VPS change) |
| `docs/API_CONTRACTS.md`, `docs/MCP_DESIGN.md`, `docs/DEPLOYMENT.md`, `docs/DEMO_RUNBOOK.md` | engineering details |
| `knowledge/` | learning notes (`CONCEPTS_INDEX.md` first) |
| `tracker/index.html` | visual project tracker (`npm run tracker` to refresh) |
