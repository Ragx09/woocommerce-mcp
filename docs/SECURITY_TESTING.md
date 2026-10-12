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
| Area | Tool | Task |
|---|---|---|
| WordPress components, users, plugins | WPScan | SEC-02 |
| Known misconfig / exposures | nuclei, nikto | SEC-02 |
| Web app passive + API scanning | OWASP ZAP (baseline, API scan) | SEC-03 |
| Auth, IDOR, CSRF, rate limits, checkout tampering | curl / vitest scripts in `tests/security/` | SEC-04 |
| MCP-specific (prompt injection, name spoofing, SSRF, credential exfiltration) | hostile test upstream + SDK client scripts | SEC-05 |
| Image CVEs | Trivy | SEC-06 |
| K8s config | kubescape | SEC-06 |
| NetworkPolicy escape | rogue `curlimages/curl` pod per namespace | SEC-06 |
| Secrets in git history | gitleaks | SEC-06 |
| Headers, cookies | curl header checks | SEC-07 |
| TLS (VPS only) | testssl.sh | SEC-07 |
| Creative attacks | second LLM session, [`RED_TEAM_BRIEF.md`](RED_TEAM_BRIEF.md) | SEC-08 |

Exact image tags and commands are filled in when each task starts (pin a version, record it here).
