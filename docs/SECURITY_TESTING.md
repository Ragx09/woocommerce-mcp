# Security testing — rules of engagement and toolkit

Phase 10 in `TASKS.md` (SEC-01…SEC-09). Goal: attack our own system the way a real attacker would, then fix what breaks. Findings go in [`SECURITY_FINDINGS.md`](SECURITY_FINDINGS.md); the final write-up is `SECURITY_REPORT.md` (SEC-09).

## Scope
| In scope (our own) | Out of scope |
|---|---|
| `store.127.0.0.1.nip.io`, `app.127.0.0.1.nip.io` (local k3d) | GitHub remote MCP, Groq, OpenRouter, nip.io DNS, any third-party host |
| The k3d cluster: namespaces `store`, `platform` | Docker Desktop / Windows host |
| Our own VPS once it exists (same hosts on its domain) | Anything not owned by the project |
| The git repo (history scan) | |

- Test accounts only: user A (admin), user B (member), throwaway admins created for testing. No real customer data exists.
- Destructive / active scans (ZAP active, brute force) run against a **throwaway install** (`scripts/down.sh && scripts/up.sh` afterwards), never the demo data you plan to record.
- The hostile test upstream (SEC-05) is disabled by default in every values file.

## Severity
| Level | Meaning | Rule |
|---|---|---|
| Critical | Credential leak, auth bypass, cross-user action, RCE | Fix before anything else |
| High | Privilege escalation, SSRF to internal services, stored XSS | Fix before submission |
| Medium | Missing hardening with a plausible exploit path | Fix or accept with reason |
| Low / Info | Defence in depth, banner leaks | Fix if cheap |

## Workflow
find → row in `SECURITY_FINDINGS.md` → fix (smallest change) → retest the exact attack → add a regression test → rerun E2E → close.

## Toolkit (run as pinned Docker images, nothing installed on the host)
| Area | Tool (pinned) | Command | Task |
|---|---|---|---|
| Findings table format | `scripts/sec/findings-check.mjs` (`--signoff`: no Open rows) | `node scripts/sec/findings-check.mjs` | SEC-01, SEC-09 |
| WordPress components, users, plugins | WPScan `wpscanteam/wpscan:v3.8.28` (no API token: versions only, no vulnerability DB) | `scripts/sec/wp-scan.sh wpscan` | SEC-02 |
| Known misconfig / exposures / CVEs | nuclei `projectdiscovery/nuclei:v3.4.10` + templates `v10.5.0` (git tag, Docker volume), no interactsh (`-ni`) | `scripts/sec/wp-scan.sh nuclei` | SEC-02 |
| Classic web server checks | nikto 2.5.0 built from its tag (`scripts/sec/nikto.Dockerfile`, `perl:5.40.2-slim`) | `scripts/sec/wp-scan.sh nikto` | SEC-02 |
| Exact exposures from findings | curl | `scripts/sec/wp-scan.sh curl` | SEC-02 |
| Web app passive + API scanning | OWASP ZAP `zaproxy/zap-stable:2.16.1` (baseline, API scan) | `scripts/sec/zap.sh` | SEC-03 |
| Auth, IDOR, CSRF, sessions, brute force, invites, checkout tampering | vitest workspace `tests/security` (live, against k3d or the VPS) | `npm test -w tests/security` | SEC-04 |
| MCP-specific (prompt injection, name spoofing, huge/slow/broken upstreams, SSRF, credential exfiltration via chat) | test-only upstream `services/hostile-mcp` (chart `hostileMcp.enabled`, false in every values file) | `scripts/sec/hostile.sh` | SEC-05 |
| Image CVEs (ours + third-party) | Trivy `aquasec/trivy:0.58.1` (`--ignore-unfixed`, HIGH/CRITICAL) | `scripts/sec/k8s-scan.sh trivy` | SEC-06 |
| K8s config | kubescape `quay.io/kubescape/kubescape-cli:v3.0.40` (NSA + MITRE) + triage list in `scripts/sec/kubescape-summary.mjs` | `scripts/sec/k8s-scan.sh kubescape` | SEC-06 |
| NetworkPolicy escape | `busybox:1.36` probe pods (`scripts/k8s-checks.sh netpol` + `rogue`) | `scripts/sec/k8s-scan.sh rogue` | SEC-06 |
| Service-account tokens | kubectl | `scripts/sec/k8s-scan.sh tokens` | SEC-06 |
| Secrets in git history | gitleaks `zricethezav/gitleaks:v8.28.0` | `scripts/sec/k8s-scan.sh gitleaks` | SEC-06 |
| Headers, cookies | curl | `scripts/sec/headers.sh` | SEC-07 |
| TLS (VPS only) | testssl.sh | — (VPS) | SEC-07 |
| Creative attacks | second LLM session, [`RED_TEAM_BRIEF.md`](RED_TEAM_BRIEF.md) | — | SEC-08 |

Reports and outputs go to `docs/evidence/sec-0N/`. Large raw reports (kubescape JSON, Trivy JSON) are reduced to a summary table there.

## Test accounts used by the suites
- User A: the seeded admin (Secret `platform/gateway-admin`), used to set up and to read the audit log.
- User B: the demo member (Secret `platform/demo-users`), the attacker in SEC-04/05/08.
- Throwaway members `sec-<random>@example.invalid`, created through the invite flow by `tests/security/session.test.mjs` and left **disabled** afterwards.
- Brute force uses e-mail addresses that do not exist (`nobody-<random>@example.invalid`), so no real account is locked; the per-IP limit is never driven to the end (it would lock this machine's own logins for 15 minutes).
- The checkout tampering test places one COD order with tampered fields and cancels it again through the gateway.
