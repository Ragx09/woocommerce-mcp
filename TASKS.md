# TASKS — Implementation Roadmap

Source of truth for progress. Rules: see `CLAUDE.md`. **Never set Status to Done without Evidence.** Statuses: `Not Started` · `In Progress` · `Blocked` · `Done`. Priorities: P0 mandatory/blocker · P1 correctness/security/resilience · P2 usability/ops · P3 optional.

Field format (parsed by `tracker/build.mjs`; keep it): `### ID — Title` followed by `- **Field:** value` bullets. Test cases are written `TC-<ID>-<n>: precondition → action → expected`.

## Schedule
| Day | Date | Focus | Exit gate |
|---|---|---|---|
| 1 | 2026-10-11 | Phase 0 + Phase 1: docs, tracker, tooling, 3 experiments | Experiments pass, plan agreed |
| 2 | 2026-10-12 | Phase 2 infra + Phase 3 store & woo-mcp + gateway passthrough | Vertical slice: Inspector → gateway → woo-mcp → WooCommerce |
| 3 | 2026-10-13 | Phase 4 gateway: aggregation, 3 upstreams, timeouts, health + Phase 9 storefront brand (niche, logo, theme, UI, catalogue; parallel, P2) | GW exit criterion; branded store if time allows |
| 4 | 2026-10-14 | Phase 5 auth, keys, audit (+ VPS provisioning if available) | Revocation + audit tests pass |
| 5 | 2026-10-15 | Phase 6 dashboard + chat agent | Chat creates a product end-to-end |
| 6 | 2026-10-16 | Phase 7 E2E + Phase 8 VPS deploy + security fixes + Phase 10 scans (SEC-01..06) | All DoD checks pass locally (+ VPS) |
| 7 | 2026-10-17 | Phase 8: docs, regression, rehearsal, video, submission + Phase 10 attacker-LLM loop (SEC-07..09, continues after submission) | Submitted |

Cut order if behind: brand polish (Phase 9) → UI polish → depth of docs. Mandatory items are never cut. Since 2026-10-24 the bonus and stand-out items (Phase 11) and TLS are required too (SPEC A-10); Days 15–20 continue past this table.

---

## Phase 0 — Repository assessment and requirements
Exit criterion: scope and environment understood; initial plan reviewed.

### P0-01 — Move repo to Linux FS, init git, create GitHub repo
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** —
- **Requirements:** REQ-DEL-04, REQ-DEL-10
- **Description:** Copy the brief to `~/projects/woocommerce-mcp` (fast FS), `git init -b main`, `.gitignore`, first commit, create a GitHub repo (needs user confirmation: public or private).
- **Output:** Local git repo with initial commit; GitHub remote.
- **Acceptance:** `git log` shows the initial commit; `git remote -v` points to GitHub; `.env` ignored.
- **Tests:** TC-P0-01-1: repo exists → `git status` → clean tree. TC-P0-01-2: create `.env` → `git check-ignore .env` → ignored.
- **Command:** `git -C ~/projects/woocommerce-mcp status && git check-ignore .env`
- **Evidence:** 2026-10-11: TC-P0-01-1 PASS — `git status -sb` → `## main...origin/main`, clean; remote `origin https://github.com/Ragx09/woocommerce-mcp.git` (created with `gh repo create --private`, initial commit pushed). TC-P0-01-2 PASS — `git check-ignore -v .env` → `.gitignore:5:.env`. Pre-push secret scan (`git grep` for gsk_/sk-/ghp_/github_pat_/AKIA/BEGIN key patterns) → no matches. Repo is **private**; make it public or add reviewers at submission (REL-17).
- **Regression risk:** Low.

### P0-02 — Install helm and k3d
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** —
- **Requirements:** REQ-K8S-01, REQ-K8S-03
- **Description:** Install pinned `helm` v3 and `k3d` binaries into `~/.local/bin`; create a throwaway cluster to confirm Docker integration.
- **Output:** Working `helm`, `k3d`; documented versions in `docs/DEPLOYMENT.md`.
- **Acceptance:** `helm version`, `k3d version` succeed; `k3d cluster create smoke` → `kubectl get nodes` Ready → deleted.
- **Tests:** TC-P0-02-1: tools installed → `k3d cluster create smoke --wait` → node Ready.
- **Command:** `helm version && k3d version && k3d cluster create smoke --wait && kubectl get nodes && k3d cluster delete smoke`
- **Evidence:** 2026-10-11: helm v3.22.0 (sha256 verified against get.helm.sh) and k3d v5.9.0 (sha256 verified against release checksums.txt) installed to `~/.local/bin`. TC-P0-02-1 PASS — `k3d cluster create smoke --wait -p 18080:80@loadbalancer` → node `k3d-smoke-server-0` Ready, k3s v1.35.5+k3s1, StorageClass `local-path (default)`, Traefik rolled out. Extra checks: Ingress `smoke.127.0.0.1.nip.io:18080` → whoami response from pod (nip.io + Traefik work from host); NetworkPolicy test → unlabelled busybox pod BLOCKED, `role=allowed` pod REACHABLE (k3s enforces NetworkPolicy on k3d, closes R7). Cluster deleted afterwards. Helm 4 exists (v4.3.0); v3.22 kept per D-010 — charts use apiVersion v2 and work on both.
- **Regression risk:** Low.

### P0-03 — Confirm VPS availability
- **Priority:** P0
- **Status:** Blocked
- **Day:** 4
- **Depends on:** —
- **Requirements:** REQ-K8S-02
- **Description:** User provisions a VPS / free tier (≥4 GB RAM, Ubuntu LTS, ports 80/443 open). Record provider, size and SSH alias (not secrets). Preparation done: `vps-setup/preflight.sh` (read-only capability check, moved from `scripts/vps-preflight.sh` 2026-10-24) and `vps-setup/install-k3s.sh` (k3s pinned to the local k3d version, API via SSH tunnel).
- **Output:** SSH access confirmed; facts recorded in `docs/DEPLOYMENT.md`.
- **Acceptance:** `vps-setup/preflight.sh` run on the VPS exits 0 (RAM ≥3.8 GB, ≥2 CPU, ≥20 GB disk, amd64/arm64, systemd, 80/443 free, outbound HTTPS).
- **Tests:** TC-P0-03-1: VPS exists → ssh command → prints specs.
- **Command:** `vps-setup/up.sh` (runs the preflight) or `ssh <alias> 'bash -s' < vps-setup/preflight.sh`
- **Evidence:** 2026-10-24: provider chosen — JarvisLabs CPU VM 4 vCPU / 16 GB / 100 GB (2026-10-25: changed to 2 vCPU / 8 GB, demo with 2 stores in total; credits ₹500 added, SSH key + Security Group done), on-demand, destroyed between sessions (`vps-setup/VPS.md` §2). `jl` 0.2.17 installed, key `~/.ssh/jarvis_vps` created; waiting for account credits. Blocked: no VPS yet (user will obtain one; decision 2026-10-11). 2026-10-11: preflight script syntax-checked and dry-run on the local WSL host (exit 0) — this proves the script works, not the VPS. Provider guidance in `docs/DEPLOYMENT.md` §5.
- **Regression risk:** High schedule risk if it slips past Day 5.

### P0-04 — Obtain LLM and GitHub credentials
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-01
- **Requirements:** REQ-CHAT-01, REQ-CHAT-04, REQ-GW-08
- **Description:** User creates a Groq API key (+ optional OpenRouter key) and a fine-grained GitHub PAT (one throwaway repo, Issues read/write). Stored only in the gitignored `.env`.
- **Output:** `.env` with keys (never printed or committed).
- **Acceptance:** `.env` exists, ignored; a smoke request to Groq chat completions with a tool definition returns a `tool_calls` response.
- **Tests:** TC-P0-04-1: key present → `scripts/llm-smoke.mjs` → response contains tool_calls.
- **Command:** `node scripts/llm-smoke.mjs groq` (or `openrouter`)
- **Evidence:** 2026-10-11: `.env` present, gitignored, mode 600; format check (no values printed): `LLM_API_KEY` set (gsk_ prefix), `OPENROUTER_API_KEY` empty (optional), `GITHUB_MCP_PAT` empty. TC-P0-04-1 PASS — `node scripts/llm-smoke.mjs groq` → HTTP 200 in 652 ms, `finish_reason=tool_calls`, `woo__list_orders {"after":"2026-10-11T00:00:00Z","status":"processing"}`. Groq `/models` lists `openai/gpt-oss-120b` (also gpt-oss-20b, qwen3.8-27b); free tier limit 1000 requests/day. 2026-10-12: `GITHUB_MCP_PAT` added by the user (fine-grained `github_pat_…`, value never printed); verified in ARC-15 (`get_me` → account Ragx09); copied into Secret `platform/upstream-seed` via `scripts/make-secrets.sh --rotate platform/upstream-seed` (`github-pat` 93 bytes, `woo-token` unchanged). `.env` had CRLF line endings (trailing `\r` on every value) → converted to LF, mode 600 kept. OpenRouter key optional.
- **Regression risk:** Free-tier limits.

### P0-05 — Extract requirement IDs
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** —
- **Requirements:** all
- **Description:** Restate every requirement of `problem-statement.md` with a unique ID in `SPEC.md`.
- **Output:** `SPEC.md` §4–7.
- **Acceptance:** Every bullet of the brief's Requirements, User stories, Definition of done and Deliverables maps to ≥1 REQ ID.
- **Tests:** TC-P0-05-1: manual side-by-side review of the brief vs SPEC → no unmapped bullet.
- **Command:** `grep -c '^- \*\*REQ-' SPEC.md`
- **Evidence:** 2026-10-11: SPEC.md written with 66 REQ IDs (STORE 3, MCP 9, GW 12, AUTH 7, CHAT 4, K8S 9, DOD 12, DEL 10); `grep -c` → 66 in SPEC and 66 rows in traceability; reviewed against the brief section by section.
- **Regression risk:** Low.

### P0-06 — Classify mandatory vs bonus
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-05
- **Requirements:** all
- **Description:** Separate mandatory scope from bonus and stand-out items; note which cheap hardening items are pulled into core as P1.
- **Output:** `SPEC.md` §8; Bonus section in this file.
- **Acceptance:** No bonus item is P0; every mandatory item has a P0/P1 task.
- **Tests:** TC-P0-06-1: review → no P3 task maps to a mandatory REQ.
- **Command:** manual review
- **Evidence:** 2026-10-11: SPEC §8 + Bonus section below.
- **Regression risk:** Low.

### P0-07 — Requirements traceability matrix
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-05
- **Requirements:** all
- **Description:** Map every REQ to component, tasks, tests, status and evidence.
- **Output:** `docs/REQUIREMENTS_TRACEABILITY.md`.
- **Acceptance:** Every REQ ID in SPEC appears exactly once in the matrix with ≥1 task and ≥1 test.
- **Tests:** TC-P0-07-1: tracker build reports 0 unmapped requirements.
- **Command:** `npm run tracker` (prints coverage summary)
- **Evidence:** 2026-10-11: matrix created; tracker coverage check reports all REQs mapped (see P0-11 evidence).
- **Regression risk:** Must be kept updated as tasks finish.

### P0-08 — Risk register
- **Priority:** P1
- **Status:** Done
- **Day:** 1
- **Depends on:** —
- **Requirements:** —
- **Description:** List the top technical and schedule risks with mitigations and the experiments that retire them.
- **Output:** `docs/PROGRESS.md` § Risks.
- **Acceptance:** Each risk has an owner task.
- **Tests:** n/a (document)
- **Command:** —
- **Evidence:** 2026-10-11: 7 risks recorded in PROGRESS.md.
- **Regression risk:** —

### P0-09 — Technology decisions
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-05
- **Requirements:** —
- **Description:** Record D-001…D-013 with options and trade-offs; validation pending for D-002, D-003 and D-013.
- **Output:** `DECISIONS.md`.
- **Acceptance:** Each decision lists options, choice, why and trade-offs.
- **Tests:** n/a
- **Command:** —
- **Evidence:** 2026-10-11: DECISIONS.md D-001…D-013 (status Proposed).
- **Regression risk:** —

### P0-10 — Documentation skeletons
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-05
- **Requirements:** REQ-DEL-01..08
- **Description:** Create CLAUDE.md, SPEC, ARCHITECTURE, TASKS, TEST_PLAN, DECISIONS, THREAT_MODEL, README, docs/*, knowledge/*.
- **Output:** Files present with initial content.
- **Acceptance:** All files listed in CLAUDE.md exist.
- **Tests:** TC-P0-10-1: `ls` each documented path → all exist.
- **Command:** `ls CLAUDE.md SPEC.md ARCHITECTURE.md TASKS.md TEST_PLAN.md DECISIONS.md THREAT_MODEL.md README.md docs knowledge`
- **Evidence:** 2026-10-11: all files created (see first commit).
- **Regression risk:** —

### P0-11 — Project tracker
- **Priority:** P2
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-10
- **Requirements:** —
- **Description:** `tracker/build.mjs` parses the Markdown files into `tracker/data.js`; `tracker/index.html` shows overview, status, timeline, tasks, requirement coverage, DoD, decisions and learning. Works from file://.
- **Output:** `tracker/` folder; `npm run tracker`.
- **Acceptance:** Build prints counts that match `grep -c '^### ' TASKS.md`; HTML renders with no console errors.
- **Tests:** TC-P0-11-1: run build → task count equals grep count. TC-P0-11-2: open index.html → all tabs render.
- **Command:** `npm run tracker`
- **Evidence:** 2026-10-11: `npm run tracker` → "tasks: 140 … requirements: 66 verified: 0 with gaps: 0 unmapped in SPEC: 0", no warnings; `grep -c '^### ' TASKS.md` → 140 (TC-P0-11-1 pass). Headless Chromium (Playwright 1.64 Docker image) loaded all 9 tabs at 1280px and 390px: 0 console/page errors, no horizontal page scroll, Mermaid diagrams rendered (TC-P0-11-2 pass); doc links resolve inside the Docs tab.
- **Regression risk:** Markdown format drift breaks parsing; build warns on unparsed tasks.

### P0-12 — Plan review checkpoint
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-01, P0-02, P0-05..P0-11
- **Requirements:** —
- **Description:** Present the assessment, experiment results and roadmap to the user for approval before Phase 2.
- **Output:** User approval noted in PROGRESS.md.
- **Acceptance:** Explicit user go-ahead.
- **Tests:** n/a
- **Command:** —
- **Evidence:** 2026-10-11: checkpoint presented; user go-ahead ("Do P0-01,02,03,12"). ARC-13/14/15 were not run before the checkpoint; they remain the next tasks and still gate WC-03, WC-06, GW-04 and GW-13 directly, so no gate is weakened. P0-03 (VPS) and P0-04 (credentials) stay open as tracked blockers.
- **Regression risk:** —

---

## Phase 1 — Architecture and technical validation
Exit criterion: architecture agreed; critical assumptions validated by experiments.

### ARC-01 — Component diagram
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-09
- **Requirements:** REQ-DEL-06
- **Description:** Mermaid component diagram with all workloads, namespaces and external parties.
- **Output:** `ARCHITECTURE.md` §2.
- **Acceptance:** Every component in SPEC appears; arrows show the call direction.
- **Tests:** TC-ARC-01-1: diagram renders in the tracker.
- **Command:** `npm run tracker`
- **Evidence:** 2026-10-11: ARCHITECTURE.md §2.
- **Regression risk:** Keep it updated.

### ARC-02 — Network boundaries
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** ARC-01
- **Requirements:** REQ-MCP-08, REQ-K8S-06
- **Description:** Define the public vs internal table and the NetworkPolicy matrix.
- **Output:** `ARCHITECTURE.md` §3.
- **Acceptance:** Every Service is classified.
- **Tests:** Verified later by TC-SEC-02/03.
- **Command:** —
- **Evidence:** 2026-10-11: ARCHITECTURE.md §3.
- **Regression risk:** —

### ARC-03 — Roles and permissions matrix
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** —
- **Requirements:** REQ-AUTH-01
- **Description:** Admin/member capabilities.
- **Output:** `SPEC.md` §2; API route → role mapping in `docs/API_CONTRACTS.md`.
- **Acceptance:** Every planned route has a role.
- **Tests:** Verified later by TC-AUTH-02.
- **Command:** —
- **Evidence:** 2026-10-11: SPEC §2, API_CONTRACTS route table.
- **Regression risk:** —

### ARC-04 — Tool discovery design
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** ARC-01
- **Requirements:** REQ-GW-02, REQ-GW-05
- **Description:** Fan-out list, cache and health loop.
- **Output:** `docs/MCP_DESIGN.md` §4.
- **Acceptance:** Behaviour defined for enabled, disabled, slow and dead upstreams.
- **Tests:** TC-INT-02..05 (later).
- **Command:** —
- **Evidence:** 2026-10-11: MCP_DESIGN §4.
- **Regression risk:** —

### ARC-05 — Routing design
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** ARC-06
- **Requirements:** REQ-GW-03
- **Description:** Name parsing → upstream lookup → checks → forward.
- **Output:** `docs/MCP_DESIGN.md` §5.
- **Acceptance:** Error codes defined for unknown, disabled and unreachable.
- **Tests:** TC-UNIT-01 (later).
- **Command:** —
- **Evidence:** 2026-10-11: MCP_DESIGN §5.
- **Regression risk:** —

### ARC-06 — Collision policy
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** —
- **Requirements:** REQ-GW-04
- **Description:** `slug__tool` always; length rule.
- **Output:** D-005, MCP_DESIGN §3.
- **Acceptance:** Deterministic and documented.
- **Tests:** TC-UNIT-01.
- **Command:** —
- **Evidence:** 2026-10-11: D-005.
- **Regression risk:** —

### ARC-07 — API key lifecycle
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** —
- **Requirements:** REQ-AUTH-03..05
- **Description:** Format, hashing, show-once, revocation, last_used.
- **Output:** D-008, MCP_DESIGN §8.
- **Acceptance:** Issue, validate and revoke are all specified.
- **Tests:** TC-UNIT-02, TC-AUTH-01.
- **Command:** —
- **Evidence:** 2026-10-11: D-008.
- **Regression risk:** —

### ARC-08 — Audit schema
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** —
- **Requirements:** REQ-AUTH-06
- **Description:** Fields, outcomes, source, redaction.
- **Output:** MCP_DESIGN §9.
- **Acceptance:** Covers user, server, tool, ts, duration and outcome.
- **Tests:** TC-AUTH-05.
- **Command:** —
- **Evidence:** 2026-10-11: MCP_DESIGN §9.
- **Regression risk:** —

### ARC-09 — Timeouts and errors
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** ARC-04
- **Requirements:** REQ-GW-06
- **Description:** Budgets (list 3 s, call 15 s, connect 2 s) and error codes.
- **Output:** MCP_DESIGN §6.
- **Acceptance:** Every failure mode has a client-visible error.
- **Tests:** TC-INT-03.
- **Command:** —
- **Evidence:** 2026-10-11: MCP_DESIGN §6.
- **Regression risk:** —

### ARC-10 — Chat tool loop design
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** ARC-07
- **Requirements:** REQ-CHAT-01..03
- **Description:** Internal token → gateway `/mcp`; loop cap; transcript.
- **Output:** ARCHITECTURE §4.2, MCP_DESIGN §10.
- **Acceptance:** No path from chat to upstreams that bypasses `/mcp`.
- **Tests:** TC-INT-07.
- **Command:** —
- **Evidence:** 2026-10-11: ARCHITECTURE §4.2.
- **Regression risk:** —

### ARC-11 — Kubernetes topology
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** ARC-02
- **Requirements:** REQ-K8S-04..08
- **Description:** Namespaces, workloads, PVCs, Ingress hosts, NetworkPolicies.
- **Output:** ARCHITECTURE §5–6, DEPLOYMENT.md.
- **Acceptance:** Every workload listed with kind, PVC and exposure.
- **Tests:** TC-K8S-02 (later).
- **Command:** —
- **Evidence:** 2026-10-11: DEPLOYMENT.md §Topology.
- **Regression risk:** —

### ARC-12 — Local vs VPS values diff
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** ARC-11
- **Requirements:** REQ-K8S-02, REQ-K8S-03
- **Description:** Table of values that differ.
- **Output:** ARCHITECTURE §6.
- **Acceptance:** Only values differ; no template forks.
- **Tests:** TC-K8S-01.
- **Command:** —
- **Evidence:** 2026-10-11: ARCHITECTURE §6.
- **Regression risk:** —

### ARC-13 — Experiment: MCP SDK v1 stateless Streamable HTTP vs real clients
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-01
- **Requirements:** REQ-MCP-02, REQ-GW-12, REQ-DOD-05
- **Description:** A tiny `experiments/mcp-hello` server (SDK v1, stateless, requires `Authorization: Bearer test`) with one tool. Connect from MCP Inspector CLI and Claude Code (`claude mcp add --transport http`). Also connect via the SDK client (gateway side).
- **Output:** Result + exact SDK version recorded in D-002.
- **Acceptance:** All three clients list and call the tool; a request without the bearer → 401.
- **Tests:** TC-ARC-13-1: server running → Inspector CLI `tools/list` → 1 tool. TC-ARC-13-2: Claude Code connected → call tool → result. TC-ARC-13-3: no header → 401.
- **Command:** `npx @modelcontextprotocol/inspector --cli http://localhost:3999/mcp --transport http --header "Authorization: Bearer test" --method tools/list`
- **Evidence:** 2026-10-11: `experiments/mcp-hello` (SDK `@modelcontextprotocol/sdk@1.32.1`, zod 4.6.6, stateless `sessionIdGenerator: undefined`, `enableJsonResponse: true`, fresh server+transport per request). TC-ARC-13-1 PASS — Inspector CLI 2.10.1 `tools/list` → `greet`; `tools/call greet name=Inspector` → `Hello, Inspector!`. TC-ARC-13-2 PASS — `claude mcp add --transport http --scope local hello … --header 'Authorization: Bearer test'` → `claude mcp list` `✔ Connected`; `claude -p … --allowedTools mcp__hello__greet` → `Hello, Claude Code!` (registration removed afterwards). SDK client (`client.mjs`) → protocol `2025-11-25`, no session id, list + call OK, invalid args → `isError: true`. TC-ARC-13-3 PASS — no header → 401, wrong token → 401.
- **Regression risk:** If it fails, revisit D-002 (SDK v2 or a sessionful transport).

### ARC-14 — Experiment: WooCommerce REST with OAuth1 from Node
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** P0-01
- **Requirements:** REQ-MCP-09, REQ-STORE-01
- **Description:** `docker compose` with official wordpress + mariadb + wpcli: install WP + WooCommerce non-interactively, create a REST key via WP-CLI, then call `GET /wp-json/wc/v3/products` over plain HTTP with an OAuth1 signature from Node.
- **Output:** Working init commands (reused for the wp-init Job) + signer snippet; D-003 updated.
- **Acceptance:** 200 with JSON products; a bad signature → 401.
- **Tests:** TC-ARC-14-1: store up → signed GET → 200. TC-ARC-14-2: tampered secret → 401.
- **Command:** `node experiments/woo-auth/smoke.mjs`
- **Evidence:** 2026-10-11: `experiments/woo-auth` — compose with `mariadb:11.8.9`, `wordpress:7.1.3-php8.3-apache`, `wordpress:cli-2.12.0-php8.3` (run as uid 33: the Alpine cli image's www-data is 82), WooCommerce 11.2.1. `wp-init.sh` installs core, WooCommerce, COD, 3 products, `mcp-service` (shop_manager) + read_write REST key via `wp eval` (`wc_api_hash`); re-run → `rest key exists`, product count still 3 (idempotent). `node smoke.mjs` 8/8 PASS: TC-ARC-14-1 signed GET → 200 (3 products); encoded search `a b+c ~*é` → 200; signed POST (JSON body) → 201; DELETE → 200; TC-ARC-14-2 tampered secret → 401; signing against the request host instead of the WP home URL → 401; bad key → 401. First signer attempt failed on encoding → fixed by reading WC 11.2.1 `check_oauth_signature` (sort raw keys, double-encode pairs). Stack torn down (`down -v`), throwaway key deleted.
- **Regression risk:** If OAuth1 fails, fall back to an HTTPS-terminated internal call or the `HTTPS` server var override.

### ARC-15 — Experiment: additional upstreams reachable
- **Priority:** P0
- **Status:** Done
- **Day:** 1
- **Depends on:** ARC-13, P0-04
- **Requirements:** REQ-GW-08
- **Description:** Run `server-everything` in Streamable HTTP mode in Docker and connect the SDK client; connect the SDK client to GitHub remote MCP with the PAT bearer; list tools on both.
- **Output:** Confirmed image/command and URL; D-013 updated.
- **Acceptance:** `tools/list` works for both.
- **Tests:** TC-ARC-15-1: everything container → list → tools. TC-ARC-15-2: GitHub with PAT → list → tools; without PAT → 401.
- **Command:** `node experiments/upstreams/probe.mjs <url> [TOKEN_ENV_VAR]` (`experiments/upstreams/ev.sh start` runs server-everything on :3001)
- **Evidence:** 2026-10-11: TC-ARC-15-1 PASS — `@modelcontextprotocol/server-everything@2026.8.31` (`dist/index.js streamableHttp`, PORT env) → SDK client: protocol 2025-11-25, **sessionful** (issues `Mcp-Session-Id`), 13 tools, all names valid for `slug__tool`; `echo` call → `Echo: via gateway client`. Restart test: stale session → `StreamableHTTPError` (-32000), fresh connect → 13 tools ⇒ GW-04 must reconnect once on session errors. TC-ARC-15-2 PASS (2026-10-12) — `node experiments/upstreams/probe.mjs https://api.githubcopilot.com/mcp/ GITHUB_MCP_PAT` → connected in 4218 ms, protocol 2025-11-25, **sessionful** (`Mcp-Session-Id`), **46 tools** (add_issue_comment, issue_write, list_issues, get_me, …), names incompatible with `slug__tool`: none; `CALL='get_me {}'` → isError=false, login `Ragx09`; without token → 401. DeepWiki fallback unreachable from this network (TCP timeout); the timeout hung ~20 s despite the SDK `timeout` option ⇒ GW-09 must abort the transport fetch itself. Security: server-everything has a `get-env` tool that returns its process env ⇒ its pod must carry no secrets (T-15).
- **Regression risk:** GitHub unreachable → DeepWiki fallback.

---

## Phase 2 — Kubernetes, Helm and deployment foundation
Exit criterion: a repeatable Helm deployment works on k3d.

### INF-01 — Monorepo layout
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** P0-12
- **Requirements:** REQ-DEL-04
- **Description:** npm workspaces (`services/woo-mcp`, `services/gateway`, `apps/dashboard`), shared tsconfig, eslint, vitest.
- **Output:** Root `package.json` workspaces; `npm run build`/`test` across workspaces.
- **Acceptance:** `npm install && npm run build && npm test` succeed on empty skeletons.
- **Tests:** TC-INF-01-1: fresh clone → install/build/test → exit 0.
- **Command:** `npm ci && npm run build && npm test`
- **Evidence:** 2026-10-11: root `package.json` workspaces `services/*` (gateway joins at GW-01, dashboard at UI-01), `tsconfig.base.json` (strict, nodenext), TypeScript 7.0.2, vitest 5.0.3. `npm install && npm run build && npm test` exit 0 (26 unit tests). Deviation: no eslint; `tsc --noEmit` in strict mode is the lint gate (`npm run typecheck`).
- **Regression risk:** Low.

### INF-02 — k3d cluster config
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** P0-02
- **Requirements:** REQ-K8S-01
- **Description:** `k3d/cluster.yaml` (1 server, ports 80/443 → loadbalancer, k3s defaults incl. Traefik and the network-policy controller).
- **Output:** `scripts/cluster-up.sh`.
- **Acceptance:** Cluster Ready; Traefik running; `curl http://anything.127.0.0.1.nip.io` → 404 from Traefik.
- **Tests:** TC-INF-02-1: script → `kubectl get pods -n kube-system` shows traefik Running.
- **Command:** `scripts/cluster-up.sh && kubectl -n kube-system get pods`
- **Evidence:** 2026-10-11: `k3d/cluster.yaml` (1 server, k3s v1.35.5+k3s1, host 80/443 → loadbalancer) + `scripts/cluster-up.sh` (idempotent, waits for Traefik) / `cluster-down.sh`. Cluster Ready, traefik rolled out.
- **Regression risk:** Port 80 conflict on Windows host.

### INF-03 — Umbrella Helm chart skeleton
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-01
- **Requirements:** REQ-K8S-03
- **Description:** `charts/platform` with `_helpers.tpl`, common labels, per-component toggles.
- **Output:** Chart that templates cleanly.
- **Acceptance:** `helm lint charts/platform` passes.
- **Tests:** TC-INF-03-1: lint → 0 failures.
- **Command:** `helm lint charts/platform`
- **Evidence:** 2026-10-11: `charts/platform` (single chart with per-component toggles `store.enabled`, `wooMcp.enabled`; helpers for labels, selectors, required resources, hosts/URLs, image names, hardened securityContext). `helm lint` 0 failures (local + prod). Deviation from plan: one chart with component folders instead of subcharts (less indirection, same values-only environment diff) — recorded in D-011.
- **Regression risk:** —

### INF-04 — values-local and values-prod
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-02, REQ-K8S-03
- **Description:** Two values files; differences limited to domain, TLS, image registry/pullPolicy and resources.
- **Output:** `charts/platform/values-local.yaml`, `values-prod.yaml`.
- **Acceptance:** `helm template` succeeds for both; diff shows only expected keys.
- **Tests:** TC-INF-04-1: template both → kubeconform valid.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** 2026-10-11: `values.yaml` (shared), `values-local.yaml` (domain 127.0.0.1.nip.io, http, pullPolicy Never), `values-prod.yaml` (domain, https + cert-manager issuer, ghcr.io registry, larger storage/resources). `scripts/check-chart.sh`: both render, kubeconform 16/16 valid, diff check → only image/pull policy/storage/resources/URL/TLS lines differ.
- **Regression risk:** —

### INF-05 — Namespaces
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-04
- **Description:** `store` and `platform` namespaces, created by the chart (or `--create-namespace` + per-resource namespace).
- **Output:** Namespace manifests.
- **Acceptance:** Both namespaces exist after install.
- **Tests:** TC-INF-05-1: `kubectl get ns store platform`.
- **Command:** `kubectl get ns store platform`
- **Evidence:** 2026-10-11: chart renders Namespaces `store` and `platform` with `helm.sh/resource-policy: keep` and Pod Security `enforce: baseline` / `warn: restricted`; `make-secrets.sh` pre-creates them with Helm ownership metadata so Helm adopts them. `kubectl get ns store platform` → Active.
- **Regression risk:** —

### INF-06 — Secrets strategy
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-05
- **Requirements:** REQ-K8S-09, REQ-CHAT-04
- **Description:** `scripts/make-secrets.sh` creates K8s Secrets from `.env` + random generation (DB passwords, CREDENTIALS_KEY, session secret, admin password); the chart references `existingSecret` names and never contains values.
- **Output:** Script + chart references.
- **Acceptance:** `grep -ri password charts/` shows no literal values; secrets exist in the cluster.
- **Tests:** TC-INF-06-1: run script → `kubectl get secret -n platform gateway-secrets`. TC-INF-06-2: secret scan → none.
- **Command:** `scripts/make-secrets.sh && kubectl get secrets -A | grep -E 'gateway|store'`
- **Evidence:** 2026-10-11: `scripts/make-secrets.sh` creates store/{mariadb-secrets, wordpress-admin, woo-api, woo-mcp-auth} and platform/upstream-seed from random values (+ `GITHUB_MCP_PAT` from .env), via `--from-env-file=<(…)` (no secrets in argv), never printed. TC-INF-06-1 PASS (5 created; rerun → 5× `exists (kept)`). TC-INF-06-2 PASS — chart policy check fails on any rendered Secret or literal *PASSWORD/SECRET/TOKEN/_KEY env value → 0 violations.
- **Regression risk:** Running the script twice must not rotate DB passwords on existing PVCs (idempotent: skip if exists).

### INF-07 — Test workload through Ingress
- **Priority:** P1
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-02, INF-03
- **Requirements:** REQ-K8S-06
- **Description:** Temporary whoami Deployment + Ingress to prove Traefik routing and nip.io.
- **Output:** Removed after verification.
- **Acceptance:** `curl http://whoami.127.0.0.1.nip.io` → 200.
- **Tests:** TC-INF-07-1: curl → 200.
- **Command:** `curl -s -o /dev/null -w '%{http_code}' http://whoami.127.0.0.1.nip.io`
- **Evidence:** 2026-10-11: whoami Deployment + Ingress `smoke.127.0.0.1.nip.io` returned the pod's response through Traefik (P0-02 smoke cluster, then deleted); the real store Ingress now serves `store.127.0.0.1.nip.io` → 200.
- **Regression risk:** —

### INF-08 — Requests/limits convention
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-08
- **Description:** Every container takes `resources` from values; helper fails the render if missing.
- **Output:** Helper + defaults.
- **Acceptance:** TC-K8S-02 jq check passes.
- **Tests:** TC-INF-08-1: `helm template | scripts/check-resources.sh` → 0 missing.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** 2026-10-11: `platform.resources` helper fails the render without requests+limits; `scripts/lib/chart-policy.py` also checks every container (0 violations over 16 objects).
- **Regression risk:** —

### INF-09 — Probes convention
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-07
- **Description:** Readiness + liveness on every container (HTTP `/healthz` `/readyz` for our services; TCP or exec for DBs; HTTP for wordpress).
- **Output:** Probe blocks per workload.
- **Acceptance:** TC-K8S-02 passes for probes.
- **Tests:** TC-INF-09-1: check script → 0 containers missing probes.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** 2026-10-11: mariadb (exec healthcheck.sh startup/readiness/liveness), wordpress (HTTP startup/readiness `/wp-login.php`/liveness), woo-mcp (`/readyz` signed store call, `/healthz`). TC-INF-09-1 PASS (policy check); TC-INF-13-2 negative test: removing the woo-mcp liveness probe → `FAIL Deployment/woo-mcp[woo-mcp]: missing livenessProbe`, exit 1.
- **Regression risk:** Liveness too aggressive on WordPress first boot → use startupProbe.

### INF-10 — Services
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-04
- **Description:** ClusterIP Services for every workload.
- **Output:** Service templates.
- **Acceptance:** No NodePort/LoadBalancer except Traefik.
- **Tests:** TC-INF-10-1: `kubectl get svc -A` → types checked.
- **Command:** `kubectl get svc -A`
- **Evidence:** 2026-10-11: ClusterIP Services mariadb:3306, wordpress:80, woo-mcp:80→8080; policy check rejects any non-ClusterIP Service in the chart.
- **Regression risk:** —

### INF-11 — Ingress hosts
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-07
- **Requirements:** REQ-K8S-06
- **Description:** Ingress for `store.<domain>` and `app.<domain>` (`/` dashboard, `/api` and `/mcp` gateway); domain from values.
- **Output:** Ingress templates; local domain approach in DEPLOYMENT.md.
- **Acceptance:** TC-K8S-04 passes.
- **Tests:** TC-INF-11-1: curl each host/path → expected code.
- **Command:** `scripts/k8s-checks.sh ingress`
- **Evidence:** 2026-10-11: store Ingress `store.<domain>` (Traefik, optional TLS via cert-manager annotation) → `/`, `/shop/` 200; no public route to woo-mcp (404). 2026-10-14 (with UI-20): `app.<domain>` `/` → dashboard, `/api` + `/mcp` (both Prefix) → gateway. TC-INF-11-1 PASS via `scripts/k8s-checks.sh ingress` (gateway identified by its `x-request-id` header): GET / and /servers → dashboard 200; POST /mcp → gateway 401; GET /mcp → gateway 401 (405 with a key); /mcp/x → gateway 404; /api/me → gateway 401; /healthz → dashboard (gateway probes not public). Local domain approach: nip.io (`docs/DEPLOYMENT.md`).
- **Regression risk:** Low.

### INF-12 — Persistent volumes
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-05
- **Description:** PVCs for mariadb, wordpress and postgres with storageClass from values.
- **Output:** PVC templates.
- **Acceptance:** PVCs Bound.
- **Tests:** TC-INF-12-1: `kubectl get pvc -A` → Bound.
- **Command:** `kubectl get pvc -A`
- **Evidence:** 2026-10-11: PVCs `data-mariadb-0` (StatefulSet volumeClaimTemplate, retention Retain) and `wordpress-data` (`helm.sh/resource-policy: keep`) both Bound on `local-path`. Postgres PVC follows the same pattern in GW-02.
- **Regression risk:** `helm uninstall` must keep PVCs (`helm.sh/resource-policy: keep`).

### INF-13 — Chart validation script
- **Priority:** P1
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-04
- **Requirements:** REQ-K8S-03, REQ-K8S-07, REQ-K8S-08
- **Description:** `scripts/check-chart.sh`: helm lint, template for both values files, kubeconform, probes/resources jq check.
- **Output:** Script, run before every chart commit.
- **Acceptance:** Exit 0 on a good chart; non-zero when a probe is removed (negative test).
- **Tests:** TC-INF-13-1: good → 0. TC-INF-13-2: remove probe → fails.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** 2026-10-11: `scripts/check-chart.sh` = helm lint ×2, helm template ×2, kubeconform v0.8.0 (k8s 1.35 schemas, strict) 16/16 valid ×2, policy check (resources, probes, allowPrivilegeEscalation=false, drop ALL, no SA token, no Secrets, ClusterIP only) 0 violations, values-diff guard. TC-INF-13-1 PASS (exit 0); TC-INF-13-2 PASS (missing probe → exit 1).
- **Regression risk:** —

### INF-14 — Install/upgrade idempotency
- **Priority:** P1
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-11, INF-12
- **Requirements:** REQ-K8S-02
- **Description:** `helm upgrade --install` twice with no changes → no pod restarts; data kept.
- **Output:** Evidence in TASKS.
- **Acceptance:** Pod restart counts and ages unchanged.
- **Tests:** TC-INF-14-1: upgrade twice → `kubectl get pods` ages unchanged.
- **Command:** `scripts/deploy.sh local && scripts/deploy.sh local`
- **Evidence:** 2026-10-11: no-op `helm upgrade` (rev 2→3) → mariadb-0, wordpress, woo-mcp restart counts 0 and start times identical (diff empty); `wp-init-3` reran as a no-op (`rest key up to date`, no `sample products created`). Content-addressed image tags (`scripts/build-images.sh`) keep upgrades restart-free when code is unchanged.
- **Regression risk:** Random values in templates (use `lookup` or external secrets). 2026-10-12 (INF-15): content-addressed tags were not stable across *rebuilds* (BuildKit provenance timestamps) → fixed in `build-images.sh` with `--provenance=false --sbom=false`.

### INF-15 — One-command up/down scripts
- **Priority:** P1
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-14
- **Requirements:** REQ-DEL-01
- **Description:** `scripts/up.sh` (cluster, secrets, build+import images, helm install, wait) and `scripts/down.sh`.
- **Output:** Scripts documented in README.
- **Acceptance:** From a clean machine state, `up.sh` reaches all-Ready.
- **Tests:** TC-INF-15-1: down → up → `kubectl wait --for=condition=Ready pods --all -A`.
- **Command:** `scripts/up.sh`
- **Evidence:** 2026-10-12: TC-INF-15-1 PASS — `scripts/down.sh --all` (cluster `mcp` deleted, 9 s) → `time scripts/up.sh` → exit 0, **real 5m31.7s**; `kubectl wait --for=condition=Ready pods --all -A --field-selector=status.phase!=Succeeded` → all 10 pods condition met (gateway, postgres-0, mariadb-0, woo-mcp, wordpress + kube-system); wp-init-1 Completed. Smoke on the fresh stack: `/shop/` 200; `/mcp` without key 401; with the new dev key `tools/list` → 5 `woo__*` tools, `tools/call woo__list_products` → 3 products. Re-run: secrets "exists (kept)", cluster "exists". **Found and fixed:** a no-op re-run restarted gateway and woo-mcp because BuildKit provenance attestations embed timestamps, changing the image id on every build (layers were identical) → `build-images.sh` now builds with `--provenance=false --sbom=false`; two builds → same id `sha256:7cde5207…`; second `up.sh` (1m02s, rev 4) → pod names and start times unchanged (diff empty). `up.sh` now also prints the gateway URL and how to read the dev key. README "Local setup" written.
- **Regression risk:** Re-enabling provenance/SBOM in builds brings back restarts on every deploy. The first run pulls images (~5 min); slow networks may need a longer `--timeout`.

---

## Phase 3 — WooCommerce and custom MCP server
Exit criterion: all required tools work against the real store; woo-mcp is reachable only from the gateway.

### WC-01 — MariaDB StatefulSet
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-06, INF-12
- **Requirements:** REQ-STORE-01, REQ-K8S-05
- **Description:** Official `mariadb:11`, PVC, Secret-sourced passwords, probes (`healthcheck.sh`), resources.
- **Output:** Template in the store component.
- **Acceptance:** Pod Ready; PVC Bound.
- **Tests:** TC-WC-01-1: `kubectl -n store wait --for=condition=Ready pod -l app=mariadb`.
- **Command:** same
- **Evidence:** 2026-10-11: StatefulSet `mariadb` (`mariadb:11.8.9`, runAsUser 999, drop ALL, passwords from `mariadb-secrets`), PVC Bound, startup/readiness/liveness via `healthcheck.sh`. Pod Ready.
- **Regression risk:** —

### WC-02 — WordPress Deployment
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-01, INF-11
- **Requirements:** REQ-STORE-01, REQ-K8S-05, REQ-K8S-06
- **Description:** Official wordpress image; PVC at `/var/www/html`; `WP_HOME`/`WP_SITEURL` from values; `X-Forwarded-Proto` handling; startup/readiness/liveness probes.
- **Output:** Template.
- **Acceptance:** `http://store.127.0.0.1.nip.io` loads without redirect loops.
- **Tests:** TC-WC-02-1: curl → 200 or a single expected 302.
- **Command:** `curl -sI http://store.127.0.0.1.nip.io`
- **Evidence:** 2026-10-11: Deployment `wordpress` (`wordpress:7.1.3-php8.3-apache`, Recreate, PVC `/var/www/html`, WP_HOME/WP_SITEURL pinned to the Ingress URL, X-Forwarded-Proto → HTTPS, DISALLOW_FILE_EDIT; caps dropped except the 7 Apache needs). TC-WC-02-1 PASS — `/`, `/shop/`, `/product/urumi-mug/`, `/cart/` → 200, `/checkout/` with empty cart → single 302 to `/cart/` (no loop); `/wp-json/` home = `http://store.127.0.0.1.nip.io`.
- **Regression risk:** siteurl mismatch.

### WC-03 — wp-init Job
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-02, ARC-14
- **Requirements:** REQ-STORE-01, REQ-STORE-02, REQ-GW-10
- **Description:** Idempotent WP-CLI Job (Helm post-install/post-upgrade hook): core install, WooCommerce install and activation, store settings (currency, timezone), COD enabled, 3 sample products, `mcp-service` user + REST key (read_write) stored in Secret `woo-api` (creates only if absent).
- **Output:** Job + script.
- **Acceptance:** Job Completed; re-running is a no-op; Secret `woo-api` exists.
- **Tests:** TC-WC-03-1: install → Job Succeeded. TC-WC-03-2: helm upgrade → Job succeeds without duplicate products or keys.
- **Command:** `kubectl -n store get jobs && kubectl -n store get secret woo-api`
- **Evidence:** 2026-10-11: Job `wp-init-<revision>` (wp-cli 2.12.0, uid 33) runs `charts/platform/files/wp-init.sh`: core install, WooCommerce 11.2.1, currency/timezone/country, COD on, guest checkout, 3 products, `mcp-service` shop_manager + REST key from Secret `woo-api` (hash stored, rotation supported). TC-WC-03-1 PASS (Complete). TC-WC-03-2 PASS (upgrade → `rest key up to date`, still 3 seed products). Changed from post-install hook to a revisioned Job: the hook deadlocked `helm --wait` (woo-mcp readiness needs the installed store).
- **Regression risk:** Non-idempotent init duplicating data.

### WC-04 — Storefront checkout (manual)
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-03
- **Requirements:** REQ-STORE-02, REQ-STORE-03, REQ-DOD-01, REQ-DOD-02
- **Description:** Add to cart → checkout with COD → order visible in wp-admin → Orders.
- **Output:** Screenshot or notes in evidence; runbook steps.
- **Acceptance:** Order exists with status Processing (or On hold).
- **Tests:** TC-WC-04-1: manual runbook step → order present; also `wp wc shop_order list` via kubectl exec.
- **Command:** `kubectl -n store exec deploy/wordpress -- wp wc shop_order list --user=admin --allow-root` (or REST)
- **Evidence:** 2026-10-11: real-browser checkout via `scripts/e2e-checkout.sh` (Playwright 1.64 in Docker): Urumi Mug → cart → block checkout (guest, address) → Cash on delivery → **order #14**, $12.00, `order-received` page (screenshot `docs/evidence/wc-04-order-received.png`). Order visible through woo-mcp `list_orders date=today` and `get_order` (WC-15).
- **Regression risk:** Block-based checkout needs the COD gateway enabled.

### WC-05 — Persistence test
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-04
- **Requirements:** REQ-K8S-05
- **Description:** Delete the wordpress and mariadb pods; the data survives.
- **Output:** Evidence.
- **Acceptance:** Previous order and products still present.
- **Tests:** TC-PER-01.
- **Command:** `kubectl -n store delete pod -l 'app in (mariadb,wordpress)' && kubectl -n store wait --for=condition=Ready pod -l 'app in (mariadb,wordpress)' && scripts/woo-int.sh`
- **Evidence:** 2026-10-11: TC-PER-01 PASS — deleted mariadb-0 and wordpress pod, both recreated Ready, then `scripts/woo-int.sh` 7/7: seeded products present, today's storefront order still listed and readable.
- **Regression risk:** —

### WC-06 — woo-mcp skeleton
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-01, ARC-13
- **Requirements:** REQ-MCP-01, REQ-MCP-02
- **Description:** TS service, config from env (store URL, key, secret via Secret), pino logging, Dockerfile (non-root, distroless or node-slim).
- **Output:** `services/woo-mcp`.
- **Acceptance:** Builds; container starts.
- **Tests:** TC-WC-06-1: `docker run` → `/healthz` 200.
- **Command:** `npm run build -w services/woo-mcp && docker build -t woo-mcp:dev services/woo-mcp`
- **Evidence:** 2026-10-11: `services/woo-mcp` (TS, config validation fails fast, pino with redaction), multi-stage Dockerfile (node:24.19.0-alpine3.24, prod deps only, uid 1000). TC-WC-06-1 PASS — `docker run --read-only --cap-drop ALL` → `/healthz` 200, `id` → uid=1000, no token → 401.
- **Regression risk:** —

### WC-07 — Streamable HTTP endpoint + health
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-06
- **Requirements:** REQ-MCP-02
- **Description:** `POST /mcp` stateless transport; `/healthz` (liveness), `/readyz` (checks WooCommerce reachability).
- **Output:** Endpoint.
- **Acceptance:** Inspector CLI lists tools.
- **Tests:** TC-WC-07-1: Inspector `tools/list` → 5 tools.
- **Command:** `npx @modelcontextprotocol/inspector --cli http://localhost:8080/mcp --transport http --method tools/list`
- **Evidence:** 2026-10-11: stateless Streamable HTTP `POST /mcp` (fresh server+transport per request, JSON responses, 1 MB body limit, bearer = `woo-mcp-auth` token compared via SHA-256 digests in constant time), `GET /mcp` → 405, `/healthz`, `/readyz` (signed store call, cached 5 s). TC-WC-07-1 PASS — in cluster via port-forward, Inspector CLI 2.10.1 `tools/list` → list_products, create_product, list_orders, get_order, update_order_status; no token → 401.
- **Regression risk:** —

### WC-08 — Tool: list_products
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-03
- **Description:** Params: search?, per_page (≤50), page. Returns id, name, price, status, stock, permalink.
- **Output:** Tool + unit test.
- **Acceptance:** Returns sample products.
- **Tests:** TC-WC-08-1: store seeded → call → ≥3 products.
- **Command:** `npm test -w services/woo-mcp`
- **Evidence:** 2026-10-11: TC-WC-08-1 PASS — Inspector `tools/call list_products` in cluster → 3 products (Urumi Sticker Pack 5.00, T-Shirt 25.00, Mug 12.00); unit test checks mapping and that the call goes to the internal URL with an HMAC-SHA256 signature.
- **Regression risk:** —

### WC-09 — Tool: create_product
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-04, REQ-DOD-03
- **Description:** Params: name, regular_price (decimal string), description?, status (default publish). Returns id + permalink.
- **Output:** Tool + test.
- **Acceptance:** Product visible on the storefront.
- **Tests:** TC-WC-09-1: call → product id; curl permalink → 200.
- **Command:** `npm run test:int -w services/woo-mcp`
- **Evidence:** 2026-10-11: TC-WC-09-1 PASS — `INT_PUBLISH=1 scripts/woo-int.sh`: created `Integration Product <ts>` 7.50, found via list_products, permalink fetched through the Ingress → 200 containing the name.
- **Regression risk:** —

### WC-10 — Tool: list_orders
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-05, REQ-DOD-04
- **Description:** Params: status?, after?/before? (ISO), `date` shortcut `today`, per_page. Returns id, number, status, total, created, customer name, line items summary.
- **Output:** Tool + test.
- **Acceptance:** "today" returns orders created today (store timezone).
- **Tests:** TC-WC-10-1: place order → list today → contains it.
- **Command:** `npm run test:int -w services/woo-mcp`
- **Evidence:** 2026-10-11: TC-WC-10-1 PASS — `list_orders date=today` returns the storefront order; 'today' uses the store timezone from `/wp-json/` (unit test: 20:00 UTC → 2026-10-12 for Asia/Kolkata).
- **Regression risk:** Timezone boundaries.

### WC-11 — Tool: get_order
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-06
- **Description:** Param: order_id. Returns full order detail minus sensitive fields (no payment tokens).
- **Output:** Tool + test.
- **Acceptance:** Correct order returned; unknown id → clear error.
- **Tests:** TC-WC-11-1: existing id → detail. TC-WC-11-2: 999999 → isError "order not found".
- **Command:** `npm run test:int -w services/woo-mcp`
- **Evidence:** 2026-10-11: TC-WC-11-1 PASS (detail incl. `payment_method: Cash on delivery`, no transaction_id/payment token/meta_data/phone); TC-WC-11-2 PASS (`999999` → isError `Order 999999 not found.`).
- **Regression risk:** —

### WC-12 — Tool: update_order_status
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-07
- **Description:** Params: order_id, status ∈ {pending, processing, on-hold, completed, cancelled, refunded, failed}.
- **Output:** Tool + test.
- **Acceptance:** Status changes in wp-admin.
- **Tests:** TC-WC-12-1: set completed → get_order shows completed. TC-WC-12-2: invalid status → validation error.
- **Command:** `npm run test:int -w services/woo-mcp`
- **Evidence:** 2026-10-11: TC-WC-12-1 PASS — processing → completed (get_order confirms) → restored; TC-WC-12-2 PASS — `shipped` → validation error.
- **Regression risk:** —

### WC-13 — Validation and error mapping
- **Priority:** P1
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-08..WC-12
- **Requirements:** REQ-MCP-03..07
- **Description:** zod schemas; WooCommerce errors → `isError: true` with safe messages (no keys, no stack traces).
- **Output:** Shared error helper + unit tests.
- **Acceptance:** TC-UNIT-07 passes.
- **Tests:** TC-UNIT-07.
- **Command:** `npm test -w services/woo-mcp`
- **Evidence:** 2026-10-11: TC-UNIT-07 PASS — invalid inputs rejected before any store call (5 cases); 401/500/network/timeout map to fixed safe messages that never contain the consumer key/secret, `oauth_` params or internal hostnames (4 cases); redirects not followed (`redirect: 'error'`).
- **Regression risk:** —

### WC-14 — Internal-only exposure (NetworkPolicy)
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-07, INF-10
- **Requirements:** REQ-MCP-08
- **Description:** No Ingress for woo-mcp; NetworkPolicy allows ingress only from pods labelled `app=gateway` in `platform`. Also mariadb ← wordpress/wp-init only.
- **Output:** NetworkPolicy templates.
- **Acceptance:** TC-SEC-02 and TC-SEC-03 pass.
- **Tests:** TC-SEC-02, TC-SEC-03.
- **Command:** `scripts/k8s-checks.sh netpol`
- **Evidence:** 2026-10-11: default-deny ingress in `store`; mariadb ← wordpress/wp-init; wordpress ← Traefik/woo-mcp; woo-mcp ← platform/app=gateway only, egress → wordpress:80 + DNS only. `scripts/k8s-checks.sh netpol` 8/8 PASS (TC-SEC-02a–d, TC-SEC-03a–c, wordpress from platform CLOSED). First run had 2 false results from the probe harness (connecting before kube-router programmed the new pod IP; output lost to a PodSecurity warning) → probe waits 3 s, uses a restricted securityContext, retries once.
- **Regression risk:** Breaks the gateway if labels mismatch.

### WC-15 — woo-mcp integration tests against the real store
- **Priority:** P1
- **Status:** Done
- **Day:** 2
- **Depends on:** WC-08..WC-12
- **Requirements:** REQ-MCP-03..07
- **Description:** vitest suite using the SDK client via port-forward: create → list → get → update → list today.
- **Output:** `services/woo-mcp/test/int.test.ts`.
- **Acceptance:** All green against k3d.
- **Tests:** TC-INT-01.
- **Command:** `scripts/woo-int.sh` (`INT_PUBLISH=1` for the storefront check)
- **Evidence:** 2026-10-11: TC-INT-01 PASS — 7/7 (list → create → list today → get → unknown id → update round trip → invalid status) against k3d via port-forward, MCP SDK client with the token from the Secret.
- **Regression risk:** —

---

## Phase 4 — MCP gateway and multiple upstreams
Exit criterion: one endpoint exposes tools from ≥3 upstreams and handles the required failure cases.

### GW-01 — Gateway skeleton
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** INF-01
- **Requirements:** REQ-DEL-04
- **Description:** Fastify app, config, pino with redaction, `/healthz` `/readyz`, Dockerfile.
- **Output:** `services/gateway`.
- **Acceptance:** Container healthy.
- **Tests:** TC-GW-01-1: `/healthz` → 200.
- **Command:** `npm run build -w services/gateway`
- **Evidence:** 2026-10-11: `npm test -w services/gateway` → 7 passed (TC-GW-01-1 `/healthz` 200; `/readyz` 200/503 naming failed checks; JSON 404/500 without leaking internals; 413 body limit; secrets in headers/fields redacted in logs; config validation). `docker run --read-only --user 1000:1000 gateway:build` → `/healthz` 200 `{"status":"ok"}`, SIGTERM → exit 0. k3d: `pod/gateway` 1/1 Running; `curl app.127.0.0.1.nip.io/api/me` → 404 `{"error":"not_found"}` from gateway, `/healthz` not routed (Traefik 404); pod in `default` ns → gateway: timeout (NetworkPolicy). `scripts/check-chart.sh` → lint/kubeconform/policy pass, 21 objects.
- **Regression risk:** —

### GW-02 — Postgres + upstream model
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** GW-01, INF-12
- **Requirements:** REQ-GW-01
- **Description:** Postgres StatefulSet; Drizzle schema + migrations (upstreams: id, slug, name, url, enabled, auth_type, auth_header, credential_enc, created_by, timestamps); migrations run on startup with a lock.
- **Output:** Schema + migration.
- **Acceptance:** Migration applies on a fresh DB; re-run is a no-op.
- **Tests:** TC-GW-02-1: start twice → no error.
- **Command:** `scripts/gateway-db-int.sh` (throwaway Postgres in Docker → `npm run test:int -w services/gateway`); `npm run db:migrate -w services/gateway`
- **Evidence:** 2026-10-12: `scripts/gateway-db-int.sh` → 16 passed: TC-GW-02-1 fresh DB migrates, 2nd run no-op (1 row in `drizzle.__drizzle_migrations`); TC-GW-02-2 three concurrent runs → no error, no double-apply (advisory lock); TC-GW-02-3 unreachable DB → clear error after timeout; TC-GW-02-4 defaults; TC-GW-02-5 11 bad rows each rejected by the expected named constraint (slug format/unique, http URL, header-name CRLF injection, credential with auth none, …). k3d: `postgres-0` 1/1 + PVC 1Gi Bound; fresh install (PVC deleted) → gateway retries ~10 s, "database migrations applied", 0 restarts (startupProbe); `/readyz` → 503 during Postgres pod deletion, `{"status":"ready"}` after, row persisted, gateway 0 restarts; pod in `default` ns → postgres:5432 "no response" (NetworkPolicy). check-chart: 24 objects, 0 violations.
- **Regression risk:** Concurrent migrations with replicas → advisory lock (tested). Schema changes need `npm run db:generate` + committed SQL.

### GW-03 — Seed WooCommerce upstream
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** GW-02
- **Requirements:** REQ-GW-10
- **Description:** On startup, ensure upstream slug `woo` → `http://woo-mcp.store.svc.cluster.local/mcp` exists (from values); never overwrite admin edits.
- **Output:** Seeder.
- **Acceptance:** Fresh install lists `woo` first.
- **Tests:** TC-GW-03-1..7 (`test/int/seed.int.test.ts`), TC-GW-03-U1..U4 (`test/unit/credentials.test.ts`). `GET /api/upstreams` needs a session (AUTH-03), so TC-GW-03-1 checks `listUpstreams()` (the function the route will use) instead of opening an unauthenticated API.
- **Command:** `scripts/gateway-db-int.sh`; `npm test -w services/gateway`
- **Evidence:** 2026-10-12: unit 11/11 (AES-256-GCM round trip, random IV, wrong key / other slug / tampered byte → throws, key format, public shape has `hasCredential` and no ciphertext); integration 23/23 incl. TC-GW-03-1 fresh DB → `created`, woo listed first, credential encrypted; -2 restart → `unchanged`, row not rewritten; -3 rotated token → `refreshed`; -4 admin edit → `admin-edited`, never overwritten; -5 admin delete → not re-created; -6 slug created by hand first → left alone; -7 4 concurrent seeders → 1 row. k3d: gateway log `{"slug":"woo","result":"created"}`; row `woo | WooCommerce | http://woo-mcp.store.svc.cluster.local/mcp | bearer | encrypted`; `pg_dump` contains the plaintext token 0 times; decrypted credential hash = `woo-mcp-auth` Secret hash; after `rollout restart` → `"result":"unchanged"`.
- **Regression risk:** `CREDENTIALS_KEY` rotation makes stored credentials unreadable (re-enter or re-seed). Admin edits must go through the ORM so `updated_at` is bumped (`$onUpdate`).

### GW-04 — Upstream client pool
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** GW-02, ARC-13
- **Requirements:** REQ-GW-02, REQ-GW-03
- **Description:** Per-upstream SDK `Client` + `StreamableHTTPClientTransport` with injected headers; reconnect on failure; rebuilt on config change.
- **Output:** `upstreams/pool.ts`.
- **Acceptance:** Can list tools on `woo`.
- **Tests:** TC-GW-04-1..7 (`test/unit/pool.test.ts`, in-process fake upstreams `test/helpers/fake-upstream.ts`, stateless and sessionful).
- **Command:** `npm test -w services/gateway`
- **Evidence:** 2026-10-12: `src/upstreams/pool.ts` — lazy per-upstream SDK `Client`, shared connect, decrypted credential → bearer/custom header only, rebuilt on row change, closed on disable/remove, one transparent reconnect on transport errors (not on upstream JSON-RPC errors), undici connect timeout 2 s. Unit 18/18 incl. TC-GW-04-1 connect/list/reuse/close (1 initialize); -2 header injection (no inbound auth forwarded); -3 3 concurrent callers → 1 connect; -4 sessionful upstream restart → reconnect, 2 initializes; -5 URL change → rebuilt, disabled → refused; -6 dead upstream → `UpstreamUnavailableError` < 3 s, message without URL; -7 unknown tool → isError result, no retry. k3d (acceptance): from the gateway pod, pool → `woo` tools in 503 ms: list_products, create_product, list_orders, get_order, update_order_status; `list_products` call isError=false. Gateway log `upstream pool ready ["woo"]`; rolling restart clean.
- **Regression risk:** Connection leaks: entries replaced during connect close the new client; `close()` on shutdown. tools/call retry is only safe for transport errors before execution — GW-08 must pass a stricter retry predicate.

### GW-05 — Tool discovery
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** GW-04
- **Requirements:** REQ-GW-02
- **Description:** Per-upstream `listTools` with pagination, cached with a timestamp.
- **Output:** `src/upstreams/discovery.ts` (`ToolDiscovery.discover()`).
- **Acceptance:** Cached list served when the upstream is temporarily slow.
- **Tests:** TC-GW-05-1..7 (`test/unit/discovery.test.ts`): pagination, slow → stale cache, cache expiry, isolation, unreachable, config change, single-flight/disable.
- **Command:** `npm test -w services/gateway`
- **Evidence:** 2026-10-12: `ToolDiscovery` — parallel `listTools` over pool upstreams (`Promise.allSettled`), follows `nextCursor` (max 20 pages), one 3 s deadline per upstream incl. connect/reconnect (aborts the request), cache `{version, tools, fetchedAt}`; on failure serves the cache as `stale` if ≤ 60 s old and the upstream config is unchanged, else reports it in `failed` (safe message, no URL); concurrent calls share one in-flight request. Fixed `safeReason` in pool.ts (SDK error codes were reported without the `MCP error`/`HTTP` prefix). `npm run typecheck` clean; `npm test -w services/gateway` → **25/25 passed** (3 consecutive runs), incl. TC-GW-05-1 5 tools over 3 pages; -2 slow upstream (2 s delay) → cached list `stale:true`, `error: upstream slow timed out after 300 ms`, returned < 1 s, healthy upstream live; -3 cache 60 001 ms old → omitted, `MCP error -32603`; -4 failing upstream isolated; -5 unreachable → failed < 1 s, no `127.0.0.1` in message; -6 URL change → old tools not served; -7 3 concurrent → 1 upstream list, disabled → dropped. Not wired into `/mcp` yet (GW-06); real woo-mcp check deferred to the GW-06 vertical slice (Docker was not running). The "health = Connected" condition from MCP_DESIGN §4 lands with GW-10.
- **Regression risk:** Serving stale tools after an upstream changed its tool set (bounded to 60 s); GW-08 must handle `unknown tool` from the upstream gracefully.

### GW-06 — Aggregated tools/list at /mcp
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** GW-05, GW-07
- **Requirements:** REQ-GW-02, REQ-GW-12
- **Description:** Gateway MCP server (stateless) implementing `tools/list` over all enabled upstreams. Temporary static dev key until AUTH-08.
- **Output:** `src/mcp/route.ts` (POST `/mcp`, stateless, dev-key auth, GET/DELETE → 405), `src/mcp/aggregate.ts` (public tool list + `ToolIndex`); `MCP_DEV_KEY` from Secret `gateway-dev-key` (chart + `make-secrets.sh`).
- **Acceptance:** **Vertical slice milestone**: Inspector → gateway → woo-mcp → WooCommerce returns products.
- **Tests:** TC-GW-06-1: Inspector CLI list via gateway → `woo__list_products` etc. Unit TC-GW-06-U1..U7 (`test/unit/mcp-route.test.ts`, `aggregate.test.ts`): aggregation over 2 fakes, 401 cases incl. no key configured, client key not forwarded, dead/disabled upstream, registry change picked up, registry error without internals + GET 405, field allowlist.
- **Command:** `npx @modelcontextprotocol/inspector --cli http://app.127.0.0.1.nip.io/mcp --transport http --header "Authorization: Bearer $KEY" --method tools/list`
- **Evidence:** 2026-10-12: `npm test -w services/gateway` → **40/40 passed** (3 runs), typecheck clean; `scripts/check-chart.sh` → lint ×2, kubeconform 25/25 ×2, policy 0 violations. k3d: `make-secrets.sh` → `gateway-dev-key: created`; `build-images.sh` → `gateway:sha-d8c2da5073bd`; `deploy.sh local` → rev 10, rollout OK. **TC-GW-06-1 PASS** — `npx @modelcontextprotocol/inspector@2.10.1 --cli http://app.127.0.0.1.nip.io/mcp --transport http --header "Authorization: Bearer $KEY" --method tools/list` → `woo__list_products`, `woo__create_product`, `woo__list_orders`, `woo__get_order`, `woo__update_order_status`, descriptions prefixed `[woo]`; gateway log `tools/list tools=5 upstreams=["woo"] failed=[] ms=196` (20 ms warm). No key / wrong key → 401. Dev key occurrences in gateway and woo-mcp logs: 0. Path proven: Inspector → Traefik → gateway → woo-mcp (Inspector → … → WooCommerce **returning products** needs `tools/call` = GW-08; `tools/call` currently → "Method not found").
- **Regression risk:** The shared dev key is temporary: AUTH-08 must remove `MCP_DEV_KEY` (chart env, Secret, config). Each tools/list costs one DB query + one list per upstream (single-flight, 3 s cap).

### GW-07 — Namespacing (collision policy)
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** ARC-06
- **Requirements:** REQ-GW-04
- **Description:** Implement D-005 (`toPublicName`, `parsePublicName`).
- **Output:** `src/mcp/naming.ts` (`toPublicName`, `parsePublicName`, `publicDescription`, `ToolIndex`) + `test/unit/naming.test.ts`.
- **Acceptance:** TC-UNIT-01 passes.
- **Tests:** TC-UNIT-01 = TC-GW-07-1..8 (cross-upstream collision, `__` in upstream names, malformed names, 64-char limit + hash, invalid characters, duplicates, bad slug, description prefix/cap).
- **Command:** `npm test -w services/gateway -- naming`
- **Evidence:** 2026-10-12: `npx vitest run test/unit/naming.test.ts` → **8/8 passed**; `npm test -w services/gateway` → 33/33; typecheck clean. Results: `woo__search` / `github__search` both resolvable; `everything__a__b` → slug `everything`, tool `a__b`; 70-char names → 64 chars `github__x{47}_<8 hex>`, distinct and deterministic; `files.read` → `srv__files_read_<hash>` (no clash with a real `files_read`); duplicate → first kept, conflict reported; descriptions `[slug] …` capped at 1024. Extends D-005: invalid characters get the hash form too, and routing resolves through `ToolIndex` (hashed names cannot be split back).
- **Regression risk:** Changing the hash rule renames tools for every client; treat it as a breaking change.

### GW-08 — Routing tools/call
- **Priority:** P0
- **Status:** Done
- **Day:** 2
- **Depends on:** GW-06
- **Requirements:** REQ-GW-03
- **Description:** Parse → lookup → checks (exists, enabled) → forward → return result unchanged (except for error normalization).
- **Output:** `tools/call` handler in `src/mcp/route.ts`; `ToolDiscovery.toolsFor()`; `isSafeCallRetry()` in `pool.ts`.
- **Acceptance:** `woo__list_orders` via the gateway returns orders.
- **Tests:** TC-GW-08-1: call through gateway → result. TC-GW-08-2: unknown name → error `unknown_tool`. Unit TC-GW-08-1..8 (`mcp-route.test.ts`, `discovery.test.ts`): routing + arguments, unknown/malformed/unknown-slug, disabled, hashed long name, isError passthrough + JSON-RPC error not retried, unreachable < 3 s without URL, key not forwarded, `toolsFor` cache/refresh.
- **Command:** Inspector CLI `--method tools/call --tool-name woo__list_orders`
- **Evidence:** 2026-10-12: typecheck clean; `npm test -w services/gateway` → **48/48 passed** (3 runs). k3d (`gateway:sha-32a72cdfdcb4`, rev 11). **Day 2 vertical slice PASS** — Inspector CLI 2.10.1 → Traefik → gateway → woo-mcp → WooCommerce: **TC-GW-08-1** `--method tools/call --tool-name woo__list_products` → isError=false, 5 products (Urumi Mug 12.00, T-Shirt 25.00, Sticker Pack 5.00, 2 integration products); `woo__list_orders` → 6 orders (e.g. #20 processing 12.00 USD "1× Urumi Mug"); `woo__get_order {"order_id":20}` → order 20; `woo__get_order` with a wrong argument → upstream `isError` passed through unchanged. **TC-GW-08-2** raw JSON-RPC `woo__nope` → `-32602 unknown tool: woo__nope`, `data.code=unknown_tool`. Gateway log per call: `tools/call upstream=woo tool=list_products outcome=ok ms=210` (no arguments/results logged). Dev key occurrences in gateway and woo-mcp logs: 0.
- **Regression risk:** Retry is limited to "certainly not executed" errors (404 session, ECONNREFUSED); widening it can duplicate writes such as create_product. 15 s default timeout until GW-09.

### GW-09 — Timeouts
- **Priority:** P0
- **Status:** Done
- **Day:** 3
- **Depends on:** GW-08
- **Requirements:** REQ-GW-06
- **Description:** Connect 2 s / list 3 s / call 15 s (configurable); AbortController; clear `upstream_timeout` error.
- **Output:** Timeout wrapper.
- **Acceptance:** TC-INT-03 passes.
- **Tests:** TC-INT-03.
- **Command:** `npm run test:int -w services/gateway`
- **Evidence:** 2026-10-13: `withDeadline()` in `src/upstreams/pool.ts` (one deadline over connect + call + the single reconnect; AbortController → SDK sends `notifications/cancelled`), used by `tools/call` and discovery; budgets from env `UPSTREAM_CONNECT/LIST/CALL_TIMEOUT_MS` (2000/3000/15000, range-checked) and Helm `gateway.upstreamTimeouts`. Typecheck clean. `npm test -w services/gateway` → **49/49** (3 runs; new TC-GW-09-1 config defaults/validation). **TC-INT-03 PASS** — `npx vitest run test/int/timeouts.int.test.ts` → 3/3 (5 runs), budgets connect 300 / list 400 / call 600 ms: slow call → `upstream_timeout: upstream everything did not answer within 0.6 s` in ~600 ms while a parallel `woo__echo` succeeds, upstream received the cancel, call not repeated, same upstream serves the next call; slow `tools/list` → only `woo__echo` listed within the budget; hung TCP upstream (accepts, never answers) → list without it and a readable call error without the URL, both within budget. `scripts/gateway-db-int.sh` → **26/26** (DB + seed + timeouts). `scripts/check-chart.sh` → kubeconform 24/24 valid, policy 0 violations, values diff PASS. k3d: `gateway:sha-bc5d9c54189e`, rev 19, rollout OK, log `upstream pool ready timeouts={connectMs:2000,listMs:3000,callMs:15000}`; Inspector CLI 2.10.1 through Traefik → 5 `woo__*` tools, `woo__list_orders` → 2 orders (`outcome=ok ms=353`); dev key occurrences in gateway log: 0.
- **Regression risk:** A stateless upstream (woo-mcp) cannot act on `notifications/cancelled` (arrives on a fresh server instance): only the HTTP request is aborted, so a slow write may still complete after the client saw `upstream_timeout`. Budgets are gateway-wide, not per upstream (MCP_DESIGN §6).

### GW-10 — Failure isolation + health loop
- **Priority:** P0
- **Status:** Done
- **Day:** 3
- **Depends on:** GW-09
- **Requirements:** REQ-GW-05, REQ-GW-09, REQ-DOD-10
- **Description:** allSettled fan-out; health check every 10 s (list or ping); status Connected / Unreachable / Disabled with `last_error` and `last_checked_at`.
- **Output:** Health module.
- **Acceptance:** TC-INT-04 passes.
- **Tests:** TC-INT-04.
- **Command:** `npm run test:int -w services/gateway`
- **Evidence:** 2026-10-13: `src/upstreams/health.ts` `HealthMonitor` (loop every `HEALTH_INTERVAL_MS`=10 s, parallel `ping` under the 3 s list budget; status connected/unreachable/disabled/unknown + `lastError`/`lastCheckedAt`/`lastOkAt`; passive reports from lists and calls; slow tool calls do not affect health), wired into discovery (unreachable → not contacted, no stale list) and `tools/call` (unreachable → `upstream_unreachable: <lastError>` at once). Typecheck clean. **TC-INT-04 PASS** — `test/int/health.int.test.ts` 5/5: dead upstream → unreachable with `lastError` "upstream everything unreachable: ECONNREFUSED" (no URL), other upstream listed and callable, list < 200 ms and call < 200 ms without contacting it, restart on the same port → connected, tools back; hung TCP upstream → unreachable within one check budget, next list skips it; disabled → `disabled`, 0 requests; refused call marks unreachable without the loop; loop alone notices death and recovery. Unit + TC-INT-03 + TC-INT-04 together 57/57 ×5; `scripts/gateway-db-int.sh` → **31/31**. Also fixed a pre-existing cold-start flake (TC-GW-05-1 failed 1 in 3 on the old code with a 300 ms budget) by giving non-timeout tests a larger budget. Chart: `HEALTH_INTERVAL_MS` from `gateway.healthIntervalMs`; `check-chart.sh` 0 violations, values diff PASS. **k3d** (`gateway:sha-2adb8f59d027`, rev 20): startup log `woo unknown→connected`; `kubectl -n store scale deploy/woo-mcp --replicas=0` → log `connected→unreachable err="upstream woo unreachable: ECONNREFUSED"` 4 s later; curl `tools/call woo__list_orders` → `isError` `upstream_unreachable: upstream woo unreachable: ECONNREFUSED` in **0.059 s** (gateway `ms=3`); `tools/list` → `[]` in 0.025 s (`failed=["woo"] ms=2`); scaled back to 1 → `unreachable→connected` 9 s after Ready, list → 5 tools. Dev key occurrences in gateway log: 0.
- **Regression risk:** Health is per replica (in memory): with 2+ replicas each one checks on its own and the dashboard shows the answering replica's view. After a recovery, tools reappear only on the next loop round (≤ 10 s); a transient refused connection hides an upstream for up to one interval.

### GW-11 — Enable/disable behaviour
- **Priority:** P0
- **Status:** Done
- **Day:** 3
- **Depends on:** GW-08
- **Requirements:** REQ-GW-01, REQ-DOD-09
- **Description:** A disabled upstream is excluded from the list; calls are rejected with `upstream_disabled`; the pool connection is closed.
- **Output:** Logic + test.
- **Acceptance:** TC-INT-05 passes.
- **Tests:** TC-INT-05.
- **Command:** `npm run test:int -w services/gateway`
- **Evidence:** 2026-10-13: list/call/pool behaviour already existed (GW-06/08: registry read from the DB per request, `pool.sync` closes disabled entries); added `setUpstreamEnabled(db, id, enabled)` in `src/upstreams/repo.ts` (for PATCH `/api/upstreams/:id`) and **fixed** `pool.sync` to keep registry order — before, a disabled-then-enabled upstream moved to the end of `tools/list`, so replicas could disagree on order. **TC-INT-05 PASS** — `test/int/enable.int.test.ts` (real Postgres, two gateway replicas on one DB) 3/3: disable → both replicas on their next request list only `woo__echo`, `everything__add` → `-32602 upstream everything is disabled`, `data.code=upstream_disabled`, pooled client closed, woo calls fine, disabled upstream receives **0** requests (incl. health rounds; status `disabled`); enable → tools and calls back on both; a replica without `/mcp` traffic closes the connection on its next health round; unknown id → undefined. `scripts/gateway-db-int.sh` → **34/34** ×3; unit 49/49 ×3; typecheck clean. **k3d** (`gateway:sha-007a4d429950`, rev 21): `UPDATE upstreams SET enabled=false … WHERE slug='woo'` (psql in postgres-0; no admin API yet) → `tools/list` → `[]` (0.036 s), `tools/call woo__list_products` → `-32602 … upstream woo is disabled`, `data.code=upstream_disabled`; `enabled=true` → 5 tools, `list_products` ok (`ms=454`); no restart. Dev key occurrences in gateway log: 0.
- **Regression risk:** Replicas see the change on next request (read from DB; no stale in-memory flag).

### GW-12 — Encrypted credential injection
- **Priority:** P0
- **Status:** Done
- **Day:** 3
- **Depends on:** GW-04
- **Requirements:** REQ-GW-01, REQ-GW-07
- **Description:** AES-256-GCM (D-009); header/bearer injection; never forward the inbound Authorization.
- **Output:** `crypto.ts`, transport header builder.
- **Acceptance:** TC-UNIT-05, TC-INT-06 pass.
- **Tests:** TC-UNIT-05, TC-INT-06.
- **Command:** `npm test -w services/gateway`
- **Evidence:** 2026-10-13 (encryption itself: GW-03): header builder extracted to `upstreamHeaders(key, row)` in `src/upstreams/pool.ts` — decrypts per row (slug as AAD), bearer or custom header, built from the row only; undecryptable credential or a value with CR/LF/control chars → `UpstreamUnavailableError` "stored credential …" without the value; upstream fetch uses `redirect: 'error'`. Probe: undici follows a 307 and keeps `X-Api-Key` (drops only `Authorization`) — SDK 1.32 already stops cross-origin redirects (`redirectPolicy: 'same-origin'`), ours is a second layer. **TC-UNIT-05** = TC-GW-03-U1/U2 (round trip, tampered/other key/other slug rejected), plus TC-GW-12-U1 (headers per auth type), U2 (4 bad credentials → error without the value), U3 (redirecting upstream → nothing reaches the target): `npm test -w services/gateway` → **52/52** ×3. **TC-INT-06 PASS** — `test/int/credentials.int.test.ts` (real Postgres): woo (header `X-Internal-Token`, stateless), github (bearer, sessionful, session restarted mid-test), plain (none); client sends its key + a spoofed `x-internal-token`; across list, calls, an `isError` call, health pings and the reconnect, every woo request carried exactly the woo token, every github request `Bearer <PAT>`, plain none; client key and spoofed value in 0 upstream requests; DB rows, `/mcp` responses and trace-level gateway logs contain neither secret nor the client key. Mutation check: also sending the woo token as `Authorization` → TC-INT-06 fails. `scripts/gateway-db-int.sh` → **35/35**. **k3d** (`gateway:sha-44fd77c114ca`, rev 22): `woo__list_orders` → 2 orders (woo-mcp accepted the injected token); woo token in the response 0, in gateway and woo-mcp logs 0; dev key in both logs 0; `credential_enc` does not contain the token.
- **Regression risk:** Key rotation not supported (documented).

### GW-13 — everything-mcp upstream in cluster
- **Priority:** P0
- **Status:** Done
- **Day:** 3
- **Depends on:** ARC-15, INF-10
- **Requirements:** REQ-GW-08
- **Description:** Deployment of server-everything (Streamable HTTP), probes, limits, NetworkPolicy gateway-only; registered via seed or values.
- **Output:** Template.
- **Acceptance:** Gateway lists `everything__*` tools.
- **Tests:** TC-GW-13-1: list via gateway → includes everything tools.
- **Command:** Inspector CLI list
- **Evidence:** 2026-10-13: new workspace `services/everything-mcp` (`@modelcontextprotocol/server-everything@2026.8.31`, locked in the root `package-lock.json`; image `node:24.19.0-alpine3.24`, uid 1000, `GZIP_ALLOWED_DOMAINS=invalid`); chart `templates/platform/everything-mcp.yaml`: Deployment (TCP readiness/liveness probes — the server has no health route; requests 20m/64Mi, limit 192Mi; read-only root FS, all caps dropped, no SA token, `enableServiceLinks: false`, **no Secrets or credentials in the pod** — it has a `get-env` tool, T-15), ClusterIP Service, NetworkPolicy ingress from `app=gateway` only and **no egress**. Registered by the gateway seeder (`loadSeeds()` in `src/upstreams/seed.ts`: woo, everything [auth none], github; `SEED_EVERYTHING_URL` from `gateway.seed.everything`). `docker run --read-only` + `probe.mjs` → 13 tools, sessionful. Unit **55/55** (new TC-GW-13-U1, TC-GW-14-U1); `scripts/check-chart.sh` → 27/27 valid, 0 violations, values diff PASS. **k3d** (rev 24, `everything-mcp:sha-54d4fbad9d2e`, `gateway:sha-f923b4c2a35a`): log `seed upstream everything created`, `everything unknown→connected`. **TC-GW-13-1 PASS** — Inspector CLI 2.10.1 through Traefik `tools/list` → **64 tools {woo:5, everything:13, github:46}** incl. `everything__echo … everything__simulate-research-query`; `everything__echo` → `Echo: via gateway` (58 ms), `everything__get-sum {2,40}` → 42; `get-env` → only PORT/NODE_ENV/HOME/PATH/KUBERNETES_*/GZIP_ALLOWED_DOMAINS (no secret); SSRF attempt `gzip-file-as-resource data=http://wordpress.store.svc…` → `isError` "Domain … is not in the allowed domains list". `scripts/k8s-checks.sh netpol` → **12/12 PASS** incl. TC-GW-13-2a/b everything-mcp from an intruder pod / from `store` → CLOSED, 2c from `app=gateway` → OPEN, 2d raw TCP egress from the everything pod to the API server ClusterIP → CLOSED (same probe from the gateway → OPEN).
- **Regression risk:** Image or command differences → pin the version.

### GW-14 — GitHub remote upstream
- **Priority:** P0
- **Status:** Done
- **Day:** 3
- **Depends on:** GW-12, P0-04
- **Requirements:** REQ-GW-08, REQ-GW-07
- **Description:** Register `github` with the bearer PAT through the admin API (or seed from a Secret); egress allowed.
- **Output:** Registered upstream.
- **Acceptance:** `github__*` tools listed; the PAT never appears in any response or log.
- **Tests:** TC-GW-14-1: list → github tools. TC-AUTH-04 scan.
- **Command:** Inspector CLI list
- **Evidence:** 2026-10-13: seeded from Secret `upstream-seed` key `github-pat` (`SEED_GITHUB_URL`=`gateway.seed.github.url` https://api.githubcopilot.com/mcp/, `SEED_GITHUB_TOKEN` secretKeyRef optional; empty PAT → github skipped with a warning, the gateway still starts — TC-GW-14-U1), bearer credential AES-GCM encrypted in Postgres; gateway egress was already open (NetworkPolicy restricts ingress only). **k3d**: log `seed upstream github created`, `github unknown→connected`. **TC-GW-14-1 PASS** — Inspector CLI `tools/list` through Traefik → 46 `github__*` tools (64 total, 4.9 s cold); `github__get_me` → `login=Ragx09` (1383 ms); `github__list_issues` on a missing repo → readable `isError` passed through. **PAT scan** (exact value and 20-char prefix, `grep -cF`): tools/list output 0, call results 0, error result 0, `everything__get-env` 0, gateway log (141 lines) 0, `upstreams.credential_enc` 0. TC-AUTH-04 (`/api` responses) still runs with AUTH-15. Toolset not limited: all 46 tools kept for now (GitHub toolset URL `/mcp/x/issues` is the fallback if the chat model struggles, UI-14).
- **Regression risk:** GitHub tool count is large (many tools) → consider a toolset header `X-MCP-Toolsets: issues` to limit.

### GW-15 — Cross-server call test
- **Priority:** P0
- **Status:** Done
- **Day:** 3
- **Depends on:** GW-13, GW-14
- **Requirements:** REQ-DOD-07
- **Description:** Script calls `woo__list_orders` then `github__create_issue` with a summary.
- **Output:** `scripts/cross-server.mjs`.
- **Acceptance:** Issue created in the throwaway repo.
- **Tests:** TC-GW-15-1: run → issue URL printed.
- **Command:** `node scripts/cross-server.mjs`
- **Evidence:** 2026-10-26 k3d (rev 29), after the user made the repo public and gave the PAT Issues read/write: `GITHUB_REPO=Ragx09/mcp-issue-write-test node scripts/cross-server.mjs` → `ok tools/list (83 tools, woo + github present)`, `ok woo__list_orders (470 ms)`, `ok github__issue_write (1356 ms)`, `issue https://github.com/Ragx09/mcp-issue-write-test/issues/1`. Earlier the same day: 2026-10-26 k3d: `GITHUB_REPO=Ragx09/mcp-issue-write-test node scripts/cross-server.mjs` → `ok tools/list (69 tools)`, `ok woo__list_orders`, then `github__issue_write` 404 (repo private, PAT sees public repos only); user made the repo public → `403 Resource not accessible by personal access token` (fine-grained PAT has read-only public-repo access). Resolved by the user (PAT Issues read/write). 2026-10-13: `scripts/cross-server.mjs` written (one SDK client → gateway `/mcp`; checks both tools are listed, `woo__list_orders` → summary by status/value + table → `github__issue_write {method:create}`; prints the issue URL; `--dry-run` stops before writing; `GITHUB_REPO=owner/repo` required, key read from Secret `gateway-dev-key` and never printed). Dry run on k3d: `ok tools/list (64 tools, woo + github present)`, `ok woo__list_orders (501 ms)`, issue text with 2 orders (processing 2, 2598.00 INR). **Unblocked 2026-10-25: the user created the throwaway repo `Ragx09/mcp-issue-write-test`; the real run (`GITHUB_REPO=Ragx09/mcp-issue-write-test node scripts/cross-server.mjs`, then `scripts/e2e.sh cross`) needs the k3d cluster and is still to do.** Was blocked: the throwaway repo the PAT may write to was not recorded (P0-04) and is not visible through `search_repositories` (only public repos, none a throwaway); not guessing, because the issue would be public. Needs the repo name from the user, then `GITHUB_REPO=<owner/repo> node scripts/cross-server.mjs`.
- **Regression risk:** —

### GW-16 — Kill-pod resilience test
- **Priority:** P0
- **Status:** Done
- **Day:** 3
- **Depends on:** GW-10, GW-13
- **Requirements:** REQ-DOD-10, REQ-GW-05
- **Description:** Scale everything-mcp to 0 (and also `kubectl delete pod`) → list still returns woo+github within 3 s; status Unreachable; recovers when back.
- **Output:** `scripts/k8s-checks.sh killpod`.
- **Acceptance:** As described.
- **Tests:** TC-GW-16-1: scale 0 → list ok without everything → status Unreachable. TC-GW-16-2: scale 1 → Connected within 20 s.
- **Command:** `scripts/k8s-checks.sh killpod`
- **Evidence:** 2026-10-13: `scripts/k8s-checks.sh killpod` (curl JSON-RPC to the public `/mcp`, gateway log `upstream status changed` as the status source until the API exists). Chart: `terminationGracePeriodSeconds: 5` for everything-mcp (node is PID 1 without a SIGTERM handler; a delete used to wait the full 30 s — found by this test). **k3d rev 25, 13/13 PASS, twice:** baseline list 0.97 s [woo:5 everything:13 github:46]; **TC-GW-16-1** scale 0 → list 0.69 s [woo:5 github:46], everything → Unreachable at once (the refused connect is reported passively), list while Unreachable 0.85 s, `everything__echo` → `upstream_unreachable: upstream everything unreachable: ECONNREFUSED`, `woo__list_products` still OK; **TC-GW-16-2** scale 1 → Connected **7 s** after Ready (≤ 20 s), list 0.97 s with all 64 tools, `everything__echo` → `Echo: back`; **kubectl delete pod** → list 0.66 s with woo + github (replacement already serving), new pod answers `everything__echo` at once on a new MCP session (stale session reconnect, D-013 finding), list complete. Run time 75 s → 33 s after the grace-period fix. Dashboard status display: E2E-09.
- **Regression risk:** —

### GW-17 — Structured logging with redaction
- **Priority:** P1
- **Status:** Done
- **Day:** 3
- **Depends on:** GW-01
- **Requirements:** REQ-K8S-09
- **Description:** Request ID per call; redaction paths; no tool args at info level.
- **Output:** Logger config + test.
- **Acceptance:** TC-UNIT-06 passes.
- **Tests:** TC-UNIT-06.
- **Command:** `npm test -w services/gateway -- redact`
- **Evidence:** 2026-10-13: `src/logger.ts` — (1) request id = random UUID per request (`genReqId`; a client `X-Request-Id` is ignored), returned as `x-request-id` on every response incl. the hijacked `/mcp` replies, present on every line of the request; (2) name-based redaction extended (top level + one level down + nested `headers`: authorization, cookie, password, credential(Enc), token, pat, apiKey, secret, consumer/client secrets, `mcp-session-id` …); (3) value-based scrub as a second layer (`formatters.log` + `hooks.logMethod`): Bearer/Basic values, GitHub PATs (`github_pat_`, `gh?_`), our `mgw_` keys, WooCommerce `ck_/cs_` keys, `sk-`/`gsk_` LLM keys are masked anywhere — msg text, error messages, unknown fields, arrays; plain objects only, so Fastify `req`/`res` reach their serializers intact; (4) `tools/call` logs at info only `reqId, upstream, tool, outcome, ms`; at debug the argument *names*; never values or results; (5) `/healthz` and `/readyz` log at warn only (probe noise: 0 lines). `pino` 10.4.0 declared as a devDependency (was only transitive). **TC-UNIT-06 PASS** — `npm test -w services/gateway -- redact` → 5/5; **mutation-checked**: removing the value scrub, the msg scrub, the key list, logging `args`, or the UUID ids each fails the matching test; a scrubber that flattened `req` to `{}` (found on k3d, first deploy) is now caught too. Unit **60/60** (11 sequential runs; one earlier full run had 1 unexplained failure that did not recur; 5 suites in parallel overload the machine and fail across unrelated files, not a test signal); typecheck clean; `scripts/gateway-db-int.sh` → **35/35**. **k3d** (`gateway:sha-65e80bd829f8`, rev 27): `github__get_me` with a forged `X-Request-Id` → response `X-Request-Id: ec9a8fca-…` (UUID), the 3 log lines of that request carry it (`incoming request` with method/url/host, `tools/call upstream=github tool=get_me outcome=ok ms=2019`, `request completed statusCode=200`); forged id in log 0; probe lines 0; wrong key → 401 + `rejected /mcp request` line, key in log 0; GitHub PAT / dev key / woo token / `get_me` login in the log: **0 / 0 / 0 / 0**. `scripts/k8s-checks.sh killpod` 13/13 again; chart 0 violations.
- **Regression risk:** —

---

## Phase 5 — Identity, team management, API keys and auditing
Exit criterion: separate users authenticated; access enforced; revoked keys rejected; tool calls audited correctly.

### AUTH-01 — Users and roles schema
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** GW-02
- **Requirements:** REQ-AUTH-01
- **Description:** users(id, email, name, role admin|member, password_hash, disabled_at); sessions; invites; api_keys; audit_log tables.
- **Output:** Migration.
- **Acceptance:** Migration applies.
- **Tests:** TC-AUTH-01-1: migrate fresh → tables exist.
- **Command:** `npm run db:migrate -w services/gateway`
- **Evidence:** 2026-10-13: `src/db/schema.ts` + migration `drizzle/0002_auth.sql` (drizzle-kit generate): `users` (email lower-case + unique, role admin|member, `password_hash` must be argon2id PHC, `disabled_at` — users are disabled, not deleted), `sessions` (keyed by **SHA-256 of the cookie token**, expiry > created, indexes user/expiry), `invites` (`token_hash`, role, 72 h expiry set by AUTH-04, `used_at/used_by`), `api_keys` (D-008: `key_hash` SHA-256 hex unique + `prefix` `mgw_`+8, owner, created_by, last_used, revoked_at/by), `audit_log` (see AUTH-12); `upstreams.created_by` now a FK to users (set null). Every invariant is a DB CHECK: a plaintext key, raw session/invite token or non-argon2 password is refused by the database itself. Found and fixed while writing the test: `\s` inside the Drizzle `sql` template lost its backslash (`[^@s]`), now `[[:space:]]`. **TC-AUTH-01-1 PASS** — `test/int/auth-schema.int.test.ts` 6/6 on a fresh DB: columns + indexes of all five tables; email case/unique/format, role, password-hash rules; plaintext key / whole key as prefix / duplicate hash refused; raw tokens and past expiry refused; user deletion cascades sessions + keys; `upstreams.created_by` FK. `scripts/gateway-db-int.sh` → **41/41**; unit 60/60; typecheck clean. **k3d** (`gateway:sha-b4130f09b570`, rev 28): migration applied on the existing DB (3 migrations recorded), `\dt` → api_keys app_meta audit_log invites sessions upstreams users; seeded upstreams kept (`unchanged`/`admin-edited`), `cross-server.mjs --dry-run` → 64 tools, `woo__list_orders` ok.
- **Regression risk:** —

### AUTH-02 — Admin seed + login
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-01
- **Requirements:** REQ-AUTH-01
- **Description:** Seed the first admin from Secret `gateway-admin`; `POST /api/auth/login` (argon2id verify, rate limit).
- **Output:** Route + test.
- **Acceptance:** Correct password → session cookie; wrong → 401.
- **Tests:** TC-AUTH-02-1/2.
- **Command:** `npm test -w services/gateway -- auth`
- **Evidence:** 2026-10-13: `src/auth/` — `password.ts` (argon2id via `@node-rs/argon2` 2.2.1, m=19456 t=2 p=1, PHC strings; unknown users verified against a dummy hash so timing does not reveal accounts; >256-char passwords refused unhashed), `tokens.ts` (32-byte base64url tokens, SHA-256), `sessions.ts` (row keyed by SHA-256 of the cookie token, 12 h), `limiter.ts` (failures per IP+email 5 and per IP 20 in a sliding 15 min window → 429 + Retry-After; success clears the account counter; in memory per replica), `seed-admin.ts` (Secret `gateway-admin` → `ADMIN_EMAIL`/`ADMIN_PASSWORD`, created only while no admin exists, advisory lock), `routes.ts` `POST /api/auth/login` (`@fastify/cookie` 11.1.2; `sid` cookie HttpOnly, SameSite=Strict, Secure from `COOKIE_SECURE` = chart `global.scheme == https`, Path=/, Max-Age 43200; one answer `401 invalid_credentials` for unknown email, wrong password and disabled user). Fastify now rejects unknown body fields (`removeAdditional: false`). Dependency versions picked ≥ 2 weeks old. `scripts/make-secrets.sh` creates `platform/gateway-admin`. Int tests now run file by file (`--no-file-parallelism`): argon2 CPU load made the cold-start timing of TC-INT-03 flaky once (1 failure, then 7/7 green). **Tests:** unit 64/64 (TC-AUTH-02-U1 hash/verify, U2 unknown-user timing within 0.5–2× of a wrong password, U3 limiter); **TC-AUTH-02-1/2/3/4 PASS** in `test/int/auth-login.int.test.ts` (seed once/never overwrite; right password → cookie attrs + only the token hash in `sessions`; wrong/unknown/disabled → identical 401 without cookie; 5 failures → 429 even with the right password while another IP logs in; malformed or extra fields → 400); **mutation-checked** (dropping the disabled check, the failure count, the cookie flags or the dummy verify each fails a test); `scripts/gateway-db-int.sh` → **46/46** ×3; chart 0 violations, values diff PASS (COOKIE_SECURE allowed: derived from the scheme). **k3d** (`gateway:sha-f8fe13344435`, rev 29, musl argon2 binary in the image): `seed admin created`; through Traefik: right password → 200 `{user:{…role:"admin"}}` + `Set-Cookie: sid=<43>; Max-Age=43200; Path=/; HttpOnly; SameSite=Strict` (0.28 s); wrong → 401 (0.078 s), unknown → identical 401 (0.078 s); 5 failures → right password 429 `Retry-After: 900`; DB: `$argon2id$v=19$m=19456,t=2,p=1…`, session `id_hash` 64 hex; admin password in the gateway log 0. **Finding:** every request reaches the gateway as `10.42.0.1` (Traefik Service `externalTrafficPolicy: Cluster` SNATs), so per-IP limits are global and 5 bad logins from anyone lock the admin out for 15 min. Fix for the VPS: `scripts/vps-install-k3s.sh` writes a Traefik `HelmChartConfig` with `externalTrafficPolicy: Local`; validated on k3d (Service switched to Local in 12 s, store 200, the gateway saw `172.19.0.4` instead of the SNAT address), then reverted locally. Real-IP check on the VPS: REL-01.
- **Regression risk:** —

### AUTH-03 — Sessions
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-02
- **Requirements:** REQ-AUTH-01
- **Description:** DB sessions, httpOnly + SameSite=Strict (+ Secure in prod) cookie, 12 h expiry, logout, Origin check on mutations.
- **Output:** Middleware.
- **Acceptance:** `/api/me` works with the cookie; cross-origin POST rejected.
- **Tests:** TC-AUTH-03-1/2.
- **Command:** `npm test -w services/gateway -- session`
- **Evidence:** 2026-10-13: `src/auth/guard.ts` — `requireSession(db)` (401 `unauthenticated` unless the cookie maps to an unexpired session of an enabled user), `requireRole(...)` (403 `forbidden`; used by AUTH-10), Origin check on every mutating `/api` request (`Origin` must equal `PUBLIC_ORIGIN`; else `Sec-Fetch-Site` must be same-origin/none; neither header = not a browser → allowed; no configured origin → fail closed) → 403 before any route work; `routes.ts` `POST /api/auth/logout` (deletes the row, clears the cookie, idempotent 204), `GET /api/me`. Sessions: fixed 12 h, `last_seen_at` refreshed at most every 5 min. Chart: `PUBLIC_ORIGIN` = `<scheme>://app.<domain>`; `COOKIE_SECURE` (AUTH-02). **TC-AUTH-03-1 PASS** (`test/int/auth-session.int.test.ts` 5/5): `/api/me` with the cookie → `{id,email,name,role}`; missing/empty/forged/oversized cookie → 401; logout → old cookie 401, `Set-Cookie: sid=; Max-Age=0 … HttpOnly; SameSite=Strict`; disabled user and expired session → 401 on the next request; member on an admin-only route → 403, admin → 200, no session → 401. **TC-AUTH-03-2 PASS**: with a valid admin cookie, Origin `https://evil.example`, `http://` variant, look-alike suffix, `null`, `Sec-Fetch-Site: cross-site` and `same-site` → 403; own origin, same-origin, no browser headers → 200; cross-origin login → 403 without cookie (login CSRF); cross-origin GET still answered. TC-AUTH-03-U1 (rules + `PUBLIC_ORIGIN` validation). **Mutation-checked** (no origin hook, ignoring `Sec-Fetch-Site`, disabled users keeping sessions, logout keeping the row: each fails a test). Unit 65/65, `scripts/gateway-db-int.sh` 51/51, chart 0 violations. **k3d** (`gateway:sha-310f31ea3e5b`, rev 30) via Traefik: login with Origin → 200; `/api/me` with cookie 200, without 401; logout from `https://evil.example` → 403 and the session still works; login from evil origin → 403; logout with our Origin → 204, `/api/me` → 401; log lines `cross-origin /api request refused origin=https://evil.example`; admin password in log 0.
- **Regression risk:** —

### AUTH-04 — Invitations
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-03
- **Requirements:** REQ-AUTH-02
- **Description:** Admin `POST /api/invites` → one-time link (token hashed, 72 h, role member|admin).
- **Output:** Route + test.
- **Acceptance:** TC-AUTH-03 passes.
- **Tests:** TC-AUTH-03.
- **Command:** `npm test -w services/gateway -- invite`
- **Evidence:** 2026-10-13: `src/auth/invites.ts` + `invite-routes.ts`: `POST /api/invites` (admin; `{email, role?}` → 201 `{id,email,role,expiresAt,inviteUrl}`; token = 32 random bytes, only SHA-256 stored, 72 h; the link carries the token in the `#fragment` so it never reaches a server or a log; a new invite deletes the open ones for that email; existing user → 409), `GET /api/invites` (admin; open invites, no token/hash). **Contract change:** the invitee endpoints take the token in the body (`POST /api/invites/check`, `POST /api/invites/accept`) instead of `/api/invites/:token`, because request URLs are logged. **TC-AUTH-03 PASS** (`test/int/invite.int.test.ts` 7/7): link format, hash-only storage, 72 h; member → 403, anonymous → 401, existing email → 409, bad email/role/extra field → 400; expired → 410 `invite_expired` (no user created); older invite replaced → 404; unknown → 404; used → 410. Mutation-checked (single-use, expiry and replacement removed → tests fail). **k3d** (rev 31) via Traefik: admin login → `POST /api/invites {"email":"bob@example.invalid"}` → `inviteUrl http://app.127.0.0.1.nip.io/invite#<token>`, expires +72 h; `/api/invites/check` 200; `/api/invites/accept` 201 `{user:{…role:"member"}}` + cookie, Bob `/api/me` 200; reuse → 410 `invite_used`; Bob creating an invite → 403; re-inviting Bob → 409; DB: invite `used`, `token_hash` 64 hex, Bob `$argon2id$`; invite token, Bob's and the admin's password in the gateway log: 0 / 0 / 0.
- **Regression risk:** —

### AUTH-05 — Accept invite
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-04
- **Requirements:** REQ-AUTH-02
- **Description:** `POST /api/invites/:token/accept` sets name and password; token consumed.
- **Output:** Route.
- **Acceptance:** Second use → 410.
- **Tests:** TC-AUTH-05-1.
- **Command:** `npm test -w services/gateway -- invite`
- **Evidence:** 2026-10-13: `POST /api/invites/accept {token,name,password}` → 201 `{user}` + session cookie (signed in at once); password rules (≥12, ≤256) checked before hashing; the invite is consumed by a conditional `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING` in the same transaction as the user insert, so concurrent accepts cannot both win; the role comes from the invite only. **TC-AUTH-05-1 PASS**: check → accept → `/api/me` and password login work, `used_at/used_by` set; second accept → **410** `invite_used`, user unchanged; 3 simultaneous accepts → `[201, 410, 410]`, one user; admin-role invite → admin; weak password → 400 and the invite stays usable; extra `role` field → 400; cross-origin accept → 403. Also replaced the timing-based TC-AUTH-02-U2 (flaky under parallel load, 1 in 6–8 runs) with a deterministic spy test: an unknown email runs a real argon2 `verify` against a hash with the same parameters (catches both "no dummy" and "cheaper dummy" mutations); unit 65/65 ×6. `scripts/gateway-db-int.sh` → **58/58**. **k3d** (rev 31) via Traefik: admin login → `POST /api/invites {"email":"bob@example.invalid"}` → `inviteUrl http://app.127.0.0.1.nip.io/invite#<token>`, expires +72 h; `/api/invites/check` 200; `/api/invites/accept` 201 `{user:{…role:"member"}}` + cookie, Bob `/api/me` 200; reuse → 410 `invite_used`; Bob creating an invite → 403; re-inviting Bob → 409; DB: invite `used`, `token_hash` 64 hex, Bob `$argon2id$`; invite token, Bob's and the admin's password in the gateway log: 0 / 0 / 0.
- **Regression risk:** —

### AUTH-06 — API key generation
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-03
- **Requirements:** REQ-AUTH-03
- **Description:** `POST /api/keys` (own) and admin `POST /api/users/:id/keys`; returns plaintext once.
- **Output:** Route.
- **Acceptance:** Key works on `/mcp`.
- **Tests:** TC-AUTH-06-1.
- **Command:** `npm test -w services/gateway -- keys`
- **Evidence:** 2026-10-13: `src/auth/api-keys.ts` + `key-routes.ts`: `POST /api/keys {name}` (own) and admin `POST /api/users/:id/keys` → 201 `{id,name,prefix,createdAt,key}` — the only time the key is shown; key = `mgw_` + 43 base62 chars from 32 CSPRNG bytes; max 20 active keys per user (409); `GET /api/keys` own keys, admin `?all=1` everyone's (member → 403), never a hash or key. **TC-AUTH-06-1 PASS**: a member's new key lists and calls tools through `/mcp` with the SDK client, `last_used_at` set, list shows prefix + owner only, key never forwarded upstream; admin-issued key works; member issuing for others → 403; unknown user → 404, bad id → 400; limit 20 → 409; anonymous 401; cross-origin 403. TC-UNIT-02 (format, 2000 keys unique, all 62 characters used, 12-char prefixes distinct). `test/int/api-keys.int.test.ts` (real Postgres + real `/mcp` + fake upstream) 7/7; `scripts/gateway-db-int.sh` → **65/65**; unit **66/66**; typecheck clean; chart 0 violations. **k3d** (`gateway` rev 32): old shared dev key → 401; member Bob (from the AUTH-05 invite) logs in, `POST /api/keys` → `mgw_Su4KKF6k…` (47 chars), MCP Inspector CLI 2.10.1 `tools/list` → 64 tools, `tools/call woo__list_orders` → order 139; Bob `GET /api/keys?all=1` → 403; `DELETE /api/keys/:id` → 204 and the next `/mcp` call → **401**; gateway log line `tools/call` carries `userId`+`keyId` of Bob; Bob's key in the log 0.
- **Regression risk:** —

### AUTH-07 — Hashed key storage
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-06
- **Requirements:** REQ-AUTH-05
- **Description:** SHA-256 hash + prefix only (D-008).
- **Output:** Key module.
- **Acceptance:** DB contains no plaintext key (query check).
- **Tests:** TC-UNIT-02; TC-AUTH-07-1: `select` → only hash and prefix.
- **Command:** `kubectl -n platform exec sts/postgres -- psql -c 'select prefix, length(key_hash) from api_keys'`
- **Evidence:** 2026-10-13: `api_keys` stores `key_hash` = SHA-256 hex (DB CHECK, unique) + `prefix` (`mgw_`+8, DB CHECK) — the AUTH-01 schema refuses a plaintext key (TC-AUTH-01-1). **TC-AUTH-07-1 PASS**: after issuing a key, `SELECT * FROM api_keys` contains its SHA-256 but neither the key nor its secret part (characters 13+). k3d: `select name, prefix … from api_keys` shows only prefixes. `test/int/api-keys.int.test.ts` (real Postgres + real `/mcp` + fake upstream) 7/7; `scripts/gateway-db-int.sh` → **65/65**; unit **66/66**; typecheck clean; chart 0 violations.
- **Regression risk:** —

### AUTH-08 — Key validation on /mcp
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-07, GW-06
- **Requirements:** REQ-AUTH-03, REQ-GW-12
- **Description:** Bearer key → user context; remove the temporary dev key; update `last_used_at`.
- **Output:** Middleware.
- **Acceptance:** TC-AUTH-01 passes.
- **Tests:** TC-AUTH-01.
- **Command:** `npm run test:int -w services/gateway`
- **Evidence:** 2026-10-13: `/mcp` authenticates `Authorization: Bearer <key>` (scheme case-insensitive) with `authenticateApiKey()`: format check, then a DB lookup by SHA-256 joined with the owner — revoked keys and disabled users refused, no cache; `last_used_at` written at most once a minute; the caller (`principal` = user, key, role) is attached to the request and every log line (attribution for AUTH-11/13). **Temporary dev key removed**: `MCP_DEV_KEY` config, chart env + `gateway.devKeySecret`, `make-secrets.sh` entry, and the Secret on k3d (deleted after checking nothing referenced it). Scripts now use short-lived keys: `scripts/lib/gateway-key.mjs` logs in as the seeded admin, creates a key and revokes it afterwards (`cross-server.mjs`, `k8s-checks.sh killpod`); tests use `test/helpers/static-auth.ts`. **TC-AUTH-01 (key part) PASS**: no header, forged `mgw_…`, key + 1 char, key − 1 char, `Basic`, bare key, empty bearer → 401 `invalid_api_key` (audit rows: AUTH-13). Mutation-checked (revoked accepted, disabled owner accepted → tests fail). k3d: `cross-server.mjs --dry-run` → 64 tools, `woo__list_orders` ok, its temp key revoked; `k8s-checks.sh killpod` 13/13 with its own temp key (revoked). **k3d** (`gateway` rev 32): old shared dev key → 401; member Bob (from the AUTH-05 invite) logs in, `POST /api/keys` → `mgw_Su4KKF6k…` (47 chars), MCP Inspector CLI 2.10.1 `tools/list` → 64 tools, `tools/call woo__list_orders` → order 139; Bob `GET /api/keys?all=1` → 403; `DELETE /api/keys/:id` → 204 and the next `/mcp` call → **401**; gateway log line `tools/call` carries `userId`+`keyId` of Bob; Bob's key in the log 0.
- **Regression risk:** —

### AUTH-09 — Revocation
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-08
- **Requirements:** REQ-AUTH-04, REQ-DOD-08
- **Description:** `DELETE /api/keys/:id` (owner or admin) sets revoked_at; the next request is rejected.
- **Output:** Route.
- **Acceptance:** Revoke → the immediately following call → 401.
- **Tests:** TC-AUTH-09-1.
- **Command:** `npm run test:int -w services/gateway -- revoke`
- **Evidence:** 2026-10-13: `DELETE /api/keys/:id` (owner or admin) → 204, sets `revoked_at/revoked_by`, idempotent; another member's key → **404** (ids cannot be probed). Every `/mcp` request re-reads the key row, so revocation applies to the very next request. **TC-AUTH-09-1 PASS**: key works → another member's DELETE 404 (key still works) → owner DELETE 204 → the immediately following `/mcp` call **401**; repeat DELETE 204; admin revokes a member's key → 401, `revoked_by` = admin; disabling a user stops all their keys at once and re-enabling restores them. Mutation-checked (members revoking any key → test fails). **k3d** (`gateway` rev 32): old shared dev key → 401; member Bob (from the AUTH-05 invite) logs in, `POST /api/keys` → `mgw_Su4KKF6k…` (47 chars), MCP Inspector CLI 2.10.1 `tools/list` → 64 tools, `tools/call woo__list_orders` → order 139; Bob `GET /api/keys?all=1` → 403; `DELETE /api/keys/:id` → 204 and the next `/mcp` call → **401**; gateway log line `tools/call` carries `userId`+`keyId` of Bob; Bob's key in the log 0.
- **Regression risk:** —

### AUTH-10 — Server-side authorization on /api
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-03
- **Requirements:** REQ-AUTH-01, REQ-GW-07
- **Description:** `requireRole('admin')` on server/member/audit/admin-key routes; table-driven test over all routes.
- **Output:** Guard + test.
- **Acceptance:** TC-AUTH-02 passes.
- **Tests:** TC-AUTH-02.
- **Command:** `npm test -w services/gateway -- authz`
- **Evidence:** 2026-10-13: **default-deny router** `src/auth/access.ts`: every `/api` route must declare `config.access` = public | session | admin, otherwise registering it throws (startup fails); the matching guard (`requireSession` [+ `requireRole('admin')`]) is attached as the route's first `onRequest` hook, so authentication and role run **before the body is parsed or validated**; `accessTable(app)` lists the policy of every registered route. All auth/invite/key routes converted. **TC-AUTH-02 PASS** — `test/int/authz.int.test.ts` 5/5 walks the routes actually registered (11): public set is exactly login, logout, invites/check, invites/accept; admin set exactly `GET/POST /api/invites`, `POST /api/users/:id/keys`; anonymous → 401 `unauthenticated` on every non-public route (empty body: auth before validation); member → 403 `forbidden` on every admin route, admin passes; member passes every session route; a `/api` route without a policy cannot be registered. **Mutation-checked**: dropping the admin role check (4 tests fail), moving the guard to `preHandler` after validation (2 fail), downgrading the issue-key route to session (2 fail). Server and member API routes (`/api/upstreams`, `/api/users`, `/api/audit`) do not exist yet (UI-04..09, AUTH-14); they are covered automatically by this table test when added. Unit 66/66, `scripts/gateway-db-int.sh` **70/70**. **k3d** (rev 33): member Bob → `POST /api/invites` 403, `GET /api/invites` 403, `POST /api/users/<uuid>/keys` 403; anonymous → 401 on all three.
- **Regression risk:** New routes forgetting the guard → default-deny router.

### AUTH-11 — Request attribution context
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-08
- **Requirements:** REQ-AUTH-06, REQ-CHAT-03
- **Description:** AsyncLocalStorage context {userId, keyId, source, requestId} available to the router and audit.
- **Output:** Context module.
- **Acceptance:** Audit rows carry the correct user.
- **Tests:** TC-AUTH-11-1.
- **Command:** `npm test -w services/gateway`
- **Evidence:** 2026-10-13: `CallContext {requestId, userId, keyId, source}` (`src/audit/audit.ts`) built by `/mcp` auth from the principal and passed **explicitly** to the per-request MCP server (`buildServer(deps, log, ctx)`); AsyncLocalStorage was not needed because the gateway already builds one server per request — explicit is simpler to follow and to test. The same principal is bound to every log line (`userId`, `keyId`, AUTH-08). `Principal.source` defaults to `mcp`; the chat agent's internal token will set `chat` (UI-15). **TC-AUTH-11-1 PASS** (`test/int/audit.int.test.ts`): Alice and Bob call `woo__echo` 10× concurrently → 10 rows, 5 per user, each with that user's own key id. Mutation: dropping the key from the context → 2 tests fail. **k3d** (rev 34) audit rows after real traffic: Bob's key "audit check" → `tools/list ok`, `tools/call woo list_orders ok 464 ms`, `everything echo ok 36 ms`, `woo woo__nope rejected unknown_tool`; a forged key → `tools/call denied invalid_api_key` with no user/key; `cross-server.mjs` → two rows for admin@example.invalid with its temporary key.
- **Regression risk:** —

### AUTH-12 — Audit schema
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-01
- **Requirements:** REQ-AUTH-06
- **Description:** Per ARC-08; indexes on ts and user.
- **Output:** Migration.
- **Acceptance:** Table exists with required columns.
- **Tests:** TC-AUTH-12-1.
- **Command:** `npm run db:migrate -w services/gateway`
- **Evidence:** 2026-10-13: delivered with the AUTH-01 migration (`drizzle/0002_auth.sql`). `audit_log`: `id` bigint identity, `ts`, `request_id` (the GW-17 request id), `user_id` (FK set null; **must** be null when outcome=denied), `api_key_id`, `source` mcp|chat, `method` tools/call|tools/list|initialize|other, `upstream_id` (no FK) + `upstream_slug` (text, survives upstream removal), `tool`, `duration_ms ≥ 0`, `outcome` ok|tool_error|error|timeout|unreachable|rejected|denied, `error_code` (`^[a-z_]{1,40}$`: codes only, no upstream free text); no argument/result columns. Indexes `audit_ts_idx (ts desc)`, `audit_user_ts_idx (user_id, ts desc)`, `audit_upstream_ts_idx (upstream_slug, ts desc)`. **TC-AUTH-12-1 PASS** (inside TC-AUTH-01-1, `auth-schema.int.test.ts`): columns and indexes present; all 7 outcomes accepted; denied-with-user, unknown outcome/source, negative duration and free-text error refused; rows remain after the user is deleted, with `user_id` cleared. On k3d: table present (rev 28). Outcome set extended from MCP_DESIGN §9 with `tool_error` and `rejected` (doc updated).
- **Regression risk:** —

### AUTH-13 — Audit writes for all outcomes
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-11, AUTH-12
- **Requirements:** REQ-AUTH-06, REQ-DOD-11
- **Description:** Write ok/error/timeout/denied (including invalid-key attempts with user null).
- **Output:** Audit writer.
- **Acceptance:** TC-AUTH-05 passes.
- **Tests:** TC-AUTH-05.
- **Command:** `npm run test:int -w services/gateway -- audit`
- **Evidence:** 2026-10-13: `dbAuditSink()` writes one `audit_log` row per `tools/call`, per `tools/list` and per refused `/mcp` request; the call handler is restructured so a single `finally` logs and audits exactly once whatever happens: `ok`, `tool_error` (upstream `isError`), `error`/`upstream_error`, `timeout`/`upstream_timeout`, `unreachable`/`upstream_unreachable`, `rejected` (`unknown_tool`, `upstream_disabled` — thrown JSON-RPC errors), registry failure → `error`/`registry_unavailable`; refused key → `denied`/`invalid_api_key` with user and key null and no client-supplied names; never arguments or results; codes validated `^[a-z_]{1,40}$`; a failed audit write is logged and never fails the call. **TC-AUTH-05 PASS** (`test/int/audit.int.test.ts` 5/5): list + 7 calls → exactly the 8 expected rows with method, upstream, tool, outcome, code, user, key, source, request id (unique per request), duration (timeout row ≥ 750 ms), upstream id; argument text absent; unreachable upstream → 2 `unreachable` rows; **TC-AUTH-01 audit part PASS**: no key / forged key / revoked key / unauthenticated list → 401 + `denied` rows without user; audit table renamed away → the call still succeeds. Mutation-checked (denied not audited, rejected not audited, wrong key attribution → tests fail). Unit test files now run one after another too (`--no-file-parallelism`, ~8 s): argon2 tests made the 300 ms discovery timing test TC-GW-05-2 fail 1 in 7 runs in parallel. Unit 66/66 ×6, `scripts/gateway-db-int.sh` **75/75** ×3. **k3d** (rev 34) audit rows after real traffic: Bob's key "audit check" → `tools/list ok`, `tools/call woo list_orders ok 464 ms`, `everything echo ok 36 ms`, `woo woo__nope rejected unknown_tool`; a forged key → `tools/call denied invalid_api_key` with no user/key; `cross-server.mjs` → two rows for admin@example.invalid with its temporary key.
- **Regression risk:** Audit failure must not lose the call result (log the error).

### AUTH-14 — Audit query API
- **Priority:** P0
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-13
- **Requirements:** REQ-AUTH-07
- **Description:** `GET /api/audit?user&upstream&outcome&from&to&limit&cursor` (admin).
- **Output:** Route.
- **Acceptance:** Filters work; members → 403.
- **Tests:** TC-AUTH-14-1.
- **Command:** `npm test -w services/gateway -- audit`
- **Evidence:** 2026-10-13: `src/audit/query.ts` `GET /api/audit` (access `admin`, default-deny table updated): filters `user` (uuid), `upstream` (slug), `outcome`, `source`, `from`/`to` (ISO date-time, from ≤ to), `limit` 1..200 (default 50), `cursor`; newest first; **keyset pagination** by id (no OFFSET; stable while new rows arrive); items `{id, ts, requestId, source, method, upstream, tool, durationMs, outcome, errorCode, keyPrefix, user:{id,email,name}|null}` — no hashes. **Tests PASS** (`test/int/audit-query.int.test.ts` 4/4): 31 seeded rows newest first with exact fields; each filter and a combination return the right counts; pages of 7 → 5 pages, 31 distinct ids in order, unaffected by a row inserted mid-way; member 403, anonymous 401, 10 bad filters (non-uuid user, unknown outcome, limit 0/500, bad date, negative/text cursor, path in upstream, unknown param, from > to) → 400. `scripts/gateway-db-int.sh` **80/80**; unit 66/66. **k3d** (rev 35): admin `GET /api/audit?limit=3` → the cross-server rows (admin, key `mgw_rYJGjz5e`) and the denied row, `nextCursor` 5; `?user=<Bob>&outcome=rejected` → 1; `?outcome=denied` → 1 row, no user; member 403, anonymous 401, `?outcome=maybe` 400. Note: an intermittent 10 s `beforeAll` timeout in `credentials.int.test.ts` (database create/drop checkpoints on the WSL Docker disk) → integration hook timeout raised to 30 s.
- **Regression risk:** —

### AUTH-15 — Secret redaction tests
- **Priority:** P1
- **Status:** Done
- **Day:** 4
- **Depends on:** AUTH-10, GW-12
- **Requirements:** REQ-GW-07, REQ-K8S-09
- **Description:** Scan every `/api` response and log output during the test run for known secret values.
- **Output:** Test.
- **Acceptance:** TC-AUTH-04 passes.
- **Tests:** TC-AUTH-04.
- **Command:** `npm run test:int -w services/gateway -- leak`
- **Evidence:** 2026-10-13: **TC-AUTH-04 PASS** — `test/int/secrets-scan.int.test.ts`: full app at **debug** log level with known secrets in play (admin + member passwords, invite token, two API keys incl. their secret part, a revoked key, the upstream bearer token, the credentials encryption key, and every stored hash: key hashes, session hashes, invite hash, argon2 hashes, credential ciphertext); drives login (right + wrong), invite create/list/check/accept/re-accept, key create/issue/list/list-all, `/api/me`, `/mcp` list/call/error/bad key/revoked key, revoke, `/api/audit`, logout, and **every route in the live access table anonymously and as a member** (> 30 responses, > 30 log lines). No secret in any response body (except the one response that creates a key/invite) nor in any log line; the upstream did receive its token. **Mutation-checked**: adding `keyHash` to the key list → the scan fails (`stored value in GET /api/keys`); logging the login password under a non-secret field name (`attempt`) → the scan fails on the log — a leak neither redaction layer catches, which is why this end-to-end scan exists. A failing scan names the secret kind and the response, with the value masked. `scripts/gateway-db-int.sh` **80/80**. k3d: admin password in the gateway log 0 (also checked for every AUTH task).
- **Regression risk:** —

---

## Phase 6 — Backend, dashboard and AI chat
Exit criterion: dashboard and chat work with the real gateway and store.

### UI-01 — Dashboard skeleton
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** INF-01
- **Requirements:** REQ-DEL-04
- **Description:** Vite + React + TS + TanStack Query + React Router; layout with nav.
- **Output:** `apps/dashboard`.
- **Acceptance:** `npm run build -w apps/dashboard` succeeds.
- **Tests:** TC-UI-01-1: build → dist.
- **Command:** `npm run build -w apps/dashboard`
- **Evidence:** 2026-10-14: `apps/dashboard` workspace (root `workspaces` + `apps/*`): Vite 8.3.1, React 19.3.0, TanStack Query 5.104.0, React Router 8.4.0, @vitejs/plugin-react 6.1.1 (all ≥ 2 weeks old; root `overrides` pins vite 8.3.1 so vitest shares it). Layout with top nav (Overview, Servers, Chat, My API keys; admin adds Members, Audit log), placeholders for later UI tasks, light/dark tokens, phone layout. TC-UI-01-1 PASS: `npm run build -w apps/dashboard` → `tsc --noEmit` clean, `dist/index.html` + `assets/index-*.js` (303 kB, 96 kB gzip) + css. Dev server proxies `/api` to k3d with the gateway's own Origin.
- **Regression risk:** Low.

### UI-02 — API client
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-01, AUTH-03
- **Requirements:** —
- **Description:** fetch wrapper (credentials: same-origin, JSON, error handling, 401 → login).
- **Output:** `src/api.ts`.
- **Acceptance:** Used by all pages.
- **Tests:** TC-UI-02-1: unit test of the error mapping.
- **Command:** `npm test -w apps/dashboard`
- **Evidence:** 2026-10-14: `src/api.ts` — `api<T>()` (same-origin credentials, JSON, 204 → undefined), `ApiError{status,code,message,retryAfterSec}`; friendly messages for actionable codes, server text kept for 4xx validation, never shown for 5xx or non-JSON proxy pages; `rate_limited` uses Retry-After; 401 `unauthenticated` → one handler that clears the cache and redirects to `/login?next=…` (`invalid_credentials` does not); network failure → `network_error`, aborts pass through. TC-UI-02-1 PASS: `npm test -w apps/dashboard` → 7/7.
- **Regression risk:** Low.

### UI-03 — Login / logout / accept invite
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-02, AUTH-05
- **Requirements:** REQ-AUTH-01, REQ-AUTH-02
- **Description:** Pages for login, logout, invite acceptance.
- **Output:** Pages.
- **Acceptance:** Manual flow works for admin and member.
- **Tests:** TC-UI-03-1 (manual): invite → accept → login.
- **Command:** manual (runbook)
- **Evidence:** 2026-10-14: Login (`/login`, `?next=` limited to in-app paths — open-redirect guard), sign-out, invite acceptance (`/invite#<token>`: token read once and removed from the address bar/history; check → name + password ≥ 12 + repeat → signed in), `RequireAuth` (admin-only routes redirect members; the server enforces again). TC-UI-03-1 automated in a real browser: `scripts/dashboard-screens.sh` (Playwright 1.64 image, k3d) → **20/20 PASS**: anonymous /audit → login → back to /audit; wrong password → generic message, field cleared; admin nav; invite created from the page (201); sign-out → /api/me 401; invite link → token gone from URL, weak/mismatched password blocked, account created, member nav without admin pages, /members → /, member `GET /api/invites` 403; reused link → "already been used"; deep link /keys after login; `?next=//evil.example` stays on the dashboard; no horizontal scroll at 390 px; no console errors (CSP). Screenshots in `tests/e2e/out/screens/ui-03-*.png`. Each run leaves one throwaway member `carol-<ts>@example.invalid` on k3d.
- **Regression risk:** Low.

### UI-04 — Server list with status and tools
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-02, GW-10
- **Requirements:** REQ-GW-09, REQ-GW-10
- **Description:** Table of upstreams with status badge, last error and expandable tools; auto-refresh every 10 s.
- **Output:** Page.
- **Acceptance:** Shows Connected / Unreachable / Disabled correctly.
- **Tests:** TC-UI-04-1 (manual + API): kill pod → badge Unreachable.
- **Command:** `scripts/gateway-db-int.sh` (TC-UI-04-API), `scripts/dashboard-screens.sh servers` (TC-UI-04-1)
- **Evidence:** 2026-10-14: gateway `src/upstreams/routes.ts`: `GET /api/upstreams` (session; registry + health + tool count; admins also get url/auth details, members do not; never a credential) and `GET /api/upstreams/:id/tools` (public names, descriptions, parameters; 404/409/502/400). Dashboard `pages/Servers.tsx`: cards with status badge (Connected / Unreachable / Disabled / Checking…), last error, tool count, last check, expandable tools, refetch every 10 s, summary line. **TC-UI-04-API** (`test/int/upstreams-api.int.test.ts`, real Postgres + fake upstreams + real HealthMonitor) 6/6: order, status per server, counts, token/ciphertext absent, member without url/auth (mutation-checked: admin fields for members → fails), tools view, disabled 409, unknown 404, kill → unreachable with safe error (no IP) while the other stays connected, restart → connected with last error kept, disable/enable on next request, anonymous 401. authz table test and AUTH-15 secret scan now include the new routes; int **86/86**, gateway unit 66/66. **TC-UI-04-1** in a real browser on k3d (`scripts/dashboard-screens.sh servers`) **16/16**: WooCommerce (5 tools), Everything (13), GitHub (46) Connected; WooCommerce tools expand with required params marked; host scales everything-mcp to 0 → badge Unreachable after 9 s without reload, others Connected, error shown without internal URL, Show tools disabled; scale to 1 → Connected after 10 s with last error kept; throwaway member sees the list without URL/auth, no horizontal scroll at 390 px, no page errors. `k8s-checks.sh all` 0 failures; chart 0 violations; auth flow still 20/20.
- **Regression risk:** Low. Health is per replica (each replica's own monitor); with several gateway replicas two refreshes may briefly disagree.

### UI-05 — Add server
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-04
- **Requirements:** REQ-GW-01
- **Description:** Form: name, slug, URL, auth type none|bearer|header, header name, credential (write-only).
- **Output:** Form + `POST /api/upstreams` (validation incl. SSRF guard).
- **Acceptance:** New server appears and connects.
- **Tests:** TC-UI-05-1; TC-SEC-01.
- **Command:** `npm test -w services/gateway -- ssrf`, `scripts/gateway-db-int.sh`, `scripts/dashboard-screens.sh admin`
- **Evidence:** 2026-10-14: `POST /api/upstreams` (admin; JSON schema + `resolveAuth` rules: header needs a non-reserved name, bearer/header need a credential, none forbids one; credential printable ASCII, encrypted with AES-GCM bound to the slug, never returned; duplicate slug 409; DB CHECKs as a second layer) + SSRF guard `src/upstreams/ssrf.ts` on save and at connect time (pool agent `lookup` + literal-IP check; allowlist = `UPSTREAM_ALLOWED_HOSTS` + seeded hosts, Helm `gateway.upstreamAllowedHosts`). Dashboard `pages/ServerForm.tsx` (`/servers/new`, slug suggested from the name, auth radio, password-type credential field). **TC-UNIT-04** 5/5 (address classes incl. mapped IPv6/NAT64, URL syntax, allowlist by name, connect-time lookup). **TC-UI-05-API** (`test/int/upstreams-admin.int.test.ts`): create → encrypted in DB, not in the response, connects with that credential, 2 tools; 8 invalid bodies → 400; **TC-SEC-01** (metadata IP + name, cluster postgres, localhost by name, 10/8, [::1], 127.0.0.2 as integer, file://, userinfo, unresolvable → 400; public + allowlisted name → 201); a row inserted around the API (localhost) → Unreachable `ssrf_blocked` at connect time; member 403. Both guard layers mutation-checked (connect-time off → 1 failure; save-time off → 3 failures). Int **96/96**, unit **71/71**; AUTH-15 scan now includes create/rotate. **Live k3d API** (TC-SEC-01): 169.254.169.254, metadata.google.internal, postgres (both names), gateway, mariadb, wordpress, kubernetes.default.svc, localhost, 127.0.0.1, [::1], 10.43.0.1 → 400 `ssrf_blocked`; seeded servers still Connected. **TC-UI-05-1** browser (`scripts/dashboard-screens.sh admin`): metadata URL refused in the form with the reason; adding a second registration of everything-mcp with a bearer token → card Connected, token never on the page, `<slug>__echo` on `/mcp` (13 new tools).
- **Regression risk:** Low.

### UI-06 — Edit server
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-05
- **Requirements:** REQ-GW-01
- **Description:** Edit name, URL and credential (blank = keep existing); the slug is immutable.
- **Output:** Form + `PATCH`.
- **Acceptance:** Change takes effect; the credential is never displayed.
- **Tests:** TC-UI-06-1.
- **Command:** `scripts/gateway-db-int.sh`, `scripts/dashboard-screens.sh admin`
- **Evidence:** 2026-10-14: `PATCH /api/upstreams/:id` (name, URL via SSRF guard, auth type/header, credential keep/replace/remove, `slug` rejected 400, empty body 400). Edit form `/servers/:id/edit`: slug read-only, credential field empty with "leave empty to keep it". **TC-UI-06-API**: rename keeps the credential; rotation → new value encrypted, never returned, the upstream receives the new token and no longer the old one after reconnect; switch to header keeps the credential, `credential:null` with bearer 400, to none clears it; SSRF on URL change 400 (URL unchanged); unknown 404; member 403. **TC-UI-06-1** browser: rename saved, credential kept, still Connected.
- **Regression risk:** Low.

### UI-07 — Disable / remove server
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-05, GW-11
- **Requirements:** REQ-GW-01, REQ-DOD-09
- **Description:** Toggle + delete with confirm.
- **Output:** Buttons + `PATCH`/`DELETE`.
- **Acceptance:** Tools disappear from the gateway list.
- **Tests:** TC-UI-07-1.
- **Command:** `scripts/dashboard-screens.sh admin` (TC-UI-07-1 uses `/mcp` tools/list)
- **Evidence:** 2026-10-14: Disable/Enable button (`PATCH {enabled}`) and Delete with an in-page two-step confirm (no browser dialog) → `DELETE /api/upstreams/:id` (204; 404 after). **TC-UI-07-API**: disable → `disabled`, tools 409; enable → connected 2 tools; delete → gone, second delete 404, member 403. **TC-UI-07-1** browser with an API key on `/mcp` like an external client: disable → badge Disabled and the server's tools gone from `tools/list`; enable → back; delete → card gone and `tools/list` back to the 64-tool baseline. The test removes its server and revokes its temporary key (checked: 0 active keys afterwards).
- **Regression risk:** Low.

### UI-08 — Member read-only server view
- **Priority:** P1
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-04
- **Requirements:** REQ-AUTH-01, REQ-GW-12
- **Description:** Members see servers and tools without management controls, plus a "Connect your MCP client" panel with the gateway URL and config snippets.
- **Output:** Role-aware page.
- **Acceptance:** No admin buttons for members (and the API rejects them anyway).
- **Tests:** TC-UI-08-1.
- **Command:** `scripts/dashboard-screens.sh admin`
- **Evidence:** 2026-10-14: members see the server list and status without URL/auth details (API omits them, UI-04) and without Add/Edit/Disable/Delete; admin-only routes `/servers/new`, `/servers/:id/edit` redirect members to `/`; the API refuses member writes (authz table test: POST/PATCH/DELETE /api/upstreams are admin routes). **TC-UI-08-1** browser (`dashboard-screens.sh admin`): throwaway member sees 0 admin actions, `PATCH`/`DELETE` from the member's session → 403/403, `/servers/new` → `/`.
- **Regression risk:** Low.

### UI-09 — Members and invites page
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-03, AUTH-04
- **Requirements:** REQ-AUTH-02
- **Description:** List members, create invite (copy link), disable member.
- **Output:** Page.
- **Acceptance:** Invite link works.
- **Tests:** TC-UI-09-1.
- **Command:** `scripts/gateway-db-int.sh`, `scripts/dashboard-screens.sh team`
- **Evidence:** 2026-10-14: gateway `src/auth/user-routes.ts`: `GET /api/users` (key stats, no hash), `PATCH /api/users/:id` (disable/enable, role; deletes sessions on disable; refuses self and the last active admin under `FOR UPDATE`, re-checks the caller inside the transaction), `DELETE /api/invites/:id`. Dashboard `pages/Members.tsx`: invite form → link shown once with Copy (Clipboard API, select fallback on plain http), open invites with Withdraw, People table with Make admin/member and Disable/Enable (none on your own row). **TC-UI-09-API** (`test/int/users-api.int.test.ts`) 6/6: list, disable → session + key 401 and login refused, enable restores keys, self/last-admin 409, concurrent mutual demotion → exactly one succeeds (5 full-suite runs), validation 400/404, withdrawn invite → 404. authz table now 10 admin routes. Int **102/102**. **TC-UI-09-1** browser: invite created and copied, withdrawn invite refused, the link creates the account, new member listed, disable → their session and key 401 at once, enable → key works.
- **Regression risk:** Low.

### UI-10 — Admin key management
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-09, AUTH-09
- **Requirements:** REQ-AUTH-04
- **Description:** Admin sees all keys (prefix, owner, last used) and can issue or revoke.
- **Output:** Page.
- **Acceptance:** Revoke from the UI → the external client is rejected.
- **Tests:** TC-UI-10-1.
- **Command:** `scripts/gateway-db-int.sh`, `scripts/dashboard-screens.sh team`
- **Evidence:** 2026-10-14: `pages/Keys.tsx` admin part: "Issue a key for a member" (active members only; key shown once) and "All keys (everyone)" with owner, prefix, created, last used, status, Revoke, show-revoked toggle. **TC-UI-10-1** browser: admin revokes the member's key from All keys → that client's next `/mcp` call 401; key issued for the member works on `/mcp`.
- **Regression risk:** Low.

### UI-11 — My API keys
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-02, AUTH-06
- **Requirements:** REQ-AUTH-03
- **Description:** Generate (shown once with a copy button), list, revoke own keys.
- **Output:** Page.
- **Acceptance:** Generated key works in Inspector.
- **Tests:** TC-UI-11-1.
- **Command:** `scripts/gateway-db-int.sh`, `scripts/dashboard-screens.sh team`
- **Evidence:** 2026-10-14: `pages/Keys.tsx` (nav "API keys"): connection hint (endpoint + Bearer header), create (name → full key shown once with Copy and a "cannot be recovered" note), My keys table (prefix only after reload), revoke. **TC-UI-11-1** browser: member creates a key → `mgw_` + 43 chars shown once → `tools/list` on `/mcp` with it → 64 tools, `everything__echo` call ok → after reload only `mgw_…` prefix in the page. The MCP request is the same JSON-RPC POST Inspector sends; an Inspector run with a dashboard-made key is part of E2E.
- **Regression risk:** Low.

### UI-12 — Audit log page
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-02, AUTH-14
- **Requirements:** REQ-AUTH-07
- **Description:** Table: time, user, source, server, tool, duration, outcome; filters; auto-refresh.
- **Output:** Page.
- **Acceptance:** New calls appear within 10 s.
- **Tests:** TC-UI-12-1.
- **Command:** `scripts/gateway-db-int.sh`, `scripts/dashboard-screens.sh team`
- **Evidence:** 2026-10-14: `pages/Audit.tsx` (admin): table time/user (+ key prefix)/source/server/tool or method/duration/outcome (+ error code), filters user/server/outcome/source mapped to `GET /api/audit`, refresh every 10 s, "Load older" via the keyset cursor. **TC-UI-12-1** browser: filtered by the new member, their `echo` call is listed; a new `get-sum` call made afterwards appears after 10 s without reload.
- **Regression risk:** Low.

### UI-13 — LLM provider config
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** INF-06, P0-04
- **Requirements:** REQ-CHAT-04
- **Description:** Values `llm.baseUrl`, `llm.model`; Secret `llm-secrets.LLM_API_KEY`; Groq default, OpenRouter tested.
- **Output:** Config + chart.
- **Acceptance:** No key in the bundle or values files.
- **Tests:** TC-SEC-05.
- **Command:** `grep -r "$LLM_API_KEY" apps/dashboard/dist charts || echo clean`
- **Evidence:** 2026-10-26 **fallback provider:** `gateway.llm.fallback` (OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` by default) with key `fallback-api-key` in `llm-secrets` (from .env `OPENROUTER_API_KEY`, `scripts/make-secrets.sh`); `withFallback()` sends the same completion to the fallback once when the primary answers 429, 5xx, times out or 413; other refusals are not retried elsewhere; if both fail the primary error (and its Retry-After) is reported. TC-UI-13-U2 3 tests, gateway unit 122/122. **Live 2026-10-26:** user set `OPENROUTER_API_KEY`; `scripts/make-secrets.sh --rotate platform/llm-secrets` → keys `api-key`, `fallback-api-key`; both gateway pods log `fallback: openrouter.ai/api/v1, nvidia/nemotron-3-ultra-550b-a55b:free`. `node scripts/llm-smoke.mjs openrouter` → `HTTP 200 in 398 ms, finish_reason=tool_calls`, `PASS TC-P0-04-1`. The former default `openai/gpt-oss-120b:free` now answers 404 (free variant withdrawn). 2026-10-15: `config.ts` `llm` {baseUrl, model, apiKey, timeoutMs, maxTokens} from env `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_TIMEOUT_MS` / `LLM_MAX_OUTPUT` (default Groq; base URL must be http(s) without credentials, query or fragment; no key → chat disabled, logged at startup without the key). Chart: values `gateway.llm.*`, key only via `secretKeyRef` `llm-secrets/api-key` (optional); `make-secrets.sh` creates `llm-secrets` from `.env` `LLM_API_KEY`. **TC-UI-13-1** unit PASS (mutation-checked: dropping the URL checks fails it), unit 72/72; `check-chart.sh` 0 violations (env renamed from `LLM_MAX_TOKENS`: the policy treats `*TOKEN*` names as secrets). k3d rev 47: log `chat llm configured` (baseUrl, model only); Deployment shows `LLM_API_KEY valueFrom`; in-pod `GET $LLM_BASE_URL/models` → HTTP 200, model listed (egress + Secret OK); key found 0 times in gateway logs. **TC-SEC-05** `grep -rlF "$LLM_API_KEY" apps/dashboard/dist charts` + env/Secret names in the bundle → clean. `llm-smoke.mjs groq` → tool_call `woo__list_orders`, PASS. OpenRouter: not needed (user decision 2026-10-15: Groq only); switching remains a values change (`gateway.llm.baseUrl`/`model`).
- **Regression risk:** —

### UI-14 — Chat agent loop (backend)
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-13, UI-15
- **Requirements:** REQ-CHAT-01
- **Description:** `POST /api/chat` {messages} → loop: LLM with tools → execute tool_calls via gateway MCP client → repeat (max 8) → return answer + tool transcript.
- **Output:** `chat/agent.ts`.
- **Acceptance:** TC-INT-07 passes with a stub LLM; real LLM smoke passes.
- **Tests:** TC-INT-07; TC-UI-14-1 real smoke.
- **Command:** `npm run test:int -w services/gateway -- chat`
- **Evidence:** 2026-10-15: `chat/llm.ts` (OpenAI-compatible client, plain fetch; key only in the Authorization header, `redirect: 'error'`; 429 → `llm_rate_limited` + Retry-After, 413 → "too large", 5xx → `llm_unavailable`, timeout → `llm_timeout`; errors keep only a short provider code, never body text), `chat/agent.ts` (loop: tools/list → LLM → tools/call via own `/mcp` → repeat; 8 rounds, 16 calls, 150 s deadline; results cut to 4 KB for the model, 500-char preview for the UI; invented names and bad JSON args become error results), `chat/routes.ts` (`POST /api/chat`, session; body: 1..40 user/assistant turns ≤ 8000 chars, last = user; 503 `chat_disabled` without key; one request per user at a time `chat_busy`; 30/10 min per user `rate_limited`). **Found on k3d:** 64 tools ≈ 16.7k tokens vs Groq free tier 8k tokens/min → HTTP 413 on every request. Fix (D-019): tools offered by keyword relevance within a 6000-char budget + local `find_tools` meta-tool (best 8 callable next round, further names listed, exact name → callable); calls still go through `/mcp`. **TC-UI-14-U1..U3** unit 15/15, unit 95/95; **TC-INT-07** + TC-UI-14-API int 7/7 (stub LLM, real Postgres/sessions/`/mcp`): reply + transcript, alice/bob audit rows `source=chat`, disabled server's tools not offered, history kept, 401/400s (no client `system` role), LLM error mapping, busy + window; `/api/chat` added to the AUTH-10 table test; int 114/114. Mutation-checked: busy guard, last-turn check, invented-name filter. **TC-UI-14-1** real Groq on k3d rev 52 (`node scripts/chat-smoke.mjs`): "What orders came in today?" → `woo__list_orders {date:today}` → "no orders today"; "List 3 products" → `woo__list_products {per_page:3}` → 3 products with ₹ prices; "Which GitHub account…" → `find_tools` → `github__get_me` → "Ragx09"; each call one audit row under the admin with `source=chat`. A third question within the same minute got 429 `llm_rate_limited` with Retry-After (free-tier budget, handled). Notes: woo `date:today` uses the store timezone; `list_products` also returns draft `Integration Product …` rows left by `woo-int.sh`.
- **Regression risk:** Too many tools for small models → cap or filter.

### UI-15 — Internal token to gateway /mcp
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** AUTH-08
- **Requirements:** REQ-GW-11, REQ-CHAT-03
- **Description:** HMAC-signed short-lived token (`sub`, `src=chat`, `exp`), accepted by `/mcp` auth alongside API keys; the agent's MCP client targets the gateway's own URL.
- **Output:** Token module.
- **Acceptance:** Audit rows from chat show the user + `source=chat`; an expired token → 401.
- **Tests:** TC-UI-15-1/2.
- **Command:** `npm test -w services/gateway -- internal-token`
- **Evidence:** 2026-10-15: `src/auth/internal-token.ts` — `itk_<b64url{sub,src:'chat',exp}>.<HMAC-SHA256>`, 5 min max, key = 32 random bytes per process (never stored or sent; the agent calls its own process over loopback, D-018); `mcpAuthenticator`: API keys from anywhere, `itk_` only when the raw TCP peer is loopback (not `X-Forwarded-For`); user re-checked in the DB on every request (disabled → 401); principal `{keyId:null, source:'chat'}`; log scrub for `itk_…`. **TC-UI-15-U1/U2** unit 8/8 (expiry, other key, payload swap under a valid signature, malformed input, src/sub/exp checks behind a valid HMAC, scrub, loopback forms); unit 80/80. **TC-UI-15-1** (int, real Postgres + real `/mcp`): alice's and bob's tokens → tools/list + tools/call OK, audit rows `user_id` = each user, `api_key_id` NULL, `source=chat`; same user via API key → `source=mcp`. **TC-UI-15-2**: expired, other-process, forged (bob's id under alice's signature), garbage → 401 + `denied` rows without user; valid token from `10.42.0.9`/`::ffff:10.42.0.9` with `X-Forwarded-For: 127.0.0.1` → 401; disabling the user → next request 401. Int 107/107. Mutation-checked: loopback check removed → 1 fail; expiry removed → 3 fail; disabled-user filter removed → 1 fail. k3d rev 48 via Ingress: API key → 200, 64 tools; `itk_` token → 401 (plain and with `X-Forwarded-For: 127.0.0.1`); 0 token strings in gateway logs. Minting is wired in UI-14 (`POST /api/chat`).
- **Regression risk:** —

### UI-16 — Chat UI with tool-call display
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-14
- **Requirements:** REQ-CHAT-02
- **Description:** Chat page showing messages and collapsible tool-call cards (tool, server, args, result excerpt, ms, ok or error).
- **Output:** Page.
- **Acceptance:** Tool calls visible for each answer.
- **Tests:** TC-UI-16-1 (browser, `tests/e2e/dashboard-chat.mjs`), TC-UI-16-U1 (dashboard unit), TC-UI-16-U2 (gateway unit, tool_use_failed retry).
- **Command:** `scripts/dashboard-screens.sh chat`; `npm test -w apps/dashboard`; `npm test -w services/gateway`
- **Evidence:** 2026-10-16: Chat page (`apps/dashboard/src/pages/Chat.tsx`, store `src/chat.ts`): messages, collapsible tool-call cards (status, tool, server, ms; expanded: full name, arguments, result/error excerpt), stop reason, "1 failed" count, progress line with seconds, suggestions, New chat, Enter to send. The conversation lives in memory outside the page (survives page changes, not reloads; nothing in browser storage; cleared on sign-out/expiry; an answer arriving after New chat/sign-out is dropped). Replies drawn as text nodes with a Markdown subset (bold, code, headings, bullets) — never HTML. Errors mapped for `chat_disabled`, `chat_busy`, `llm_rate_limited` (+ Retry-After seconds), `llm_timeout`, `llm_unavailable`, `llm_error`, `chat_failed`; a failed question goes back into the input. Dashboard unit `vitest run test` → `Tests 19 passed (19)` (TC-UI-16-U1; stale-answer and one-at-a-time guards mutation-checked). `scripts/dashboard-screens.sh chat` on k3d rev 57 → `PASS TC-UI-16-1 (19/19)`: stubbed 429/503 errors, stubbed `<img onerror>` reply stays text, real Groq question → `woo__list_orders` card (`ok list_orders woo 255 ms`), answer survives /keys → /chat, audit 1 row under the admin with source=chat, phone width overflow 0px, no CSP/page errors. **Found and fixed (gateway):** Groq refused 3 of 5 first rounds with `HTTP 400 tool_use_failed` — gpt-oss-120b sent `per_page: 100` to `woo__list_orders` (schema maximum 50) and Groq validates tool arguments against the schema. `chat/llm.ts` now retries once and tells the model the provider's validation message (scrubbed of the API key and credential-shaped strings, ≤ 400 chars, never logged or returned); the log line now carries the safe detail (`HTTP 400, tool_use_failed`). D-020. Gateway unit `Tests 96 passed (96)` (TC-UI-16-U2, retry and scrub mutation-checked); in-pod probe: both refused tries recovered on the hinted retry; after deploy 4/4 live questions answered (browser + 3× `chat-smoke.mjs`), 0 `llm failed` lines. Screens: `tests/e2e/out/screens/ui16-chat-*.png`.
- **Regression risk:** The retry doubles the tokens of a refused round (free tier 8k TPM). `dashboard-screens.sh chat` is not in `all` (uses the real LLM).

### UI-17 — Chat attribution test
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-15, AUTH-13
- **Requirements:** REQ-CHAT-03, REQ-DOD-11
- **Description:** Two users chat; audit rows are attributed correctly.
- **Output:** Integration test.
- **Acceptance:** Rows match the users.
- **Tests:** TC-UI-17-1.
- **Command:** `scripts/gateway-db-int.sh` (throwaway Postgres; runs all int files, incl. `test/int/chat-attribution.int.test.ts`)
- **Evidence:** 2026-10-16: `test/int/chat-attribution.int.test.ts` (TC-UI-17-1, real Postgres + sessions + /mcp over loopback with the internal token, fake upstreams, stub LLM with a barrier so all agents are in flight together): (1) alice (admin), bob, carol chat at the same time, 3 rounds → 9 `tools/call` rows, each under the user who asked, `source=chat`, no key, upstreams matching each question, each reply carries its own marker; (2) alice + carol chat while bob calls `/mcp` with his API key at the same time → `alice chat nokey woo/list_orders`, `bob mcp key everything/echo`, `bob mcp key woo/list_orders`, `carol chat nokey everything/echo`, key id = bob's; (3) failed tool call in the chat → `tool_error` row under carol; (4) `GET /api/audit?user=<bob>&source=chat` as admin → only bob's two chat calls; member → 403. `scripts/gateway-db-int.sh` → `Tests 118 passed (118)`. Mutation: chat route minting every token for the first user served → 5 tests fail (4 new + TC-INT-07 two-user), restored. Live real-LLM attribution was shown in UI-14/16 (admin); two real users via the dashboard is E2E-10.
- **Regression risk:** none (test only).

### UI-18 — Error states
- **Priority:** P2
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-16
- **Requirements:** REQ-GW-06
- **Description:** Friendly display of LLM rate limits, upstream errors and timeouts.
- **Output:** UI handling.
- **Acceptance:** A killed upstream yields a readable error in chat.
- **Tests:** TC-UI-18-1 (browser, real LLM), TC-UI-18-U1 (dashboard unit), TC-UI-18-U2 (gateway unit), TC-UI-18-API (int).
- **Command:** `npm -w @platform/dashboard test`; `npx vitest run test/unit` (services/gateway); `scripts/gateway-db-int.sh`; `scripts/dashboard-screens.sh chat-errors` (scales woo-mcp to 0 and back); `scripts/dashboard-screens.sh chat`
- **Evidence:** 2026-10-21. **Found:** a killed upstream never produced a tool error in chat — the gateway leaves an unreachable server's tools out of `tools/list`, so the model only said it had no such tool. Fix: `POST /api/chat` now returns `unavailable:[{server,name}]` (enabled + health-monitor unreachable) and names those slugs in the system prompt; a failed lookup does not fail the chat. Dashboard: `describeToolError()` maps `upstream_unreachable` / `upstream_timeout` (with seconds) / `upstream … is disabled` / `unknown tool` / `upstream_error` to one actionable sentence and badge per card (raw excerpt only in the expanded card); a summary box above the answer; LLM `Retry-After` becomes a live countdown (Send/Retry disabled, the store refuses to send during the wait). Dashboard unit `Tests 25 passed (25)`; gateway unit `Tests 100 passed (100)`; int `Tests 119 passed (119)`. Mutations: unreachable mapping off → 1 fail; send guard off → 1 fail; prompt without `unavailable` → 1 fail; restored. k3d rev 67: `dashboard-screens.sh chat-errors` → `chat-errors: 15/15 passed` (stubbed 4 failure kinds, no IP/ECONNREFUSED in the visible text; real Groq with woo-mcp at 0: `unavailable [{"server":"woo","name":"WooCommerce"}]`, notice "The woo server (WooCommerce) could not be reached…", model reply "The WooCommerce server (woo) is currently unreachable, so I can't retrieve today's orders right now."); woo-mcp restored Ready. Regression `dashboard-screens.sh chat` → `TC-UI-16-1 (21/21)` (rate-limit stub now 3 s; checks the countdown). Screenshots `tests/e2e/out/screens/ui18-*.png`.
- **Regression risk:** low — chat response gains one field; the chat int test window raised 6 → 9 per minute to fit the new test.

### UI-19 — Chat "create product" flow
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-16, WC-09
- **Requirements:** REQ-DOD-03, REQ-DOD-04
- **Description:** "Create a product called Demo Mug priced 499" → product on the storefront; "what orders came in today?" → lists orders. (Whole rupees: the store shows INR without decimals, so 12.50 would be shown and charged as ₹13; SPEC A-09.)
- **Output:** Evidence.
- **Acceptance:** Both prompts succeed with real Groq.
- **Tests:** TC-E2E-03, TC-E2E-04.
- **Command:** `scripts/e2e.sh chat` (API + storefront order) and `scripts/dashboard-screens.sh chat-create` (browser)
- **Evidence:** 2026-10-17, k3d rev 57, real Groq (`openai/gpt-oss-120b`). New `scripts/chat-flow.mjs` behind `scripts/e2e.sh chat` (first mode of the E2E-14 script): the chat creates "Demo Mug <stamp>", the script checks the product page and the public Store API, orders it as a guest with COD through `scripts/e2e-checkout.sh` (now takes `PRODUCT_SLUG`), asks today's orders and compares with MariaDB, then checks the audit log. Run 2 → `PASS UI-19 chat flow (12/12): Demo Mug 10171852 id 148, order #149`: `woo__create_product {"name":"Demo Mug 10171852","regular_price":"499"} → ok`, page 200 with `₹499`, Store API `INR 499`, order #149 contains the product, `woo__list_orders {"date":"today"} → ok`, tool count 2 = database 2 (2026-10-18 Asia/Kolkata), reply names "Order 149 – ₹ 499", audit `create_product` + `list_orders` under the admin with source=chat. **Found:** run 1 asked "priced 12.50" → product 146 stored 12.50 but the storefront shows `₹13` and the order (#147) was charged 13, because the brand import sets 0 price decimals (`woocommerce_price_num_decimals`); the chat and MCP path were right (8/8 chat checks passed, 2 storefront price checks failed). Kept the brand setting, moved the demo prompt to whole rupees (SPEC A-09, runbook). Browser: `scripts/dashboard-screens.sh chat-create` → `PASS UI-19 browser (6/6): Demo Mug 10171853`: ok `create_product` card with the name and `"regular_price": "499"`, reply names the product, its storefront page 200 "Demo Mug 10171853" `₹499`, no CSP/page errors. Screens `tests/e2e/out/screens/ui19-chat-create.png`, `ui19-storefront-product.png`. Test data kept in the store: products 146 (₹13), 148, 150, orders #147, #149. **Fixed 2026-10-18 (no rounding):** the brand import now sets `woocommerce_price_num_decimals` = 2 and the tatva theme trims a zero fraction (`woocommerce_price_trim_zeros`), so 12.50 stays ₹12.50 and ₹1,299 stays ₹1,299. k3d rev 58 (store-assets `sha-7c3c4297e9f3`): product 146 now shows `₹12.50`, Store API `1250` minor unit 2; `/`, `/shop/`, `/shop/page/2/` contain 0 `.00` prices. `PRICE=12.50 node scripts/chat-flow.mjs` → `PASS UI-19 chat flow (12/12): Demo Mug 10180917 id 151, order #152`, incl. the new check `the order line is charged the exact price (not rounded) (line total 12.5)`; the tool-vs-DB count comparison was skipped this run (result excerpt cut at 500 chars, 3 orders today) — the reply named #152.
- **Regression risk:** Model choice.

### UI-20 — Dashboard image + Helm
- **Priority:** P0
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-01, INF-11
- **Requirements:** REQ-K8S-04
- **Description:** nginx-unprivileged image serving dist with SPA fallback; probes, limits; Ingress `/`.
- **Output:** Dockerfile + template.
- **Acceptance:** `http://app.127.0.0.1.nip.io` loads the dashboard.
- **Tests:** TC-K8S-04.
- **Command:** `curl -s http://app.127.0.0.1.nip.io | grep -q '<div id="root"'`
- **Evidence:** 2026-10-14: `apps/dashboard/Dockerfile` (node build → `nginxinc/nginx-unprivileged:1.30.4-alpine3.24`, nginx started directly, read-only root fs + `/tmp` emptyDir), `nginx.conf` (SPA fallback, immutable `/assets/`, `no-cache` index, CSP `default-src 'self'` + `frame-ancestors 'none'`, nosniff, DENY, no-referrer); chart `templates/platform/dashboard.yaml` (probes, 10m/16Mi, limit 64Mi, uid 101, no SA token, NetworkPolicy: Traefik only in, no egress); Ingress `app` `/` → dashboard. **Found and fixed:** Traefik orders routers by rule length, so `Path(/mcp)` lost to `PathPrefix(/)` and POST /mcp hit nginx (405) → `/mcp` is now Prefix. `build-images.sh`/`deploy.sh` include the dashboard. TC-K8S-04 PASS (`curl -s http://app.127.0.0.1.nip.io | grep -q '<div id="root"'`); `scripts/k8s-checks.sh all` → 28 PASS, 0 failures (incl. TC-UI-20-1a/b/c: dashboard from a random pod / the gateway CLOSED, dashboard egress CLOSED; `nc` verified working); chart 0 violations both envs; `up.sh` re-run → same dashboard tag, no restart.
- **Regression risk:** Low.

---

## Phase 7 — External MCP clients and acceptance testing
Exit criterion: required workflows work across dashboard chat, gateway, external MCP clients and WooCommerce.

### E2E-01 — External gateway URL
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** AUTH-08, INF-11
- **Requirements:** REQ-GW-12
- **Description:** `http://app.<domain>/mcp` reachable from the host (and from Windows for Cursor).
- **Output:** Documented URL.
- **Acceptance:** Without a key → 401; with a key → initialize ok.
- **Tests:** TC-K8S-04.
- **Command:** `curl -s -o /dev/null -w '%{http_code}' -X POST http://app.127.0.0.1.nip.io/mcp`
- **Evidence:** 2026-10-18, k3d: `node scripts/e2e-acceptance.mjs url` (part of `scripts/e2e.sh all`, `docs/evidence/e2e-all-k3d-2026-10-18.txt`) → `PASS TC-K8S-04a /mcp without a key → 401 + WWW-Authenticate`, `PASS TC-K8S-04b forged key → 401`, `PASS TC-K8S-04c initialize with B's key → ok (mcp-gateway 2025-06-18)`, `PASS TC-K8S-04d GET /mcp → 405`; both 401s found in the audit as `denied` without a user. URL documented in README § Connect an external MCP client (`http://app.127.0.0.1.nip.io/mcp`; same from Windows via nip.io → 127.0.0.1).
- **Regression risk:** —

### E2E-02 — Client configuration docs
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** E2E-01
- **Requirements:** REQ-DEL-03
- **Description:** README sections for Claude Code, Cursor and Inspector.
- **Output:** README.
- **Acceptance:** Following the docs verbatim works.
- **Tests:** TC-EXT-01/02.
- **Command:** —
- **Evidence:** 2026-10-18: README § Using the system → Claude Code (`claude mcp add --transport http … --header` and a `--mcp-config` file), Cursor (`mcp.json` with `url` + `headers`), MCP Inspector (UI and CLI). Verified as written: Inspector CLI `--method tools/list` → 64 tools (TC-EXT-01) and `--method tools/call --tool-name woo__list_orders --tool-arg date=today` → `{"count":4,"date":"2026-10-18","orders":[{"id":154 …`; Claude Code 2.1.302 with the `--mcp-config` form and B's key answered the orders question (E2E-05). **Not run:** `claude mcp add` itself (it would change the user's Claude Code config; same URL/header as the verified file form) and Cursor (not installed here).
- **Regression risk:** —

### E2E-03 — Users A and B
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** AUTH-05, AUTH-06
- **Requirements:** REQ-DOD-12
- **Description:** Script or runbook to create user A (admin or member) and user B (member) with keys.
- **Output:** `scripts/seed-demo-users.mjs` (B's password in Secret `platform/demo-users`, never committed).
- **Acceptance:** Both log in and have keys.
- **Tests:** TC-E2E-03-1.
- **Command:** `node scripts/seed-demo-users.mjs [--key]`
- **Evidence:** 2026-10-18: `scripts/seed-demo-users.mjs` (Node instead of the planned `.sh`, reuses `scripts/lib/gateway-key.mjs`): A = seeded admin, B = member `demo-b@example.invalid` created through the real invite → accept flow; B's password generated into Secret `platform/demo-users` (via `kubectl apply` stdin, never printed or committed); `--key` prints a new key for B once. First run → `created user B demo-b@example.invalid (member) through the invite flow`, `ok user A admin@example.invalid (admin) signs in`, `ok user B … (member) signs in`; second run idempotent (no create). TC-E2E-03-1 PASS in the acceptance run.
- **Regression risk:** —

### E2E-04 — B lists tools externally
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** E2E-03
- **Requirements:** REQ-DOD-05, REQ-DOD-06
- **Description:** Inspector CLI + Claude Code with B's key → tools of all 3 servers.
- **Output:** Evidence.
- **Acceptance:** woo, everything and github tools listed.
- **Tests:** TC-EXT-01, TC-EXT-02.
- **Command:** Inspector CLI list
- **Evidence:** 2026-10-18 (`docs/evidence/e2e-all-k3d-2026-10-18.txt`): `PASS TC-EXT-01 B tools/list → tools of every enabled server (woo:5 everything:13 github:46; enabled: woo, everything, github)`, `PASS TC-EXT-01 MCP Inspector CLI with B's key lists woo, everything and github tools (64 tools)`. Claude Code with B's key used `woo__list_orders` and `github__search_issues` (E2E-05/06).
- **Regression risk:** —

### E2E-05 — B asks the orders question
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** E2E-04
- **Requirements:** REQ-DOD-06
- **Description:** In Claude Code: "What orders came in today in the store?"
- **Output:** Evidence.
- **Acceptance:** Correct order list.
- **Tests:** TC-EXT-02.
- **Command:** manual (Claude Code)
- **Evidence:** 2026-10-18: scripted `PASS TC-EXT-02 B woo__list_orders {date: today} = the store database (tool [#147, #149, #152, #154], db [#147, #149, #152, #154] on 2026-10-18 Asia/Kolkata)`. Real Claude Code 2.1.302 (`claude -p "What orders came in today in the store? …" --mcp-config <B's key> --strict-mcp-config`) → "Four orders came in today, October 18, 2026" with #154 ₹249.75, #152 ₹12.50, #149 ₹499.00, #147 ₹13.00 (= MariaDB); audit rows `demo-b@example.invalid mgw_rcoWEuUd woo list_orders ok`. Temporary key revoked afterwards.
- **Regression risk:** —

### E2E-06 — Cross-upstream prompt
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** E2E-04, GW-15
- **Requirements:** REQ-DOD-07
- **Description:** "Summarize today's orders and open a GitHub issue in <repo> with the summary."
- **Output:** Issue URL as evidence.
- **Acceptance:** Both servers' tools called (audit shows both).
- **Tests:** TC-E2E-07.
- **Command:** manual + audit query
- **Evidence:** 2026-10-18, read-only variant (REQ-DOD-07 needs tools from two upstreams in one prompt; GW-15's issue write still waits for the throwaway repo): Claude Code with B's key, one prompt "get today's store orders … then search open GitHub issues in the public repo woocommerce/woocommerce that mention 'cash on delivery' … whether any could affect today's orders" → called `woo__list_orders`, `woo__get_order` ×4 and `github__search_issues`, answered with today's 4 orders and woocommerce/woocommerce#68674; audit: all rows under `demo-b@example.invalid` (`woo list_orders ok`, `github search_issues ok`, `woo get_order ok` ×4). An earlier attempt on the private project repo → `github list_issues tool_error` (the PAT cannot see it; also audited). Issue-creating variant: `GITHUB_REPO=owner/repo scripts/e2e.sh cross` once the repo is known (GW-15).
- **Regression risk:** —

### E2E-07 — Revoke B
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** E2E-04, UI-10
- **Requirements:** REQ-DOD-08
- **Description:** Admin revokes B's key in the dashboard → B's next call is rejected.
- **Output:** Evidence.
- **Acceptance:** 401 + audit `denied`.
- **Tests:** TC-E2E-08.
- **Command:** `scripts/e2e.sh revoke`
- **Evidence:** 2026-10-18 (`docs/evidence/e2e-all-k3d-2026-10-18.txt`): `PASS TC-E2E-08a B's key works before the revoke`, `PASS TC-E2E-08b admin revokes B's key (204)` (same `DELETE /api/keys/:id` the dashboard's Revoke button calls, browser-tested in UI-10), `PASS TC-E2E-08c B's next call → 401 ({"error":"invalid_api_key"…})`; the 401 is in the audit as `denied`.
- **Regression risk:** —

### E2E-08 — Disable an upstream
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** UI-07
- **Requirements:** REQ-DOD-09
- **Description:** Disable `everything` → tools gone from the chat agent's tool list and the external client's list.
- **Output:** Evidence.
- **Acceptance:** Both lists exclude everything tools.
- **Tests:** TC-E2E-09.
- **Command:** `scripts/e2e.sh disable`
- **Evidence:** 2026-10-18 (`docs/evidence/e2e-all-k3d-2026-10-18.txt`): `PASS TC-E2E-09b B's tools/list has no everything tools (woo:5 github:46)`, `PASS TC-E2E-09c B calling everything__echo → upstream_disabled`, `PASS TC-E2E-09d the chat agent has no everything tools (calls: [find_tools, find_tools], reply: I don’t have an “everything” server or an echo tool available.)` (real Groq, as A), re-enabled → `woo:5 everything:13 github:46`.
- **Regression risk:** —

### E2E-09 — Kill an upstream pod
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** GW-16, UI-04
- **Requirements:** REQ-DOD-10
- **Description:** `kubectl delete pod` / scale 0 → others work; dashboard Unreachable.
- **Output:** Evidence.
- **Acceptance:** As described.
- **Tests:** TC-E2E-10.
- **Command:** `scripts/e2e.sh killpod`
- **Evidence:** 2026-10-18 (`docs/evidence/e2e-all-k3d-2026-10-18.txt`): everything-mcp scaled to 0 → `PASS TC-E2E-10a dashboard API shows everything Unreachable (as B sees it) (unreachable after 5 s)` (the API the Servers page polls; the page itself browser-tested in UI-04), `PASS 10b B still lists woo and github tools`, `PASS 10c woo__list_products still works (103 ms)`, `PASS 10d github__get_me still works (465 ms)`, `PASS 10e everything__echo fails fast (17 ms)`, `PASS 10f everything Connected again after scale 1`. Pod-delete variant: GW-16 `k8s-checks.sh killpod`.
- **Regression risk:** —

### E2E-10 — Audit attribution check
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** E2E-05..E2E-09
- **Requirements:** REQ-DOD-11
- **Description:** Every call above in the audit with the correct user and outcome.
- **Output:** Evidence.
- **Acceptance:** Audit query assertions pass.
- **Tests:** TC-E2E-11.
- **Command:** `scripts/e2e.sh audit`
- **Evidence:** 2026-10-18 (`docs/evidence/e2e-all-k3d-2026-10-18.txt`): each `/mcp` request of the run is raw JSON-RPC with its `x-request-id`, looked up in `GET /api/audit` → `PASS TC-E2E-11 every request of this run is in the audit log with the right user and outcome (13 requests, 15 rows since start)` (B's ok calls, `rejected` while disabled, `unreachable` while killed, `denied` without a user for no key/forged/revoked), `PASS no row with B's key is attributed to anyone else (0)`; chat calls under A with source=chat checked by the chat flow. The check caught a real difference first: refused calls store the public tool name (`everything__echo`), routed ones the upstream name (`echo`) — the test now accepts both.
- **Regression risk:** —

### E2E-11 — A creates a product via chat
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** UI-19
- **Requirements:** REQ-DOD-03
- **Description:** Live with user A.
- **Output:** Evidence.
- **Acceptance:** Product on the storefront.
- **Tests:** TC-E2E-03.
- **Command:** manual + `scripts/e2e.sh chat`
- **Evidence:** 2026-10-18 (`docs/evidence/e2e-all-k3d-2026-10-18.txt`): as user A (seeded admin) with real Groq: `woo__create_product {"name":"Demo Mug 10180923","regular_price":"249.75"} → ok`, product page 200, `public Store API … (INR 24975)`. Same earlier with 12.50 (product 151) and in the browser (UI-19).
- **Regression risk:** —

### E2E-12 — Manual COD order
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** WC-04, E2E-11
- **Requirements:** REQ-DOD-01, REQ-DOD-02, REQ-DOD-04
- **Description:** Order the new product on the storefront.
- **Output:** Evidence.
- **Acceptance:** Order in wp-admin.
- **Tests:** TC-E2E-01, TC-E2E-02.
- **Command:** manual
- **Evidence:** 2026-10-18: guest COD order in a real browser for the chat-created product → `PASS storefront order placed for the new product (#154)`, line total 249.75 (exact); `scripts/e2e-checkout.sh` now also signs in to wp-admin (password from Secret `store/wordpress-admin`, never printed) → `PASS order placed: #155`, `PASS order #155 listed in WooCommerce admin → Orders ("… #155 Asha Rao 6 seconds ago …")`, screenshot `tests/e2e/out/admin-orders.png`.
- **Regression risk:** —

### E2E-13 — A asks today's orders via chat
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** E2E-12
- **Requirements:** REQ-DOD-04
- **Description:** Chat returns the order.
- **Output:** Evidence.
- **Acceptance:** The order number matches.
- **Tests:** TC-E2E-04.
- **Command:** manual
- **Evidence:** 2026-10-18 (`docs/evidence/e2e-all-k3d-2026-10-18.txt`): `PASS chat called woo__list_orders`, `PASS the answer names the new order (#154)`, `PASS audit: create_product and list_orders under the admin with source=chat`.
- **Regression risk:** —

### E2E-14 — Scripted acceptance suite
- **Priority:** P0
- **Status:** In Progress
- **Day:** 6
- **Depends on:** E2E-01..E2E-13
- **Requirements:** REQ-DOD-01..12
- **Description:** `scripts/e2e.sh all` runs every automatable DoD check and prints a PASS/FAIL table; manual items listed with runbook refs.
- **Output:** Script + saved run log in `docs/evidence/`.
- **Acceptance:** All automated checks PASS on local; re-run on the VPS.
- **Tests:** TC-E2E-01..12.
- **Command:** `scripts/e2e.sh all`
- **Evidence:** 2026-10-18, local k3d rev 58: `PRICE=249.75 scripts/e2e.sh all` → `PASS UI-19 chat flow (12/12): Demo Mug 10180923 id 153, order #154`, `PASS e2e all: 26 passed, 0 failed, 1 skipped` (skip = `cross`, needs `GITHUB_REPO`), `PASS scripts/e2e.sh all (chat flow + acceptance)`; log `docs/evidence/e2e-all-k3d-2026-10-18.txt` (0 key/token strings in it). Manual items: Claude Code / Cursor and the browser walk-through in `docs/DEMO_RUNBOOK.md`. **Open:** re-run on the VPS (blocked: no VPS, REL-01).
- **Regression risk:** —

---

## Phase 8 — VPS deployment, security and submission
Exit criterion: deployed, tested, documented, demo-ready and submitted.

### REL-01 — k3s on the VPS
- **Priority:** P0
- **Status:** Blocked
- **Day:** 4
- **Depends on:** P0-03
- **Requirements:** REQ-K8S-02
- **Description:** Install k3s (Traefik + local-path default), kubeconfig over SSH tunnel, firewall 22/80/443.
- **Output:** Working cluster.
- **Acceptance:** `kubectl get nodes` Ready from the laptop.
- **Tests:** TC-REL-01-1.
- **Command:** `kubectl --context vps get nodes`
- **Evidence:** Blocked on P0-03 (no VPS yet).
- **Regression risk:** —

### REL-02 — values-prod finalised
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** INF-04, REL-01
- **Requirements:** REQ-K8S-03
- **Description:** Domain (sslip.io or real), GHCR images, Secure cookies, resources.
- **Output:** `values-prod.yaml`.
- **Acceptance:** `helm template` with prod values passes checks.
- **Tests:** TC-K8S-01.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** 2026-10-18: `values-prod.yaml` final for everything that does not need the VPS: https + cert-manager issuer (`letsencrypt-prod`), `COOKIE_SECURE=true` and `PUBLIC_ORIGIN=https://app.<domain>` derived from `scheme`, GHCR prefix `ghcr.io/ragx09/` for all five own images, optional `global.imagePullSecrets` (new; renders `imagePullSecrets` on the 5 pods with our images), larger storage and MariaDB/WordPress resources. **Fixed a prod bug:** the wp-init `store-assets` init container ignored the registry prefix and pull policy (would have pulled `store-assets:<tag>` from Docker Hub on the VPS) → now `ghcr.io/ragx09/store-assets:<tag>`. The render fails while `global.domain` is the placeholder (`Error: … global.domain is still the placeholder: install with --set global.domain=<ip>.sslip.io`). `scripts/check-chart.sh` → lint local/prod PASS, kubeconform 31/31 valid, `policy: 31 objects, 0 violations` ×2, `PASS only expected keys differ`. Same chart deployed on k3d rev 63 (local values) with every pod re-admitted under Pod Security `restricted`. Open for REL-01/03: the real domain (`--set global.domain=…`) and pushing the images.
- **Regression risk:** —

### REL-03 — Same-chart install on the VPS
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** REL-02
- **Requirements:** REQ-K8S-02
- **Description:** Push images to GHCR; `helm upgrade --install` with values-prod.
- **Output:** Running system on the VPS.
- **Acceptance:** TC-VPS-01 passes.
- **Tests:** TC-VPS-01.
- **Command:** `scripts/deploy.sh prod`
- **Evidence:** —
- **Regression risk:** Image architecture (arm64 VPS) → multi-arch build.

### REL-04 — TLS with cert-manager
- **Priority:** P1
- **Status:** In Progress
- **Day:** 7
- **Depends on:** REL-03
- **Requirements:** —
- **Description:** cert-manager + Let's Encrypt HTTP-01 via Traefik; `tls.enabled` in values.
- **Output:** HTTPS hosts.
- **Acceptance:** `curl -I https://app.<domain>` valid cert.
- **Tests:** TC-REL-04-1.
- **Command:** `curl -sI https://app.<domain>`
- **Evidence:** 2026-10-24 (prep, no VPS yet): `vps-setup/up.sh` installs cert-manager chart v1.19.1 (requests/limits from `vps-setup/cert-manager-values.yaml`, verified with `helm template`: 3 Deployments + startupapicheck Job all with resources) and ClusterIssuers `letsencrypt-staging`/`letsencrypt-prod` (HTTP-01, ingressClassName traefik); `TLS_ISSUER=letsencrypt-staging` for the first try. Found and fixed: the chart's default-deny ingress would drop Let's Encrypt's HTTP-01 request to the solver pod → new NetworkPolicy `acme-solver-from-ingress` (Traefik → `acme.cert-manager.io/http01-solver=true`:8089) in `store` and `platform`. `scripts/check-chart.sh` → lint PASS ×2, kubeconform `Valid: 35, Invalid: 0` ×2, `policy: 35 objects, 0 violations` ×2, `PASS only expected keys differ`; k3d rev 2 shows both policies, `scripts/k8s-checks.sh netpol` → `failures: 0`. Found: sslip.io is not on the Public Suffix List (shared Let's Encrypt limit) → DuckDNS option in `up.sh`. Open: real issuance on the VPS.
- **Regression risk:** Rate limits → use staging first.

### REL-05 — Persistence on the VPS
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** REL-03
- **Requirements:** REQ-K8S-05
- **Description:** Run TC-PER-01/02 on the VPS.
- **Output:** Evidence.
- **Acceptance:** Data survives pod deletion.
- **Tests:** TC-PER-01, TC-PER-02.
- **Command:** `scripts/k8s-checks.sh store-data --context vps`
- **Evidence:** —
- **Regression risk:** —

### REL-06 — Secrets on the VPS
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** REL-03
- **Requirements:** REQ-K8S-09
- **Description:** `make-secrets.sh` against the VPS context; no secrets in values-prod.
- **Output:** Evidence.
- **Acceptance:** Secrets exist; secret scan clean.
- **Tests:** TC-SEC-04.
- **Command:** `scripts/make-secrets.sh --context vps`
- **Evidence:** —
- **Regression risk:** —

### REL-07 — Authorization boundary review
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** AUTH-10
- **Requirements:** REQ-AUTH-01
- **Description:** Review every route and MCP path against the role matrix; fix gaps.
- **Output:** Review notes in THREAT_MODEL.
- **Acceptance:** TC-AUTH-02 passes; review recorded.
- **Tests:** TC-AUTH-02.
- **Command:** `scripts/gateway-db-int.sh` (TC-AUTH-02 in `authz.int.test.ts`) and `node scripts/authz-live.mjs`
- **Evidence:** 2026-10-18: every `/api` route and `/mcp` reviewed against the role matrix → THREAT_MODEL §7 (matrix, enforcement points, accepted design gap: members may call every enabled tool incl. write tools with the shared credential — per-role tool control is a stand-out item). No enforcement gap found. Tests: gateway unit `Tests 96 passed (96)`, int `Test Files 21 passed (21)`, `Tests 118 passed (118)` (incl. TC-AUTH-02 route table). New `scripts/authz-live.mjs` on k3d → `PASS live authz walk`: 11 admin routes anonymous 401 / member 403, member revoking the admin's key → 404, `/api/me`, `/api/keys`, `/api/upstreams`, `/api/chat` anonymous → 401, forged session cookie → 401 (18/18). Re-run on the VPS with APP_ORIGIN.
- **Regression risk:** —

### REL-08 — SSRF validation tests
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** UI-05
- **Requirements:** —
- **Description:** TC-UNIT-04 + TC-SEC-01 against the live API.
- **Output:** Evidence.
- **Acceptance:** Blocked addresses rejected; allowlisted internal upstreams accepted.
- **Tests:** TC-UNIT-04, TC-SEC-01.
- **Command:** `npm test -w services/gateway -- ssrf`
- **Evidence:** 2026-10-14 (with UI-05): TC-UNIT-04 `npm test -w services/gateway -- ssrf` → 5/5; TC-SEC-01 in `upstreams-admin.int.test.ts` and against the live k3d API (12 internal/metadata targets → 400 `ssrf_blocked`, allowlisted seeded hosts accepted and Connected). Details in UI-05.
- **Regression risk:** Low.

### REL-09 — Workload securityContext audit
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** INF-15
- **Requirements:** —
- **Description:** runAsNonRoot where possible, no privilege escalation, drop ALL caps, automountServiceAccountToken false.
- **Output:** Chart updates; no exceptions left (WordPress now runs as www-data on 8080).
- **Acceptance:** Check script passes.
- **Tests:** TC-REL-09-1.
- **Command:** `scripts/check-chart.sh` (policy part: `scripts/lib/chart-policy.py`)
- **Evidence:** 2026-10-18. WordPress was the one root workload (Apache bound :80 as root with 7 added capabilities). Now: Apache `Listen 8080` from ConfigMap `wordpress-apache` (ports.conf + 000-default.conf), `runAsUser/Group 33`, `runAsNonRoot`, `capabilities.drop [ALL]` with nothing added, `readOnlyRootFilesystem` + emptyDirs `/var/run/apache2`, `/var/lock/apache2`, `/tmp`; Service 80 → 8080; NetworkPolicies use pod port 8080 (WordPress ingress, woo-mcp egress). MariaDB and the wp-cli init container also got `readOnlyRootFilesystem` (wp-cli: `/tmp` emptyDir). `chart-policy.py` now fails any container that is not non-root numeric user + seccomp RuntimeDefault + no added caps + read-only root: `policy: 31 objects, 0 violations` (local and prod); mutation check with the old wordpress.yaml → 3 FAILs (`capabilities.add [...]`, `must run as a non-root numeric user`, `readOnlyRootFilesystem must be true`). k3d rev 59/60: `id` in the pod → `uid=33(www-data)`, PID 1 `CapEff: 0000000000000000`, `touch /usr/local/x` → Read-only file system, uploads writable; storefront `/`, `/shop/`, `/wp-login.php`, Store API 200, product image 200 `image/webp`; `scripts/e2e-checkout.sh` → order #156 + listed in wp-admin; `e2e-acceptance.mjs orders` 3/3; `k8s-checks.sh netpol` 15 PASS / 0 failures; wp-init rev 60 Completed (50 products unchanged); MariaDB restarted Ready with read-only root. Fresh-volume install (VPS case) in Docker as uid 33, `--read-only --cap-drop ALL`: entrypoint copied WordPress into the empty volume, `blank.gif` 200. **Addendum (with REL-02):** both namespaces now enforce Pod Security `restricted` (was `baseline` because of root WordPress): after `rollout restart` of every Deployment/StatefulSet all pods were re-admitted and Ready; `kubectl -n store run root-test --image=busybox` → `Forbidden: violates PodSecurity "restricted:latest"`; `k8s-checks.sh all` failures: 0, `e2e-acceptance.mjs all` 26 passed / 1 skipped, checkout #157 + wp-admin PASS.
- **Regression risk:** Low; a fresh VPS install is the first real clean run with this (Docker fresh-volume test passed).

### REL-10 — Probes and limits audit
- **Priority:** P0
- **Status:** Done
- **Day:** 6
- **Depends on:** INF-13
- **Requirements:** REQ-K8S-07, REQ-K8S-08
- **Description:** Run TC-K8S-02 on the final chart.
- **Output:** Evidence.
- **Acceptance:** 0 missing.
- **Tests:** TC-K8S-02.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** 2026-10-18 final chart: `scripts/check-chart.sh` → `PASS helm lint (local|prod)`, kubeconform 31 resources valid, `policy: 31 objects, 0 violations` (every container has requests+limits; every long-running container readiness+liveness, Jobs exempt from probes) for local and prod; `PASS only expected keys differ`. Live k3d: all pods Ready.
- **Regression risk:** —

### REL-11 — Helm upgrade and rollback
- **Priority:** P1
- **Status:** Done
- **Day:** 7
- **Depends on:** REL-03
- **Requirements:** REQ-DEL-09
- **Description:** Upgrade the gateway image tag → `helm history` → `helm rollback` → verify; document.
- **Output:** DEPLOYMENT.md section + evidence.
- **Acceptance:** Rollback restores the previous revision without data loss.
- **Tests:** TC-K8S-03.
- **Command:** `helm history platform && helm rollback platform <rev>`
- **Evidence:** 2026-10-18 on k3d (the same Helm chart/commands as the VPS; REL-03 not needed to prove the mechanism): snapshot `26 users, 34 keys, 3 upstreams, 198 audit rows (older than 1 min), 8 orders | gateway image gateway:sha-838c10adbbe1` (rev 60) → new gateway build `sha-41dcd802e51a` → `scripts/deploy.sh local --set gateway.image.tag=sha-41dcd802e51a` → `REVISION: 61`, same counts, `PASS TC-EXT-01 … (64 tools)` → `helm rollback platform 60 --wait` → `Rollback was a success!`, `helm history`: `62 deployed … Rollback to 60`, gateway image `sha-838c10adbbe1`, counts unchanged (keys 35: the check's own temporary key, revoked), `PASS e2e orders: 3 passed`. All pods Running/Completed. DEPLOYMENT.md §6 written (commands, what a rollback does not undo: PVC data kept, forward-only migrations → two-step destructive changes, WooCommerce DB upgrades → dump first). Re-run on the VPS is part of REL-03.
- **Regression risk:** Forward-only migrations (documented).

### REL-12 — README
- **Priority:** P0
- **Status:** Done
- **Day:** 7
- **Depends on:** E2E-14
- **Requirements:** REQ-DEL-01, REQ-DEL-02, REQ-DEL-03, REQ-DEL-08
- **Description:** Local setup, VPS setup, place an order, connect a client, use chat, bonus list.
- **Output:** README.md.
- **Acceptance:** A fresh reader can follow it (dry run on a clean cluster).
- **Tests:** TC-REL-12-1: `scripts/down.sh && follow README` → works.
- **Command:** manual
- **Evidence:** 2026-10-24 TC-REL-12-1 clean-cluster dry run (user go-ahead): `scripts/down.sh --all` (cluster and all data deleted) → `scripts/up.sh` exit 0 in 737 s (all images rebuilt; README timing corrected to 6–12 min), every pod Running, woo seeded members-read-only. Then only README steps: `node scripts/seed-demo-users.mjs` (B created through the invite flow), `scripts/e2e.sh all` → chat flow 13/13 (product 118, guest COD order #119 confirmed in wp-admin) + `e2e all: 26 passed, 0 failed, 1 skipped` (log `docs/evidence/e2e-all-k3d-2026-10-24-clean.txt`); `k8s-checks.sh all` failures 0, `metrics` 7/7 (check fixed to sum both replicas' counters — it read one pod), `replicas` failures 0, `dashboard-screens.sh permissions` 17/17. README: chat section corrected for the members-read-only default + new "Tool permissions" section. The README's VPS section can only be run with a VPS (REL-01/03, BON-07). Earlier: 2026-10-18 README content complete.
- **Regression risk:** —

### REL-13 — System design and trade-offs note
- **Priority:** P0
- **Status:** Done
- **Day:** 7
- **Depends on:** E2E-14
- **Requirements:** REQ-DEL-06
- **Description:** `docs/SYSTEM_DESIGN.md` (or a README section): architecture choices, aggregation, routing, failure handling, production changes.
- **Output:** `docs/SYSTEM_DESIGN.md`
- **Acceptance:** Covers all bullets of REQ-DEL-06.
- **Tests:** checklist review.
- **Command:** —
- **Evidence:** 2026-10-18: `docs/SYSTEM_DESIGN.md` (55 lines). Checklist against REQ-DEL-06: architecture choices → §1 what runs where + §2 choices table with costs (D-002/003/004/008/009/011/012/018/019); tool aggregation, routing, failure handling → §3 (naming/collisions, parallel list with 3 s deadlines and last-good cache, call path with credential injection and retry rules, health loop and fast fail, SSRF guard); production changes → §4 table DNS, ingress, TLS, images, storage class, secrets, resources, upgrade/rollback + what a real production would add. Every behaviour claimed links to verified tasks (E2E-08/09, GW-16, REL-09/11, TC-INT-05); TLS on the VPS is marked as REL-04. Also refreshed the stale 'draft' banners in ARCHITECTURE.md and MCP_DESIGN.md (protocol version note corrected to 'negotiated', audit now implemented).
- **Regression risk:** —

### REL-14 — Threat model final
- **Priority:** P0
- **Status:** Done
- **Day:** 7
- **Depends on:** REL-07, REL-08
- **Requirements:** REQ-DEL-07
- **Description:** Complete §4 answers with verified mitigations (mark Verified + test IDs).
- **Output:** THREAT_MODEL.md.
- **Acceptance:** All 4 required questions answered; no unverified claims.
- **Tests:** checklist review.
- **Command:** —
- **Evidence:** 2026-10-18: THREAT_MODEL.md final for the local deployment. §4: all four REQ-DEL-07 questions answered with the tests behind each claim (Q3 untrusted upstreams: namespacing, caps, server-side prompt, loop limits, admin-only servers, SSRF, instant disable, residual risk stated; Q4 member vs member: the REL-07 boundaries plus shared-credential writes, shared LLM quota, login lockout scope). Row statuses re-checked against evidence: T-03, T-05, T-08, T-11 → Implemented with test IDs; T-07/T-13/T-19 stay Partial and T-17/18/20 Planned (Phase 10 / VPS), with what is missing stated. **Two gaps closed while reviewing:** (1) T-08: no upstream response size cap → `capResponse` in the pool (4 MiB, `UPSTREAM_MAX_RESPONSE_BYTES`, Helm `gateway.upstreamMaxResponseBytes`; Content-Length check + streaming count, POST only); TC-T08-1..3, unit `Tests 99 passed (99)` (mutation: cap off → TC-T08-1 fails), int 118/118, k3d rev 65 acceptance `26 passed, 0 failed, 1 skipped`; also fixed Helm rendering 4194304 as `4.194304e+06` (`int64`). (2) T-11: `scripts/secret-scan.sh` (gitleaks v8.28.0, history + committable files) → first run `leaks found: 35`, all one prose false positive (`token gone from URL, weak/mismatched password…` in TASKS.md and tracker/data.js) → allowlisted in `.gitleaks.toml` → `no leaks found` ×2, `PASS secret scan`; a planted fake `ghp_` token → `leaks found: 1`, `FAIL`; `.env` (gitignored) is excluded by design.
- **Regression risk:** Low; the cap applies to POST responses only (GET SSE untouched).

### REL-15 — Demo rehearsal
- **Priority:** P0
- **Status:** Not Started
- **Day:** 7
- **Depends on:** E2E-14, REL-12
- **Requirements:** REQ-DEL-09
- **Description:** Full dry run of DEMO_RUNBOOK with timing; fix rough edges.
- **Output:** Updated runbook.
- **Acceptance:** Run completes in under 20 min with no failures.
- **Tests:** runbook.
- **Command:** —
- **Evidence:** —
- **Regression risk:** —

### REL-16 — Record demo video
- **Priority:** P0
- **Status:** Not Started
- **Day:** 7
- **Depends on:** REL-15, BON-16
- **Requirements:** REQ-DEL-09
- **Description:** Record covering all 6 required topics.
- **Output:** Video link.
- **Acceptance:** Checklist of topics ticked.
- **Tests:** checklist.
- **Command:** —
- **Evidence:** —
- **Regression risk:** —

### REL-17 — Repository check and submission
- **Priority:** P0
- **Status:** Not Started
- **Day:** 7
- **Depends on:** REL-16
- **Requirements:** REQ-DEL-10
- **Description:** Secret scan, clean clone build, links, then **the user** submits the form (https://forms.gle/nftwgyNeenSDmiRb6).
- **Output:** Confirmation from the user.
- **Acceptance:** User confirms submission.
- **Tests:** TC-SEC-04; clean clone `scripts/up.sh`.
- **Command:** `gitleaks detect` (or grep scan)
- **Evidence:** —
- **Regression risk:** —

---

## Phase 9 — Storefront brand and catalogue
Brand: **TATVA (current working concept; may change, D-015)**. Source material: [`brand/tatva/tatva-brand-and-products.md`](brand/tatva/tatva-brand-and-products.md) (brand + catalogue), [`brand/tatva/v1-brand-ui-theme.md`](brand/tatva/v1-brand-ui-theme.md) (UI/theme), [`docs/PRODUCT_IMAGES.md`](docs/PRODUCT_IMAGES.md) (images). If the concept changes, only these docs and D-015 change; the tasks stay the same.
Exit criterion: the storefront follows the current brand concept and theme spec, has the catalogue, comes back the same on a fresh cluster, and checkout and MCP tests still pass. Added 2026-10-12 at the user's request. Runs alongside Phase 4 on Day 3; P2, so brand polish is the first thing cut if behind.

### BRD-01 — Niche and positioning
- **Priority:** P2
- **Status:** Done
- **Day:** 3
- **Depends on:** WC-03
- **Requirements:** —
- **Description:** Current working concept **TATVA** (D-015, may change): curated multi-brand Indian lifestyle store, primary line "The Essence of Good Design.", 5 categories (Home & Living hero), placeholder brands, voice and merchandising rules. Source of truth: `brand/tatva/tatva-brand-and-products.md` (user-supplied).
- **Output:** `brand/tatva/tatva-brand-and-products.md` (brand + catalogue), applied in theme copy and `services/store-assets/stores/tatva/catalogue.json`.
- **Acceptance:** BRD-02..05 built from it without further questions; brand-name review note for REL-16/17 recorded (D-015).
- **Tests:** TC-BRD-01-1: copy check — site title, tagline, hero, concept page match the doc; no unsupported claims.
- **Command:** —
- **Evidence:** 2026-10-12: site title "TATVA – The Essence of Good Design." on every page; concept page and homepage copy follow §1–4/§7 of the doc (no "sustainable/handmade/organic" claims, demo disclosure in footer, brand pages and product pages). Scan of 10 storefront pages for "urumi" → 0.
- **Regression risk:** Concept may change: only the docs, D-015, `catalogue.json` and the theme copy need edits.

### BRD-02 — Logo and visual identity
- **Priority:** P2
- **Status:** Done
- **Day:** 3
- **Depends on:** BRD-01
- **Requirements:** —
- **Description:** Wordmark for the working name (Literata, letter-spaced, as site title so it stays crisp and editable) + SVG wordmark + site icon; palette and fonts from `brand/tatva/v1-brand-ui-theme.md` §2 (+ terracotta accent).
- **Output:** `brand/tatva/logo/tatva-wordmark.svg`, `brand/tatva/logo/site-icon-512.png`, `favicon-64.png`; site icon installed by the importer; fonts Literata + Manrope (OFL, bundled in the theme, no CDN).
- **Acceptance:** Logo readable at 32 px; text pairs meet WCAG AA.
- **Tests:** TC-BRD-02-1 contrast; TC-BRD-02-2 favicon set.
- **Command:** —
- **Evidence:** 2026-10-12: site icon = forest-green "T" monogram (512 px) set as `site_icon` by the importer. Contrast (WCAG formula, computed): charcoal/ivory 13.50, forest/ivory 11.07, white/forest 11.96, charcoal/sand 10.78, forest/sand 8.84, footer note/forest 8.82, terracotta/ivory 5.04; spec grey #737873 on ivory 4.17 (fails AA 4.5) → muted grey token darkened to #5F645F: 5.59 on ivory, 6.04 on white. Fonts served from the theme (no external requests: audit console errors 0 on 20/22 page views).
- **Regression risk:** Changing the name means changing the site title value and the SVG text only.

### BRD-03 — Design tokens and theme
- **Priority:** P2
- **Status:** Done
- **Day:** 3
- **Depends on:** BRD-02
- **Requirements:** —
- **Description:** Theme decision (D-016): `tatva` child theme of Twenty Twenty-Five (block theme, WooCommerce blocks). theme.json maps the TATVA palette onto the parent's slots (base, contrast, accent-1..6) so every parent/WooCommerce template inherits it; type scale Literata (display) + Manrope (UI).
- **Output:** `services/store-assets/theme/tatva/` (theme.json, style.css, functions.php, parts/, templates/, patterns/, assets/).
- **Acceptance:** Tokens match `brand/tatva/v1-brand-ui-theme.md`; no hard-coded colours outside theme.json except the documented footer note tint.
- **Tests:** TC-BRD-03-1 grep for raw hex outside theme.json.
- **Command:** `grep -rn "#[0-9A-Fa-f]\{6\}" services/store-assets/theme/tatva --include=*.css --include=*.html --include=*.php`
- **Evidence:** 2026-10-12: palette Warm ivory #F8F6F0, Charcoal #252A27, Forest #173D35, Sand #E8DCC9, Sage #A6B7A0, Muted grey #5F645F, White, Terracotta #A4532F; buttons 2 px radius, visible focus outline, reduced-motion respected. Raw hex outside theme.json: footer note colour #d9dfd6 only (documented).
- **Regression risk:** A parent-theme update could change parent patterns; our templates override header, footer, home, archives, brand and product pages.

### BRD-04 — Storefront UI layout
- **Priority:** P2
- **Status:** Done
- **Day:** 3
- **Depends on:** BRD-03
- **Requirements:** —
- **Description:** Pages per `brand/tatva/v1-brand-ui-theme.md`: header (wordmark, Home/Shop/Brands/Categories/Our Concept, search, account, cart; mobile menu), homepage sections in spec order (hero, curation principles, shop by category, featured brands, featured products, curated collection "The Morning Table", concept), shop/category/brand/search archives with category/brand/price filters and sorting (no rating sort: no reviews exist), product page (gallery, brand, ₹ price, add to cart, SKU, demo-listing note, related products), brand directory, category directory, concept page, footer. Brand shown on cards, product page and cart lines. Missing-image fallback.
- **Output:** Theme templates/patterns; pages Brands, Categories, Our Concept created by the importer (bodies are theme patterns).
- **Acceptance:** Homepage matches the spec sections in order; links work; mobile usable; checkout still works.
- **Tests:** TC-BRD-04-1 screenshots desktop+mobile; TC-BRD-04-2 search returns products; TC-BRD-04-3 empty search shows a clear empty state.
- **Command:** `scripts/storefront-screens.sh`
- **Evidence:** 2026-10-12: `scripts/storefront-screens.sh` → 11 pages × 2 viewports: all 200, broken images 0, missing alt 0, horizontal scroll none, console errors 0 on 20/22 (the 2 are `/cart/`: WooCommerce cart script requests `/cart/undefinedwc/store/v1/cart` → 404; cart and checkout work, source not yet identified — open item). Search "mug" → product found; "zzzz" → "No products found" state. Screenshots: `docs/evidence/brd-07-*.jpg`.
- **Regression risk:** Block checkout markup changes could affect `scripts/e2e-checkout.sh`.

### BRD-05 — Product catalogue and images
- **Priority:** P2
- **Status:** Done
- **Day:** 3
- **Depends on:** BRD-01
- **Requirements:** —
- **Description:** INR store; 5 categories, 9 placeholder brands (WooCommerce Brands), the 50-product proposed catalogue from `brand/tatva/tatva-brand-and-products.md` §6 (illustrative ₹ prices, descriptions only restating the product name), 8 featured, collection tag "The Morning Table". Images per `docs/PRODUCT_IMAGES.md`, restricted to **CC0 / Public Domain** (no attribution needed, so the store shows no credits — user decision 2026-10-12); sourced via the Openverse and Wikimedia Commons APIs, chosen visually, cropped/resized only. Imported idempotently (SKU, image key + checksum); replaces the old sample products (trashed).
- **Output:** `services/store-assets/stores/tatva/catalogue.json`, `services/store-assets/stores/tatva/images/{products,editorial,brand}/`, `services/store-assets/stores/tatva/images/manifest.json` (source, creator, licence, URLs, original size, sha256, modifications, alt), `services/store-assets/import/import-catalogue.php`, tools `scripts/brand/{find_images,fetch_image,validate_images}.py`.
- **Acceptance:** Fresh install → all 5 categories have products; re-running wp-init creates no duplicates; every product has an image or a recorded gap.
- **Tests:** TC-BRD-05-1 counts; TC-BRD-05-2 re-run → unchanged; TC-BRD-05-3 MCP list_products returns ₹ catalogue; TC-BRD-05-4 `validate_images.py`.
- **Command:** `python3 scripts/brand/validate_images.py && scripts/woo-int.sh`
- **Evidence:** 2026-10-12: `validate_images.py` exit 0 — products with images **49/50** (gap: TAT-005 desk organiser, no suitable CC0 image without an identifiable third-party product → WooCommerce placeholder + theme fallback), 8 editorial/category images, 57 unique files, licences CC0 56 + Public domain 1, sources Openverse (rawpixel 26, StockSnap 24, WordPress Photo Directory 2, Flickr 2) + Wikimedia Commons 3, 2.6 MB total, WebP 800×1000 (products) / 900×1125 (tiles) / 3:2 (editorial). Import: first run "50 created, 16 images, 3 retired"; after images "54 images uploaded"; two no-op deploys "0 created, 0 updated, 50 unchanged, 0 images uploaded"; DB: 50 published products, 55 tracked attachments, no duplicate keys. Via gateway `woo__list_products {search:"stoneware"}` → Stoneware breakfast bowl 1050, dinner plate 950, Hand-finished stoneware mug 1299. `scripts/woo-int.sh` 7/7.
- **Regression risk:** Openverse rawpixel originals are served at ~1024 px, so some product images are upscaled to 800×1000 (soft on large screens). Changing image keys re-uploads media.

### BRD-06 — Theme and asset packaging
- **Priority:** P2
- **Status:** Done
- **Day:** 3
- **Depends on:** BRD-03, BRD-05
- **Requirements:** —
- **Description:** `store-assets` image (busybox 1.37.0, files only) built by `scripts/build-images.sh` with a content-addressed tag; the wp-init Job copies it via an initContainer into an emptyDir, then WP-CLI swaps the theme in atomically, activates it and runs the importer. Toggle `store.init.brand.enabled` (off → old plain store). Store settings from values: title TATVA, INR, Asia/Kolkata, IN:KA.
- **Output:** `services/store-assets/Dockerfile`, `charts/platform/templates/store/wp-init.yaml` (initContainer + emptyDir), `charts/platform/files/wp-init.sh`, values `store.init.brand`, `scripts/deploy.sh` tag wiring.
- **Acceptance:** Fresh helm install → branded store with no manual steps; data survives pod deletion.
- **Tests:** TC-BRD-06-1 fresh cluster → branded homepage. TC-BRD-06-2 delete wordpress pod → still branded.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** 2026-10-12: `check-chart.sh` → lint ×2, kubeconform 24/24 ×2, policy 0 violations. Deploys rev 5–15 applied the theme + import through the Job (no manual steps). TC-BRD-06-2 PASS: `kubectl delete pod -l app=wordpress` → new pod Ready → title "TATVA – The Essence of Good Design.", hero and brands present. TC-BRD-06-1 on a deleted cluster **not re-run** after branding (it wipes local data; the INF-15 clean run predates branding) — run with `scripts/down.sh --all && scripts/up.sh` before REL.
- **Regression risk:** For the VPS the `store-assets` image must be pushed to the registry like the other images (REL-03).

### BRD-07 — Storefront verification
- **Priority:** P2
- **Status:** Done
- **Day:** 3
- **Depends on:** BRD-04, BRD-06
- **Requirements:** —
- **Description:** Screenshots (desktop + mobile) checked against `brand/tatva/v1-brand-ui-theme.md` §9; regression of checkout and MCP tools.
- **Output:** `docs/evidence/brd-07-*.jpg`; `scripts/storefront-screens.sh`, `tests/e2e/screens.mjs`.
- **Acceptance:** Checkout (COD) passes; woo-int passes; screenshots stored.
- **Tests:** TC-BRD-07-1 `scripts/e2e-checkout.sh` → COD PASS. TC-BRD-07-2 `scripts/woo-int.sh` → all PASS.
- **Command:** `scripts/e2e-checkout.sh && scripts/woo-int.sh`
- **Evidence:** 2026-10-12: e2e checkout PASS (TATVA mug, Indian address, Bengaluru/Karnataka/560001, COD) — orders #83, #139; `scripts/woo-int.sh` 7/7 (product lookup now by search: catalogue + draft test products exceed one page); woo-mcp unit 26/26; gateway unit 48/48. 9 screenshots in `docs/evidence/brd-07-*.jpg`. §9 checklist: warm editorial direction, concept understandable from the homepage, coherent shop/category/brand/product pages, brand visible but not dominant, buy within the store, deliberate mobile layout (2-column category tiles, mobile menu), accessible contrast/focus/alt, claims marked as demo.
- **Regression risk:** —

### BRD-08 — Admin and login branding
- **Priority:** P2
- **Status:** Done
- **Day:** 3
- **Depends on:** BRD-06
- **Requirements:** —
- **Description:** TATVA look for wp-admin and `wp-login.php` (user request 2026-10-13). A registered admin colour scheme "TATVA" (forest menu, sand current item, terracotta counters; palette from `theme.json`), default for new users and for the admin user while still on the default scheme; login page with the TATVA wordmark, cream background and forest button; logo links to the store. Presentation only: no auth, capability or login-flow change. Users can still pick another scheme under Users → Profile, and wp-init keeps it.
- **Output:** `services/store-assets/theme/tatva/inc/admin.php`, `assets/css/admin-colors.css`, `assets/css/login.css`, `assets/images/tatva-wordmark.svg`; `charts/platform/files/wp-init.sh` (scheme for the admin user); `scripts/admin-screens.sh`, `tests/e2e/admin-screens.mjs`.
- **Acceptance:** Admin pages use the TATVA scheme; login page shows the wordmark and links to the store; a user-chosen scheme survives redeploys; storefront audit unchanged.
- **Tests:** TC-BRD-08-1 admin scheme loaded and computed colours (desktop + mobile). TC-BRD-08-2 login wordmark (SVG 200), link to store, colours. TC-BRD-08-3 wp-init sets `tatva` only when the scheme is unset/default; storefront audit and chart check still pass.
- **Command:** `SERVICES=store-assets scripts/build-images.sh && scripts/deploy.sh local && scripts/admin-screens.sh`
- **Evidence:** 2026-10-13: `scripts/admin-screens.sh` → 11/11 PASS: `admin-color-tatva` body class + scheme stylesheet; `#adminmenuwrap` rgb(23, 61, 53), current item rgb(232, 220, 201), admin bar rgb(15, 44, 38) (desktop + mobile); login logo `/wp-content/themes/tatva/assets/images/tatva-wordmark.svg` → 200, link `http://store.127.0.0.1.nip.io/` "TATVA", body rgb(248, 246, 240), button rgb(23, 61, 53); Profile offers TATVA among 10 schemes. TC-BRD-08-3: users already on `modern` were left unchanged by wp-init rev 16 (no "admin colour scheme" line); after deleting the admin's `admin_color` meta, rev 18 logged `admin colour scheme: tatva` and the meta is `tatva`. Catalogue import still "0 created, 0 updated, 50 unchanged". `scripts/check-chart.sh` → 0 violations; `scripts/storefront-screens.sh` → 20 OK, 2 WARN (the known `/cart/undefinedwc/store/v1/cart` 404, unchanged). Screenshots `docs/evidence/brd-08-*.jpg`.
- **Regression risk:** Low; a WordPress core admin CSS change could leave some elements in the default colours.

## Phase 10 — Security testing: attack and harden
Exit criterion: every scan and manual test in `docs/SECURITY_TESTING.md` has run, every finding in `docs/SECURITY_FINDINGS.md` is fixed (with a regression test) or explicitly accepted, and `docs/SECURITY_REPORT.md` is written. Added 2026-10-12 at the user's request. Starts after E2E-14 (Day 6–7) and continues after submission. **Scope: only our own targets** — the local k3d hosts (`*.127.0.0.1.nip.io`, the cluster) and later our own VPS. Third-party services we only connect to (GitHub remote MCP, Groq, OpenRouter) are out of scope.

### SEC-01 — Rules of engagement and findings workflow
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** E2E-14
- **Requirements:** —
- **Description:** Fix scope, targets, test accounts (users A and B and a throwaway admin only), allowed times, severity scale (Critical/High/Medium/Low/Info), and the loop: find → `docs/SECURITY_FINDINGS.md` row → fix → retest → regression test → close.
- **Output:** `docs/SECURITY_TESTING.md` (rules + tool list), `docs/SECURITY_FINDINGS.md`.
- **Acceptance:** Both docs exist; every later SEC task logs into the findings table.
- **Tests:** TC-SEC-01-1: findings table parses (one row per finding, all columns filled).
- **Command:** —
- **Evidence:** 2026-10-25 — `docs/SECURITY_TESTING.md` (scope, accounts, severity, workflow, every tool pinned with its command), `docs/SECURITY_FINDINGS.md` (one row per finding, 29 rows). TC-SEC-01-1 `node scripts/sec/findings-check.mjs` → `PASS findings table (total 29, Fixed 22, Accepted 5, False positive 2)`; mutation: a bad severity and an Open row → 2 FAIL lines, exit 1.
- **Regression risk:** —

### SEC-02 — Web scanners against the storefront
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** SEC-01
- **Requirements:** —
- **Description:** WPScan (core, themes, plugins, user enumeration), nuclei and nikto (misconfiguration, exposed `xmlrpc.php`, `readme.html`, `wp-json/wp/v2/users`, directory listing, debug output). All tools run as pinned Docker images.
- **Output:** Reports under `docs/evidence/sec-02/`; findings logged.
- **Acceptance:** No open High/Critical; user enumeration and `xmlrpc.php` disabled or justified.
- **Tests:** TC-SEC-02-1: WPScan → no vulnerable components. TC-SEC-02-2: `GET /wp-json/wp/v2/users` anonymously → no user list.
- **Command:** `scripts/sec/wp-scan.sh`
- **Evidence:** 2026-10-25 — `scripts/sec/wp-scan.sh` (WPScan 3.8.28, nuclei 3.4.10 + templates v10.5.0, nikto 2.5.0 built from its tag, curl). First WPScan run still identified `admin` → **F-WEB-6**; nikto → **F-WEB-7** (versions), **F-WEB-8** (no store headers), F-WEB-14 (Info). After the fixes: curl 31/31 PASS (TC-SEC-02-2 users REST 401, -5 xmlrpc 403, -6 author 404, -7 version files 403, -8 no listings, -10 WC REST 401, -12/13/14/17 no versions, -15/16 no author, -18/19 same answers for real and unknown users); WPScan "identified no users", "WordPress version could not be detected", XML-RPC not reported; nuclei 4857 templates → 0 results (the first nuclei runs loaded no templates — caught by the new templates-loaded check); nikto 10 items, all reviewed (wp-app.log = 404 false positive). WPScan has no API token (vulnerability DB needs a registered account): component CVEs come from Trivy/nuclei instead. WooCommerce REST (woo-mcp) unaffected: e2e orders/tools PASS. Reports `docs/evidence/sec-02/`.
- **Regression risk:** Disabling REST user endpoints must not break WooCommerce REST used by woo-mcp.

### SEC-03 — OWASP ZAP scans
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** SEC-01
- **Requirements:** —
- **Description:** ZAP baseline (passive) on the store and dashboard; authenticated ZAP API scan of `/api` (OpenAPI or recorded requests) as a member and as an admin.
- **Output:** HTML reports under `docs/evidence/sec-03/`; findings logged.
- **Acceptance:** No open High; Medium items fixed or accepted with a reason.
- **Tests:** TC-SEC-03-1: baseline → 0 FAIL. TC-SEC-03-2: API scan → no 5xx with stack traces, no reflected input.
- **Command:** `scripts/sec/zap.sh`
- **Evidence:** 2026-10-25 — `scripts/sec/zap.sh` (zap-stable 2.16.1). Baseline (passive): store → 4 Medium triaged (F-WEB-12 CSRF-token heuristics, F-WEB-13 CSP without script-src), 0 High; dashboard → 0 Medium/High. API scan (active) from `tests/security/zap/openapi.json` as member and as admin against a **throwaway gateway** in Docker (own Postgres, everything-mcp upstream, random secrets): 0 High after triage (one run reported SQLi on login = **F-AUTH-3** false positive caused by the login limiter), 8574 requests, 0 unexpected 5xx (503 chat_disabled expected: no LLM key), no stack trace. Reports and summaries in `docs/evidence/sec-03/`.
- **Regression risk:** Active scans create junk data; run against a throwaway install.

### SEC-04 — Manual auth and business-logic tests
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** SEC-01, REL-07
- **Requirements:** REQ-AUTH-01, REQ-AUTH-04
- **Description:** Member calls every admin `/api` route; revoked and malformed keys on `/mcp`; key prefix enumeration and timing; IDOR on keys, members and audit rows; CSRF and session handling (fixation, logout, cookie reuse); login brute force and lockout/rate limit; invite token reuse; checkout price/quantity/coupon tampering via Store API.
- **Output:** Test scripts under `tests/security/`; findings logged.
- **Acceptance:** Every case rejected server-side and recorded in the audit log where applicable.
- **Tests:** TC-SEC-04-1 … one per case above, automated where possible.
- **Command:** `npm test -w tests/security`
- **Evidence:** 2026-10-25 — workspace `tests/security` (vitest, live against k3d): `npm test -w tests/security` → 4 files, 55 passed (+36 hostile, run by SEC-05). TC-SEC-04-1 15 admin routes × (member 403, anonymous 401), no credential in upstream views; -2 revoked key 401 on the next call, 9 malformed keys 401, Basic/query-string keys refused; -3 forged prefix = random key byte-for-byte, timing median diff 0.0 ms; -4 IDOR (keys 404, no minting for others, audit 403, mass assignment 400, forbidden tool audited `rejected/tool_forbidden` under B); -5 invite reuse/withdrawn/guessed/role injection refused; -6 CSRF (foreign, null, look-alike Origin, cross-site, form-encoded) 403; -7 fixation, logout, disabled user (sessions and keys dead at once); -8 brute force → **F-AUTH-2** (10 guesses with 2 replicas) fixed → 429 after 5, XFF/case/space bypasses fail; -9/-10 Store API: client prices ignored, bad quantities refused, fake coupons 400, trashed products refused, tampered checkout (total 1, status completed, set_paid, customer_id 1, forged transaction id) → order #127 at the catalogue price ₹649, not paid, guest, then cancelled through the gateway. Output `docs/evidence/sec-04/`. Regression: the file costs 7 failed logins (the shared per-IP limit is 20 / 15 min; an earlier version used 19 and locked the dashboard tests' admin login once).
- **Regression risk:** Rate limits must not break the E2E suite (exempt or raise for test keys).

### SEC-05 — MCP and AI-specific tests
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** SEC-01, REL-08
- **Requirements:** —
- **Description:** Register a deliberately hostile in-cluster test upstream: prompt injection in tool descriptions and results, huge and slow responses, tool names that try to spoof another server's `slug__tool`. SSRF via upstream URL (metadata IP, cluster services, redirects, DNS rebinding). Try to make the chat agent reveal upstream credentials or other users' data, or call tools as another user.
- **Output:** Hostile test upstream (test-only chart toggle); findings logged; THREAT_MODEL updated.
- **Acceptance:** No credential or cross-user leak; hostile upstream cannot break listing or other upstreams; SSRF targets rejected.
- **Tests:** TC-SEC-05-1 injection; TC-SEC-05-2 oversize/slow; TC-SEC-05-3 name spoof; TC-SEC-05-4 SSRF set (incl. TC-SEC-01); TC-SEC-05-5 chat credential exfiltration attempt.
- **Command:** `scripts/sec/hostile.sh`
- **Evidence:** 2026-10-25 — test-only upstream `services/hostile-mcp` (chart `hostileMcp.enabled`, false in every values file; `check-chart.sh` fails if a values file renders it) + `tests/security/hostile.test.mjs`, run by `scripts/sec/hostile.sh` (on → tests → off) → 36/36 PASS (`docs/evidence/sec-05/`). TC-SEC-05-1 injected descriptions labelled `[hostile]` and ≤ 1024 chars, no client key/cookie reaches the upstream; -2 10 MB result refused (safe error), slow tool times out at 15.0 s while tools/list answers in 0.2 s, hanging/broken/redirecting servers left out, 3000 tools → **F-MCP-5** fixed (128); redirect to 169.254.169.254 not followed; -3 spoofed `woo__list_orders` stays `hostile__woo__list_orders`, the real one still reaches WooCommerce, names unique and ^[a-zA-Z0-9_-]{1,64}$, duplicates dropped; -4 21 SSRF URLs (metadata incl. IPv4-mapped IPv6, loopback forms, cluster services, private/CGNAT, nip.io to 10.x, file/gopher/ftp, userinfo) and a PATCH to metadata → 400; -5 chat (Groq) with injected results and credential / cross-user requests: no secret pattern, no order-status change, no get-env, no system-prompt text (4/4 ran).
- **Regression risk:** The hostile upstream must be disabled by default in every values file.

### SEC-06 — Container and Kubernetes scans
- **Priority:** P1
- **Status:** Done
- **Day:** 6
- **Depends on:** SEC-01, REL-09
- **Requirements:** REQ-K8S-09
- **Description:** Trivy CVE scan of every image we build or pin; kubescape config scan of the rendered chart; a rogue pod in each namespace tries to reach woo-mcp, MariaDB, Postgres and the gateway's internal ports (NetworkPolicy escape); check service-account tokens are not mounted; gitleaks on the full git history.
- **Output:** Reports under `docs/evidence/sec-06/`; findings logged.
- **Acceptance:** No fixable Critical CVEs; NetworkPolicy blocks all unintended paths; gitleaks clean.
- **Tests:** TC-SEC-06-1 trivy; TC-SEC-06-2 kubescape; TC-SEC-06-3 rogue-pod matrix (incl. TC-SEC-02); TC-SEC-06-4 gitleaks (TC-SEC-04).
- **Command:** `scripts/sec/k8s-scan.sh`
- **Evidence:** 2026-10-25 — `scripts/sec/k8s-scan.sh all`. TC-SEC-06-1 Trivy (ours + third-party): gateway, woo-mcp, everything-mcp, dashboard, store-assets 0/0; wordpress rebuild 0 CRITICAL / 1 HIGH, wordpress:cli 0/1, mariadb and postgres 0 CRITICAL except gosu (**F-INF-5** accepted: never runs, pods start non-root); **F-INF-6** the pulled tags had 78 HIGH → pinned by digest (D-025). TC-SEC-06-2 kubescape NSA+MITRE on the local and prod renders: 99.67, only failed control C-0012 = **F-INF-7** false positive. TC-SEC-06-3 rogue-pod matrix `k8s-checks.sh netpol` + new `rogue` (random pods in store, platform and default against postgres, mariadb, woo-mcp, the gateway pod directly on 8080 and 9464, the API server; label-specific paths) → 49 probes, 0 failures. TC-SEC-06-4 gitleaks PASS. TC-SEC-06-5 no SA token mounted in any pod. TC-SEC-06-6 (new) no credential pattern in pod logs → found **F-WEB-11** (consumer key in Apache's log) → fixed. Summaries `docs/evidence/sec-06/`.
- **Regression risk:** Base-image bumps can change behaviour; rerun the full E2E after.

### SEC-07 — Security headers, cookies and TLS
- **Priority:** P1
- **Status:** Blocked
- **Day:** 7
- **Depends on:** SEC-01, REL-04
- **Requirements:** —
- **Description:** Local part (can start now): CSP, X-Frame-Options/frame-ancestors, X-Content-Type-Options, Referrer-Policy on store and dashboard; Secure/HttpOnly/SameSite on session cookies. **Blocked part:** `testssl.sh` and HSTS on the VPS need the VPS and TLS (REL-04).
- **Output:** Traefik middleware / app header config; testssl report.
- **Acceptance:** Headers present on every response; testssl grade without High issues.
- **Tests:** TC-SEC-07-1 headers check; TC-SEC-07-2 cookie flags; TC-SEC-07-3 testssl (VPS).
- **Command:** `scripts/sec/headers.sh`
- **Evidence:** 2026-10-25 — local part Done: `scripts/sec/headers.sh` → 15/15 PASS: TC-SEC-07-1 store (HTML, static, Store API JSON, 404), dashboard (index, route, asset), gateway (/api 401/400, /mcp 401, `no-store`); TC-SEC-07-2 dashboard `sid` HttpOnly + SameSite=Strict, WooCommerce session cookie HttpOnly + SameSite=Lax. Found and fixed **F-WEB-8** (store had none of the headers), **F-WEB-9** (gateway JSON), **F-WEB-10** (cookies without SameSite; the first Apache rule segfaulted, see the row). HSTS is sent only over TLS (verified in the pod with X-Forwarded-Proto https). **Blocked:** testssl.sh, HSTS and the Secure flag on the VPS (REL-04).
- **Regression risk:** A strict CSP can break WordPress admin and block checkout scripts.

### SEC-08 — Attacker-LLM loop
- **Priority:** P1
- **Status:** Done
- **Day:** 7
- **Depends on:** SEC-02, SEC-03, SEC-04, SEC-05, SEC-06
- **Requirements:** —
- **Description:** A second LLM session acts as attacker, using `docs/RED_TEAM_BRIEF.md` (scope, targets, user-B key only, goals, report format). Work in rounds: the attacker reports findings, this session fixes each one with a regression test, and the attacker retests. The attacker never gets admin credentials, upstream secrets or cluster access beyond what a member has.
- **Output:** `docs/RED_TEAM_BRIEF.md`; one findings-table row per issue; round log in `docs/SECURITY_FINDINGS.md`.
- **Acceptance:** At least 2 rounds; the last round finds no new High/Critical. **Relaxed to 1 round by user decision 2026-10-25 (SPEC A-12);** both round-1 findings fixed and verified.
- **Tests:** Regression tests added per finding (TC-SEC-08-n).
- **Command:** `npm test -w services/gateway` (unit) + `npm test -w tests/security -- authz` (live)
- **Evidence:** 2026-10-25 — attacker = a separate LLM **subagent** (this session the defender), user-B member key only, live k3d. **Round 1: 2 findings + 1 observation; both fixed and verified, SEC-08 closed after round 1 (user decision, A-12).** Setup: targets on host port 80 (`http://{store,app}.127.0.0.1.nip.io/`), brief URLs resolved; user B `/api/me` role=`member`, member key minted via `/api/keys` — no admin/upstream/cluster access. **F-MCP-6 (High):** members got all 46 `github__*` incl. destructive writes (default `memberAccess=all`). Fixed — `SEED_GITHUB_MEMBER_TOOLS` chart value defaults members to 26 read-only tools; live row patched to `memberAccess=selected` (26); gateway `sha-bc6ad1732a0f`. **F-API-1 (Low):** member `/api/upstreams` leaked internal `lastError`/timing; moved to admin-only view. **Held:** RBAC (past CSRF gate), key scoping+revocation, no credential/key leak, SSRF allowlist, server-authoritative pricing, injection-resistant chat. **Observation accepted:** member reads of minimized customer orders are intended (T-27). Tests: gateway unit 112/112 incl. TC-SEC-08-1 (seed); `tests/security` authz 24/24 incl. TC-SEC-08-1 (live policy: github `memberAccess=selected`, no writes, member⊂admin) and TC-SEC-08-2 (member rows carry no `lastError`/timing/`url`, admin rows do). Rounds logged in `docs/SECURITY_FINDINGS.md`.
- **Regression risk:** Fixes under time pressure; every fix reruns the E2E suite.

### SEC-09 — Hardening sign-off and security report
- **Priority:** P1
- **Status:** Done
- **Day:** 7
- **Depends on:** SEC-08
- **Requirements:** REQ-DEL-07, REQ-DEL-08
- **Description:** Close or formally accept every finding; update THREAT_MODEL; write the report used for the video's "Security posture" section.
- **Output:** `docs/SECURITY_REPORT.md` (what was tried, found, fixed, residual risk).
- **Acceptance:** Findings table has no open item without an owner and reason.
- **Tests:** TC-SEC-09-1: full E2E + security suites green after all fixes.
- **Command:** `scripts/sec/static.sh && node scripts/sec/findings-check.mjs --signoff && scripts/e2e.sh && npm test -w tests/security`
- **Evidence:** 2026-10-26 **k3d sign-off (rev 29–33, `main` incl. 026cedb):** TC-SEC-09-1 full regression `scripts/e2e.sh all` → `PASS UI-19 chat flow (13/13)`, `PASS e2e all: 26 passed, 0 failed, 1 skipped` (skip = TC-E2E-07, run on its own: GW-15 issue #1), `PASS e2e oauth`; plus `e2e.sh stores` 31/31 and `e2e.sh hosted` 25/25. Live security suites on the cluster: `tests/security` oauth 13/13 (TC-SEC-12), stores 18/18 with `SEC_ALLOW_BULK=1` (TC-SEC-11 incl. the cap race on two gateway replicas), authz 24/24, session 14/14, checkout 15/15, bruteforce 2/2, `scripts/sec/hostile.sh` 36/36. `scripts/sec/static.sh` → `checks failed: 0, skipped: 0` (npm audit, gitleaks history + tree, semgrep, hadolint, kube-linter ×3, chart policy; tools run from their pinned images; the tree scan now skips the gitignored `.env`, mutation-checked: a planted fake PAT in a normal file still fails). `scripts/sec/k8s-scan.sh trivy` → 0 fixable CRITICAL on all 10 images. **Found:** F-INF-10 (provisioner never scanned; Helm v3.22.0 Go CVEs, 5 HIGH → fixed: Helm v3.22.1 built with Go 1.26.10, 0 HIGH) and F-INF-11 (brotli HIGH in the WordPress images, no upstream rebuild yet → Accepted by the user with re-check). `scripts/sec/findings-check.mjs` → total 42, Fixed 31, Accepted 8, False positive 3, 0 open. Not covered here: TLS/HSTS on a real domain (SEC-07, VPS). 2026-10-25 (no cluster in this session — the parts that need one are listed). Done now: `docs/SECURITY_REPORT.md` (what was tried, found, fixed, accepted, residual risk, what is not yet proven, video talking points, how to re-run); `scripts/sec/static.sh` (npm audit, gitleaks history + tree, semgrep with 7 rule packs, hadolint on every Dockerfile, kube-linter on the platform/store/hosted charts, kubeconform) → `checks failed: 0, skipped: 0` (`docs/evidence/sec-static-2026-10-25.txt`); new live suite `tests/security/stores.test.mjs` (TC-SEC-11, 18 tests: authorization matrix, IDOR, CSRF/origin, 16 injection payloads × 3 fields, mass assignment, one-time secrets under a 10-way race, ~30 hosted image/env/path attacks, forged internal calls, cap race, store tool access) run against the real gateway + a stand-in provisioner: 17 passed, 1 skipped; plus `tests/security/oauth.test.mjs` (TC-SEC-12, 13 attack tests on the OAuth authorization server: hostile redirect URIs and metadata, open-redirect probes, PKCE downgrades, parameter pollution, consent CSRF/replay, code replay, refresh rotation/replay, OAuth tokens on /api, revocation, uniform 401) 13/13, mutation-checked (accepting any redirect URI fails 9) (store tools through `/mcp` need real upstreams); mutation-checked (removing the owner scoping fails 3 tests). Findings: **F-CRY-1** (Medium: GCM openers accepted truncated tags — a correct 4-byte prefix opened a blob; fixed in 3 places, unit mutation-checked), **F-API-2** (Low: hosted path dot segments; API + DB CHECK, migration 0009), **F-DEP-1/2/4** (fastify 5.12.7, fast-uri/ip-address, vite 8.3.4: fixed), **F-DEP-3/F-INF-9** accepted with reasons, **F-INF-8** (anti-affinity, PDB policy: fixed), **F-SEC-1** false positive. Also found and fixed a documentation bug: the findings table was split by a blank line, so `findings-check.mjs` had ignored 11 rows; the table is one block and the checker now fails when a row sits outside it (mutation-checked). `node scripts/sec/findings-check.mjs --signoff` → `PASS … (total 40, Fixed 30, Accepted 7, False positive 3)`: no open finding. Regression after the dependency upgrades: gateway unit 119/119, provisioner 26/26, dashboard 30/30, gateway int 174/175 (1 pre-existing host failure), typecheck clean, `check-chart.sh` exit 0 with kubeconform (50/50 valid), `check-docs.sh` PASS. **Not done (needs k3d/VPS):** TC-SEC-09-1 (full E2E + the security suites after all fixes, including `tests/security` on the cluster and the 3 environment-dependent `authz` checks that failed against a hand-started gateway without the real woo/GitHub upstreams), `k8s-checks.sh stores|hosted|rbac`, Trivy on the rebuilt images, testssl on a VPS (SEC-07). SEC-09 therefore stays In Progress.
- **Regression risk:** —

---

## Phase 11 — Bonus and stand-out items (required)
Exit criterion: the multi-store bonus and all nine "Other ways to stand out" items of the problem statement are Done with evidence, the multi-store test passes (chat compares today's orders across two stores; one store deleted → its tools and resources gone), and the README stand-out table lists each one. **Required since 2026-10-24 by user decision** (SPEC A-10); these were P3 backlog bullets before. They come after the P0 release tasks except REL-16/REL-17, which wait for this phase. Items 4 and 9 were already built; items 1 and 6 are tracked in Phase 8 and Phase 10 and summarised here.

### BON-01 — Per-role tool permissions
- **Priority:** P1
- **Status:** Done
- **Day:** 15
- **Depends on:** AUTH-10, GW-08
- **Requirements:** REQ-SO-02
- **Description:** Admin-managed rule per server for the member role (D-021): all tools, none, or selected tools; default for woo from the chart (read tools only). `tools/list` hides denied tools; `tools/call` to a denied tool is refused server-side (`tool_forbidden`) and audited as `denied`, also when the name is guessed and also for the chat (internal token carries the user, the same rules apply). Dashboard page to edit the rules; members see only their allowed tools.
- **Output:** migration (`tool_rules`), `services/gateway/src/authz/tool-rules.ts`, `/api/tool-rules` (admin), dashboard Permissions page, MCP_DESIGN + API_CONTRACTS sections, DECISIONS entry.
- **Acceptance:** With the rule "members: woo read-only", member B's `tools/list` has no `woo__create_product`/`woo__update_order_status`, a direct call to either is refused and audited, admin A still sees and calls them; the chat for B cannot create a product.
- **Tests:** TC-BON-01-1 (int): list filtered per role; TC-BON-01-2 (int): direct call refused + audit row `denied`; TC-BON-01-3 (int): chat token obeys the rules; TC-BON-01-4 (browser): rule edited in the dashboard takes effect on the next request.
- **Command:** `npm test -w services/gateway && scripts/gateway-db-int.sh && scripts/dashboard-screens.sh permissions`
- **Evidence:** 2026-10-24: per-server member rule (`member_access` all/none/selected + `member_tools`, migration 0003, D-021) enforced in `/mcp` (`src/authz/tool-access.ts`); admin API + dashboard server form "Member access"; chart seeds woo members read-only on first creation (`gateway.seed.woo.memberTools`). `npm test -w services/gateway` → `Tests 103 passed (103)` (TC-BON-01-U1..U3; both enforcement points mutation-checked: removing either guard → 1 failed). `scripts/gateway-db-int.sh` → `Tests 124 passed (124)` (TC-BON-01-1..5: lists per role, direct call refused + audited `rejected/tool_forbidden` with no upstream call, chat internal token gets the member's tools, admin-only + API/DB validation, seeder sets the default once). Dashboard unit 25/25. k3d rev 69: `scripts/dashboard-screens.sh permissions` → `17/17 passed` (form sets woo read-only + everything hidden; member key: woo__list_products/list_orders/get_order only, `woo__create_product` → "tool not allowed for your role", admin still 64 tools; member Servers page 3 tools, everything hidden; audit row; rules restored); `admin` 16/16; `check-chart.sh` 0 violations. Existing k3d rows stay `all` (seed default applies to new installs; REL-12 clean run).
- **Regression risk:** A wrong default hides tools from admins; find_tools (D-019) must search only allowed tools.

### BON-02 — Many tools (search, then call)
- **Priority:** P1
- **Status:** Done
- **Day:** 5
- **Depends on:** UI-14
- **Requirements:** REQ-SO-04
- **Description:** The chat offers the most relevant tools within a size budget plus a local `find_tools` meta-tool that searches the full list and makes matches callable (D-019).
- **Output:** `services/gateway/src/chat/agent.ts`, D-019, MCP_DESIGN §10.
- **Acceptance:** 64 tools from 3 servers work with an 8k TPM free-tier model; a tool outside the first selection is found and called.
- **Tests:** TC-UI-14-API, TC-INT-07.
- **Command:** `node scripts/chat-smoke.mjs`
- **Evidence:** 2026-10-15 (UI-14): real Groq on k3d rev 52 — GitHub account question answered via `find_tools` → `github__get_me`; without the budget every request was 413. Unit 95/95, int 114/114.
- **Regression risk:** BON-01 must filter what find_tools can return.

### BON-03 — Metrics per server
- **Priority:** P1
- **Status:** Done
- **Day:** 15
- **Depends on:** GW-08, GW-10
- **Requirements:** REQ-SO-08
- **Description:** Prometheus `GET /metrics` on a separate internal port 9464 of the gateway (own listener, no Service port, no Ingress route; NetworkPolicy admits only pods labelled `platform.io/metrics-scraper: "true"`): `mcp_tool_calls_total{upstream,outcome,source}`, `mcp_tool_call_duration_seconds{upstream}` histogram, `mcp_tools_list_total{outcome}`, `mcp_requests_denied_total{reason}`, `mcp_upstream_up{upstream,status}`; fed by the audit events, bounded labels (registry slugs only, no tool names/users). The dashboard (admins) shows per server for the last hour: calls, failed (%), p95, refused — computed from the audit log so it covers every replica. Failure reasons already exist (UI-04, UI-18).
- **Output:** `services/gateway/src/metrics.ts`, chart port + NetworkPolicy (scrape only from the namespace), Servers page columns, MCP_DESIGN section.
- **Acceptance:** After calls that succeed, fail and time out, `/metrics` shows matching counters and the Servers page matches them; `/metrics` is not reachable through the Ingress.
- **Tests:** TC-BON-03-1 (unit): counters and histogram per outcome; TC-BON-03-2 (k3d): `curl app.<domain>/metrics` → 404, in-cluster scrape → 200.
- **Command:** `npm test -w services/gateway && scripts/k8s-checks.sh metrics`
- **Evidence:** 2026-10-24: `src/metrics.ts` (hand-written exposition, no new dependency), `src/audit/stats.ts`, chart `gateway.metrics` + NetworkPolicy `gateway-metrics-from-scrapers` + prometheus.io annotations, Servers card "Last hour". Unit `Tests 106 passed (106)` (TC-BON-03-1/1b/1c: series per outcome/source, histogram buckets, a client-supplied slug never becomes a label, escaping, listener serves only /metrics). Int `Tests 125 passed (125)` (TC-BON-03-3: last hour only, failed vs refused, p95 = 95th percentile not max). k3d rev 70 `scripts/k8s-checks.sh metrics` → 7 PASS, `failures: 0`: Ingress `/metrics` has no gateway metrics; unlabelled pods in platform and store → CLOSED; labelled scraper → histogram + `mcp_upstream_up{upstream="woo",status="connected"} 1`; two `woo__list_orders` → counter 4 → 6; no keys/tool names/e-mails; dashboard API woo stats `{"calls":10,"failed":0,"rejected":2,"p95Ms":278}`. Regression: `k8s-checks.sh netpol` failures 0, `dashboard-screens.sh servers` 16/16, `check-chart.sh` 32 objects 0 violations.
- **Regression risk:** Label cardinality; no user ids or arguments in labels.

### BON-04 — Scaling: replicas and per-key rate limits
- **Priority:** P1
- **Status:** Done
- **Day:** 15
- **Depends on:** GW-11, AUTH-08
- **Requirements:** REQ-SO-07
- **Description:** Gateway at 2 replicas by default (rolling update maxUnavailable 0, PodDisruptionBudget minAvailable 1, preStop pause 5 s + graceful close so a deleted pod loses no request). Per-key and per-user budget on `/mcp` tools/call + tools/list (default 120 / 240 per minute; Helm `gateway.rateLimit`), shared by all replicas through Postgres (`rate_limits`, one atomic upsert per request; window starts at the first hit) → 429 + Retry-After, audited `rejected/rate_limited`. The chat's one-request-per-user lock and its 30/10 min window moved to Postgres too (`leases` self-expire if a pod dies). Chat requests (internal token) do not count against the /mcp budget (they have their own). D-022.
- **Output:** gateway rate limiter, `gateway.replicas` + limits in values, `scripts/k8s-checks.sh replicas`, DECISIONS entry.
- **Acceptance:** With 2 replicas every E2E check passes; a key exceeding its limit gets 429 on whichever replica it hits; killing one replica does not break clients.
- **Tests:** TC-INT-05 (exists, 2 replicas); TC-BON-04-1 (int): limit shared by two instances; TC-BON-04-2 (k3d): `e2e.sh all` with `replicas: 2`.
- **Command:** `scripts/gateway-db-int.sh && scripts/k8s-checks.sh replicas && scripts/e2e.sh all`
- **Evidence:** 2026-10-24: `src/ratelimit.ts` (PgRateLimiter + MemoryRateLimiter), migration 0004, `/mcp` + chat wired, chart replicas 2/PDB/strategy/preStop. Unit 106/106. Int `Tests 129 passed (129)`: TC-BON-04-1 (two gateway instances on one DB: key budget 3 → 4th request refused on the other replica, Retry-After > 50 s, initialize not counted, user budget across keys, other user unaffected, 3 audit rows), TC-BON-04-1a (chat works while its user is over the API budget), TC-BON-04-1b (chat busy across replicas, lease released after), TC-BON-04-1c (lease expiry, only the holder releases, window restart); mutation: a per-replica memory limiter → 3 tests fail. k3d rev 72 `scripts/k8s-checks.sh replicas` ×2 → 7/7 each: 2 ready replicas, PDB minAvailable=1, 20 tools/list spread 10 + 10, one dashboard session on both replicas 10/10, a pod deleted during 40 `woo__list_orders` calls → 0 failed, replacement Ready, 140 parallel requests → 60 × 200 + 80 × 429 (120/min incl. 60 earlier), Retry-After 14 s. (Before the preStop pause one run lost 1 of 40 calls with 502 → fixed.) Full acceptance with 2 replicas: `scripts/e2e.sh all` → chat flow 13/13 (real Groq, product 159, order #160) + `e2e all: 26 passed, 0 failed, 1 skipped` (log `docs/evidence/e2e-all-k3d-2026-10-24-2-replicas.txt`). Login limiter stays per replica (T-13).
- **Regression risk:** In-memory chat lock is per process.

### BON-05 — Security hardening complete
- **Priority:** P1
- **Status:** Done
- **Day:** 16
- **Depends on:** SEC-09
- **Requirements:** REQ-SO-06
- **Description:** Summary task for stand-out item 6: SSRF guard, least-privilege RBAC for every component that talks to the Kubernetes API (new with BON-09), deny-by-default NetworkPolicies (incl. egress, finding F-INF-2), non-root containers, encrypted upstream credentials; all open findings in `docs/SECURITY_FINDINGS.md` fixed or accepted (SEC-09).
- **Output:** see SEC-01..09, BON-09.
- **Acceptance:** SEC-09 Done; the provisioner's RBAC passes a `kubectl auth can-i` matrix (only its own verbs, only store/hosted namespaces).
- **Tests:** TC-SEC-01, `scripts/k8s-checks.sh netpol`, chart policy, TC-BON-09-2.
- **Command:** `scripts/k8s-checks.sh all && scripts/check-chart.sh`
- **Evidence:** 2026-10-26: SEC-09 Done (above); provisioner RBAC `kubectl auth can-i` matrix `scripts/k8s-checks.sh rbac` 47 PASS / 0 fail (incl. `hosted-manager` and the admission policy for `hosted-*`), `netpol` 25/0, `stores` 34/0, `hosted` 20/0; chart policy PASS. 2026-10-26 k3d: `scripts/k8s-checks.sh rbac` → 47 PASS, `failures: 0` (provisioner `can-i` matrix); `netpol` → 25 PASS, `failures: 0`. Still waits for SEC-09. 2026-10-25 (SEC-09): static analysis and the new live suite closed every remaining finding (F-CRY-1, F-API-2, F-DEP-1..4, F-INF-8..9, F-SEC-1; 40 rows, 0 open), `docs/SECURITY_REPORT.md`; waits for the cluster runs listed in SEC-09 and BON-09/10/14. 2026-10-24 — all 13 red-team findings closed (12 Fixed, F-MCP-3 Accepted with reason) + F-WEB-5 found and fixed; table in `docs/SECURITY_FINDINGS.md`. F-INF-1: Trivy → 0 CRITICAL/0 HIGH on gateway, woo-mcp, everything-mcp, dashboard (D-024). F-INF-2/F-MCP-4: egress default-deny, `k8s-checks.sh netpol` failures 0 incl. TC-SEC-10a..j. F-WEB-1..5: Apache/PHP rules + mu-plugin (curl matrix). F-MCP-1: prompt backstop (unit mutation-checked, live replay 3/3). F-AUTH-1: cookie mutations need browser headers. F-MCP-2: everything members without get-env. F-INF-3/4: CPU limits + `workload` ServiceAccounts, enforced by chart policy. Regression on k3d rev 7: gateway unit 108/108, int 129/129, woo-mcp 26/26, dashboard 25/25; `e2e.sh all` 26/0/1 + chat 13/13 (GitHub + Groq through the new egress rules, order #125); `k8s-checks.sh all/metrics/replicas` 0 failures; `dashboard-screens.sh all` 20+19+17+16+16 passed; storefront 20 OK (+ known /cart/ WARN); admin screens all passed after fixing wp-init for WordPress 7's default `modern` admin scheme (found by the REL-12 clean install). Still open for this task: SEC-09 sign-off (formal scans SEC-02/03/06 incl. third-party images, SEC-08 attacker-LLM loop) and the provisioner's RBAC (BON-09).
- **Regression risk:** Egress default-deny can break WordPress updates and the GitHub/Groq calls; allow by destination explicitly.

### BON-06 — Upgrades and rollback
- **Priority:** P1
- **Status:** Done
- **Day:** 8
- **Depends on:** REL-11
- **Requirements:** REQ-SO-09
- **Description:** Upgrade the store, the MCP server and the gateway with Helm and roll back safely.
- **Output:** `docs/DEPLOYMENT.md` §6.
- **Acceptance:** Upgrade → rollback with data intact.
- **Tests:** REL-11.
- **Command:** see REL-11.
- **Evidence:** 2026-10-18 (REL-11): upgrade → `helm rollback` verified on k3d, orders and gateway data intact. Re-run on the VPS with BON-07.
- **Regression risk:** Multi-store adds per-store releases: BON-11 must document their upgrade path too.

### BON-07 — VPS deployment with TLS
- **Priority:** P0
- **Status:** Blocked
- **Day:** 15
- **Depends on:** P0-03, REL-01, REL-03, REL-04, REL-05, REL-06
- **Requirements:** REQ-SO-01, REQ-K8S-02
- **Description:** Summary task for stand-out item 1: the same charts on a k3s VPS, shown working, with what changed through Helm values (domain, ingress, storage, secrets) documented, and TLS with cert-manager (REL-04, now required). Includes the E2E-14 re-run on the VPS and, once built, the multi-store and hosted-server flows on the VPS.
- **Output:** see REL-01..06.
- **Acceptance:** `scripts/e2e.sh all` passes against the VPS over https.
- **Tests:** TC-E2E-14 on the VPS.
- **Command:** `BASE=https://app.<domain> scripts/e2e.sh all`
- **Evidence:** Blocked: no VPS yet (P0-03).
- **Regression risk:** —

### BON-08 — OAuth on the gateway
- **Priority:** P1
- **Status:** Done
- **Day:** 16
- **Depends on:** AUTH-08, AUTH-03
- **Requirements:** REQ-SO-03
- **Description:** MCP authorization spec (OAuth 2.1): `/.well-known/oauth-protected-resource` + `WWW-Authenticate` on 401 from `/mcp`; the gateway as its own authorization server (`/.well-known/oauth-authorization-server`, authorization code + PKCE S256 only, dynamic client registration with redirect URI rules, consent page using the dashboard session, short-lived access tokens bound to the user and the `/mcp` resource (RFC 8707), refresh tokens rotated, all stored as hashes, revocable by the user and admins). API keys keep working. Check the spec version against the SDK before building.
- **Output:** `services/gateway/src/oauth/*`, migration, consent page, DECISIONS + THREAT_MODEL entries, README "connect with browser login".
- **Acceptance:** Claude Code (or MCP Inspector) connects to `/mcp` with no key, opens the browser login, and lists the user's tools; calls are audited under that user with `source=oauth`; revoking the grant or disabling the user → next call 401.
- **Tests:** TC-BON-08-1 (int): full code+PKCE flow, wrong verifier/redirect refused; TC-BON-08-2 (int): token for another resource refused; TC-BON-08-3 (manual): real client login.
- **Command:** `scripts/gateway-db-int.sh && scripts/e2e.sh oauth`
- **Evidence:** 2026-10-25 (branch `bon-multistore`). Spec checked: SDK 1.32.1 `LATEST_PROTOCOL_VERSION = '2025-11-25'`. `scripts/gateway-db-int.sh` → `Test Files 25 passed (25)`, `Tests 141 passed (141)` incl. `test/int/oauth.int.test.ts` 11 tests: TC-BON-08-1 (SDK `auth()` client: 401 → RFC 9728 → RFC 8414 → DCR → authorize S256 → consent → token → tools/list + tools/call audited `source=oauth`; refresh rotation + replay revokes grant; wrong verifier burns the code, wrong redirect / other client / replayed code refused; revoke and disable → 401, API key still 200; deny → `access_denied`; register refuses non-loopback http, `javascript:`/`data:`, fragments, credentials, confidential clients; unknown client / unregistered redirect → plain 400 with no Location; consent decision without cookie 401, foreign Origin 403; per-IP 429), TC-BON-08-2 (resource `https://other.example/mcp` → `invalid_target` at authorize and token; token refused by an authenticator for another resource and with OAuth off). Unit 112/112, dashboard 25/25, `scripts/check-chart.sh` PASS. k3d (gateway `sha-d945252046cd`, dashboard `sha-76bd6bb2b971`, 2 replicas, via Ingress): `scripts/e2e.sh oauth` → 15 PASS incl. `dynamic registration (mcpc_…)`, `authorize → consent page`, `tools/list as B over OAuth (41 tools)`, `audited as B, source=oauth`, `revoked grant → 401 on next call`, `revoked grant → refresh refused`, `PASS  e2e oauth`. Regression `node scripts/e2e-acceptance.mjs all` → `PASS  e2e all: 26 passed, 0 failed, 1 skipped` (skip = cross, GW-15) after updating two stale checks: TC-K8S-04a now expects `WWW-Authenticate: Bearer resource_metadata=…`; TC-E2E-10d used `github__get_me`, which SEC-08 F-MCP-6 removed from members — it now calls `github__search_repositories` and requires a `result` (the old check passed on a JSON-RPC refusal). **Open:** TC-BON-08-3 (manual: real Claude Code browser login) — step in `docs/DEMO_RUNBOOK.md`, to run at REL-15.
- **Regression risk:** Open redirect and CSRF on the consent page; must not weaken API-key auth.

### BON-09 — Provisioner foundation and RBAC
- **Priority:** P1
- **Status:** Done
- **Day:** 18
- **Depends on:** SEC-09, BON-08 (order: multi-store after all other tasks, user 2026-10-25)
- **Requirements:** REQ-SO-05, REQ-SO-06, REQ-BON-02, REQ-BON-07
- **Description:** Design D-026 / A-11. (1) Extract the store into its own chart `charts/store` (mariadb, wordpress + hardening ConfigMap, wp-init, woo-mcp, NetworkPolicies, ResourceQuota, LimitRange, Ingress, `workload` ServiceAccount); the platform chart installs the default TATVA store through it as a dependency (`file://../store`), no behaviour change. (2) `services/provisioner` (TypeScript, Node 24, single replica + Postgres lease): the only component with Kubernetes rights (the gateway keeps none); runs a pinned `helm upgrade --install` / `helm uninstall` of `charts/store` into `store-<slug>`. (3) RBAC: ClusterRole `provisioner` (namespaces create/delete/get/list, RoleBindings create, `bind` only on ClusterRole `store-manager`); `store-manager` = only the namespaced kinds the store chart renders, granted per store namespace by a RoleBinding; a ValidatingAdmissionPolicy refuses the provisioner any namespace or RoleBinding outside `store-*` without label `platform.io/store`. (4) Desired state in Postgres (`stores`, `store_members`; own DB role with grants only there): the gateway writes, the provisioner reconciles (idempotent by request id, provisioning timeout → Failed with reason, restart mid-create resumes from DB + Helm release state). (5) Internal endpoint `POST /internal/stores/:id/ready|deleted` on the gateway, HMAC-signed with an internal Secret, NetworkPolicy gateway ← provisioner only.
- **Output:** `charts/store`, `services/provisioner`, chart templates (SA, ClusterRoles, VAP, NetworkPolicies), migration, D-026, THREAT_MODEL entries (compromised provisioner, namespace escape, forged ready call).
- **Acceptance:** The default store renders and runs unchanged through `charts/store` (e2e all, storefront/admin screens green); the provisioner can create/delete only labelled `store-*` namespaces and the listed kinds in them (VAP refuses the rest); killing it mid-create resumes; the gateway pod still mounts no token.
- **Tests:** TC-BON-09-1 (k3d): reconcile after kill; TC-BON-09-2 (k3d): `kubectl auth can-i --as=system:serviceaccount:platform:provisioner` matrix (allowed and refused verbs) + VAP refusals (namespace `kube-system`/unlabelled, RoleBinding to `cluster-admin`); TC-BON-09-3 (int): forged/unsigned ready call refused.
- **Command:** `scripts/k8s-checks.sh rbac && scripts/check-chart.sh`
- **Evidence:** 2026-10-25 (branch `bon-multistore`). (1) `charts/store` extracted (linked as `charts/platform/charts/store`, dependency `file://../store`): rendered platform manifests before/after compared object by object → `compared 41 41`, **no differences** for local and prod. (2) `services/provisioner` (reconcile loop, Helm v3.22.0 pinned + sha256-verified in the image, chart baked in). (3) `templates/rbac-provisioner.yaml` + projected token + `provisioner-egress` NetworkPolicy. (4) migration `0006_stores` (`stores`, `store_members`, `upstreams.store_id`, role `provisioner` with column-level SELECT). (5) `/internal/stores/:id/{ready,failed,deleted}` HMAC-signed. Tests: provisioner unit 8/8 (TC-BON-09-U1..U5 incl. both signing copies agree); gateway int `Tests 145 passed (145)` incl. TC-BON-09-3 (unsigned, wrong key, stale, signature for another store, tampered body → 401; foreign woo-mcp URLs → 400; idempotent ready/failed/deleted; provisioner DB role denied `SELECT *`, `admin_password_enc`, users, upstreams, api_keys, UPDATE, DELETE, INSERT); gateway unit 112/112. k3d: `scripts/k8s-checks.sh rbac` → 31 PASS, `failures: 0` (TC-BON-09-2a..ae); TC-BON-09-1: store `kt3` inserted, provisioner pod deleted right after its Helm release appeared → new pod → `kt3: ready | after 200s`, upstream `woo-kt3|t|selected|["list_products", "list_orders", "get_order"]`, storefront `kt3.store.127.0.0.1.nip.io` 200, admin tools/list shows 5 `woo-kt3__*` tools, `woo-kt3__list_products` returns that store's products; timeout path: `failed | provisioning timed out after 15 min (not ready: database, WordPress, MCP server, store setup)`; teardown: `status=deleted after 55s`, no namespace, PV or Helm release left. **Found and fixed:** (a) store quota `limits.cpu: 2` below the chart's own limits (~3) → MariaDB refused by the quota → now 4 CPU / 3 GiB; (b) **fresh installs were broken since BON-05**: the hardening mu-plugin was a subPath mount inside the data volume, so the kubelet created `wp-content/` as root before the image copied WordPress in and the WooCommerce install failed (`Error: No plugins installed.`); it is now mounted at `/var/www/platform-mu-plugins` with `WPMU_PLUGIN_DIR` (hardening re-checked: `/?author=1` 404, `/wp-json/wp/v2/users` 401, `/xmlrpc.php` 403). Regression after the move: `e2e all: 26 passed, 0 failed, 1 skipped`, `PASS e2e oauth`, `k8s-checks netpol failures: 0`, `check-chart` 0 violations, storefront screens unchanged (known `/cart/` warning only), `PASS findings table`, headers `failures: 0`.
- **Regression risk:** Moving the store templates can break the default store and the VPS path; Pod Security `restricted` and default-deny must apply to every created namespace.

### BON-10 — Hosted MCP servers by container image
- **Priority:** P1
- **Status:** Done
- **Day:** 17
- **Depends on:** BON-09, UI-05
- **Requirements:** REQ-SO-05
- **Description:** Admin adds a server by image (+ port, path, env, Secret values) instead of URL. The provisioner deploys it into a `hosted-<slug>` namespace with its own Secret, requests/limits, probes, non-root, gateway-only ingress NetworkPolicy and no egress unless allowed; the gateway registers it (no SSRF exception needed: internal Service host recorded by the provisioner) and removes everything on delete. Image allowlist by registry in Helm values.
- **Output:** dashboard "Add by image" form, `/api/upstreams` kind `hosted`, provisioner templates.
- **Acceptance:** Adding `everything-mcp` by image from the dashboard → Ready, tools listed and callable through `/mcp`; delete → namespace, Secret, Service and registration gone; a disallowed registry is refused.
- **Tests:** TC-BON-10-1 (k3d): add → list → call → delete → gone; TC-BON-10-2 (int): registry allowlist; TC-BON-10-3 (k3d): hosted pod cannot reach store or platform.
- **Command:** `scripts/e2e.sh hosted`
- **Evidence:** 2026-10-26 **k3d (rev 29, `main` incl. 026cedb):** `scripts/e2e.sh hosted` → `PASS BON-10 hosted servers (25/25)`: TC-BON-10-2 docker.io and `:latest` refused, member cannot add; TC-BON-10-1 added → Ready after 24 s, namespace `platform.io/hosted` + Pod Security restricted, Secret/Service/NetworkPolicies/quota present, pod non-root/read-only/no capabilities/no token/limits, secret value only in the Secret (not in Deployment, Helm values, API or gateway logs) but in the pod env, 13 tools listed and a call reaches it, members none by default → exactly `e2e-every__echo` once allowed and refused the rest, audit under the right users, address/credential not editable via `/api/upstreams`; delete → tools gone next request, not in `/api/upstreams` or the hosted list, namespace, Secret and Helm release gone. TC-BON-10-3 `scripts/k8s-checks.sh hosted` → 20 PASS, `failures: 0`. Browser `scripts/dashboard-screens.sh hosted` → `PASS BON-10 hosted page (10/10)` (refusals with the allowed list, Creating… → Ready in 21 s, secret name only, egress off by default, pods/quota, hosted badge, typed delete, no page errors). 2026-10-25 (branch `test_v.01`; **no cluster in this session — nothing below ran on k3d**). Built: migration `0007_hosted` (`hosted_servers`, `upstreams.hosted_id`, provisioner column grants), gateway `src/hosted/routes.ts` (`/api/hosted` admin only: registry allowlist, fixed tag/digest, env/slug/port/path validation, caps under a lock, write-only encrypted secrets, delete unregisters first) and `src/hosted/internal.ts` (signed ready/failed/deleted; ready accepts only the server's own Service URL, registers with no credential and members none), `hostedEnvKey` (HKDF of the signing key) in both signing copies, SSRF host pattern, `/api/upstreams` `kind` + edit/delete guards, chart `charts/hosted` (non-root 10001, read-only fs, no token, quota/LimitRange, default-deny, gateway-only ingress, optional 443-only egress), RBAC `hosted-manager` + admission-policy branch (`platform.io/hosted`) + gateway egress rule, provisioner `src/hosted.ts` (+ Dockerfile bakes the chart), Helm values `provisioner.hosted.*`, dashboard Servers → Hosted servers (add by image, status, failure reason, secrets names only, typed delete). Real Postgres: `test/int/hosted-api.int.test.ts` 9/9 (admin-only on every route; 13 bad images incl. prefix trick `ghcr.io/acmeevil`, `..`, `//`, `:latest`; DB CHECK refuses a raw bad image; env rules; secret not in any response or column and not openable with another slug/key/the credentials key; 6 parallel creates → exactly 3; forged/unsigned/re-pointed ready refused; members none until allowed, store-owned fields not editable; failed reason; delete + name reuse; hosting off without key/registries) — mutation-checked (dropping the `/` from the prefix check fails the allowlist test). Provisioner unit 16/16 (8 new: namespace/RoleBinding/Secret/values, secrets never in Helm values, both key derivations agree, restart resumes, image-pull/crash/quota/timeout reasons, teardown order). Gateway unit 118/118, int 168/169 (the 1 failure `connect-time guard` is pre-existing on this host), dashboard 30/30, typecheck clean, `scripts/check-chart.sh` PASS incl. new hosted render/policy checks (helm 3.22.0). Browser (Chromium, 16/16) against the real gateway with a stand-in provisioner: disallowed registry, `:latest` and a malformed env line refused in the form, Creating… → Ready without reload, only the secret NAME shown, egress off by default, hosted badge in the servers list, failed image shows why, typed delete, member sees no section and gets 403. **Added later the same day:** admin runtime line for hosted servers, vanished-namespace recovery (same monitor as stores) and the cluster browser script `tests/e2e/dashboard-hosted.mjs` (`scripts/dashboard-screens.sh hosted`: refusals, add, Ready, runtime, badge, delete) — run as written against the real gateway + dashboard with a stand-in provisioner: 10/10. **Open (needs k3d):** TC-BON-10-1 `scripts/e2e.sh hosted` (everything-mcp re-tagged as `ghcr.io/ragx09/everything-mcp:e2e-…`, imported, added, called through /mcp, deleted → no trace) and TC-BON-10-3 `scripts/k8s-checks.sh hosted` + the new `rbac` checks (hosted pod cannot reach stores, platform, API server, other hosted servers; VAP refusals) — written and syntax-checked, not run; rebuild/import the gateway, dashboard and provisioner images first.
- **Regression risk:** Hostile image: limits, no token, no egress.

### BON-11 — Multi-store: per-store install and niche templates
- **Priority:** P1
- **Status:** Done
- **Day:** 19
- **Depends on:** BON-09
- **Requirements:** REQ-BON-02
- **Description:** `charts/store` values per store: name, tagline, niche, accent colour, host `<slug>.store.<domain>`, generated Secrets (DB passwords, WooCommerce keys, woo-mcp token, one-time wp-admin password). Every store uses the TATVA theme with its own name/tagline (no TATVA name on new stores, A-11) and a per-niche accent within the TATVA palette, set by wp-init. Niche catalogues in `services/store-assets/stores/<store>/catalogue.json`: Stationery & desk, Tea & coffee, Home & ceramics, Bags & accessories (from the existing 50-product catalogue), Custom (owner's niche text as the only category, no products). Bike accessories is BON-17. The default store stays as it is.
- **Output:** `charts/store` values/templates, wp-init theme parameters, niche catalogue files, DEPLOYMENT notes (per-store upgrade path).
- **Acceptance:** Two extra stores of different niches install side by side, each with its own name, tagline, accent, products and a working COD checkout.
- **Tests:** TC-BON-11-1 (k3d): two stores Ready, `e2e-checkout.sh` against each; TC-BON-11-2: storefront screens per store (name in header, no TATVA name, niche products).
- **Command:** `scripts/e2e.sh stores`
- **Evidence:** 2026-10-25 (branch `bon-multistore`). `charts/store` init values `tagline`/`niche`/`nicheText` → wp-init env `STORE_TAGLINE`/`STORE_NICHE`/`STORE_NICHE_TEXT`; importer picks `catalogue/<niche>.json` (generated by `scripts/brand/build_niche_catalogues.py`: stationery 7, tea-coffee 7, home-ceramics 18, bags 8 products; custom = one category from the owner's text, no products; bike = BON-17) and sets option `platform_store_niche`; theme (`functions.php` `TATVA_NICHES`): niche hero copy, tagline as kicker, accent-1/accent-6 per niche, niche editorial images when shipped, store name instead of TATVA in every pattern, login page without the TATVA wordmark, no TATVA favicon. Default store unchanged: wp-init `catalogue: 50 products (0 created, 0 updated, 50 unchanged)`, title `TATVA – The Essence of Good Design.`, no niche CSS. k3d, two stores created side by side (`chai` tea-coffee, `ridgeline` bike) → `chai=ready ridgeline=ready after 235s`; storefronts: `Chai Corner – Small-batch teas and coffees | accent-1:#5A3A22 | TATVA mentions: 0`, `Ridgeline – Ride. Drive. Explore. | accent-1:#202820 | TATVA mentions: 0`; Store API `chai products: 7 | with image: 7`, `ridgeline products: 50 | with image: 39`. TC-BON-11-1: `scripts/e2e-checkout.sh` (now takes STORE_URL + STORE_NS) → `PASS order placed: #28` + `PASS order #28 listed in WooCommerce admin` (chai), `PASS order placed: #109` + listed in admin (ridgeline). TC-BON-11-2: checked in Chrome (store name in header, niche hero and accent, no TATVA name); full `storefront-screens.sh` run per store still to do with BON-15. Note: created stores keep the TATVA admin colour scheme in wp-admin (presentation only).
- **Regression risk:** RAM: each store ≈ 0.3 CPU / 0.7 GB requested; 5 stores on the 16 GB VPS, 2–3 on the laptop.

### BON-12 — Multi-store: create/delete API and dashboard
- **Priority:** P1
- **Status:** Done
- **Day:** 20
- **Depends on:** BON-11
- **Requirements:** REQ-BON-01, REQ-BON-06, REQ-BON-07
- **Description:** `/api/stores`: create (`{name, niche, tagline, nicheText?}`, idempotency key; slug derived from the name, unique, shown before creating, not editable), list (own + shared; admins all; the default store shown as "default", not deletable), get, delete (owner or admin; typed slug confirmation). Caps server-side: 3 stores per member, 5 in total (Helm values; admins count toward the total only). Members and admins may create (A-11). Store page: status Provisioning / Ready / Failed with reason, URL, wp-admin link, created time, access list (owner/admin add or remove members), tool rule for shared members (default read-only, widen to all/selected like BON-01), one-time view of the wp-admin password (wiped after viewing; admin reset shows a new one once), delete; admins also see namespace, pod readiness and quota usage. Stores page refreshed live.
- **Output:** gateway routes + migration, dashboard Stores pages, API_CONTRACTS.
- **Acceptance:** Three stores created at once from the dashboard all reach Ready; a forced failure shows a clear reason; caps, ownership and access-list changes are enforced on the server (member 403/404 on others' stores); the wp-admin password can be viewed exactly once.
- **Tests:** TC-BON-12-1 (int): API rules (caps, ownership, idempotency, slug); TC-BON-12-2 (browser): create three, see Ready/Failed, view password once, share with a member, delete.
- **Command:** `scripts/gateway-db-int.sh && scripts/dashboard-screens.sh stores`
- **Evidence:** 2026-10-26 **k3d (branch `updt_v.0.1` fast-forwarded to `main`, images rebuilt, Helm rev 27/28, migrations 0007–0009 applied):** `scripts/dashboard-screens.sh stores` → `PASS TC-BON-12-2 stores page (15/15)`: 2a three stores created at once (Creating…), 2b all three Ready without a reload (236 s after the last click), own host link, 2c fourth refused with a clear message, 2d wp-admin password shown once, owner has no reset/runtime, 2e admin sees pods/quota (`Pods 3/3 ready · CPU limits 2.5 of 4 · memory limits 1.3 GiB of 3 GiB`), 2f admin reset gives a new one-time password, 2g shared person sees only that store (no settings, only `woo-<slug>` in their server list), 2h delete → gone from list and gateway, no page errors. **Found and fixed:** the Stores page crashed over plain http (`TypeError: crypto.randomUUID is not a function` — only defined in secure contexts; earlier browser runs used localhost) so the create form never rendered on k3d → idempotency key from `crypto.getRandomValues` (`apps/dashboard/src/pages/Stores.tsx`); dashboard typecheck OK, unit 30/30. Failed-with-reason display: stand-in browser run below + provisioning timeout → Failed with reason (BON-09). 2026-10-25 (branch `claude/trusting-turing-7n7uqe`; **no cluster in this session — nothing below ran on k3d**). Built: `services/gateway/src/stores/routes.ts` (`/api/stores` list/slug preview/create/get/delete/members/rule/one-time password; caps under an advisory lock; idempotency key; names limited to letters, digits, plain punctuation), `src/config.ts` `stores` (+ chart env `STORE_MAX_PER_MEMBER/TOTAL`, `STORE_HOST_SUFFIX`, `STORE_SCHEME`, `DEFAULT_STORE_URL`), dashboard `Stores` page (create form with slug preview, live status 4 s while provisioning/deleting, Failed reason, open/wp-admin links, one-time password, access list, tool rule, typed-slug delete, admin namespace), docs API_CONTRACTS/MCP_DESIGN/D-028/T-31. Real Postgres 16 (local): `test/int/stores-api.int.test.ts` 15/15 — TC-BON-12-1: slug rules, idempotent create, validation (script/shell/template injection refused), caps 2/4 incl. **8 parallel creates → exactly 2, 12 parallel from 4 people → exactly 4**, ownership 404s, sharing rules, password once under 5 concurrent requests (1×200, 4×410, wiped, not in any other column), tool rule, delete + name reuse, store servers not editable through `/api/upstreams`; mutation-checked (removing the lock fails the race test; removing the owner scope fails 5). Gateway unit 118/118, dashboard unit 27/27, both typecheck, `scripts/check-chart.sh` PASS (helm 3.22.0; kubeconform not installed). Browser TC-BON-12-2 against the **real gateway + a stand-in provisioner** (Chromium, 23/23: create → Creating… → Ready without reload, links, password once then 'Already shown', failed store with reason, third store refused, share with B, rule saved, B sees it read-only and only that server, delete → Deleting… → gone, B's server list empty, 375 px no h-scroll, no page errors; script kept outside the repo). **Added later the same day:** admin 'reset wp-admin password' (gateway seals a generated password with a derived key → provisioner runs a one-off wp-cli Job in the store → patches `wordpress-admin` → reports; admin-only, retriable, viewable once; migration 0008, `src/stores/routes.ts`, `provisioner/src/reset.ts`), admin runtime view (pods ready/total, quota CPU/memory limits used vs hard, about every 30 s; `provisioner/src/monitor.ts`, `src/runtime.ts`), and the cluster browser script `tests/e2e/dashboard-stores.mjs` (`scripts/dashboard-screens.sh stores`: member creates 3 at once, 4th refused, all Ready, admin runtime + reset, owner password once, share read-only, delete all). Evidence: int `stores-api` now 19 tests (reset admin-only/403 for owner, sealed with the derived key and not openable with the credentials key, once-only view, failed reset retriable, runtime validated), provisioner unit 25/25 (reset Job: password never on the command line, no Secret left behind, restart resumes the same Job; derived keys agree and differ per label), gateway int 174/175 (the 1 pre-existing host failure), chart check PASS; the stores script run **as written** against the real gateway + dashboard with a stand-in provisioner: 15/15 (including admin runtime line, reset, member without admin extras, 403 on reset as owner); a second browser run covered 'Gone Shop' vanished-namespace (below). **Open:** the acceptance run on the real cluster (`scripts/dashboard-screens.sh stores`, about 6–10 minutes) and a forced-failure run (the Failed + reason path is covered by BON-09's timeout test and the stand-in browser run, not forced on the cluster). One pre-existing int failure on this host (`TC-UI-05-API connect-time guard`, 'unknown' vs 'unreachable'; also fails on the unmodified tree — sandbox DNS), not caused by this task.
- **Regression risk:** Concurrent creates racing the caps (check under a row lock); a stuck store must not block others.

### BON-13 — Multi-store: automatic MCP registration and teardown
- **Priority:** P1
- **Status:** Done
- **Day:** 21
- **Depends on:** BON-12
- **Requirements:** REQ-BON-03, REQ-BON-04
- **Description:** When a store's pods are Ready the provisioner calls the gateway's signed ready endpoint; the gateway encrypts the woo-mcp token like any upstream credential and registers upstream `woo-<slug>` (owner-scoped; description names the store, tools `woo-<slug>__list_orders` …). Gateway egress allows woo-mcp pods in namespaces labelled `platform.io/store`. Delete: unregister first (tools gone on the next request), then `helm uninstall` and namespace deletion (PVCs, PVs, Secrets with it); audit rows stay.
- **Output:** provisioner + gateway registration code, NetworkPolicy change, MCP_DESIGN section.
- **Acceptance:** A new store's tools appear for its owner without manual steps; after delete nothing remains (`kubectl get ns,pv`, `/api/upstreams`, `tools/list`, Helm release).
- **Tests:** TC-BON-13-1 (k3d): create → tools listed and callable → delete → no trace; TC-BON-13-2 (int): registration only through the signed endpoint.
- **Command:** `scripts/e2e.sh stores`
- **Evidence:** 2026-10-26 **k3d (branch `updt_v.0.1` fast-forwarded to `main`, images rebuilt, Helm rev 27/28, migrations 0007–0009 applied):** `KEEP=1 scripts/e2e.sh stores` → `PASS BON-15 multi-store acceptance (31/31)`: TC-BON-13-1 tools of both new stores appear for the owner with no manual step, `woo-<slug>__list_orders` works through the gateway for each; after delete: tools gone on the very next request, `/api/upstreams` no longer lists it, `kubectl` namespace/volume/Helm release gone, other store untouched, audit rows kept. 2026-10-25 (no cluster in this session). Registration: the BON-09 signed `ready` call already registers `woo-<slug>` (owner-scoped, token encrypted); added: a store's server cannot be edited (url/credential/name) or deleted through `/api/upstreams` (409), delete unregisters the server in the same transaction that sets `desired=absent`, the pool drops its connection at once (`registryChanged`), and `deleted` removes any leftover upstream. Gateway egress to `platform.io/store` namespaces' woo-mcp pods was already in `networkpolicies.yaml` (BON-09). Int `stores-api` TC-BON-13 parts: delete → upstream row gone and `tools/list` empty on the very next request, retried delete 202, `deleted` → store 404 and name reusable; `stores-internal` TC-BON-09-3 (registration only through the signed endpoint) 4/4. Docs: MCP_DESIGN §16. `scripts/e2e-stores.mjs` (TC-BON-13-1: create → tools listed and callable → delete → nothing left in kubectl/Helm/`/api/upstreams`) is written and syntax-checked, **not run (needs the cluster)**. **Open:** TC-BON-13-1 on k3d.
- **Regression risk:** A delete that fails half-way must be retried by the reconcile loop, not leave orphans.

### BON-14 — Multi-store: isolation, access, guardrails, recovery
- **Priority:** P1
- **Status:** Done
- **Day:** 22
- **Depends on:** BON-13
- **Requirements:** REQ-BON-05, REQ-BON-06, REQ-BON-07
- **Description:** Per store namespace: default-deny ingress + egress; wordpress ← Traefik + its own woo-mcp; mariadb ← its own wordpress; woo-mcp ← the gateway only; wp-init → its own mariadb + internet :443. ResourceQuota (≈ 1 CPU / 1.5 GiB limits / 4 GiB storage) + LimitRange. Access in `/mcp` and the chat (extend `authz/tool-access.ts`): owner and admins all tools, members on the store's access list its tool rule (default read-only), everyone else nothing (hidden in tools/list, refused in tools/call, audited). Guardrails: caps, provisioning timeout → Failed with reason. Recovery: kill the provisioner mid-create → completes or fails cleanly.
- **Output:** store chart NetworkPolicies/quota, gateway authz, `scripts/k8s-checks.sh stores` probes, THREAT_MODEL.
- **Acceptance:** Probe pods prove one store's woo-mcp/wordpress cannot reach another store's database or WordPress; quota, caps and timeout enforced server-side; access rules hold for API keys and the chat; the kill test passes.
- **Tests:** TC-BON-14-1 (k3d): cross-store probe matrix; TC-BON-14-2: quota/cap/timeout; TC-BON-14-3: provisioner killed mid-create; TC-BON-14-4 (int): store access rules (owner, shared member, other member, admin).
- **Command:** `scripts/k8s-checks.sh stores && scripts/gateway-db-int.sh`
- **Evidence:** 2026-10-26 **k3d (branch `updt_v.0.1` fast-forwarded to `main`, images rebuilt, Helm rev 27/28, migrations 0007–0009 applied):** `scripts/k8s-checks.sh stores` (stores `e2e-chai-260000` + `ridgeline`) → 34 PASS, `failures: 0` (TC-BON-14-1 cross-store probe matrix incl. A↔B mariadb/wordpress/woo-mcp CLOSED, gateway → woo-mcp only; TC-BON-14-2 quota, LimitRange, Pod Security, token automount). TC-BON-14-3 in `e2e.sh stores`: provisioner pod deleted 20 s into the create → both stores Ready after 332 s. TC-BON-14-4 live: member B sees neither store, calling a store tool by name refused (`tool not allowed for your role`), share → read-only set (get_order, list_orders, list_products) only, unshare → gone next request. Also `k8s-checks.sh rbac` 47 PASS / 0 fail, `netpol` 25 PASS / 0 fail. 2026-10-25 (no cluster in this session). Access rules (TC-BON-14-4, int, real Postgres, 4 tests + unit): `src/authz/store-access.ts` `roleFor` — owner/admin all tools, access-list members the store's rule, others nothing; applied in `/mcp` (tools/list and tools/call), `/api/upstreams`, `/api/upstreams/:id/tools` and the chat's unreachable-servers hint; refusals audited `tool_forbidden` and reach no upstream (fake upstream call counter unchanged); changes (widen/narrow rule, remove person, delete store) apply on the next request; fails closed without an access source; same answers over API key and internal chat token. Mutation-checked: making `roleFor` ignore the store fails 5 tests. Guardrails: caps under lock (TC-BON-12-1), provisioning timeout → Failed with reason already covered by BON-09 (`failed | provisioning timed out after 15 min …`). Store chart already renders default-deny ingress+egress, wordpress ← Traefik + own woo-mcp, mariadb ← own wordpress/wp-init, woo-mcp ← gateway only, wp-init → mariadb + :443, ResourceQuota + LimitRange, `workload` ServiceAccount (BON-09/11). `scripts/k8s-checks.sh stores` (TC-BON-14-1 cross-store matrix of 24 probes + TC-BON-14-2 quota, LimitRange, Pod Security, token automount per store namespace) is written and syntax-checked, **not run**. THREAT_MODEL T-31, D-028. **Recovery added (same day):** a Ready store or hosted server whose namespace vanished (e.g. `kubectl delete ns`) is reported after three consecutive 404s (`provisioner/src/monitor.ts` → `/internal/.../missing`); the gateway marks it Failed with 'namespace removed outside the platform', unregisters its server in the same transaction and wipes its password; deleting it from the dashboard then cleans up (D-030, MCP_DESIGN §18). Evidence: provisioner unit (reports only after 3 consecutive misses, a blip resets the count, one failing row does not stop the others), int `stores-api` + `hosted-api` (signed, idempotent, ignored for non-ready rows, tools gone on the next request, delete still works), stand-in browser run (Failed + reason, server unregistered, delete). **Open:** run `k8s-checks.sh stores` and the provisioner-kill test (TC-BON-14-3, inside `e2e-stores.mjs`) on k3d; the quota in the chart is 4 CPU / 3 GiB (above the ≈1 CPU / 1.5 GiB in the description, because the store's own limits sum to about 3 CPU — BON-09).
- **Regression risk:** The gateway egress change must not widen access to anything but labelled store woo-mcp pods.

### BON-15 — Multi-store acceptance test
- **Priority:** P1
- **Status:** Done
- **Day:** 23
- **Depends on:** BON-14
- **Requirements:** REQ-BON-08
- **Description:** The problem statement's test, scripted: create two stores of different niches, place orders in each, ask the chat to compare today's orders across the two stores (counts must match each MariaDB), then delete one store and show its tools and resources are gone. Added to the demo runbook.
- **Output:** `scripts/e2e.sh stores`, DEMO_RUNBOOK section.
- **Acceptance:** Chat answer names both stores' order counts matching each database; after delete `tools/list`, `/api/upstreams` and `kubectl` show nothing of that store.
- **Tests:** TC-BON-15-1 (k3d, then VPS).
- **Command:** `scripts/e2e.sh stores`
- **Evidence:** 2026-10-26 **k3d (branch `updt_v.0.1` fast-forwarded to `main`, images rebuilt, Helm rev 27/28, migrations 0007–0009 applied):** `KEEP=1 scripts/e2e.sh stores` → `PASS BON-15 multi-store acceptance (31/31)` (Groq): orders 2 in `e2e-chai-260000` (#28, #30), 1 in `e2e-ridge-260000` (#110), `db 2 / 1`; chat called both `woo-e2e-*__list_orders`, tool counts = each MariaDB (2=2, 1=1), reply names both counts; delete → no trace (tools, `/api/upstreams`, namespace, volumes, Helm release). First run 27/31: **found and fixed** a test bug — `e2e-stores.mjs` bought the TATVA default product (`hand-finished-stoneware-mug`, 404 in niche stores) → now buys the first purchasable product from each store's Store API. VPS re-run belongs to E2E-14. 2026-10-25 (no cluster in this session). `scripts/e2e-stores.mjs` + `scripts/e2e.sh stores` written (node --check / bash -n OK): creates a tea-and-coffee and a bike store from the API, kills the provisioner 20 s in (TC-BON-14-3), checks both Ready, member B sees nothing and is refused by name, tools appear for A with no manual step, share/unshare gives and removes the read-only set, orders (2 in one store, 1 in the other) match each store's MariaDB, the chat compares them (each `woo-<slug>__list_orders` count = that store's database; the answer names both numbers), delete one store → tools gone on the next request, `/api/upstreams`, namespace, volumes and Helm release gone, audit rows kept; cleanup deletes the other store (KEEP=1 keeps it). DEMO_RUNBOOK §8 added. **Not run — acceptance still open** (needs the k3d cluster and the LLM key; about 8 minutes).
- **Regression risk:** Groq free-tier limits: retry on 429 like the security suite.

### BON-17 — Bike accessories niche
- **Priority:** P1
- **Status:** Done
- **Day:** 23
- **Depends on:** BON-11; the user's catalogue md files in `docs/`
- **Requirements:** REQ-BON-02
- **Description:** Bike accessories catalogue from the md files the user will add to `docs/` (product names, prices, descriptions); product images curated from open-license sources following `docs/PRODUCT_IMAGES.md` (commercial-use licences only, credits in the image manifest), baked into the store-assets image as `catalogue/bike.json`.
- **Output:** `services/store-assets/stores/ridgeline/catalogue.json`, images + manifest entries.
- **Acceptance:** A store created with the Bike accessories niche shows the catalogue with images and credits; licences recorded.
- **Tests:** TC-BON-17-1: storefront screens for a bike store (no broken images, prices).
- **Command:** `scripts/storefront-screens.sh`
- **Evidence:** 2026-10-26 **resumed by the user and verified on k3d:** images from the owner-supplied set (31a2a56). A bike store created from the dashboard API (`bike-check-41556`, Ready in 186 s, store-assets `sha-18c9a989df45`) → Store API 50 products, 0 without an image; `STORE_URL=… PAGES=<bike pages> scripts/storefront-screens.sh` desktop: home, shop, product, brands, brand, categories, category, concept, two searches all 200 with `broken=0 fallbacks=0 noAlt=0 hScroll=false consoleErrors=0`. **Found and fixed:** on phones every page scrolled sideways (the header icons were pushed 52–84 px off-screen by the longer store name + bike mark: RIDGELINE 474 px, BIKE CHECK 41556 442 px at 390 px; TATVA also 374 px at 360 px) → `services/store-assets/theme/tatva/style.css` mobile block: narrower gutters/gaps, compact search button, smaller mark, a long name wraps; checked with the CSS injected on the bike, Ridgeline and TATVA stores at 390 and 360 px → scrollWidth = viewport on all six, nothing clipped (screenshots); built theme on the default store `scripts/storefront-screens.sh` → 20 OK, hScroll false everywhere (only the known `/cart/` console 404, BRD-07). `scripts/storefront-screens.sh` now takes any store (`STORE_URL` sets the host mapping). Note: a Ready store keeps the theme it was created with (the provisioner only reconciles provisioning/deleting stores), so `ridgeline` shows the new header after it is recreated. 2026-10-25 **PAUSED by the user (Blocked = on hold by decision, resume on their word; 11 images open).** Earlier: catalogue `services/store-assets/stores/ridgeline/catalogue.json` from `brand/ridgeline/ridgeline-brand-products.md` §6 (50 products, 7 categories, 6 placeholder brand labels, 6 collections; descriptions claim no fitment/certification). Images sourced by 3 parallel agents with `scripts/brand/find_images.py`/`fetch_image.py` (now `IMAGE_ROOT`/`MANIFEST` aware), CC0/PD only: `services/store-assets/stores/ridgeline/images/manifest.json` 49 entries — **39/50 product images + 10 editorial** (hero, concept, collection, 7 category tiles); licences `CC0 1.0` 27, `CC0` 15, `Public domain` 7; sources Openverse + Wikimedia Commons; every file decodes as WebP, source/asset URL and alt recorded, no duplicate content (2 duplicates and 1 image showing a third party's username removed). Live: `ridgeline.store.127.0.0.1.nip.io` 50 products, checkout order #109 PASS. **Open:** 11 products without a suitable CC0/PD image (RDG-009, 012, 013, 015, 022, 025, 028, 029, 038, 046, 047: tail bag, motorcycle cover, phone mounts, sunshade, seat-back organiser, dry bag, chain lube, patch set, base layer, EDC pouch) show the theme's name fallback; several images are below 1000×1250 (Openverse serves ~1024 px) and some are representative (e.g. a helmet for the intercom). Needs the user's call: accept, or supply images. Retry 2026-10-25 (PRODUCT_IMAGES.md §4/§9 rules, Openverse all providers + Commons, 4 queries per slot): TAT-005 and the 11 Ridgeline SKUs still have no suitable CC0/PD image (only drawings, scenes, branded items such as an ATLANTIC spray can or a Gather organiser, or a pouch image already used for RDG-036); Pexels/Unsplash/Pixabay need API keys not configured; Higgsfield generation unavailable (plan). Recorded as missing, no unrelated photo used.
- **Regression risk:** Image licences: no image without a recorded commercial-use licence.

### BON-16 — Stand-out documentation and demo
- **Priority:** P1
- **Status:** Done
- **Day:** 20
- **Depends on:** BON-01..BON-15
- **Requirements:** REQ-DEL-08
- **Description:** README stand-out table updated to every item with locations; DEMO_RUNBOOK and video plan include permissions, OAuth login, metrics, hosted server, multi-store; SYSTEM_DESIGN and THREAT_MODEL updated.
- **Output:** README, `docs/DEMO_RUNBOOK.md`, `docs/SYSTEM_DESIGN.md`, `THREAT_MODEL.md`.
- **Acceptance:** Every stand-out item and the bonus listed with where to find it; rehearsal (REL-15) covers them.
- **Tests:** checklist.
- **Command:** `scripts/check-docs.sh`
- **Evidence:** 2026-10-25 (documentation deliverable; REL-15 rehearsal still to do). README: usage sections for stores and hosted servers; stand-out table rewritten to all nine items + the multi-store bonus + brand, each with a status word (verified on k3d · built, cluster run pending · prepared), what was built and where; the old "Not attempted yet" line replaced. New `docs/VIDEO_PLAN.md` (timings, what to show per required topic and per stand-out item, pre-recording checklist, topic checklist). DEMO_RUNBOOK §9 hosted servers and §10 observability/scaling added (§8 multi-store from BON-12). SYSTEM_DESIGN: provisioner/stores/hosted rows in the workload table and a new §5 (provisioning design and cost, store access, hosted servers as untrusted code, honest status). THREAT_MODEL T-29..T-32 cover provisioner, internal API, store access and hosted images. Checklist test `scripts/check-docs.sh` → 50 PASS, failures: 0 (README lists all nine items and the bonus, each row states its status, every path named in the section exists, runbook and video plan cover every item and all six topics, SYSTEM_DESIGN/THREAT_MODEL/traceability entries present, no placeholder text); it found one real defect on its first run (`values-prod.yaml` named without its directory) which was fixed, and fails when a README row is removed (checked). **Note:** the table's status words must be updated when the pending cluster runs (BON-10, BON-12..15) pass — `scripts/check-docs.sh` keeps the structure honest, not the status.
- **Regression risk:** —

---
