#!/usr/bin/env bash
# SEC-06: container and Kubernetes scans (pinned Docker images, nothing installed on the host).
#   trivy      — CVEs in every image the chart runs: ours (tags from .images.env) and the pinned third-party ones
#   kubescape  — NSA + MITRE frameworks on the rendered chart (local and prod values)
#   tokens     — no pod in store/platform has a service-account token mounted
#   logs       — no credential pattern in any store/platform pod log (F-WEB-11)
#   rogue      — NetworkPolicy escape matrix (scripts/k8s-checks.sh netpol + rogue)
#   gitleaks   — secrets in the full git history and the committable files (scripts/secret-scan.sh)
# Reports: docs/evidence/sec-06/. Exit 1 on a fixable CRITICAL CVE or a failed check.
# Usage: scripts/sec/k8s-scan.sh [all|trivy|kubescape|tokens|rogue|logs|gitleaks]
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=docs/evidence/sec-06; mkdir -p "$OUT"
TRIVY=aquasec/trivy:0.58.1 KUBESCAPE=quay.io/kubescape/kubescape-cli:v3.0.40
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }

images() {
  [ -f .images.env ] && . ./.images.env
  echo "gateway:${gateway_tag:-dev} woo-mcp:${woo_mcp_tag:-dev} everything-mcp:${everything_mcp_tag:-dev} dashboard:${dashboard_tag:-dev} store-assets:${store_assets_tag:-dev}"
  helm template platform charts/platform -f charts/platform/values-local.yaml 2>/dev/null \
    | awk '/^ +image: /{print $2}' | grep -E '[:/]' | grep -vE '^(gateway|woo-mcp|everything-mcp|dashboard|store-assets|hostile-mcp):' | sort -u | tr '\n' ' '
}

trivy() {
  local img summary=() crit high
  : >"$OUT/trivy.txt"
  for img in $(images); do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache "$TRIVY" image -q \
      --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --format json "$img" >"$OUT/trivy-${img//[:\/@]/_}.json" 2>/dev/null
    # F-INF-5 (Accepted): gosu in the mariadb/postgres images (Go stdlib CVEs). It only runs when a container
    # starts as root to drop to the database user; ours start as uid 999/70, so it never executes.
    read -r crit high acc < <(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); let c=0,h=0,a=0;
      for (const x of r.Results??[]) for (const v of x.Vulnerabilities??[]) { if (x.Target==="usr/local/bin/gosu") { a++; continue } v.Severity==="CRITICAL"?c++:h++ } console.log(c,h,a)' "$OUT/trivy-${img//[:\/@]/_}.json")
    printf '%-34s fixable CRITICAL %3s  HIGH %3s  accepted (gosu, F-INF-5) %3s\n' "${img%@*}" "$crit" "$high" "$acc" | tee -a "$OUT/trivy.txt"
    [ "$crit" = 0 ] && pass "TC-SEC-06-1 ${img%@*}: no fixable CRITICAL" || fail "TC-SEC-06-1 ${img%@*}: $crit fixable CRITICAL"
    rm -f "$OUT/trivy-${img//[:\/@]/_}.json"   # the table above is the evidence
  done
}

kubescape() {
  local env
  for env in local prod; do
    helm template platform charts/platform -f "charts/platform/values-$env.yaml" --set global.domain=example.test >"$OUT/rendered-$env.yaml"
    # The container cannot write to the mount (non-root): the JSON report comes on stdout, logs on stderr.
    docker run --rm -v "$PWD/$OUT:/scan:ro" "$KUBESCAPE" scan framework nsa,mitre "/scan/rendered-$env.yaml" \
      --format json >"$OUT/kubescape-$env.json" 2>/dev/null
    rm -f "$OUT/rendered-$env.yaml"
    node scripts/sec/kubescape-summary.mjs "$OUT/kubescape-$env.json" | tee "$OUT/kubescape-$env.txt"
    rm -f "$OUT/kubescape-$env.json"   # 100 kB of rendered objects; the summary is the evidence
    grep -q '^FAIL' "$OUT/kubescape-$env.txt" && fail "TC-SEC-06-2 kubescape ($env): untriaged failed controls" || pass "TC-SEC-06-2 kubescape ($env)"
  done
}

tokens() {
  local bad
  bad=$( { kubectl get pods -n store -o json; kubectl get pods -n platform -o json; } | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const docs=s.split(/\n(?=\{)/).map(JSON.parse); const bad=[];
      for (const p of docs.flatMap(d=>d.items)) { const vols=(p.spec.volumes??[]).filter(v=>v.projected?.sources?.some(x=>x.serviceAccountToken)||/^kube-api-access/.test(v.name));
        if (p.spec.automountServiceAccountToken!==false || vols.length) bad.push(p.metadata.namespace+"/"+p.metadata.name) } console.log(bad.join(" ")) })')
  [ -z "$bad" ] && pass "TC-SEC-06-5 no service-account token mounted in any store/platform pod" || fail "TC-SEC-06-5 token mounted: $bad"
}

rogue() {
  local out; out=$(scripts/k8s-checks.sh netpol; scripts/k8s-checks.sh rogue)
  echo "$out" | tee "$OUT/rogue.txt" | grep -E '^(FAIL|failures)'
  local n; n=$(grep -c '^FAIL' <<<"$out")
  [ "$n" = 0 ] && pass "TC-SEC-06-3 NetworkPolicy matrix ($(grep -c '^PASS' <<<"$out") probes)" || fail "TC-SEC-06-3 $n probe(s) failed"
}

# F-WEB-11 / T-11: no credential in any pod's logs (WooCommerce keys, gateway keys and tokens, GitHub, LLM keys).
logs() {
  local pod hits=() re='ck_[0-9a-f]{20,}|cs_[0-9a-f]{20,}|mgw_[A-Za-z0-9]{20,}|itk_[A-Za-z0-9._-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gsk_[A-Za-z0-9]{20,}|sk-or-[A-Za-z0-9-]{20,}'
  for ns in store platform; do
    for pod in $(kubectl -n "$ns" get pods -o jsonpath='{.items[*].metadata.name}'); do
      kubectl -n "$ns" logs "$pod" --all-containers --tail=-1 2>/dev/null | grep -qE "$re" && hits+=("$ns/$pod")
    done
  done
  [ ${#hits[@]} = 0 ] && pass "TC-SEC-06-6 no credential pattern in any store/platform pod log" || fail "TC-SEC-06-6 credential pattern in logs of: ${hits[*]}"
}

gitleaks() {
  scripts/secret-scan.sh >"$OUT/gitleaks.txt" 2>&1 && pass "TC-SEC-06-4 gitleaks (history + committable files)" || fail "TC-SEC-06-4 gitleaks: see $OUT/gitleaks.txt"
  tail -1 "$OUT/gitleaks.txt"
}

case "${1:-all}" in
  trivy|kubescape|tokens|rogue|logs|gitleaks) "$1" ;;
  all) trivy; kubescape; tokens; rogue; logs; gitleaks ;;
  *) echo "usage: $0 all|trivy|kubescape|tokens|rogue|logs|gitleaks"; exit 2 ;;
esac
echo "failures: $fails"
exit $(( fails > 0 ))
