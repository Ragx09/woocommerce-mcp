# Security findings

One row per finding (SEC-01 workflow, see [`SECURITY_TESTING.md`](SECURITY_TESTING.md)). Status: `Open` · `Fixed` · `Accepted` (reason required) · `False positive`.

| ID | Found by | Severity | Component | Description | Fix commit | Regression test | Status |
|---|---|---|---|---|---|---|---|
| F-INF-1 | SEC-06 agent | High | Images (gateway, woo-mcp, everything-mcp, dashboard) | Outdated deps/base: each Node image has 1 critical + 13 high CVEs (tar CVE-2026-59873, ip-address SSRF CVE-2026-69192, undici, brace-expansion, http-cache-semantics; alpine openssl one patch behind); dashboard 5 high OS CVEs. | — | — | Open |
| F-WEB-1 | SEC-02 (main) | Medium | WordPress REST | `/wp-json/wp/v2/users` discloses usernames+slugs (`admin`, `mcp-service`) to anonymous users. | — | — | Open |
| F-WEB-2 | SEC-02 (main) | Medium | WordPress | `xmlrpc.php` enabled; `system.multicall` (brute-force amplification) and pingback reachable. | — | — | Open |
| F-MCP-1 | SEC-05 agent | Medium | Chat agent (`/api/chat`) | Stored prompt injection via product name/description can make the chat reveal its system prompt + tool schemas when the user turn asks it to obey embedded instructions. Attacker-cooperative (neutral summarize did NOT leak; direct "show system prompt" refused). No credential/tool-call leak. | — | — | Open |
| F-INF-2 | SEC-06 agent | Medium | NetworkPolicy (egress) | No egress default-deny: WordPress/PHP, mariadb, postgres, gateway can reach the public internet (C2/exfil path). woo-mcp/everything-mcp/dashboard already capped. | — | — | Open |
| F-WEB-3 | SEC-02 (main) | Low | WordPress | `?author=1` → 301 `/author/admin/` confirms the admin login slug (same root cause as F-WEB-1). | — | — | Open |
| F-WEB-4 | SEC-02 (main) | Low | WordPress/Apache | Version/banner disclosure: `readme.html`, `license.txt`, `Server: Apache/2.4.68`, `X-Powered-By: PHP/8.3.35`. | — | — | Open |
| F-AUTH-1 | SEC-04 (main) | Low | Gateway API | State-changing POST accepted with no `Origin` header; SameSite=Strict already blocks real CSRF, so defense-in-depth only. | — | — | Open |
| F-MCP-2 | SEC-05 agent | Low | everything-mcp `get-env` | Leaks cluster recon (Service IP 10.43.0.1, pod name) to a member. No credentials. | — | — | Open |
| F-MCP-3 | SEC-05 agent | Low | github upstream | `github__get_me` returns the shared-credential owner's GitHub identity+email to member B (PAT not exposed). | — | — | Open |
| F-MCP-4 | SEC-05 agent | Low | Gateway SSRF defense | SSRF protection for forwarded tool args relies on the upstream's own allowlist, not a gateway egress policy (overlaps F-INF-2). | — | — | Open |
| F-INF-3 | SEC-06 agent | Low | All workloads | No CPU limits (memory limits present) — a busy pod can starve neighbours. | — | — | Open |
| F-INF-4 | SEC-06 agent | Info | ServiceAccount | Default SA token automount not disabled at the SA object level (pods override it, so not currently exploitable). | — | — | Open |

## Attacker-LLM rounds (SEC-08)
| Round | Date | Findings | New High/Critical | Notes |
|---|---|---|---|---|
