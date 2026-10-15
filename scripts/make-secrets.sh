#!/usr/bin/env bash
# Creates the Kubernetes Secrets the chart references (INF-06). Idempotent: an existing Secret is
# never overwritten (use --rotate <namespace>/<name> to replace one). Values are random or come from
# .env, are passed to kubectl via a file descriptor (not argv), and are never printed.
# Usage: scripts/make-secrets.sh [--context <kube-context>] [--rotate ns/name]
set -euo pipefail
cd "$(dirname "$0")/.."

CTX=() ROTATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --context) CTX=(--context "$2"); shift 2 ;;
    --rotate) ROTATE="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
k() { kubectl "${CTX[@]}" "$@"; }
rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }
hex() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$1"; }

RELEASE=platform RELEASE_NS=default STORE_NS=store PLATFORM_NS=platform

# Namespaces are owned by the Helm release; pre-create them with Helm's ownership metadata so
# `helm install` adopts them instead of failing.
for ns in "$STORE_NS" "$PLATFORM_NS"; do
  if ! k get namespace "$ns" >/dev/null 2>&1; then
    k create namespace "$ns" >/dev/null
    k label namespace "$ns" app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
    k annotate namespace "$ns" meta.helm.sh/release-name="$RELEASE" meta.helm.sh/release-namespace="$RELEASE_NS" --overwrite >/dev/null
    echo "namespace $ns created"
  fi
done

# secret <ns> <name> <<'EOF' key=value lines EOF
secret() {
  local ns="$1" name="$2" data; data="$(cat)"
  if [ "$ROTATE" = "$ns/$name" ]; then k -n "$ns" delete secret "$name" >/dev/null; echo "secret $ns/$name: rotating"; fi
  if k -n "$ns" get secret "$name" >/dev/null 2>&1; then echo "secret $ns/$name: exists (kept)"; return; fi
  k -n "$ns" create secret generic "$name" --from-env-file=<(printf '%s\n' "$data") >/dev/null
  k -n "$ns" label secret "$name" app.kubernetes.io/part-of=platform >/dev/null
  echo "secret $ns/$name: created"
}

secret "$STORE_NS" mariadb-secrets <<EOF
mariadb-password=$(rand 32)
mariadb-root-password=$(rand 32)
EOF
secret "$STORE_NS" wordpress-admin <<EOF
admin-user=admin
admin-password=$(rand 24)
admin-email=admin@example.invalid
EOF
secret "$STORE_NS" woo-api <<EOF
consumer-key=ck_$(hex 40)
consumer-secret=cs_$(hex 40)
EOF

# woo-mcp ↔ gateway token: the same value in both namespaces (the gateway injects it upstream).
if k -n "$STORE_NS" get secret woo-mcp-auth >/dev/null 2>&1 && [ "$ROTATE" != "$STORE_NS/woo-mcp-auth" ]; then
  WOO_MCP_TOKEN="$(k -n "$STORE_NS" get secret woo-mcp-auth -o jsonpath='{.data.token}' | base64 -d)"
else
  WOO_MCP_TOKEN="$(rand 48)"
fi
secret "$STORE_NS" woo-mcp-auth <<EOF
token=$WOO_MCP_TOKEN
EOF
[ "$ROTATE" = "$STORE_NS/woo-mcp-auth" ] && ROTATE="$PLATFORM_NS/upstream-seed"

secret "$PLATFORM_NS" postgres-secrets <<EOF
password=$(rand 32)
EOF
# Encrypts upstream credentials in the gateway DB. Rotating it makes stored credentials unreadable.
secret "$PLATFORM_NS" gateway-secrets <<EOF
credentials-key=$(hex 64)
EOF

# First dashboard admin (AUTH-02): seeded only while the gateway DB has no admin; never overwritten.
secret "$PLATFORM_NS" gateway-admin <<EOF
admin-email=${GATEWAY_ADMIN_EMAIL:-admin@example.invalid}
admin-password=$(rand 24)
EOF

# Gateway secrets (used from Phase 4 on). Upstream credentials seeded into the gateway DB.
[ -f .env ] && set -a && . ./.env && set +a
secret "$PLATFORM_NS" upstream-seed <<EOF
woo-token=$WOO_MCP_TOKEN
github-pat=${GITHUB_MCP_PAT:-}
EOF
unset WOO_MCP_TOKEN

# Chat agent LLM key (UI-13, REQ-CHAT-04). Only created when .env has one; the gateway runs without it
# (chat disabled). To change it later: edit .env, then --rotate platform/llm-secrets.
if [ -n "${LLM_API_KEY:-}" ]; then
  secret "$PLATFORM_NS" llm-secrets <<EOF
api-key=$LLM_API_KEY
EOF
else
  echo "secret $PLATFORM_NS/llm-secrets: skipped (LLM_API_KEY not set in .env; chat disabled)"
fi

echo "done. Read a value without printing it elsewhere, e.g.:"
echo "  kubectl -n $STORE_NS get secret wordpress-admin -o jsonpath='{.data.admin-password}' | base64 -d"
echo "  kubectl -n $PLATFORM_NS get secret gateway-admin -o jsonpath='{.data.admin-password}' | base64 -d"
