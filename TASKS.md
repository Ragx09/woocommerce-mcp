# TASKS — Implementation Roadmap

Source of truth for progress. Rules: see `CLAUDE.md`. **Never set Status to Done without Evidence.** Statuses: `Not Started` · `In Progress` · `Blocked` · `Done`. Priorities: P0 mandatory/blocker · P1 correctness/security/resilience · P2 usability/ops · P3 optional.

Field format (parsed by `tracker/build.mjs`; keep it): `### ID — Title` followed by `- **Field:** value` bullets. Test cases are written `TC-<ID>-<n>: precondition → action → expected`.

## Schedule
| Day | Date | Focus | Exit gate |
|---|---|---|---|
| 1 | 2026-10-11 | Phase 0 + Phase 1: docs, tracker, tooling, 3 experiments | Experiments pass, plan agreed |
| 2 | 2026-10-12 | Phase 2 infra + Phase 3 store & woo-mcp + gateway passthrough | Vertical slice: Inspector → gateway → woo-mcp → WooCommerce |
| 3 | 2026-10-13 | Phase 4 gateway: aggregation, 3 upstreams, timeouts, health | GW exit criterion |
| 4 | 2026-10-14 | Phase 5 auth, keys, audit (+ VPS provisioning if available) | Revocation + audit tests pass |
| 5 | 2026-10-15 | Phase 6 dashboard + chat agent | Chat creates a product end-to-end |
| 6 | 2026-10-16 | Phase 7 E2E + Phase 8 VPS deploy + security fixes | All DoD checks pass locally (+ VPS) |
| 7 | 2026-10-17 | Phase 8: docs, regression, rehearsal, video, submission | Submitted |

Cut order if behind: UI polish → TLS → bonus → depth of docs. Mandatory items are never cut.

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
- **Status:** In Progress
- **Day:** 1
- **Depends on:** P0-01
- **Requirements:** REQ-CHAT-01, REQ-CHAT-04, REQ-GW-08
- **Description:** User creates a Groq API key (+ optional OpenRouter key) and a fine-grained GitHub PAT (one throwaway repo, Issues read/write). Stored only in the gitignored `.env`.
- **Output:** `.env` with keys (never printed or committed).
- **Acceptance:** `.env` exists, ignored; a smoke request to Groq chat completions with a tool definition returns a `tool_calls` response.
- **Tests:** TC-P0-04-1: key present → `scripts/llm-smoke.mjs` → response contains tool_calls.
- **Command:** `node scripts/llm-smoke.mjs groq` (or `openrouter`)
- **Evidence:** 2026-10-11: `.env` present, gitignored, mode 600; format check (no values printed): `LLM_API_KEY` set (gsk_ prefix), `OPENROUTER_API_KEY` empty (optional), `GITHUB_MCP_PAT` empty. TC-P0-04-1 PASS — `node scripts/llm-smoke.mjs groq` → HTTP 200 in 652 ms, `finish_reason=tool_calls`, `woo__list_orders {"after":"2026-10-11T00:00:00Z","status":"processing"}`. Groq `/models` lists `openai/gpt-oss-120b` (also gpt-oss-20b, qwen3.8-27b); free tier limit 1000 requests/day. Remaining: GitHub PAT (needed by ARC-15); OpenRouter key optional.
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
- **Status:** Not Started
- **Day:** 1
- **Depends on:** P0-01
- **Requirements:** REQ-MCP-02, REQ-GW-12, REQ-DOD-05
- **Description:** A tiny `experiments/mcp-hello` server (SDK v1, stateless, requires `Authorization: Bearer test`) with one tool. Connect from MCP Inspector CLI and Claude Code (`claude mcp add --transport http`). Also connect via the SDK client (gateway side).
- **Output:** Result + exact SDK version recorded in D-002.
- **Acceptance:** All three clients list and call the tool; a request without the bearer → 401.
- **Tests:** TC-ARC-13-1: server running → Inspector CLI `tools/list` → 1 tool. TC-ARC-13-2: Claude Code connected → call tool → result. TC-ARC-13-3: no header → 401.
- **Command:** `npx @modelcontextprotocol/inspector --cli http://localhost:3999/mcp --transport http --header "Authorization: Bearer test" --method tools/list`
- **Evidence:** —
- **Regression risk:** If it fails, revisit D-002 (SDK v2 or a sessionful transport).

### ARC-14 — Experiment: WooCommerce REST with OAuth1 from Node
- **Priority:** P0
- **Status:** Not Started
- **Day:** 1
- **Depends on:** P0-01
- **Requirements:** REQ-MCP-09, REQ-STORE-01
- **Description:** `docker compose` with official wordpress + mariadb + wpcli: install WP + WooCommerce non-interactively, create a REST key via WP-CLI, then call `GET /wp-json/wc/v3/products` over plain HTTP with an OAuth1 signature from Node.
- **Output:** Working init commands (reused for the wp-init Job) + signer snippet; D-003 updated.
- **Acceptance:** 200 with JSON products; a bad signature → 401.
- **Tests:** TC-ARC-14-1: store up → signed GET → 200. TC-ARC-14-2: tampered secret → 401.
- **Command:** `node experiments/woo-auth/smoke.mjs`
- **Evidence:** —
- **Regression risk:** If OAuth1 fails, fall back to an HTTPS-terminated internal call or the `HTTPS` server var override.

### ARC-15 — Experiment: additional upstreams reachable
- **Priority:** P0
- **Status:** Not Started
- **Day:** 1
- **Depends on:** ARC-13, P0-04
- **Requirements:** REQ-GW-08
- **Description:** Run `server-everything` in Streamable HTTP mode in Docker and connect the SDK client; connect the SDK client to GitHub remote MCP with the PAT bearer; list tools on both.
- **Output:** Confirmed image/command and URL; D-013 updated.
- **Acceptance:** `tools/list` works for both.
- **Tests:** TC-ARC-15-1: everything container → list → tools. TC-ARC-15-2: GitHub with PAT → list → tools; without PAT → 401.
- **Command:** `node experiments/upstreams/list.mjs`
- **Evidence:** —
- **Regression risk:** GitHub unreachable → DeepWiki fallback.

---

## Phase 2 — Kubernetes, Helm and deployment foundation
Exit criterion: a repeatable Helm deployment works on k3d.

### INF-01 — Monorepo layout
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** P0-12
- **Requirements:** REQ-DEL-04
- **Description:** npm workspaces (`services/woo-mcp`, `services/gateway`, `apps/dashboard`), shared tsconfig, eslint, vitest.
- **Output:** Root `package.json` workspaces; `npm run build`/`test` across workspaces.
- **Acceptance:** `npm install && npm run build && npm test` succeed on empty skeletons.
- **Tests:** TC-INF-01-1: fresh clone → install/build/test → exit 0.
- **Command:** `npm ci && npm run build && npm test`
- **Evidence:** —
- **Regression risk:** Low.

### INF-02 — k3d cluster config
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** P0-02
- **Requirements:** REQ-K8S-01
- **Description:** `k3d/cluster.yaml` (1 server, ports 80/443 → loadbalancer, k3s defaults incl. Traefik and the network-policy controller).
- **Output:** `scripts/cluster-up.sh`.
- **Acceptance:** Cluster Ready; Traefik running; `curl http://anything.127.0.0.1.nip.io` → 404 from Traefik.
- **Tests:** TC-INF-02-1: script → `kubectl get pods -n kube-system` shows traefik Running.
- **Command:** `scripts/cluster-up.sh && kubectl -n kube-system get pods`
- **Evidence:** —
- **Regression risk:** Port 80 conflict on Windows host.

### INF-03 — Umbrella Helm chart skeleton
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-01
- **Requirements:** REQ-K8S-03
- **Description:** `charts/platform` with `_helpers.tpl`, common labels, per-component toggles.
- **Output:** Chart that templates cleanly.
- **Acceptance:** `helm lint charts/platform` passes.
- **Tests:** TC-INF-03-1: lint → 0 failures.
- **Command:** `helm lint charts/platform`
- **Evidence:** —
- **Regression risk:** —

### INF-04 — values-local and values-prod
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-02, REQ-K8S-03
- **Description:** Two values files; differences limited to domain, TLS, image registry/pullPolicy and resources.
- **Output:** `charts/platform/values-local.yaml`, `values-prod.yaml`.
- **Acceptance:** `helm template` succeeds for both; diff shows only expected keys.
- **Tests:** TC-INF-04-1: template both → kubeconform valid.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** —
- **Regression risk:** —

### INF-05 — Namespaces
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-04
- **Description:** `store` and `platform` namespaces, created by the chart (or `--create-namespace` + per-resource namespace).
- **Output:** Namespace manifests.
- **Acceptance:** Both namespaces exist after install.
- **Tests:** TC-INF-05-1: `kubectl get ns store platform`.
- **Command:** `kubectl get ns store platform`
- **Evidence:** —
- **Regression risk:** —

### INF-06 — Secrets strategy
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-05
- **Requirements:** REQ-K8S-09, REQ-CHAT-04
- **Description:** `scripts/make-secrets.sh` creates K8s Secrets from `.env` + random generation (DB passwords, CREDENTIALS_KEY, session secret, admin password); the chart references `existingSecret` names and never contains values.
- **Output:** Script + chart references.
- **Acceptance:** `grep -ri password charts/` shows no literal values; secrets exist in the cluster.
- **Tests:** TC-INF-06-1: run script → `kubectl get secret -n platform gateway-secrets`. TC-INF-06-2: secret scan → none.
- **Command:** `scripts/make-secrets.sh && kubectl get secrets -A | grep -E 'gateway|store'`
- **Evidence:** —
- **Regression risk:** Running the script twice must not rotate DB passwords on existing PVCs (idempotent: skip if exists).

### INF-07 — Test workload through Ingress
- **Priority:** P1
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-02, INF-03
- **Requirements:** REQ-K8S-06
- **Description:** Temporary whoami Deployment + Ingress to prove Traefik routing and nip.io.
- **Output:** Removed after verification.
- **Acceptance:** `curl http://whoami.127.0.0.1.nip.io` → 200.
- **Tests:** TC-INF-07-1: curl → 200.
- **Command:** `curl -s -o /dev/null -w '%{http_code}' http://whoami.127.0.0.1.nip.io`
- **Evidence:** —
- **Regression risk:** —

### INF-08 — Requests/limits convention
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-08
- **Description:** Every container takes `resources` from values; helper fails the render if missing.
- **Output:** Helper + defaults.
- **Acceptance:** TC-K8S-02 jq check passes.
- **Tests:** TC-INF-08-1: `helm template | scripts/check-resources.sh` → 0 missing.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** —
- **Regression risk:** —

### INF-09 — Probes convention
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-07
- **Description:** Readiness + liveness on every container (HTTP `/healthz` `/readyz` for our services; TCP or exec for DBs; HTTP for wordpress).
- **Output:** Probe blocks per workload.
- **Acceptance:** TC-K8S-02 passes for probes.
- **Tests:** TC-INF-09-1: check script → 0 containers missing probes.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** —
- **Regression risk:** Liveness too aggressive on WordPress first boot → use startupProbe.

### INF-10 — Services
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-04
- **Description:** ClusterIP Services for every workload.
- **Output:** Service templates.
- **Acceptance:** No NodePort/LoadBalancer except Traefik.
- **Tests:** TC-INF-10-1: `kubectl get svc -A` → types checked.
- **Command:** `kubectl get svc -A`
- **Evidence:** —
- **Regression risk:** —

### INF-11 — Ingress hosts
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-07
- **Requirements:** REQ-K8S-06
- **Description:** Ingress for `store.<domain>` and `app.<domain>` (`/` dashboard, `/api` and `/mcp` gateway); domain from values.
- **Output:** Ingress templates; local domain approach in DEPLOYMENT.md.
- **Acceptance:** TC-K8S-04 passes.
- **Tests:** TC-INF-11-1: curl each host/path → expected code.
- **Command:** `scripts/k8s-checks.sh ingress`
- **Evidence:** —
- **Regression risk:** —

### INF-12 — Persistent volumes
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-03
- **Requirements:** REQ-K8S-05
- **Description:** PVCs for mariadb, wordpress and postgres with storageClass from values.
- **Output:** PVC templates.
- **Acceptance:** PVCs Bound.
- **Tests:** TC-INF-12-1: `kubectl get pvc -A` → Bound.
- **Command:** `kubectl get pvc -A`
- **Evidence:** —
- **Regression risk:** `helm uninstall` must keep PVCs (`helm.sh/resource-policy: keep`).

### INF-13 — Chart validation script
- **Priority:** P1
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-04
- **Requirements:** REQ-K8S-03, REQ-K8S-07, REQ-K8S-08
- **Description:** `scripts/check-chart.sh`: helm lint, template for both values files, kubeconform, probes/resources jq check.
- **Output:** Script, run before every chart commit.
- **Acceptance:** Exit 0 on a good chart; non-zero when a probe is removed (negative test).
- **Tests:** TC-INF-13-1: good → 0. TC-INF-13-2: remove probe → fails.
- **Command:** `scripts/check-chart.sh`
- **Evidence:** —
- **Regression risk:** —

### INF-14 — Install/upgrade idempotency
- **Priority:** P1
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-11, INF-12
- **Requirements:** REQ-K8S-02
- **Description:** `helm upgrade --install` twice with no changes → no pod restarts; data kept.
- **Output:** Evidence in TASKS.
- **Acceptance:** Pod restart counts and ages unchanged.
- **Tests:** TC-INF-14-1: upgrade twice → `kubectl get pods` ages unchanged.
- **Command:** `scripts/deploy.sh local && scripts/deploy.sh local`
- **Evidence:** —
- **Regression risk:** Random values in templates (use `lookup` or external secrets).

### INF-15 — One-command up/down scripts
- **Priority:** P1
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-14
- **Requirements:** REQ-DEL-01
- **Description:** `scripts/up.sh` (cluster, secrets, build+import images, helm install, wait) and `scripts/down.sh`.
- **Output:** Scripts documented in README.
- **Acceptance:** From a clean machine state, `up.sh` reaches all-Ready.
- **Tests:** TC-INF-15-1: down → up → `kubectl wait --for=condition=Ready pods --all -A`.
- **Command:** `scripts/up.sh`
- **Evidence:** —
- **Regression risk:** —

---

## Phase 3 — WooCommerce and custom MCP server
Exit criterion: all required tools work against the real store; woo-mcp is reachable only from the gateway.

### WC-01 — MariaDB StatefulSet
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-06, INF-12
- **Requirements:** REQ-STORE-01, REQ-K8S-05
- **Description:** Official `mariadb:11`, PVC, Secret-sourced passwords, probes (`healthcheck.sh`), resources.
- **Output:** Template in the store component.
- **Acceptance:** Pod Ready; PVC Bound.
- **Tests:** TC-WC-01-1: `kubectl -n store wait --for=condition=Ready pod -l app=mariadb`.
- **Command:** same
- **Evidence:** —
- **Regression risk:** —

### WC-02 — WordPress Deployment
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-01, INF-11
- **Requirements:** REQ-STORE-01, REQ-K8S-05, REQ-K8S-06
- **Description:** Official wordpress image; PVC at `/var/www/html`; `WP_HOME`/`WP_SITEURL` from values; `X-Forwarded-Proto` handling; startup/readiness/liveness probes.
- **Output:** Template.
- **Acceptance:** `http://store.127.0.0.1.nip.io` loads without redirect loops.
- **Tests:** TC-WC-02-1: curl → 200 or a single expected 302.
- **Command:** `curl -sI http://store.127.0.0.1.nip.io`
- **Evidence:** —
- **Regression risk:** siteurl mismatch.

### WC-03 — wp-init Job
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-02, ARC-14
- **Requirements:** REQ-STORE-01, REQ-STORE-02, REQ-GW-10
- **Description:** Idempotent WP-CLI Job (Helm post-install/post-upgrade hook): core install, WooCommerce install and activation, store settings (currency, timezone), COD enabled, 3 sample products, `mcp-service` user + REST key (read_write) stored in Secret `woo-api` (creates only if absent).
- **Output:** Job + script.
- **Acceptance:** Job Completed; re-running is a no-op; Secret `woo-api` exists.
- **Tests:** TC-WC-03-1: install → Job Succeeded. TC-WC-03-2: helm upgrade → Job succeeds without duplicate products or keys.
- **Command:** `kubectl -n store get jobs && kubectl -n store get secret woo-api`
- **Evidence:** —
- **Regression risk:** Non-idempotent init duplicating data.

### WC-04 — Storefront checkout (manual)
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-03
- **Requirements:** REQ-STORE-02, REQ-STORE-03, REQ-DOD-01, REQ-DOD-02
- **Description:** Add to cart → checkout with COD → order visible in wp-admin → Orders.
- **Output:** Screenshot or notes in evidence; runbook steps.
- **Acceptance:** Order exists with status Processing (or On hold).
- **Tests:** TC-WC-04-1: manual runbook step → order present; also `wp wc shop_order list` via kubectl exec.
- **Command:** `kubectl -n store exec deploy/wordpress -- wp wc shop_order list --user=admin --allow-root` (or REST)
- **Evidence:** —
- **Regression risk:** Block-based checkout needs the COD gateway enabled.

### WC-05 — Persistence test
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-04
- **Requirements:** REQ-K8S-05
- **Description:** Delete the wordpress and mariadb pods; the data survives.
- **Output:** Evidence.
- **Acceptance:** Previous order and products still present.
- **Tests:** TC-PER-01.
- **Command:** `kubectl -n store delete pod -l app=mariadb -l app=wordpress && scripts/k8s-checks.sh store-data`
- **Evidence:** —
- **Regression risk:** —

### WC-06 — woo-mcp skeleton
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-01, ARC-13
- **Requirements:** REQ-MCP-01, REQ-MCP-02
- **Description:** TS service, config from env (store URL, key, secret via Secret), pino logging, Dockerfile (non-root, distroless or node-slim).
- **Output:** `services/woo-mcp`.
- **Acceptance:** Builds; container starts.
- **Tests:** TC-WC-06-1: `docker run` → `/healthz` 200.
- **Command:** `npm run build -w services/woo-mcp && docker build -t woo-mcp:dev services/woo-mcp`
- **Evidence:** —
- **Regression risk:** —

### WC-07 — Streamable HTTP endpoint + health
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-06
- **Requirements:** REQ-MCP-02
- **Description:** `POST /mcp` stateless transport; `/healthz` (liveness), `/readyz` (checks WooCommerce reachability).
- **Output:** Endpoint.
- **Acceptance:** Inspector CLI lists tools.
- **Tests:** TC-WC-07-1: Inspector `tools/list` → 5 tools.
- **Command:** `npx @modelcontextprotocol/inspector --cli http://localhost:8080/mcp --transport http --method tools/list`
- **Evidence:** —
- **Regression risk:** —

### WC-08 — Tool: list_products
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-03
- **Description:** Params: search?, per_page (≤50), page. Returns id, name, price, status, stock, permalink.
- **Output:** Tool + unit test.
- **Acceptance:** Returns sample products.
- **Tests:** TC-WC-08-1: store seeded → call → ≥3 products.
- **Command:** `npm test -w services/woo-mcp`
- **Evidence:** —
- **Regression risk:** —

### WC-09 — Tool: create_product
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-04, REQ-DOD-03
- **Description:** Params: name, regular_price (decimal string), description?, status (default publish). Returns id + permalink.
- **Output:** Tool + test.
- **Acceptance:** Product visible on the storefront.
- **Tests:** TC-WC-09-1: call → product id; curl permalink → 200.
- **Command:** `npm run test:int -w services/woo-mcp`
- **Evidence:** —
- **Regression risk:** —

### WC-10 — Tool: list_orders
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-05, REQ-DOD-04
- **Description:** Params: status?, after?/before? (ISO), `date` shortcut `today`, per_page. Returns id, number, status, total, created, customer name, line items summary.
- **Output:** Tool + test.
- **Acceptance:** "today" returns orders created today (store timezone).
- **Tests:** TC-WC-10-1: place order → list today → contains it.
- **Command:** `npm run test:int -w services/woo-mcp`
- **Evidence:** —
- **Regression risk:** Timezone boundaries.

### WC-11 — Tool: get_order
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-06
- **Description:** Param: order_id. Returns full order detail minus sensitive fields (no payment tokens).
- **Output:** Tool + test.
- **Acceptance:** Correct order returned; unknown id → clear error.
- **Tests:** TC-WC-11-1: existing id → detail. TC-WC-11-2: 999999 → isError "order not found".
- **Command:** `npm run test:int -w services/woo-mcp`
- **Evidence:** —
- **Regression risk:** —

### WC-12 — Tool: update_order_status
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-07
- **Requirements:** REQ-MCP-07
- **Description:** Params: order_id, status ∈ {pending, processing, on-hold, completed, cancelled, refunded, failed}.
- **Output:** Tool + test.
- **Acceptance:** Status changes in wp-admin.
- **Tests:** TC-WC-12-1: set completed → get_order shows completed. TC-WC-12-2: invalid status → validation error.
- **Command:** `npm run test:int -w services/woo-mcp`
- **Evidence:** —
- **Regression risk:** —

### WC-13 — Validation and error mapping
- **Priority:** P1
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-08..WC-12
- **Requirements:** REQ-MCP-03..07
- **Description:** zod schemas; WooCommerce errors → `isError: true` with safe messages (no keys, no stack traces).
- **Output:** Shared error helper + unit tests.
- **Acceptance:** TC-UNIT-07 passes.
- **Tests:** TC-UNIT-07.
- **Command:** `npm test -w services/woo-mcp`
- **Evidence:** —
- **Regression risk:** —

### WC-14 — Internal-only exposure (NetworkPolicy)
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-07, INF-10
- **Requirements:** REQ-MCP-08
- **Description:** No Ingress for woo-mcp; NetworkPolicy allows ingress only from pods labelled `app=gateway` in `platform`. Also mariadb ← wordpress/wp-init only.
- **Output:** NetworkPolicy templates.
- **Acceptance:** TC-SEC-02 and TC-SEC-03 pass.
- **Tests:** TC-SEC-02, TC-SEC-03.
- **Command:** `scripts/k8s-checks.sh netpol`
- **Evidence:** —
- **Regression risk:** Breaks the gateway if labels mismatch.

### WC-15 — woo-mcp integration tests against the real store
- **Priority:** P1
- **Status:** Not Started
- **Day:** 2
- **Depends on:** WC-08..WC-12
- **Requirements:** REQ-MCP-03..07
- **Description:** vitest suite using the SDK client via port-forward: create → list → get → update → list today.
- **Output:** `services/woo-mcp/test/int.test.ts`.
- **Acceptance:** All green against k3d.
- **Tests:** TC-INT-01.
- **Command:** `scripts/port-forward.sh woo-mcp & npm run test:int -w services/woo-mcp`
- **Evidence:** —
- **Regression risk:** —

---

## Phase 4 — MCP gateway and multiple upstreams
Exit criterion: one endpoint exposes tools from ≥3 upstreams and handles the required failure cases.

### GW-01 — Gateway skeleton
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** INF-01
- **Requirements:** REQ-DEL-04
- **Description:** Fastify app, config, pino with redaction, `/healthz` `/readyz`, Dockerfile.
- **Output:** `services/gateway`.
- **Acceptance:** Container healthy.
- **Tests:** TC-GW-01-1: `/healthz` → 200.
- **Command:** `npm run build -w services/gateway`
- **Evidence:** —
- **Regression risk:** —

### GW-02 — Postgres + upstream model
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** GW-01, INF-12
- **Requirements:** REQ-GW-01
- **Description:** Postgres StatefulSet; Drizzle schema + migrations (upstreams: id, slug, name, url, enabled, auth_type, auth_header, credential_enc, created_by, timestamps); migrations run on startup with a lock.
- **Output:** Schema + migration.
- **Acceptance:** Migration applies on a fresh DB; re-run is a no-op.
- **Tests:** TC-GW-02-1: start twice → no error.
- **Command:** `npm run db:migrate -w services/gateway`
- **Evidence:** —
- **Regression risk:** Concurrent migrations with replicas → advisory lock.

### GW-03 — Seed WooCommerce upstream
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** GW-02
- **Requirements:** REQ-GW-10
- **Description:** On startup, ensure upstream slug `woo` → `http://woo-mcp.store.svc.cluster.local/mcp` exists (from values); never overwrite admin edits.
- **Output:** Seeder.
- **Acceptance:** Fresh install lists `woo` first.
- **Tests:** TC-GW-03-1: fresh DB → GET /api/upstreams → woo present.
- **Command:** `curl …/api/upstreams`
- **Evidence:** —
- **Regression risk:** —

### GW-04 — Upstream client pool
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** GW-02, ARC-13
- **Requirements:** REQ-GW-02, REQ-GW-03
- **Description:** Per-upstream SDK `Client` + `StreamableHTTPClientTransport` with injected headers; reconnect on failure; rebuilt on config change.
- **Output:** `upstreams/pool.ts`.
- **Acceptance:** Can list tools on `woo`.
- **Tests:** TC-GW-04-1: unit with fake server → connect, list, close.
- **Command:** `npm test -w services/gateway`
- **Evidence:** —
- **Regression risk:** Connection leaks.

### GW-05 — Tool discovery
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** GW-04
- **Requirements:** REQ-GW-02
- **Description:** Per-upstream `listTools` with pagination, cached with a timestamp.
- **Output:** Discovery module.
- **Acceptance:** Cached list served when the upstream is temporarily slow.
- **Tests:** TC-GW-05-1: fake upstream → list cached.
- **Command:** `npm test -w services/gateway`
- **Evidence:** —
- **Regression risk:** —

### GW-06 — Aggregated tools/list at /mcp
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** GW-05, GW-07
- **Requirements:** REQ-GW-02, REQ-GW-12
- **Description:** Gateway MCP server (stateless) implementing `tools/list` over all enabled upstreams. Temporary static dev key until AUTH-08.
- **Output:** `/mcp`.
- **Acceptance:** **Vertical slice milestone**: Inspector → gateway → woo-mcp → WooCommerce returns products.
- **Tests:** TC-GW-06-1: Inspector CLI list via gateway → `woo__list_products` etc.
- **Command:** `npx @modelcontextprotocol/inspector --cli http://app.127.0.0.1.nip.io/mcp --transport http --header "Authorization: Bearer $KEY" --method tools/list`
- **Evidence:** —
- **Regression risk:** —

### GW-07 — Namespacing (collision policy)
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** ARC-06
- **Requirements:** REQ-GW-04
- **Description:** Implement D-005 (`toPublicName`, `parsePublicName`).
- **Output:** `mcp/naming.ts` + tests.
- **Acceptance:** TC-UNIT-01 passes.
- **Tests:** TC-UNIT-01.
- **Command:** `npm test -w services/gateway -- naming`
- **Evidence:** —
- **Regression risk:** —

### GW-08 — Routing tools/call
- **Priority:** P0
- **Status:** Not Started
- **Day:** 2
- **Depends on:** GW-06
- **Requirements:** REQ-GW-03
- **Description:** Parse → lookup → checks (exists, enabled) → forward → return result unchanged (except for error normalization).
- **Output:** Router.
- **Acceptance:** `woo__list_orders` via the gateway returns orders.
- **Tests:** TC-GW-08-1: call through gateway → result. TC-GW-08-2: unknown name → error `unknown_tool`.
- **Command:** Inspector CLI `--method tools/call --tool-name woo__list_orders`
- **Evidence:** —
- **Regression risk:** —

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
- **Evidence:** —
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

## Bonus and stand-out backlog (P3, only after E2E-14 is Done)
- **BON-01** Per-role tool permissions (members read-only on orders; admins can create products or change status). Hidden from the list and rejected on call.
- **BON-02** TLS on the VPS (REL-04 if time allows).
- **BON-03** Prometheus metrics (calls, errors, latency per upstream).
- **BON-04** Multiple gateway replicas + per-key rate limits.
- **BON-05** Many-tools handling (search_tools / call_tool meta-tools).
- **BON-06** Multi-store provisioning (namespaced stores, auto-registration, quotas, teardown).
- **BON-07** OAuth on the gateway (MCP authorization spec).
