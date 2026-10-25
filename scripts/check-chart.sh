#!/usr/bin/env bash
# INF-13: lint + render both environments + schema validation + policy checks. Run before every chart commit.
set -euo pipefail
cd "$(dirname "$0")/.."
CHART=charts/platform
K8S_VERSION=1.35.0   # schema version matching k3s v1.35
rc=0
for env in local prod; do
  echo "== $env"
  helm lint "$CHART" -f "$CHART/values-$env.yaml" --quiet >/dev/null && echo "PASS  helm lint ($env)" || { echo "FAIL  helm lint ($env)"; rc=1; }
  out="$(mktemp)"
  if helm template platform "$CHART" -f "$CHART/values-$env.yaml" --set global.domain=example.test >"$out"; then
    if kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" - <"$out" | tail -1; then :; else rc=1; fi
    [ "${PIPESTATUS[0]}" = 0 ] || rc=1
    python3 scripts/lib/chart-policy.py <"$out" || rc=1
    # SEC-05: the hostile test upstream is never part of a normal install.
    if grep -q 'name: hostile-mcp' "$out"; then echo "FAIL  hostile-mcp rendered by values-$env.yaml"; rc=1; else echo "PASS  no hostile-mcp ($env)"; fi
  else
    echo "FAIL  helm template ($env)"; rc=1
  fi
  rm -f "$out"
done
echo "== hostile-mcp enabled (SEC-05 test run only): same policies"
out="$(mktemp)"
helm template platform "$CHART" -f "$CHART/values-local.yaml" --set hostileMcp.enabled=true >"$out" \
  && python3 scripts/lib/chart-policy.py <"$out" && grep -q 'hostile-mcp.platform.svc.cluster.local' "$out" \
  && echo "PASS  hostile-mcp render (policy, SSRF allowlist)" || { echo "FAIL  hostile-mcp render"; rc=1; }
rm -f "$out"
echo "== charts/hosted (BON-10): lint + render (with and without egress) + same policies"
for egress in false true; do
  out="$(mktemp)"
  helm template hosted-demo charts/hosted -n hosted-demo --set slug=demo --set image=ghcr.io/acme/demo-mcp:1.0.0 --set port=3000 --set env.MODE=demo --set allowEgress=$egress >"$out" \
    && python3 scripts/lib/chart-policy.py <"$out" \
    && [ "$(grep -c 'name: server-egress' "$out")" = "$([ "$egress" = true ] && echo 1 || echo 0)" ] \
    && grep -q 'name: default-deny' "$out" && grep -q 'name: server-from-gateway' "$out" \
    && echo "PASS  hosted render (policy, default-deny, gateway-only ingress, egress=$egress)" || { echo "FAIL  hosted render (egress=$egress)"; rc=1; }
  rm -f "$out"
done
helm lint charts/hosted --quiet --set slug=demo --set image=ghcr.io/acme/demo-mcp:1.0.0 --set port=3000 >/dev/null && echo "PASS  helm lint (hosted)" || { echo "FAIL  helm lint (hosted)"; rc=1; }
! helm template x charts/hosted --set slug=demo --set image=a/b:1 >/dev/null 2>&1 && echo "PASS  hosted chart refuses a missing port" || { echo "FAIL  hosted chart accepted a missing port"; rc=1; }
echo "== values diff (local vs prod: only domain/TLS (incl. the Secure cookie flag)/registry/pull policy/storage/resources may differ)"
unexpected="$(diff <(helm template platform "$CHART" -f "$CHART/values-local.yaml" --set global.domain=example.test) \
                   <(helm template platform "$CHART" -f "$CHART/values-prod.yaml" --set global.domain=example.test) \
  | grep -E '^[<>]' | grep -vE 'image:|imagePullPolicy|storage:|memory:|cpu:|https?://|cert-manager|annotations:|tls:|hosts:|secretName|COOKIE_SECURE|STORE_SCHEME' || true)"
if [ -z "$unexpected" ]; then echo "PASS  only expected keys differ"; else echo "$unexpected" | sed 's/^/FAIL  unexpected diff: /'; rc=1; fi
exit $rc
