# Security report (SEC-09)

What was tried against the system, what was found and fixed, what is accepted, and what is still unproven. Findings live in [SECURITY_FINDINGS.md](SECURITY_FINDINGS.md) (40 rows: 30 fixed, 7 accepted with a reason, 3 false positives, **0 open**); rules and tools in [SECURITY_TESTING.md](SECURITY_TESTING.md); the threat model in [../THREAT_MODEL.md](../THREAT_MODEL.md). This report is the source for the video's "Security posture" section (topic 4 of the demo requirements).

**Honest status in one paragraph.** Everything that can be attacked from outside the cluster or analysed statically has been attacked or analysed, and every finding is closed or accepted. The core platform, the dashboard, the gateway, the storefront and the container images were tested on a real k3d cluster (SEC-01..08). The newer surface — multi-store provisioning, hosted MCP servers, the admin password reset — was attacked with a live suite against the real gateway and dashboard code with a stand-in provisioner, plus static analysis; its **cluster-level proof (network isolation probes, RBAC matrix for hosted namespaces, the hosted-server pod hardening) is written but has not been run**, and TLS on a VPS is not testable yet. Those are listed under "Not yet proven".

## 1. What was tried
| Area | How | Result |
|---|---|---|
| WordPress / storefront (SEC-02) | WPScan, nuclei, nikto, curl matrix on the live store | 8 findings (user enumeration through REST, author archives, feeds, oEmbed and login messages; XML-RPC; banners; missing security headers; cookies without SameSite; Apache logging a WooCommerce key): all fixed except one accepted Info item (Traefik's own 400 for a malformed request line) |
| Web app and API scanning (SEC-03) | OWASP ZAP baseline on store and dashboard; authenticated API scan of the gateway on a throwaway install | CSRF-token heuristics on WooCommerce forms and the store CSP without `script-src` accepted (WordPress/WooCommerce emit inline scripts); one "SQL injection" alert on login was a false positive (the rate limiter, not the database, changed the answer) |
| Auth and business logic (SEC-04) | 55 live tests: every admin route as member and anonymous, IDOR on keys/users/audit, CSRF and origin, session fixation and expiry, brute-force limits, invite reuse, checkout tampering | Per-replica login counters (10 guesses instead of 5 with two replicas) fixed by moving limits to Postgres; cookie-carrying mutations without a browser header refused |
| MCP and AI-specific (SEC-05) | A deliberately hostile upstream (36 checks): prompt injection through tool output, spoofed tool names, huge/slow/broken/redirecting servers, 21 SSRF URLs, credential exfiltration through the chat | Unbounded tool lists (3000 tools) capped at 128; prompt-leak backstop; everything else held |
| Containers and Kubernetes (SEC-06) | Trivy on every image, kubescape (99.67), a 49-probe rogue-pod NetworkPolicy matrix, Pod Security admission | Node images from 1 critical + 13 high CVEs to 0/0 (npm removed from runtime images, patched dependencies); egress default-deny added; CPU limits and token-less ServiceAccounts everywhere; the WordPress image rebuild pinned by digest |
| Headers, cookies, TLS (SEC-07) | `scripts/sec/headers.sh` (15 checks) | Store and gateway had no security headers, cookies no SameSite: fixed. **testssl and HSTS on a real domain are blocked on the VPS** |
| Attacker-LLM (SEC-08) | A separate LLM session with only a member API key, against the live cluster | Round 1: members were offered all 46 GitHub tools including destructive writes (High, fixed: read-only default policy for members) and member server lists leaked internal error strings (Low, fixed). The loop was relaxed to one round by decision A-12 |
| Multi-store, hosted servers, admin extras (this report) | `tests/security/stores.test.mjs` (TC-SEC-11, 18 tests) against the real gateway with a stand-in provisioner: authorization matrix, IDOR, CSRF/origin, 16 injection payloads in 3 fields, mass assignment, one-time secrets under a 10-way race, about 30 hosted-image/env/path attacks, forged internal calls, cap race, store tool access | One real bug found (F-API-2: hosted `path` with dot segments); the rest held. Mutation-checked: removing the owner scoping makes 3 tests fail |
| OAuth authorization server (this report) | `tests/security/oauth.test.mjs` (TC-SEC-12, 13 tests) against the real gateway: hostile redirect URIs and client metadata, open-redirect and look-alike URI probes, PKCE downgrade (none/plain/short), implicit and scope escalation, parameter pollution, consent without session / with a foreign origin / replayed, code replay, wrong verifier / redirect / client / resource, refresh rotation and replay, OAuth tokens on `/api`, revocation, discovery documents, a uniform 401 | Everything held. Mutation-checked: accepting any redirect URI makes 9 of the 13 fail |
| Static analysis (this report) | `scripts/sec/static.sh`: npm audit, gitleaks (history and tree), semgrep (7 rule packs), hadolint, kube-linter on all three charts, kubeconform schema validation (50/50 valid) | Two classes of real findings: **F-CRY-1** (AES-GCM decrypt accepted truncated authentication tags — a correct 4-byte prefix of a real tag opened the blob; fixed in the gateway and both provisioner openers) and five dependency advisories (fastify, vite, fast-uri, ip-address fixed; esbuild in a dev-only tool accepted). Evidence: `docs/evidence/sec-static-2026-10-25.txt` |

## 2. Findings by severity
| Severity | Fixed | Accepted | False positive |
|---|---|---|---|
| High | 3 | 0 | 0 |
| Medium | 10 | 2 | 0 |
| Low | 15 | 2 | 0 |
| Info | 2 | 3 | 3 |

High: F-INF-1 (images with critical/high CVEs), F-INF-6 (WordPress images), F-MCP-6 (members offered destructive GitHub tools) — all fixed with regression tests. Accepted Medium: F-WEB-12 (anti-CSRF-token heuristics on WooCommerce forms — they carry nonces), F-WEB-13 (store CSP without `script-src`). Accepted Low: F-MCP-3 (the shared GitHub credential's owner identity is visible to members: by design, one credential per server), F-INF-5 (gosu CVEs in the database images: the binary never runs because the containers start unprivileged). Accepted Info: F-WEB-14 (Traefik's own 400 for a malformed request line), F-DEP-3 (esbuild in a dev-only tool), F-INF-9 (build-stage/test-only Dockerfile lint notes). The findings checker had silently ignored 11 rows because the table was split by a blank line; the table is now one block and `scripts/sec/findings-check.mjs --signoff` counts all 40.

## 3. What held (the answers for the video)
- **API keys and credentials.** API keys are shown once and stored as SHA-256 hashes; upstream credentials are AES-256-GCM encrypted at rest (now with an enforced 16-byte tag), write-only in the API, never forwarded to clients, and never in logs or responses (an automated sweep drives every route at debug log level looking for them). Hosted servers' secret variables and an admin's new wp-admin password are sealed with keys derived from the provisioner key and exist in plaintext only in a Kubernetes Secret and for the single moment they are shown.
- **What a member can and cannot do.** Authorization is decided on the server for every route (a default-deny router refuses to start if a route does not declare who may call it). Members get read-only tools by default, hidden from `tools/list` and refused on `tools/call` for API keys, OAuth tokens and the chat alike; they cannot see other people's stores (404, indistinguishable from an unknown id), cannot manage servers, users or keys of others, and cannot reach admin-only detail even for stores they own.
- **A malicious or compromised MCP server.** Adding a server runs the SSRF guard on save and on every connection (private, loopback, link-local and metadata ranges, DNS-rebinding safe, redirects refused); responses are size-capped, tool lists are capped, names are namespaced and validated, and tool output reaches the model as data with a prompt-leak backstop. A hosted image runs non-root with a read-only filesystem, no Kubernetes token, a quota, default-deny networking with the gateway as its only caller, and is registered without any credential and without member access.
- **The one component with cluster rights.** Only the provisioner has a Kubernetes account; admission policy limits it to labelled `store-*` and `hosted-*` namespaces and to binding two ClusterRoles; its database role can read only the columns it needs; everything it reports to the gateway is HMAC-signed, time-limited and idempotent; the gateway pod mounts no token at all.

## 4. Residual risk and accepted items
1. A hosted image can still do the one thing it is allowed to do: answer MCP calls. Its results are treated as untrusted data (T-24/T-25) but a model may still be misled by hostile text; the prompt backstop reduces, not removes, that.
2. The "share with" box lets the owner of a store test whether an email belongs to an active teammate (T-31). Acceptable in a team tool; a per-user rate limit would be the next step.
3. The store CSP has no `script-src` and the WooCommerce forms rely on nonces rather than extra tokens (F-WEB-12/13).
4. Dependencies younger than two weeks were taken for security patches (D-024): fastify 5.12.7, fast-uri 3.1.9/4.2.3, ip-address 10.7.5.
5. esbuild in the drizzle-kit migration generator has a dev-server advisory (F-DEP-3); it never runs as a server and is in no image.
6. One attacker-LLM round (decision A-12) and no external penetration test; no bug bounty; the LLM provider's free tier is a rate limit, not a control.
7. The default store keeps its original wp-admin credentials from the Secret created by `make-secrets.sh`; rotation is by changing that Secret.

## 5. Not yet proven (needs a cluster or a VPS)
| Item | Needs | Command |
|---|---|---|
| Cross-store and hosted-pod network isolation, quota and Pod Security in created namespaces | k3d | `scripts/k8s-checks.sh stores` and `hosted` |
| RBAC and admission policy for `hosted-*` namespaces | k3d | `scripts/k8s-checks.sh rbac` |
| Live security suite on the real cluster (store tools through `/mcp` for owner/shared/other, real provisioner) | k3d, about 10 minutes | `npm test -w tests/security -- stores` |
| The three environment-dependent checks of `authz.test.mjs` (they need the real woo and GitHub upstreams) and the rest of the earlier suites after the fastify/vite upgrade | k3d | `npm test -w tests/security` |
| Full acceptance run after all fixes (TC-SEC-09-1) | k3d | `scripts/e2e.sh all && scripts/e2e.sh stores && scripts/e2e.sh hosted` |
| Image CVE scan of the rebuilt gateway/provisioner/dashboard images | Docker | `scripts/sec/k8s-scan.sh trivy` |
| TLS grade, HSTS, `Secure` cookies on a real domain | VPS | testssl.sh (SEC-07) |

## 6. How to re-run
```
scripts/sec/static.sh                      # dependency, secret, code, Dockerfile and chart checks (no cluster)
node scripts/sec/findings-check.mjs --signoff   # the findings table: every row closed or accepted with a reason
npm test -w tests/security                 # live suites against a cluster; SEC_* variables allow a hand-started gateway (see tests/security/lib.mjs)
scripts/k8s-checks.sh all && scripts/k8s-checks.sh rbac && scripts/k8s-checks.sh stores && scripts/k8s-checks.sh hosted
```
