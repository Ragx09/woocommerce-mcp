# My approach: how this project was built

This folder is about the **process**, not the product. The product is described in the [main README](../README.md). Here I explain how I worked, how I used AI coding agents, and what I did to keep them honest.

## In short
- I treated the problem statement as a contract and turned it into numbered requirements, tasks and tests **before** writing code.
- I used an AI coding agent (Claude Code) as the main implementer, under a written set of rules ([`CLAUDE.md`](../CLAUDE.md)) that made it prove its work instead of just claiming it.
- I kept the decisions that cost money, change the architecture or cannot be undone for myself.
- Every number below comes from a command run on this repository, not from memory.

## How I worked

### 1. Spec first
`problem-statement.md` is the authoritative source and is never edited. From it I wrote [`SPEC.md`](../SPEC.md) with requirement IDs (`REQ-*`, **83** in the traceability matrix), and where the statement was ambiguous I wrote the assumption into SPEC § Assumptions instead of guessing silently. [`docs/REQUIREMENTS_TRACEABILITY.md`](../docs/REQUIREMENTS_TRACEABILITY.md) maps each requirement to a task, a test and the evidence.

### 2. Tasks with acceptance criteria
[`TASKS.md`](../TASKS.md) is the source of truth for progress: **174 tasks** in 12 phases (infra, WooCommerce MCP, gateway, auth, dashboard, end-to-end, release, brand, security testing, bonus). Each task has a goal, acceptance criteria, test IDs (`TC-<task>-<n>`) and an evidence field. A task is never Done without evidence: the command that was run and the key lines of its output. Today **162 are Done**; the rest are listed under [Honest limits](#honest-limits).

### 3. One small, complete change at a time
The per-task loop is written in `CLAUDE.md`: restate the goal and the concepts involved, implement the smallest complete change, run the tests and read the real output, review the diff for security and side effects, then update the docs, the handover note ([`docs/PROGRESS.md`](../docs/PROGRESS.md)) and the tracker, and commit.

### 4. Decisions are written down
**30 architecture decisions** are logged in [`DECISIONS.md`](../DECISIONS.md), each with the choice and the reason (for example D-023: images streamed into k3s's containerd instead of running a registry; D-026: a provisioner is the only component with Kubernetes rights). When I changed my mind, the old decision was rewritten, not silently overridden.

### 5. The project doubles as a learning project
I wanted to understand what I was shipping, so each task starts with a short explanation of the concepts involved, and [`knowledge/`](../knowledge/CONCEPTS_INDEX.md) holds the notes (MCP, Kubernetes and Helm, backend security, testing). My question-and-answer notebook is [`learn.md`](learn.md) here.

## How I used AI agents

| Who | What |
|---|---|
| **The agent** (Claude Code) | Wrote most of the TypeScript, Helm charts and scripts; ran the tests; kept the docs, traceability matrix and tracker in sync; drafted the threat model and the security report; ran the browser scripts that produced the screenshots. |
| **Me** | Chose the architecture and scope; set the rules the agent works under; decided when something was done; decided every step that spends money (the VPS) or cannot be undone; reviewed the diffs that touch authentication, credentials or the cluster. |

What made this work, concretely:

1. **A standing contract.** [`CLAUDE.md`](../CLAUDE.md) is read at the start of every session. It states the mission, the per-task workflow and the non-negotiable rules: no secrets in git, logs or bundles; authorization enforced on the server, never only in the UI; API keys stored as hashes; upstream credentials encrypted and never returned; every workload with probes and limits; auth never weakened to make a demo pass.
2. **Evidence or it did not happen.** "Never claim something works without evidence" is rule one. Test output is pasted into TASKS. When a check could not run (no cluster in a sandbox, no VPS), the task says so and stays In Progress or Blocked rather than being rounded up to Done.
3. **Handover between sessions.** Agents have no memory between sessions, so [`docs/PROGRESS.md`](../docs/PROGRESS.md) records the current task, the next task, the blockers and the exact commands to run next. Standing preferences (for example *ask before starting the paid VM*) live in the agent's memory and in `CLAUDE.md`.
4. **Docs that cannot drift quietly.** `scripts/check-docs.sh` fails when the README, runbook, threat model or traceability matrix disagree with each other, and `npm run tracker` regenerates a visual progress board from the Markdown (the formats it parses are part of the contract).
5. **The agent attacks its own work.** Phase 10 is security testing: static analysis (npm audit, gitleaks, semgrep, hadolint, kube-linter, kubeconform), live attack suites, a hostile-upstream harness, Trivy and kubescape, and an attacker-LLM brief ([`docs/RED_TEAM_BRIEF.md`](../docs/RED_TEAM_BRIEF.md)). Findings go to [`docs/SECURITY_FINDINGS.md`](../docs/SECURITY_FINDINGS.md) (42 rows) and each is fixed or accepted with a reason. One real example: the credential encryption accepted truncated GCM tags (F-CRY-1); it was found by this testing, fixed in three places and covered by a test.
6. **Mistakes were caught by running things, not by reading them.** Examples recorded in the repo: the login rate limit became a global lockout because the ingress hid client IPs (fixed with Traefik `externalTrafficPolicy: Local`); a store-assets image missing its registry prefix; a metrics check that read only one of two replicas. And while preparing the VPS run, a read-through of `vps-setup/up.sh` showed it never uploaded the provisioner image to the VM, which would have broken the Stores feature there; fixed before any money was spent.

### Where I did not hand over control
- **Money:** the VPS is billed by the hour from my own credit. The agent may run read-only `jl status`, but never creates, resumes or starts the VM without a fresh yes from me each time.
- **Commits:** I decide what is committed; commit messages carry no agent trailers.
- **Scope:** a requirement in the problem statement is never dropped or weakened; changes to scope were mine (for example making the bonus and stand-out items required from 2026-10-24).

## Numbers (measured 2026-10-26)
| What | Value | Command |
|---|---|---|
| Commits | 97, on 12 different days (2026-10-11 → 2026-10-26) | `git rev-list --count HEAD` |
| Tasks Done / total | 162 / 174 | tracker data (`npm run tracker`) |
| Requirements in the matrix | 83 | tracker data |
| Architecture decisions | 30 | `grep -c '^## D-' DECISIONS.md` |
| Source lines (TypeScript, `src/`) | gateway 5,859 · dashboard 2,461 · provisioner 846 · woo-mcp 532 | `find … -name '*.ts*' \| xargs cat \| wc -l` |
| Unit tests | woo-mcp 30 · gateway 122 · dashboard 30, all passing | `npm test` in each workspace |
| Helm charts | 3 (`platform`, `store`, `hosted`) | `ls charts` |
| Security findings logged | 42 rows | `grep -c '^| F-' docs/SECURITY_FINDINGS.md` |

Integration, acceptance and security suites run against a live cluster and are not part of the unit-test count; their results are recorded as evidence in `TASKS.md` and under `docs/evidence/`.

## Honest limits
These are the 12 tasks that are not Done (from the tracker):
- **Needs the VPS, which has not been run yet:** P0-03 (confirm VPS availability, Blocked), REL-01 (k3s on the VPS, Blocked), REL-03 (same-chart install), REL-04 (TLS with cert-manager, In Progress), REL-05 (persistence), REL-06 (secrets), SEC-07 (security headers, cookies and TLS, Blocked) and BON-07 (VPS deployment with TLS, Blocked). Everything is scripted in [`vps-setup/`](../vps-setup/VPS.md) and rehearsed on a clean local cluster, but not proven on a real VPS.
- **Final steps:** REL-15 (demo rehearsal), REL-16 (record the demo video) and REL-17 (repository check and submission), plus E2E-14 (scripted acceptance suite, In Progress: the scripted part passes on k3d, but the manual client steps and the cross-server GitHub check are not all recorded).

The system as a whole is verified on local k3d, not on a VPS. I would rather state that than imply otherwise.

## What is in this folder
| File | What it is |
|---|---|
| [`learn.md`](learn.md) | My project notebook: overview, glossary and the questions I asked while building, with answers |
| [`learn.html`](learn.html) | The same overview as a single illustrated page |

The design, security and operations documents stay where the tooling expects them: the [main README](../README.md#documentation) has the full map.
