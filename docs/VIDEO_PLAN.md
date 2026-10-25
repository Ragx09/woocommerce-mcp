# Demo video plan (REL-16, BON-16)

Target length 15–18 minutes (the six required topics ≈ 11 min, stand-out items ≈ 6 min). Record against the real system, two users: **A** (admin) and **B** (member). Rehearse the whole thing once first (REL-15); every step below has its expected result in [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md) and most are also a script, so a failed take can be re-checked in one command.

Never show a key, password or `.env` on screen: use `$USER_B_KEY` from the shell, copy values with the dashboard's copy buttons, blur the wp-admin password after it is shown once.

## Before recording (checklist)
- [ ] Cluster up, all pods Ready (`kubectl get pods -A`); gateway at 2 replicas; images rebuilt from the commit being shown (`scripts/up.sh`)
- [ ] `scripts/e2e.sh all` green (chat flow, A/B users, revoke, disable, kill pod, audit, OAuth); `scripts/k8s-checks.sh all` and `rbac` 0 failures
- [ ] For the stand-out part: `scripts/e2e.sh stores` and `scripts/e2e.sh hosted` green once, then the stores/servers deleted so the demo starts clean
- [ ] Users A and B exist (`node scripts/seed-demo-users.mjs --key`); throwaway repo `Ragx09/mcp-issue-write-test` for the cross-server issue
- [ ] Tabs: dashboard (A), dashboard (B, private window), storefront, wp-admin, terminal with Claude Code, `kubectl` terminal; LLM key present (Groq free tier ≈ two chat questions a minute: pause between questions)

## Part 1 — required topics
| # | Topic (problem statement) | Show | Runbook | ≈ min |
|---|---|---|---|---|
| 1 | System design and implementation | ARCHITECTURE diagram and [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) table (what runs where, who talks to whom); then the definition-of-done flow live with two users: order in the store (COD) → A in the chat creates a product and lists today's orders → B in Claude Code with an own key lists tools and asks the same → admin revokes B's key (401) → disable a server (tools vanish) → kill a pod (dashboard Unreachable, other servers fine) → Audit log shows every call under A or B | §1–§5 | 5 |
| 2 | Kubernetes | `kubectl get ns,pods,svc,ingress,pvc,secrets,networkpolicy -A`; `describe` of the gateway (requests/limits, probes, non-root, read-only, no token); what is public (Traefik → `app.` and `store.` hosts) vs internal (woo-mcp, postgres, everything-mcp: ClusterIP + NetworkPolicy); live deny test with a probe pod (`scripts/k8s-checks.sh netpol`) | §6 | 2 |
| 3 | MCP internals | A tool call's path: client → `/mcp` (auth, rate limit, authorization) → route by `<slug>__<tool>` → upstream credential injected → woo-mcp → WooCommerce REST (OAuth 1.0a) → result; collision policy (`slug__tool`, hashed over 64 chars), timeouts (3 s list / 15 s call), dead upstream (health loop, skipped in `tools/list`, calls fail in ms) | MCP_DESIGN §1–§6 | 2 |
| 4 | Security posture | Keys stored as SHA-256 hashes, upstream credentials AES-256-GCM and write-only; what B can and cannot do (read-only tools, hidden and refused); an admin adds a malicious server → SSRF guard refuses internal URLs, hostile responses are capped and treated as data (`docs/SECURITY_FINDINGS.md`); the attacker-LLM loop and findings table | THREAT_MODEL, §5 | 2 |
| 5 | Chat agent | The loop (LLM → `tools/call` through the gateway's own `/mcp` with the user's identity token → result → LLM), tool cards in the UI, B's chat has only B's tools, audit shows `source=chat`; `find_tools` for many tools | MCP_DESIGN §10 | 1 |
| 6 | Local → VPS | `scripts/check-chart.sh` "only expected keys differ" (domain, TLS, registry, storage, resources); ingress/domains/storage/secrets strategy; `helm upgrade` then `helm rollback` with data intact ([DEPLOYMENT.md](DEPLOYMENT.md) §6); VPS status stated honestly | DEPLOYMENT | 2 |

## Part 2 — stand-out items and the bonus
| Item | Show | Runbook | ≈ min |
|---|---|---|---|
| 2 Tool permissions | Servers → Edit → Member access; B's tool list before/after; calling a hidden tool directly → `tool_forbidden`; the same through the chat | §5, README | 1 |
| 3 OAuth | `claude mcp add --transport http mcp-oauth <url>` with no key → browser sign-in and consent → tools listed; revoke the grant in Dashboard → next call 401 | §4.5 | 1 |
| 7, 8 Scaling and observability | 2 gateway replicas (`kubectl get pods`), delete one pod while calls run; Servers page last-hour calls / failed % / p95; `/metrics` series (port-forward) | `k8s-checks.sh replicas`, `metrics` | 1 |
| 5 Hosted servers | Servers → Add by image (everything-mcp from the allowed registry) → Ready → tools callable by A, hidden from B until allowed; `kubectl -n hosted-<slug> get pod,networkpolicy,quota`; disallowed registry and `:latest` refused; delete leaves nothing | §9 | 1.5 |
| Bonus multi-store | Create two stores of different niches at once (one click each), watch Ready; order in each; chat compares today's orders (counts match each DB); share one with B (read-only); isolation probes; delete one → tools and namespace gone; kill the provisioner mid-create → still completes | §8 | 2.5 |
| 6 Security hardening (summary) | RBAC matrix (`k8s-checks.sh rbac`), admission policy refusing a bad namespace, rogue-pod matrix, Trivy results | THREAT_MODEL, SECURITY_FINDINGS | (inside part 1 topic 4) |

## Topic checklist (tick when recorded)
- [ ] 1 System design + DoD flow live with two users
- [ ] 2 Kubernetes (namespaces, Secrets, volumes, Ingress, requests/limits, probes, public vs internal and how it is enforced)
- [ ] 3 MCP internals (call path, collisions, timeouts, dead upstream)
- [ ] 4 Security posture (key/credential storage, member limits, malicious server)
- [ ] 5 Chat agent (tool loop, acts as the logged-in user)
- [ ] 6 Local-to-VPS story (values, ingress/domains/storage/secrets, upgrade and rollback)
- [ ] Stand-out: permissions · OAuth · scaling/metrics · hosted servers · multi-store (each shown once, with where to find the code)
