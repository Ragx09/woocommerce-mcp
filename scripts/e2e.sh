#!/usr/bin/env bash
# End-to-end acceptance checks against a running cluster, one mode per DoD area (E2E-14).
#   chat     TC-E2E-03 + TC-E2E-04 (UI-19): the chat creates a product with the real LLM, it is on the storefront,
#            a guest orders it, and the chat lists today's orders including that one (scripts/chat-flow.mjs).
#            Creates one product and one order. Two LLM questions (about one minute of the Groq free tier).
#   url|users|tools|orders|cross|disable|killpod|revoke|audit
#            Phase 7 checks as user A (admin) and user B (member, own key) — scripts/e2e-acceptance.mjs.
#   oauth    BON-08: OAuth login for /mcp (SDK client flow, consent as user B, audit source=oauth, revoke → 401).
#   stores   BON-15: two stores of different niches created from the API (provisioner killed mid-create), access rules,
#            orders in each, the chat compares them against each MariaDB, one store deleted → nothing left
#            (scripts/e2e-stores.mjs; about 8 minutes, creates and deletes two stores; not part of `all`).
#   hosted   BON-10: add everything-mcp by image through /api/hosted (allowed registry only), it runs hardened in its own
#            namespace, tools work through /mcp for the right people, delete leaves nothing (scripts/e2e-hosted.mjs).
#   all      every mode above except stores and hosted (chat first), then a PASS/FAIL summary. Manual items: docs/DEMO_RUNBOOK.md.
# Usage: scripts/e2e.sh <mode>     Env: GITHUB_REPO=owner/repo enables `cross` (creates a GitHub issue).
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  chat) node scripts/chat-flow.mjs ;;
  oauth) node scripts/e2e-oauth.mjs ;;
  stores) node scripts/e2e-stores.mjs ;;
  hosted) node scripts/e2e-hosted.mjs ;;
  url|users|tools|orders|cross|disable|killpod|revoke|audit) node scripts/e2e-acceptance.mjs "$1" ;;
  all)
    rc=0
    node scripts/chat-flow.mjs || rc=1
    node scripts/e2e-acceptance.mjs all || rc=1
    node scripts/e2e-oauth.mjs || rc=1
    echo; [ $rc = 0 ] && echo "PASS  scripts/e2e.sh all (chat flow + acceptance)" || echo "FAIL  scripts/e2e.sh all"
    exit $rc ;;
  *) echo "usage: $0 chat|oauth|stores|hosted|url|users|tools|orders|cross|disable|killpod|revoke|audit|all" >&2; exit 2 ;;
esac
