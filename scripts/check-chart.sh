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
  else
    echo "FAIL  helm template ($env)"; rc=1
  fi
  rm -f "$out"
done
echo "== values diff (local vs prod: only domain/TLS/registry/pull policy/storage/resources may differ)"
unexpected="$(diff <(helm template platform "$CHART" -f "$CHART/values-local.yaml" --set global.domain=example.test) \
                   <(helm template platform "$CHART" -f "$CHART/values-prod.yaml" --set global.domain=example.test) \
  | grep -E '^[<>]' | grep -vE 'image:|imagePullPolicy|storage:|memory:|cpu:|https?://|cert-manager|annotations:|tls:|hosts:|secretName' || true)"
if [ -z "$unexpected" ]; then echo "PASS  only expected keys differ"; else echo "$unexpected" | sed 's/^/FAIL  unexpected diff: /'; rc=1; fi
exit $rc
