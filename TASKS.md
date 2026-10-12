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

Cut order if behind: brand polish (Phase 9) → UI polish → TLS → bonus → depth of docs. Mandatory items are never cut.

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
- **Description:** User provisions a VPS / free tier (≥4 GB RAM, Ubuntu LTS, ports 80/443 open). Record provider, size and SSH alias (not secrets). Preparation done: `scripts/vps-preflight.sh` (read-only capability check) and `scripts/vps-install-k3s.sh` (k3s pinned to the local k3d version, API via SSH tunnel).
- **Output:** SSH access confirmed; facts recorded in `docs/DEPLOYMENT.md`.
- **Acceptance:** `scripts/vps-preflight.sh` run on the VPS exits 0 (RAM ≥3.8 GB, ≥2 CPU, ≥20 GB disk, amd64/arm64, systemd, 80/443 free, outbound HTTPS).
- **Tests:** TC-P0-03-1: VPS exists → ssh command → prints specs.
- **Command:** `ssh <alias> 'bash -s' < scripts/vps-preflight.sh`
- **Evidence:** Blocked: no VPS yet (user will obtain one; decision 2026-10-11). 2026-10-11: preflight script syntax-checked and dry-run on the local WSL host (exit 0) — this proves the script works, not the VPS. Provider guidance in `docs/DEPLOYMENT.md` §5.
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
- **Status:** In Progress
- **Day:** 2
- **Depends on:** INF-07
- **Requirements:** REQ-K8S-06
- **Description:** Ingress for `store.<domain>` and `app.<domain>` (`/` dashboard, `/api` and `/mcp` gateway); domain from values.
- **Output:** Ingress templates; local domain approach in DEPLOYMENT.md.
- **Acceptance:** TC-K8S-04 passes.
- **Tests:** TC-INF-11-1: curl each host/path → expected code.
- **Command:** `scripts/k8s-checks.sh ingress`
- **Evidence:** 2026-10-11: store Ingress `store.<domain>` (Traefik, optional TLS via cert-manager annotation) → `/`, `/shop/` 200; no public route to woo-mcp (404). `app.<domain>`: `/api` (Prefix) and `/mcp` (Exact) → gateway verified with GW-01 (JSON 404 from gateway; probes not routed). Dashboard `/` lands with UI-20.
- **Regression risk:** —

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
- **Status:** Not Started
- **Day:** 3
- **Depends on:** GW-08
- **Requirements:** REQ-GW-06
- **Description:** Connect 2 s / list 3 s / call 15 s (configurable); AbortController; clear `upstream_timeout` error.
- **Output:** Timeout wrapper.
- **Acceptance:** TC-INT-03 passes.
- **Tests:** TC-INT-03.
- **Command:** `npm run test:int -w services/gateway`
- **Evidence:** —
- **Regression risk:** —

### GW-10 — Failure isolation + health loop
- **Priority:** P0
- **Status:** Not Started
- **Day:** 3
- **Depends on:** GW-09
- **Requirements:** REQ-GW-05, REQ-GW-09, REQ-DOD-10
- **Description:** allSettled fan-out; health check every 10 s (list or ping); status Connected / Unreachable / Disabled with `last_error` and `last_checked_at`.
- **Output:** Health module.
- **Acceptance:** TC-INT-04 passes.
- **Tests:** TC-INT-04.
- **Command:** `npm run test:int -w services/gateway`
- **Evidence:** —
- **Regression risk:** —

### GW-11 — Enable/disable behaviour
- **Priority:** P0
- **Status:** Not Started
- **Day:** 3
- **Depends on:** GW-08
- **Requirements:** REQ-GW-01, REQ-DOD-09
- **Description:** A disabled upstream is excluded from the list; calls are rejected with `upstream_disabled`; the pool connection is closed.
- **Output:** Logic + test.
- **Acceptance:** TC-INT-05 passes.
- **Tests:** TC-INT-05.
- **Command:** `npm run test:int -w services/gateway`
- **Evidence:** —
- **Regression risk:** Replicas see the change on next request (read from DB; no stale in-memory flag).

### GW-12 — Encrypted credential injection
- **Priority:** P0
- **Status:** Not Started
- **Day:** 3
- **Depends on:** GW-04
- **Requirements:** REQ-GW-01, REQ-GW-07
- **Description:** AES-256-GCM (D-009); header/bearer injection; never forward the inbound Authorization.
- **Output:** `crypto.ts`, transport header builder.
- **Acceptance:** TC-UNIT-05, TC-INT-06 pass.
- **Tests:** TC-UNIT-05, TC-INT-06.
- **Command:** `npm test -w services/gateway`
- **Evidence:** Partial (2026-10-12, GW-03): `src/crypto/credentials.ts` (AES-256-GCM, slug as AAD) + `gateway-secrets/credentials-key` done and tested; injection into the upstream transport still open.
- **Regression risk:** Key rotation not supported (documented).

### GW-13 — everything-mcp upstream in cluster
- **Priority:** P0
- **Status:** Not Started
- **Day:** 3
- **Depends on:** ARC-15, INF-10
- **Requirements:** REQ-GW-08
- **Description:** Deployment of server-everything (Streamable HTTP), probes, limits, NetworkPolicy gateway-only; registered via seed or values.
- **Output:** Template.
- **Acceptance:** Gateway lists `everything__*` tools.
- **Tests:** TC-GW-13-1: list via gateway → includes everything tools.
- **Command:** Inspector CLI list
- **Evidence:** —
- **Regression risk:** Image or command differences → pin the version.

### GW-14 — GitHub remote upstream
- **Priority:** P0
- **Status:** Not Started
- **Day:** 3
- **Depends on:** GW-12, P0-04
- **Requirements:** REQ-GW-08, REQ-GW-07
- **Description:** Register `github` with the bearer PAT through the admin API (or seed from a Secret); egress allowed.
- **Output:** Registered upstream.
- **Acceptance:** `github__*` tools listed; the PAT never appears in any response or log.
- **Tests:** TC-GW-14-1: list → github tools. TC-AUTH-04 scan.
- **Command:** Inspector CLI list
- **Evidence:** —
- **Regression risk:** GitHub tool count is large (many tools) → consider a toolset header `X-MCP-Toolsets: issues` to limit.

### GW-15 — Cross-server call test
- **Priority:** P0
- **Status:** Not Started
- **Day:** 3
- **Depends on:** GW-13, GW-14
- **Requirements:** REQ-DOD-07
- **Description:** Script calls `woo__list_orders` then `github__create_issue` with a summary.
- **Output:** `scripts/cross-server.mjs`.
- **Acceptance:** Issue created in the throwaway repo.
- **Tests:** TC-GW-15-1: run → issue URL printed.
- **Command:** `node scripts/cross-server.mjs`
- **Evidence:** —
- **Regression risk:** —

### GW-16 — Kill-pod resilience test
- **Priority:** P0
- **Status:** Not Started
- **Day:** 3
- **Depends on:** GW-10, GW-13
- **Requirements:** REQ-DOD-10, REQ-GW-05
- **Description:** Scale everything-mcp to 0 (and also `kubectl delete pod`) → list still returns woo+github within 3 s; status Unreachable; recovers when back.
- **Output:** `scripts/k8s-checks.sh killpod`.
- **Acceptance:** As described.
- **Tests:** TC-GW-16-1: scale 0 → list ok without everything → status Unreachable. TC-GW-16-2: scale 1 → Connected within 20 s.
- **Command:** `scripts/k8s-checks.sh killpod`
- **Evidence:** —
- **Regression risk:** —

### GW-17 — Structured logging with redaction
- **Priority:** P1
- **Status:** Not Started
- **Day:** 3
- **Depends on:** GW-01
- **Requirements:** REQ-K8S-09
- **Description:** Request ID per call; redaction paths; no tool args at info level.
- **Output:** Logger config + test.
- **Acceptance:** TC-UNIT-06 passes.
- **Tests:** TC-UNIT-06.
- **Command:** `npm test -w services/gateway -- redact`
- **Evidence:** —
- **Regression risk:** —

---

## Phase 5 — Identity, team management, API keys and auditing
Exit criterion: separate users authenticated; access enforced; revoked keys rejected; tool calls audited correctly.

### AUTH-01 — Users and roles schema
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** GW-02
- **Requirements:** REQ-AUTH-01
- **Description:** users(id, email, name, role admin|member, password_hash, disabled_at); sessions; invites; api_keys; audit_log tables.
- **Output:** Migration.
- **Acceptance:** Migration applies.
- **Tests:** TC-AUTH-01-1: migrate fresh → tables exist.
- **Command:** `npm run db:migrate -w services/gateway`
- **Evidence:** —
- **Regression risk:** —

### AUTH-02 — Admin seed + login
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-01
- **Requirements:** REQ-AUTH-01
- **Description:** Seed the first admin from Secret `gateway-admin`; `POST /api/auth/login` (argon2id verify, rate limit).
- **Output:** Route + test.
- **Acceptance:** Correct password → session cookie; wrong → 401.
- **Tests:** TC-AUTH-02-1/2.
- **Command:** `npm test -w services/gateway -- auth`
- **Evidence:** —
- **Regression risk:** —

### AUTH-03 — Sessions
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-02
- **Requirements:** REQ-AUTH-01
- **Description:** DB sessions, httpOnly + SameSite=Strict (+ Secure in prod) cookie, 12 h expiry, logout, Origin check on mutations.
- **Output:** Middleware.
- **Acceptance:** `/api/me` works with the cookie; cross-origin POST rejected.
- **Tests:** TC-AUTH-03-1/2.
- **Command:** `npm test -w services/gateway -- session`
- **Evidence:** —
- **Regression risk:** —

### AUTH-04 — Invitations
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-03
- **Requirements:** REQ-AUTH-02
- **Description:** Admin `POST /api/invites` → one-time link (token hashed, 72 h, role member|admin).
- **Output:** Route + test.
- **Acceptance:** TC-AUTH-03 passes.
- **Tests:** TC-AUTH-03.
- **Command:** `npm test -w services/gateway -- invite`
- **Evidence:** —
- **Regression risk:** —

### AUTH-05 — Accept invite
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-04
- **Requirements:** REQ-AUTH-02
- **Description:** `POST /api/invites/:token/accept` sets name and password; token consumed.
- **Output:** Route.
- **Acceptance:** Second use → 410.
- **Tests:** TC-AUTH-05-1.
- **Command:** `npm test -w services/gateway -- invite`
- **Evidence:** —
- **Regression risk:** —

### AUTH-06 — API key generation
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-03
- **Requirements:** REQ-AUTH-03
- **Description:** `POST /api/keys` (own) and admin `POST /api/users/:id/keys`; returns plaintext once.
- **Output:** Route.
- **Acceptance:** Key works on `/mcp`.
- **Tests:** TC-AUTH-06-1.
- **Command:** `npm test -w services/gateway -- keys`
- **Evidence:** —
- **Regression risk:** —

### AUTH-07 — Hashed key storage
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-06
- **Requirements:** REQ-AUTH-05
- **Description:** SHA-256 hash + prefix only (D-008).
- **Output:** Key module.
- **Acceptance:** DB contains no plaintext key (query check).
- **Tests:** TC-UNIT-02; TC-AUTH-07-1: `select` → only hash and prefix.
- **Command:** `kubectl -n platform exec sts/postgres -- psql -c 'select prefix, length(key_hash) from api_keys'`
- **Evidence:** —
- **Regression risk:** —

### AUTH-08 — Key validation on /mcp
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-07, GW-06
- **Requirements:** REQ-AUTH-03, REQ-GW-12
- **Description:** Bearer key → user context; remove the temporary dev key; update `last_used_at`.
- **Output:** Middleware.
- **Acceptance:** TC-AUTH-01 passes.
- **Tests:** TC-AUTH-01.
- **Command:** `npm run test:int -w services/gateway`
- **Evidence:** —
- **Regression risk:** —

### AUTH-09 — Revocation
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-08
- **Requirements:** REQ-AUTH-04, REQ-DOD-08
- **Description:** `DELETE /api/keys/:id` (owner or admin) sets revoked_at; the next request is rejected.
- **Output:** Route.
- **Acceptance:** Revoke → the immediately following call → 401.
- **Tests:** TC-AUTH-09-1.
- **Command:** `npm run test:int -w services/gateway -- revoke`
- **Evidence:** —
- **Regression risk:** —

### AUTH-10 — Server-side authorization on /api
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-03
- **Requirements:** REQ-AUTH-01, REQ-GW-07
- **Description:** `requireRole('admin')` on server/member/audit/admin-key routes; table-driven test over all routes.
- **Output:** Guard + test.
- **Acceptance:** TC-AUTH-02 passes.
- **Tests:** TC-AUTH-02.
- **Command:** `npm test -w services/gateway -- authz`
- **Evidence:** —
- **Regression risk:** New routes forgetting the guard → default-deny router.

### AUTH-11 — Request attribution context
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-08
- **Requirements:** REQ-AUTH-06, REQ-CHAT-03
- **Description:** AsyncLocalStorage context {userId, keyId, source, requestId} available to the router and audit.
- **Output:** Context module.
- **Acceptance:** Audit rows carry the correct user.
- **Tests:** TC-AUTH-11-1.
- **Command:** `npm test -w services/gateway`
- **Evidence:** —
- **Regression risk:** —

### AUTH-12 — Audit schema
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-01
- **Requirements:** REQ-AUTH-06
- **Description:** Per ARC-08; indexes on ts and user.
- **Output:** Migration.
- **Acceptance:** Table exists with required columns.
- **Tests:** TC-AUTH-12-1.
- **Command:** `npm run db:migrate -w services/gateway`
- **Evidence:** —
- **Regression risk:** —

### AUTH-13 — Audit writes for all outcomes
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-11, AUTH-12
- **Requirements:** REQ-AUTH-06, REQ-DOD-11
- **Description:** Write ok/error/timeout/denied (including invalid-key attempts with user null).
- **Output:** Audit writer.
- **Acceptance:** TC-AUTH-05 passes.
- **Tests:** TC-AUTH-05.
- **Command:** `npm run test:int -w services/gateway -- audit`
- **Evidence:** —
- **Regression risk:** Audit failure must not lose the call result (log the error).

### AUTH-14 — Audit query API
- **Priority:** P0
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-13
- **Requirements:** REQ-AUTH-07
- **Description:** `GET /api/audit?user&upstream&outcome&from&to&limit&cursor` (admin).
- **Output:** Route.
- **Acceptance:** Filters work; members → 403.
- **Tests:** TC-AUTH-14-1.
- **Command:** `npm test -w services/gateway -- audit`
- **Evidence:** —
- **Regression risk:** —

### AUTH-15 — Secret redaction tests
- **Priority:** P1
- **Status:** Not Started
- **Day:** 4
- **Depends on:** AUTH-10, GW-12
- **Requirements:** REQ-GW-07, REQ-K8S-09
- **Description:** Scan every `/api` response and log output during the test run for known secret values.
- **Output:** Test.
- **Acceptance:** TC-AUTH-04 passes.
- **Tests:** TC-AUTH-04.
- **Command:** `npm run test:int -w services/gateway -- leak`
- **Evidence:** —
- **Regression risk:** —

---

## Phase 6 — Backend, dashboard and AI chat
Exit criterion: dashboard and chat work with the real gateway and store.

### UI-01 — Dashboard skeleton
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** INF-01
- **Requirements:** REQ-DEL-04
- **Description:** Vite + React + TS + TanStack Query + React Router; layout with nav.
- **Output:** `apps/dashboard`.
- **Acceptance:** `npm run build -w apps/dashboard` succeeds.
- **Tests:** TC-UI-01-1: build → dist.
- **Command:** `npm run build -w apps/dashboard`
- **Evidence:** —
- **Regression risk:** —

### UI-02 — API client
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-01, AUTH-03
- **Requirements:** —
- **Description:** fetch wrapper (credentials: same-origin, JSON, error handling, 401 → login).
- **Output:** `src/api.ts`.
- **Acceptance:** Used by all pages.
- **Tests:** TC-UI-02-1: unit test of the error mapping.
- **Command:** `npm test -w apps/dashboard`
- **Evidence:** —
- **Regression risk:** —

### UI-03 — Login / logout / accept invite
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-02, AUTH-05
- **Requirements:** REQ-AUTH-01, REQ-AUTH-02
- **Description:** Pages for login, logout, invite acceptance.
- **Output:** Pages.
- **Acceptance:** Manual flow works for admin and member.
- **Tests:** TC-UI-03-1 (manual): invite → accept → login.
- **Command:** manual (runbook)
- **Evidence:** —
- **Regression risk:** —

### UI-04 — Server list with status and tools
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-02, GW-10
- **Requirements:** REQ-GW-09, REQ-GW-10
- **Description:** Table of upstreams with status badge, last error and expandable tools; auto-refresh every 10 s.
- **Output:** Page.
- **Acceptance:** Shows Connected / Unreachable / Disabled correctly.
- **Tests:** TC-UI-04-1 (manual + API): kill pod → badge Unreachable.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-05 — Add server
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-04
- **Requirements:** REQ-GW-01
- **Description:** Form: name, slug, URL, auth type none|bearer|header, header name, credential (write-only).
- **Output:** Form + `POST /api/upstreams` (validation incl. SSRF guard).
- **Acceptance:** New server appears and connects.
- **Tests:** TC-UI-05-1; TC-SEC-01.
- **Command:** manual + `npm test -w services/gateway -- upstreams`
- **Evidence:** —
- **Regression risk:** —

### UI-06 — Edit server
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-05
- **Requirements:** REQ-GW-01
- **Description:** Edit name, URL and credential (blank = keep existing); the slug is immutable.
- **Output:** Form + `PATCH`.
- **Acceptance:** Change takes effect; the credential is never displayed.
- **Tests:** TC-UI-06-1.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-07 — Disable / remove server
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-05, GW-11
- **Requirements:** REQ-GW-01, REQ-DOD-09
- **Description:** Toggle + delete with confirm.
- **Output:** Buttons + `PATCH`/`DELETE`.
- **Acceptance:** Tools disappear from the gateway list.
- **Tests:** TC-UI-07-1.
- **Command:** manual + Inspector list
- **Evidence:** —
- **Regression risk:** —

### UI-08 — Member read-only server view
- **Priority:** P1
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-04
- **Requirements:** REQ-AUTH-01, REQ-GW-12
- **Description:** Members see servers and tools without management controls, plus a "Connect your MCP client" panel with the gateway URL and config snippets.
- **Output:** Role-aware page.
- **Acceptance:** No admin buttons for members (and the API rejects them anyway).
- **Tests:** TC-UI-08-1.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-09 — Members and invites page
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-03, AUTH-04
- **Requirements:** REQ-AUTH-02
- **Description:** List members, create invite (copy link), disable member.
- **Output:** Page.
- **Acceptance:** Invite link works.
- **Tests:** TC-UI-09-1.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-10 — Admin key management
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-09, AUTH-09
- **Requirements:** REQ-AUTH-04
- **Description:** Admin sees all keys (prefix, owner, last used) and can issue or revoke.
- **Output:** Page.
- **Acceptance:** Revoke from the UI → the external client is rejected.
- **Tests:** TC-UI-10-1.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-11 — My API keys
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-02, AUTH-06
- **Requirements:** REQ-AUTH-03
- **Description:** Generate (shown once with a copy button), list, revoke own keys.
- **Output:** Page.
- **Acceptance:** Generated key works in Inspector.
- **Tests:** TC-UI-11-1.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-12 — Audit log page
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-02, AUTH-14
- **Requirements:** REQ-AUTH-07
- **Description:** Table: time, user, source, server, tool, duration, outcome; filters; auto-refresh.
- **Output:** Page.
- **Acceptance:** New calls appear within 10 s.
- **Tests:** TC-UI-12-1.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-13 — LLM provider config
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** INF-06, P0-04
- **Requirements:** REQ-CHAT-04
- **Description:** Values `llm.baseUrl`, `llm.model`; Secret `llm-secrets.LLM_API_KEY`; Groq default, OpenRouter tested.
- **Output:** Config + chart.
- **Acceptance:** No key in the bundle or values files.
- **Tests:** TC-SEC-05.
- **Command:** `grep -r "$LLM_API_KEY" apps/dashboard/dist charts || echo clean`
- **Evidence:** —
- **Regression risk:** —

### UI-14 — Chat agent loop (backend)
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-13, UI-15
- **Requirements:** REQ-CHAT-01
- **Description:** `POST /api/chat` {messages} → loop: LLM with tools → execute tool_calls via gateway MCP client → repeat (max 8) → return answer + tool transcript.
- **Output:** `chat/agent.ts`.
- **Acceptance:** TC-INT-07 passes with a stub LLM; real LLM smoke passes.
- **Tests:** TC-INT-07; TC-UI-14-1 real smoke.
- **Command:** `npm run test:int -w services/gateway -- chat`
- **Evidence:** —
- **Regression risk:** Too many tools for small models → cap or filter.

### UI-15 — Internal token to gateway /mcp
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** AUTH-08
- **Requirements:** REQ-GW-11, REQ-CHAT-03
- **Description:** HMAC-signed short-lived token (`sub`, `src=chat`, `exp`), accepted by `/mcp` auth alongside API keys; the agent's MCP client targets the gateway's own URL.
- **Output:** Token module.
- **Acceptance:** Audit rows from chat show the user + `source=chat`; an expired token → 401.
- **Tests:** TC-UI-15-1/2.
- **Command:** `npm test -w services/gateway -- internal-token`
- **Evidence:** —
- **Regression risk:** —

### UI-16 — Chat UI with tool-call display
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-14
- **Requirements:** REQ-CHAT-02
- **Description:** Chat page showing messages and collapsible tool-call cards (tool, server, args, result excerpt, ms, ok or error).
- **Output:** Page.
- **Acceptance:** Tool calls visible for each answer.
- **Tests:** TC-UI-16-1 (manual).
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-17 — Chat attribution test
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-15, AUTH-13
- **Requirements:** REQ-CHAT-03, REQ-DOD-11
- **Description:** Two users chat; audit rows are attributed correctly.
- **Output:** Integration test.
- **Acceptance:** Rows match the users.
- **Tests:** TC-UI-17-1.
- **Command:** `npm run test:int -w services/gateway -- chat-attribution`
- **Evidence:** —
- **Regression risk:** —

### UI-18 — Error states
- **Priority:** P2
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-16
- **Requirements:** REQ-GW-06
- **Description:** Friendly display of LLM rate limits, upstream errors and timeouts.
- **Output:** UI handling.
- **Acceptance:** A killed upstream yields a readable error in chat.
- **Tests:** TC-UI-18-1 (manual).
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### UI-19 — Chat "create product" flow
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-16, WC-09
- **Requirements:** REQ-DOD-03, REQ-DOD-04
- **Description:** "Create a product called Demo Mug priced 12.50" → product on the storefront; "what orders came in today?" → lists orders.
- **Output:** Evidence.
- **Acceptance:** Both prompts succeed with real Groq.
- **Tests:** TC-E2E-03, TC-E2E-04.
- **Command:** manual + `scripts/e2e.sh chat`
- **Evidence:** —
- **Regression risk:** Model choice.

### UI-20 — Dashboard image + Helm
- **Priority:** P0
- **Status:** Not Started
- **Day:** 5
- **Depends on:** UI-01, INF-11
- **Requirements:** REQ-K8S-04
- **Description:** nginx-unprivileged image serving dist with SPA fallback; probes, limits; Ingress `/`.
- **Output:** Dockerfile + template.
- **Acceptance:** `http://app.127.0.0.1.nip.io` loads the dashboard.
- **Tests:** TC-K8S-04.
- **Command:** `curl -s http://app.127.0.0.1.nip.io | grep -q '<div id="root"'`
- **Evidence:** —
- **Regression risk:** —

---

## Phase 7 — External MCP clients and acceptance testing
Exit criterion: required workflows work across dashboard chat, gateway, external MCP clients and WooCommerce.

### E2E-01 — External gateway URL
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** AUTH-08, INF-11
- **Requirements:** REQ-GW-12
- **Description:** `http://app.<domain>/mcp` reachable from the host (and from Windows for Cursor).
- **Output:** Documented URL.
- **Acceptance:** Without a key → 401; with a key → initialize ok.
- **Tests:** TC-K8S-04.
- **Command:** `curl -s -o /dev/null -w '%{http_code}' -X POST http://app.127.0.0.1.nip.io/mcp`
- **Evidence:** —
- **Regression risk:** —

### E2E-02 — Client configuration docs
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-01
- **Requirements:** REQ-DEL-03
- **Description:** README sections for Claude Code, Cursor and Inspector.
- **Output:** README.
- **Acceptance:** Following the docs verbatim works.
- **Tests:** TC-EXT-01/02.
- **Command:** —
- **Evidence:** —
- **Regression risk:** —

### E2E-03 — Users A and B
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** AUTH-05, AUTH-06
- **Requirements:** REQ-DOD-12
- **Description:** Script or runbook to create user A (admin or member) and user B (member) with keys.
- **Output:** `scripts/seed-demo-users.sh` (passwords from env, not committed).
- **Acceptance:** Both log in and have keys.
- **Tests:** TC-E2E-03-1.
- **Command:** `scripts/seed-demo-users.sh`
- **Evidence:** —
- **Regression risk:** —

### E2E-04 — B lists tools externally
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-03
- **Requirements:** REQ-DOD-05, REQ-DOD-06
- **Description:** Inspector CLI + Claude Code with B's key → tools of all 3 servers.
- **Output:** Evidence.
- **Acceptance:** woo, everything and github tools listed.
- **Tests:** TC-EXT-01, TC-EXT-02.
- **Command:** Inspector CLI list
- **Evidence:** —
- **Regression risk:** —

### E2E-05 — B asks the orders question
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-04
- **Requirements:** REQ-DOD-06
- **Description:** In Claude Code: "What orders came in today in the store?"
- **Output:** Evidence.
- **Acceptance:** Correct order list.
- **Tests:** TC-EXT-02.
- **Command:** manual (Claude Code)
- **Evidence:** —
- **Regression risk:** —

### E2E-06 — Cross-upstream prompt
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-04, GW-15
- **Requirements:** REQ-DOD-07
- **Description:** "Summarize today's orders and open a GitHub issue in <repo> with the summary."
- **Output:** Issue URL as evidence.
- **Acceptance:** Both servers' tools called (audit shows both).
- **Tests:** TC-E2E-07.
- **Command:** manual + audit query
- **Evidence:** —
- **Regression risk:** —

### E2E-07 — Revoke B
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-04, UI-10
- **Requirements:** REQ-DOD-08
- **Description:** Admin revokes B's key in the dashboard → B's next call is rejected.
- **Output:** Evidence.
- **Acceptance:** 401 + audit `denied`.
- **Tests:** TC-E2E-08.
- **Command:** `scripts/e2e.sh revoke`
- **Evidence:** —
- **Regression risk:** —

### E2E-08 — Disable an upstream
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** UI-07
- **Requirements:** REQ-DOD-09
- **Description:** Disable `everything` → tools gone from the chat agent's tool list and the external client's list.
- **Output:** Evidence.
- **Acceptance:** Both lists exclude everything tools.
- **Tests:** TC-E2E-09.
- **Command:** `scripts/e2e.sh disable`
- **Evidence:** —
- **Regression risk:** —

### E2E-09 — Kill an upstream pod
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** GW-16, UI-04
- **Requirements:** REQ-DOD-10
- **Description:** `kubectl delete pod` / scale 0 → others work; dashboard Unreachable.
- **Output:** Evidence.
- **Acceptance:** As described.
- **Tests:** TC-E2E-10.
- **Command:** `scripts/e2e.sh killpod`
- **Evidence:** —
- **Regression risk:** —

### E2E-10 — Audit attribution check
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-05..E2E-09
- **Requirements:** REQ-DOD-11
- **Description:** Every call above in the audit with the correct user and outcome.
- **Output:** Evidence.
- **Acceptance:** Audit query assertions pass.
- **Tests:** TC-E2E-11.
- **Command:** `scripts/e2e.sh audit`
- **Evidence:** —
- **Regression risk:** —

### E2E-11 — A creates a product via chat
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** UI-19
- **Requirements:** REQ-DOD-03
- **Description:** Live with user A.
- **Output:** Evidence.
- **Acceptance:** Product on the storefront.
- **Tests:** TC-E2E-03.
- **Command:** manual + `scripts/e2e.sh chat`
- **Evidence:** —
- **Regression risk:** —

### E2E-12 — Manual COD order
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** WC-04, E2E-11
- **Requirements:** REQ-DOD-01, REQ-DOD-02, REQ-DOD-04
- **Description:** Order the new product on the storefront.
- **Output:** Evidence.
- **Acceptance:** Order in wp-admin.
- **Tests:** TC-E2E-01, TC-E2E-02.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### E2E-13 — A asks today's orders via chat
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-12
- **Requirements:** REQ-DOD-04
- **Description:** Chat returns the order.
- **Output:** Evidence.
- **Acceptance:** The order number matches.
- **Tests:** TC-E2E-04.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### E2E-14 — Scripted acceptance suite
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-01..E2E-13
- **Requirements:** REQ-DOD-01..12
- **Description:** `scripts/e2e.sh all` runs every automatable DoD check and prints a PASS/FAIL table; manual items listed with runbook refs.
- **Output:** Script + saved run log in `docs/evidence/`.
- **Acceptance:** All automated checks PASS on local; re-run on the VPS.
- **Tests:** TC-E2E-01..12.
- **Command:** `scripts/e2e.sh all`
- **Evidence:** —
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
- **Status:** Not Started
- **Day:** 6
- **Depends on:** INF-04, REL-01
- **Requirements:** REQ-K8S-03
- **Description:** Domain (sslip.io or real), GHCR images, Secure cookies, resources.
- **Output:** `values-prod.yaml`.
- **Acceptance:** `helm template` with prod values passes checks.
- **Tests:** TC-K8S-01.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** —
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
- **Priority:** P2
- **Status:** Not Started
- **Day:** 7
- **Depends on:** REL-03
- **Requirements:** —
- **Description:** cert-manager + Let's Encrypt HTTP-01 via Traefik; `tls.enabled` in values.
- **Output:** HTTPS hosts.
- **Acceptance:** `curl -I https://app.<domain>` valid cert.
- **Tests:** TC-REL-04-1.
- **Command:** `curl -sI https://app.<domain>`
- **Evidence:** —
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
- **Status:** Not Started
- **Day:** 6
- **Depends on:** AUTH-10
- **Requirements:** REQ-AUTH-01
- **Description:** Review every route and MCP path against the role matrix; fix gaps.
- **Output:** Review notes in THREAT_MODEL.
- **Acceptance:** TC-AUTH-02 passes; review recorded.
- **Tests:** TC-AUTH-02.
- **Command:** `npm test -w services/gateway -- authz`
- **Evidence:** —
- **Regression risk:** —

### REL-08 — SSRF validation tests
- **Priority:** P1
- **Status:** Not Started
- **Day:** 6
- **Depends on:** UI-05
- **Requirements:** —
- **Description:** TC-UNIT-04 + TC-SEC-01 against the live API.
- **Output:** Evidence.
- **Acceptance:** Blocked addresses rejected; allowlisted internal upstreams accepted.
- **Tests:** TC-UNIT-04, TC-SEC-01.
- **Command:** `npm test -w services/gateway -- ssrf`
- **Evidence:** —
- **Regression risk:** —

### REL-09 — Workload securityContext audit
- **Priority:** P1
- **Status:** Not Started
- **Day:** 6
- **Depends on:** INF-15
- **Requirements:** —
- **Description:** runAsNonRoot where possible, no privilege escalation, drop ALL caps, automountServiceAccountToken false.
- **Output:** Chart updates + exceptions documented (wordpress/apache).
- **Acceptance:** Check script passes.
- **Tests:** TC-REL-09-1.
- **Command:** `scripts/check-chart.sh security`
- **Evidence:** —
- **Regression risk:** WordPress image runs as root by default (document or use port 8080 + www-data).

### REL-10 — Probes and limits audit
- **Priority:** P0
- **Status:** Not Started
- **Day:** 6
- **Depends on:** INF-13
- **Requirements:** REQ-K8S-07, REQ-K8S-08
- **Description:** Run TC-K8S-02 on the final chart.
- **Output:** Evidence.
- **Acceptance:** 0 missing.
- **Tests:** TC-K8S-02.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** —
- **Regression risk:** —

### REL-11 — Helm upgrade and rollback
- **Priority:** P1
- **Status:** Not Started
- **Day:** 7
- **Depends on:** REL-03
- **Requirements:** REQ-DEL-09
- **Description:** Upgrade the gateway image tag → `helm history` → `helm rollback` → verify; document.
- **Output:** DEPLOYMENT.md section + evidence.
- **Acceptance:** Rollback restores the previous revision without data loss.
- **Tests:** TC-K8S-03.
- **Command:** `helm history platform && helm rollback platform <rev>`
- **Evidence:** —
- **Regression risk:** DB migrations are forward-only → note in docs.

### REL-12 — README
- **Priority:** P0
- **Status:** Not Started
- **Day:** 7
- **Depends on:** E2E-14
- **Requirements:** REQ-DEL-01, REQ-DEL-02, REQ-DEL-03, REQ-DEL-08
- **Description:** Local setup, VPS setup, place an order, connect a client, use chat, bonus list.
- **Output:** README.md.
- **Acceptance:** A fresh reader can follow it (dry run on a clean cluster).
- **Tests:** TC-REL-12-1: `scripts/down.sh && follow README` → works.
- **Command:** manual
- **Evidence:** —
- **Regression risk:** —

### REL-13 — System design and trade-offs note
- **Priority:** P0
- **Status:** Not Started
- **Day:** 7
- **Depends on:** E2E-14
- **Requirements:** REQ-DEL-06
- **Description:** `docs/SYSTEM_DESIGN.md` (or a README section): architecture choices, aggregation, routing, failure handling, production changes.
- **Output:** Note.
- **Acceptance:** Covers all bullets of REQ-DEL-06.
- **Tests:** checklist review.
- **Command:** —
- **Evidence:** —
- **Regression risk:** —

### REL-14 — Threat model final
- **Priority:** P0
- **Status:** Not Started
- **Day:** 7
- **Depends on:** REL-07, REL-08
- **Requirements:** REQ-DEL-07
- **Description:** Complete §4 answers with verified mitigations (mark Verified + test IDs).
- **Output:** THREAT_MODEL.md.
- **Acceptance:** All 4 required questions answered; no unverified claims.
- **Tests:** checklist review.
- **Command:** —
- **Evidence:** —
- **Regression risk:** —

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
- **Depends on:** REL-15
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
Brand: **TATVA (current working concept; may change, D-015)**. Source material: [`docs/tatva-brand-and-products.md`](docs/tatva-brand-and-products.md) (brand + catalogue), [`docs/v1-brand-ui-theme.md`](docs/v1-brand-ui-theme.md) (UI/theme), [`docs/PRODUCT_IMAGES.md`](docs/PRODUCT_IMAGES.md) (images). If the concept changes, only these docs and D-015 change; the tasks stay the same.
Exit criterion: the storefront follows the current brand concept and theme spec, has the catalogue, comes back the same on a fresh cluster, and checkout and MCP tests still pass. Added 2026-10-12 at the user's request. Runs alongside Phase 4 on Day 3; P2, so brand polish is the first thing cut if behind.

### BRD-01 — Niche and positioning
- **Priority:** P2
- **Status:** Not Started
- **Day:** 3
- **Depends on:** WC-03
- **Requirements:** —
- **Description:** Summarise the current working concept, **TATVA** (D-015, may change): a curated multi-brand Indian lifestyle store. Primary line "The Essence of Good Design.", campaign line "Discover brands with meaning."; audience, brand principles, voice/copy rules; the 5 categories (Home & Living as hero, Personal Care, Fashion & Accessories, Food & Drink, Stationery & Everyday Objects); placeholder brand names; merchandising rules. Source: `docs/tatva-brand-and-products.md` §1–5, §7–8.
- **Output:** `brand/BRAND.md`.
- **Acceptance:** One page that BRD-02..05 can be built from without further questions; brand-name review note for REL-16/17 recorded.
- **Tests:** TC-BRD-01-1: user reviews `brand/BRAND.md` → approved.
- **Command:** —
- **Evidence:** —
- **Regression risk:** Brand names are placeholders, not real businesses; still review names and claims before the repo goes public (REL-16/17, D-015).

### BRD-02 — Logo and visual identity
- **Priority:** P2
- **Status:** Not Started
- **Day:** 3
- **Depends on:** BRD-01
- **Requirements:** —
- **Description:** Wordmark + mark for the current working name (TATVA) as SVG, favicon/site icon (512 px PNG + ICO), colour palette and font pairing from `docs/v1-brand-ui-theme.md` §2 with licences noted. Keep the name in one place so a rename is a token change.
- **Output:** `brand/logo/` (SVG, PNG, ICO), `brand/palette.md` (hex values, contrast ratios).
- **Acceptance:** Logo readable at 32 px and on light/dark backgrounds; text/background pairs meet WCAG AA (4.5:1).
- **Tests:** TC-BRD-02-1: contrast check of each text pair → ≥ 4.5:1. TC-BRD-02-2: favicon renders in the browser tab.
- **Command:** —
- **Evidence:** —
- **Regression risk:** —

### BRD-03 — Design tokens and theme
- **Priority:** P2
- **Status:** Not Started
- **Day:** 3
- **Depends on:** BRD-02
- **Requirements:** —
- **Description:** Theme material now exists: `docs/v1-brand-ui-theme.md` (2026-10-12; was Blocked waiting for it). Turn it into theme tokens (theme.json colours, typography scale, spacing, radii, shadows) and pick the theme base (D-016).
- **Output:** Theme source under `charts/platform/files/theme/` (or as D-016 decides).
- **Acceptance:** Tokens match `brand/` material; no hard-coded colours outside the token file.
- **Tests:** TC-BRD-03-1: grep theme CSS for raw hex outside tokens → none.
- **Command:** —
- **Evidence:** —
- **Regression risk:** A theme switch can change checkout markup used by `scripts/e2e-checkout.sh`.

### BRD-04 — Storefront UI layout
- **Priority:** P2
- **Status:** Not Started
- **Day:** 3
- **Depends on:** BRD-03
- **Requirements:** —
- **Description:** Build the pages from `docs/v1-brand-ui-theme.md` (§3 navigation, §4 homepage layout, §5 required pages, §6 product/brand cards, §7 states). Style product page, cart and checkout to match. Mobile layout (≤ 400 px) without horizontal scroll.
- **Output:** Templates/patterns in the theme; About page content.
- **Acceptance:** Homepage matches the theme spec sections in order (`docs/v1-brand-ui-theme.md` §4, §9 checklist); all links work; mobile layout usable; checkout still works.
- **Tests:** TC-BRD-04-1: desktop + mobile screenshots vs theme spec → sections present. TC-BRD-04-2: header search returns products.
- **Command:** —
- **Evidence:** —
- **Regression risk:** Block checkout styling must not hide the payment method radios.

### BRD-05 — Product catalogue
- **Priority:** P2
- **Status:** Not Started
- **Day:** 3
- **Depends on:** BRD-01
- **Requirements:** REQ-STORE-01
- **Description:** Store currency INR (₹). Create the 5 categories, a brand taxonomy (WooCommerce built-in Brands) with the placeholder brands, and the proposed ~50-product starter catalogue from `docs/tatva-brand-and-products.md` §6 (name, brand, category, illustrative ₹ price, short description, image, SKU), with featured products per §8 (stoneware mug as hero). Images per `docs/PRODUCT_IMAGES.md` (open-licence, attributed). Seeded **idempotently** by wp-init (match on SKU, never duplicate on re-run); replaces today's sample products ("Urumi Mug", "Urumi T-Shirt", "Urumi Sticker Pack"), which tests and the e2e checkout still use until then.
- **Output:** Catalogue data file (`charts/platform/files/catalogue/products.json` or similar) + wp-init step; product images.
- **Acceptance:** Fresh install → all 5 categories have products; re-running wp-init creates no duplicates.
- **Tests:** TC-BRD-05-1: count products/categories/brands after install. TC-BRD-05-2: re-run wp-init → counts unchanged. TC-BRD-05-3: MCP `list_products` returns ₹ prices.
- **Command:** `scripts/woo-int.sh`
- **Evidence:** —
- **Regression risk:** Images exceed the 1 MiB ConfigMap limit → ship them via an init container or a custom image. Tests that assume old sample product names must be updated.

### BRD-06 — Theme and asset packaging
- **Priority:** P2
- **Status:** Not Started
- **Day:** 3
- **Depends on:** BRD-03, BRD-05
- **Requirements:** REQ-K8S-03
- **Description:** Install and activate the theme, logo, site icon, menus, homepage and catalogue through wp-init. Toggle in values (`store.brand.enabled`).
- **Output:** Chart templates + wp-init steps.
- **Acceptance:** `scripts/down.sh && scripts/up.sh` (or fresh `helm install`) → branded store with no manual steps; data survives pod deletion.
- **Tests:** TC-BRD-06-1: fresh cluster → branded homepage. TC-BRD-06-2: delete wordpress pod → still branded.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** —
- **Regression risk:** wp-init run time grows; keep the Job's backoff/timeout in step.

### BRD-07 — Storefront verification
- **Priority:** P2
- **Status:** Not Started
- **Day:** 3
- **Depends on:** BRD-04, BRD-06
- **Requirements:** REQ-DOD-01
- **Description:** Screenshots (desktop + mobile) checked against `docs/v1-brand-ui-theme.md` §9; full regression of checkout and MCP tools.
- **Output:** `docs/evidence/brd-07-*.png`.
- **Acceptance:** Checkout (COD) passes; woo-int passes; screenshots stored.
- **Tests:** TC-BRD-07-1: `scripts/e2e-checkout.sh` → COD checkout PASS. TC-BRD-07-2: `scripts/woo-int.sh` → all PASS.
- **Command:** `scripts/e2e-checkout.sh && scripts/woo-int.sh`
- **Evidence:** —
- **Regression risk:** —

---

## Phase 10 — Security testing: attack and harden
Exit criterion: every scan and manual test in `docs/SECURITY_TESTING.md` has run, every finding in `docs/SECURITY_FINDINGS.md` is fixed (with a regression test) or explicitly accepted, and `docs/SECURITY_REPORT.md` is written. Added 2026-10-12 at the user's request. Starts after E2E-14 (Day 6–7) and continues after submission. **Scope: only our own targets** — the local k3d hosts (`*.127.0.0.1.nip.io`, the cluster) and later our own VPS. Third-party services we only connect to (GitHub remote MCP, Groq, OpenRouter) are out of scope.

### SEC-01 — Rules of engagement and findings workflow
- **Priority:** P1
- **Status:** Not Started
- **Day:** 6
- **Depends on:** E2E-14
- **Requirements:** —
- **Description:** Fix scope, targets, test accounts (users A and B and a throwaway admin only), allowed times, severity scale (Critical/High/Medium/Low/Info), and the loop: find → `docs/SECURITY_FINDINGS.md` row → fix → retest → regression test → close.
- **Output:** `docs/SECURITY_TESTING.md` (rules + tool list), `docs/SECURITY_FINDINGS.md`.
- **Acceptance:** Both docs exist; every later SEC task logs into the findings table.
- **Tests:** TC-SEC-01-1: findings table parses (one row per finding, all columns filled).
- **Command:** —
- **Evidence:** —
- **Regression risk:** —

### SEC-02 — Web scanners against the storefront
- **Priority:** P1
- **Status:** Not Started
- **Day:** 6
- **Depends on:** SEC-01
- **Requirements:** —
- **Description:** WPScan (core, themes, plugins, user enumeration), nuclei and nikto (misconfiguration, exposed `xmlrpc.php`, `readme.html`, `wp-json/wp/v2/users`, directory listing, debug output). All tools run as pinned Docker images.
- **Output:** Reports under `docs/evidence/sec-02/`; findings logged.
- **Acceptance:** No open High/Critical; user enumeration and `xmlrpc.php` disabled or justified.
- **Tests:** TC-SEC-02-1: WPScan → no vulnerable components. TC-SEC-02-2: `GET /wp-json/wp/v2/users` anonymously → no user list.
- **Command:** `scripts/sec/wp-scan.sh`
- **Evidence:** —
- **Regression risk:** Disabling REST user endpoints must not break WooCommerce REST used by woo-mcp.

### SEC-03 — OWASP ZAP scans
- **Priority:** P1
- **Status:** Not Started
- **Day:** 6
- **Depends on:** SEC-01
- **Requirements:** —
- **Description:** ZAP baseline (passive) on the store and dashboard; authenticated ZAP API scan of `/api` (OpenAPI or recorded requests) as a member and as an admin.
- **Output:** HTML reports under `docs/evidence/sec-03/`; findings logged.
- **Acceptance:** No open High; Medium items fixed or accepted with a reason.
- **Tests:** TC-SEC-03-1: baseline → 0 FAIL. TC-SEC-03-2: API scan → no 5xx with stack traces, no reflected input.
- **Command:** `scripts/sec/zap.sh`
- **Evidence:** —
- **Regression risk:** Active scans create junk data; run against a throwaway install.

### SEC-04 — Manual auth and business-logic tests
- **Priority:** P1
- **Status:** Not Started
- **Day:** 6
- **Depends on:** SEC-01, REL-07
- **Requirements:** REQ-AUTH-01, REQ-AUTH-04
- **Description:** Member calls every admin `/api` route; revoked and malformed keys on `/mcp`; key prefix enumeration and timing; IDOR on keys, members and audit rows; CSRF and session handling (fixation, logout, cookie reuse); login brute force and lockout/rate limit; invite token reuse; checkout price/quantity/coupon tampering via Store API.
- **Output:** Test scripts under `tests/security/`; findings logged.
- **Acceptance:** Every case rejected server-side and recorded in the audit log where applicable.
- **Tests:** TC-SEC-04-1 … one per case above, automated where possible.
- **Command:** `npm test -w tests/security`
- **Evidence:** —
- **Regression risk:** Rate limits must not break the E2E suite (exempt or raise for test keys).

### SEC-05 — MCP and AI-specific tests
- **Priority:** P1
- **Status:** Not Started
- **Day:** 6
- **Depends on:** SEC-01, REL-08
- **Requirements:** —
- **Description:** Register a deliberately hostile in-cluster test upstream: prompt injection in tool descriptions and results, huge and slow responses, tool names that try to spoof another server's `slug__tool`. SSRF via upstream URL (metadata IP, cluster services, redirects, DNS rebinding). Try to make the chat agent reveal upstream credentials or other users' data, or call tools as another user.
- **Output:** Hostile test upstream (test-only chart toggle); findings logged; THREAT_MODEL updated.
- **Acceptance:** No credential or cross-user leak; hostile upstream cannot break listing or other upstreams; SSRF targets rejected.
- **Tests:** TC-SEC-05-1 injection; TC-SEC-05-2 oversize/slow; TC-SEC-05-3 name spoof; TC-SEC-05-4 SSRF set (incl. TC-SEC-01); TC-SEC-05-5 chat credential exfiltration attempt.
- **Command:** `npm test -w services/gateway -- security`
- **Evidence:** —
- **Regression risk:** The hostile upstream must be disabled by default in every values file.

### SEC-06 — Container and Kubernetes scans
- **Priority:** P1
- **Status:** Not Started
- **Day:** 6
- **Depends on:** SEC-01, REL-09
- **Requirements:** REQ-K8S-09
- **Description:** Trivy CVE scan of every image we build or pin; kubescape config scan of the rendered chart; a rogue pod in each namespace tries to reach woo-mcp, MariaDB, Postgres and the gateway's internal ports (NetworkPolicy escape); check service-account tokens are not mounted; gitleaks on the full git history.
- **Output:** Reports under `docs/evidence/sec-06/`; findings logged.
- **Acceptance:** No fixable Critical CVEs; NetworkPolicy blocks all unintended paths; gitleaks clean.
- **Tests:** TC-SEC-06-1 trivy; TC-SEC-06-2 kubescape; TC-SEC-06-3 rogue-pod matrix (incl. TC-SEC-02); TC-SEC-06-4 gitleaks (TC-SEC-04).
- **Command:** `scripts/sec/k8s-scan.sh`
- **Evidence:** —
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
- **Evidence:** —
- **Regression risk:** A strict CSP can break WordPress admin and block checkout scripts.

### SEC-08 — Attacker-LLM loop
- **Priority:** P1
- **Status:** Not Started
- **Day:** 7
- **Depends on:** SEC-02, SEC-03, SEC-04, SEC-05, SEC-06
- **Requirements:** —
- **Description:** A second LLM session acts as attacker, using `docs/RED_TEAM_BRIEF.md` (scope, targets, user-B key only, goals, report format). Work in rounds: the attacker reports findings, this session fixes each one with a regression test, and the attacker retests. The attacker never gets admin credentials, upstream secrets or cluster access beyond what a member has.
- **Output:** `docs/RED_TEAM_BRIEF.md`; one findings-table row per issue; round log in `docs/SECURITY_FINDINGS.md`.
- **Acceptance:** At least 2 rounds; the last round finds no new High/Critical.
- **Tests:** Regression tests added per finding (TC-SEC-08-n).
- **Command:** —
- **Evidence:** —
- **Regression risk:** Fixes under time pressure; every fix reruns the E2E suite.

### SEC-09 — Hardening sign-off and security report
- **Priority:** P1
- **Status:** Not Started
- **Day:** 7
- **Depends on:** SEC-08
- **Requirements:** REQ-DEL-07, REQ-DEL-08
- **Description:** Close or formally accept every finding; update THREAT_MODEL; write the report used for the video's "Security posture" section.
- **Output:** `docs/SECURITY_REPORT.md` (what was tried, found, fixed, residual risk).
- **Acceptance:** Findings table has no open item without an owner and reason.
- **Tests:** TC-SEC-09-1: full E2E + security suites green after all fixes.
- **Command:** `scripts/e2e.sh && npm test -w tests/security`
- **Evidence:** —
- **Regression risk:** —

---

## Bonus and stand-out backlog (P3, only after E2E-14 is Done)
- **BON-01** Per-role tool permissions (members read-only on orders; admins can create products or change status). Hidden from the list and rejected on call.
- **BON-02** TLS on the VPS (REL-04 if time allows).
- **BON-03** Prometheus metrics (calls, errors, latency per upstream).
- **BON-04** Multiple gateway replicas + per-key rate limits.
- **BON-05** Many-tools handling (search_tools / call_tool meta-tools).
- **BON-06** Multi-store provisioning (namespaced stores, auto-registration, quotas, teardown).
- **BON-07** OAuth on the gateway (MCP authorization spec).
