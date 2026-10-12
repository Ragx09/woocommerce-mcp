# Test Plan

Each test has an ID (`TC-<area>-<n>` for suites, `TC-<taskID>-<n>` inside TASKS.md). A test counts as passed only when it was **executed** and its output was recorded as evidence in `TASKS.md`. Requirement mapping: `docs/REQUIREMENTS_TRACEABILITY.md`.

## Tooling
| Layer | Tool | Command (planned) |
|---|---|---|
| Unit | vitest | `npm test -w services/gateway`, `npm test -w services/woo-mcp` |
| Integration | vitest + real services in k3d (port-forward) or in-process fake MCP servers | `npm run test:int -w services/gateway` |
| MCP protocol | MCP SDK client scripts; MCP Inspector CLI | `npx @modelcontextprotocol/inspector --cli <url> --method tools/list` |
| Helm / K8s | `helm lint`, `helm template \| kubeconform`, `kubectl wait`, kubectl checks | `scripts/check-chart.sh`, `scripts/k8s-checks.sh` |
| E2E acceptance | bash + node scripts using two real API keys | `scripts/e2e.sh` |
| Manual | Runbook steps (storefront checkout, Claude Code client) | `docs/DEMO_RUNBOOK.md` |

## Suites

### Unit (what a failure would reveal)
- **TC-UNIT-01** Tool-name namespacing and parsing (collisions, `__` in upstream names, 64-character limit) → routing ambiguity. REQ-GW-04
- **TC-UNIT-02** API key generation, hashing and verification → keys stored in plaintext or wrong comparison. REQ-AUTH-05
- **TC-UNIT-03** OAuth1 signature matches a known vector → woo-mcp gets 401s from WooCommerce. REQ-MCP-09
- **TC-UNIT-04** SSRF validator blocks private, metadata and loopback addresses and allows the allowlist → gateway could probe internal services. T-06
- **TC-UNIT-05** AES-GCM credential round-trip; tampered ciphertext is rejected. T-03
- **TC-UNIT-06** Log redaction removes secrets. T-10
- **TC-UNIT-07** woo-mcp input validation (zod) rejects bad prices, statuses and IDs. REQ-MCP-03..07

### Integration
- **TC-INT-01** woo-mcp ↔ real WooCommerce: every tool works (create → list → get → update status). REQ-MCP-03..07
- **TC-INT-02** Gateway aggregation over 3 fake upstreams, including two with the same tool name → both exposed, namespaced. REQ-GW-02, 04
- **TC-INT-03** Slow upstream (sleeps past the timeout) → list returns the others within the budget; a call to it returns `upstream_timeout`. REQ-GW-05, 06
- **TC-INT-04** Dead upstream (connection refused) → others are unaffected; status is Unreachable. REQ-GW-05, DOD-10
- **TC-INT-05** Disabled upstream → tools hidden; a call is rejected. DOD-09
- **TC-INT-06** Credential injection: a fake upstream records headers → it receives the stored credential and never the client's key. REQ-GW-07, T-04
- **TC-INT-07** Chat agent with a stubbed LLM issues a tool call → it goes through `/mcp`, and the audit row has the user and `source=chat`. REQ-CHAT-01, 03

### API / auth
- **TC-AUTH-01** No key / wrong key / revoked key on `/mcp` → 401 + audit `denied`. REQ-AUTH-04, DOD-08
- **TC-AUTH-02** Member calling admin routes → 403 (every admin route). REQ-AUTH-01
- **TC-AUTH-03** Invite flow: token single-use and expiring. REQ-AUTH-02
- **TC-AUTH-04** No upstream credential in any `/api` response (scan the JSON). REQ-GW-07
- **TC-AUTH-05** Audit row fields complete for ok, error, timeout and denied outcomes. REQ-AUTH-06

### Security
- **TC-SEC-01** SSRF: admin adds `http://169.254.169.254/` and `http://postgres.platform.svc:5432` → rejected. T-06
- **TC-SEC-02** NetworkPolicy: a curl pod in `default` → `woo-mcp.store.svc` times out; the gateway pod → OK. REQ-MCP-08
- **TC-SEC-03** No woo-mcp Ingress exists; external `curl` to the store host at `/mcp` → 404. REQ-MCP-08
- **TC-SEC-04** Secret scan of the repo (gitleaks or grep patterns) → no findings. REQ-K8S-09
- **TC-SEC-05** Browser bundle grep for secret values and env names → none. REQ-CHAT-04
- **Phase 10 suites** (attack and harden, `docs/SECURITY_TESTING.md`): TC-SEC-02-n web scanners (WPScan, nuclei, nikto) · TC-SEC-03-n OWASP ZAP · TC-SEC-04-n manual auth / business logic (`tests/security/`) · TC-SEC-05-n MCP/AI-specific (hostile upstream, SSRF, prompt injection) · TC-SEC-06-n Trivy, kubescape, rogue-pod NetworkPolicy matrix, gitleaks · TC-SEC-07-n headers, cookies, TLS · TC-SEC-08-n one regression test per attacker-LLM finding.

### Storefront brand (Phase 9)
- TC-BRD-01-1 … TC-BRD-07-2 (see `TASKS.md`): contrast, layout vs mockup, idempotent catalogue seeding, fresh-cluster reproducibility, checkout + woo-int regression.

### Kubernetes / deployment
- **TC-K8S-01** `helm lint` + kubeconform pass for local and prod values. REQ-K8S-03
- **TC-K8S-02** Every container has readiness and liveness probes and requests and limits (jq check over `helm template`). REQ-K8S-07, 08
- **TC-K8S-03** `helm install` then `helm upgrade` with no changes → no restarts; `helm rollback` works. REL-11
- **TC-K8S-04** Ingress hosts respond: storefront 200, dashboard 200, `/mcp` 401 without a key. REQ-K8S-06

### Persistence / recovery
- **TC-PER-01** Create a product, delete the wordpress + mariadb pods → the product still exists. REQ-K8S-05
- **TC-PER-02** Delete the postgres pod → users, keys and audit rows survive.
- **TC-PER-03** Delete the gateway pod → health statuses recover and external clients reconnect.

### End-to-end acceptance (`scripts/e2e.sh`, one check per DoD item)
TC-E2E-01 … TC-E2E-12 ↔ REQ-DOD-01 … REQ-DOD-12. Storefront checkout (DOD-01) and the Claude Code client session (DOD-05..07) also have manual runbook steps for the video.

### External MCP clients
- **TC-EXT-01** MCP Inspector CLI `tools/list` with user B's key → tools from 3 servers.
- **TC-EXT-02** Claude Code `claude mcp add --transport http gw <url> --header "Authorization: Bearer …"` → `/mcp` shows connected; the orders prompt works.
- **TC-EXT-03** Cursor `mcp.json` (optional, if Cursor is available).

### VPS
- **TC-VPS-01** Same chart + `values-prod.yaml` installs on k3s; TC-K8S-04 passes against the public hosts.
- **TC-VPS-02** E2E subset (DOD-03..11) against the VPS URL.
