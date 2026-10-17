#!/usr/bin/env bash
# End-to-end acceptance checks against a running cluster, one mode per DoD area (E2E-14 adds the rest and `all`).
#   chat   TC-E2E-03 + TC-E2E-04 (UI-19): the chat creates a product with the real LLM, it is on the storefront,
#          a guest orders it, and the chat lists today's orders including that one (scripts/chat-flow.mjs).
#          Creates one product and one order. Uses two LLM questions (about one minute of the Groq free tier).
# Usage: scripts/e2e.sh chat
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  chat) node scripts/chat-flow.mjs ;;
  *) echo "usage: $0 chat" >&2; exit 2 ;;
esac
