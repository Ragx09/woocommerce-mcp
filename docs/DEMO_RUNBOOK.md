# Demo Runbook

> Status: **Phase 7 verified on k3d 2026-10-18** (`scripts/e2e.sh all` PASS); rehearsed in REL-15. Every step lists the action and the expected result. Never put real passwords or keys in this file. Use `$USER_A_KEY` etc. from your shell.

## 0. Setup before recording
- [ ] Cluster up, all pods Ready (`kubectl get pods -A`)
- [ ] Users: **A** (admin), **B** (member): `node scripts/seed-demo-users.mjs --key` → B's key printed once (`export USER_B_KEY=…`)
- [ ] Throwaway GitHub repo for the cross-server issue
- [ ] Windows: dashboard, storefront and wp-admin tabs open; terminal with Claude Code

## 1. System design (slides or ARCHITECTURE.md diagram)
## 2. Store — REQ-DOD-01/02
1. Storefront → add a product → checkout with COD → order received page. **Expect:** order number shown.
2. wp-admin → WooCommerce → Orders. **Expect:** the order is listed.
## 3. Chat as user A — REQ-DOD-03/04
1. Log in as A → Chat → "Create a product called Demo Mug priced 499". **Expect:** tool card `woo__create_product` ok; product link. (Paise work too, e.g. "priced 12.50" → ₹12.50 on the storefront and in the order, SPEC A-09.) Scripted: `scripts/e2e.sh chat`.
2. Storefront → the product is visible → order it with COD.
3. Chat → "What orders came in today?" **Expect:** `woo__list_orders` → includes the new order.
## 4. External client as user B — REQ-DOD-05/06/07
1. `claude mcp add --transport http mcp-gateway http://app.127.0.0.1.nip.io/mcp --header "Authorization: Bearer $USER_B_KEY"` (or a `--mcp-config` file, README)
2. `/mcp` in Claude Code → tools from woo, everything and github.
3. "What orders came in today in the store?" **Expect:** same orders.
4. "Summarize today's orders and open a GitHub issue in <throwaway repo>." **Expect:** issue URL. Without the repo (read-only, verified 2026-10-18): "Get today's store orders, then search open GitHub issues in woocommerce/woocommerce that mention 'cash on delivery' and tell me whether any could affect today's orders." **Expect:** `woo__list_orders` + `github__search_issues`, both in the audit under B.
## 5. Team and control — REQ-DOD-08..11
1. Admin revokes B's key → B retries → **Expect:** 401 / tool error.
2. Disable `everything` → chat tool list and Inspector list both lack `everything__*`.
3. `kubectl -n platform delete pod -l app=everything-mcp` (or scale to 0) → dashboard Unreachable; woo tools still work.
4. Audit page → every call above, attributed to A or B.

Scripted version of 2–5 (except Claude Code itself): `scripts/e2e.sh all`.
## 6. Kubernetes tour
`kubectl get ns,pods,svc,ingress,pvc,secrets,networkpolicy -A`; show probes and limits (`kubectl describe`), the NetworkPolicy deny test.
## 7. MCP internals, security, chat loop, local→VPS (talk track; see ARCHITECTURE, MCP_DESIGN, THREAT_MODEL, DEPLOYMENT)
