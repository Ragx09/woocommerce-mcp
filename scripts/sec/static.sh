#!/usr/bin/env bash
# SEC-09: the static checks that need no cluster, in one command. Each is skipped with a clear line if its tool is missing
# (put the binaries on PATH or in $SEC_TOOLS; versions used: gitleaks 8.28.0, hadolint 2.12.0, kube-linter 0.7.2, semgrep 1.182.1).
#   npm audit (all dependencies) · gitleaks (history + working tree) · semgrep (nodejs, typescript, secrets, dockerfile, kubernetes,
#   owasp-top-ten, javascript) · hadolint on every Dockerfile · kube-linter on the rendered platform, store and hosted charts ·
#   the repo's own chart policy (scripts/check-chart.sh).
# Accepted, with reasons (docs/SECURITY_FINDINGS.md): esbuild <= 0.24.2 in the dev-only drizzle-kit toolchain (F-DEP-3).
# Usage: scripts/sec/static.sh        Exit status 1 when any check reports something that is not accepted.
set -uo pipefail
cd "$(dirname "$0")/../.."
TOOLS="${SEC_TOOLS:-/tmp/claude-0/tools}"; export PATH="$PATH:$TOOLS:$TOOLS/sg/bin"   # system python3 (PyYAML) first, the semgrep venv last
fails=0; skipped=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }
skip() { echo "SKIP  $* (tool missing)"; skipped=$((skipped+1)); }
have() { command -v "$1" >/dev/null 2>&1; }

echo "== npm audit (all workspaces, dev dependencies included)"
out="$(npm audit --json 2>/dev/null)"
python3 - "$out" <<'PY' && pass "npm audit: only the accepted dev-only esbuild advisory" || fail "npm audit reports unaccepted advisories (run: npm audit)"
import json, sys
d = json.loads(sys.argv[1]).get('vulnerabilities', {})
ACCEPTED = {'esbuild', '@esbuild-kit/core-utils', '@esbuild-kit/esm-loader', 'drizzle-kit'}  # F-DEP-3: dev toolchain, never in an image
bad = {k: v['severity'] for k, v in d.items() if k not in ACCEPTED}
print('   unaccepted:', bad or 'none', '| accepted (dev-only):', sorted(k for k in d if k in ACCEPTED))
sys.exit(1 if bad else 0)
PY
echo "== npm audit (production dependencies only: what the images contain)"
npm audit --omit=dev >/dev/null 2>&1 && pass "npm audit --omit=dev: 0 vulnerabilities" || fail "npm audit --omit=dev reports vulnerabilities"

echo "== gitleaks"
if have gitleaks; then
  gitleaks detect --source . --no-banner --redact >/dev/null 2>&1 && pass "gitleaks: no secrets in the history" || fail "gitleaks found something in the history"
  # The tree scan reads ignored files too; the local .env holds the real credentials by design (gitignored, never committed),
  # so it is skipped here only while git ignores it. The history scan above keeps the plain config and would catch a committed .env.
  tree_cfg="$(mktemp /tmp/gitleaks-tree.XXXXXX)"
  printf '[extend]\npath = "%s/.gitleaks.toml"\n' "$PWD" >"$tree_cfg"
  git check-ignore -q .env && printf "[allowlist]\ndescription = \"gitignored local secrets file\"\npaths = ['''^(\\\\./)?\\\\.env\$''']\n" >>"$tree_cfg"
  gitleaks detect --source . --no-git --no-banner --redact --config "$tree_cfg" >/dev/null 2>&1 && pass "gitleaks: no secrets in the working tree (gitignored .env skipped)" || fail "gitleaks found something in the working tree"
  rm -f "$tree_cfg"
else skip gitleaks; fi

echo "== semgrep"
if have semgrep; then
  semgrep --metrics=off --config p/nodejs --config p/typescript --config p/secrets --config p/dockerfile --config p/kubernetes --config p/owasp-top-ten --config p/javascript \
    --quiet --error services apps scripts charts tests >/tmp/semgrep.out 2>&1 && pass "semgrep: 0 findings" || { fail "semgrep findings:"; head -30 /tmp/semgrep.out; }
else skip semgrep; fi

echo "== hadolint"
if have hadolint || have hadolint-Linux-x86_64; then
  H="$(command -v hadolint || command -v hadolint-Linux-x86_64)"; bad=0
  for f in $(git ls-files | grep -E 'Dockerfile'); do "$H" --no-color "$f" >/tmp/hadolint.out 2>&1 || { bad=1; echo "   $f"; head -5 /tmp/hadolint.out; }; done
  [ $bad = 0 ] && pass "hadolint: every Dockerfile clean (ignores carry their reason in the file)" || fail "hadolint findings"
else skip hadolint; fi

echo "== kube-linter (rendered charts)"
if have kube-linter && have helm; then
  tmp="$(mktemp -d)"
  helm template platform charts/platform -f charts/platform/values-local.yaml >"$tmp/platform.yaml" 2>/dev/null
  helm template store-demo charts/store -n store-demo --set labels.store=demo --set host=demo.store >"$tmp/store.yaml" 2>/dev/null
  helm template hosted-demo charts/hosted -n hosted-demo --set slug=demo --set image=ghcr.io/acme/demo:1.0.0 --set port=3000 --set allowEgress=true >"$tmp/hosted.yaml" 2>/dev/null
  for f in platform store hosted; do kube-linter lint "$tmp/$f.yaml" >"$tmp/$f.out" 2>&1 && pass "kube-linter: $f chart clean" || { fail "kube-linter: $f chart"; grep -v '^KubeLinter' "$tmp/$f.out" | cut -c1-220 | head -8; }; done
  rm -rf "$tmp"
else skip kube-linter; fi

echo "== chart policy"
scripts/check-chart.sh >/tmp/check-chart.out 2>&1 && pass "scripts/check-chart.sh" || { fail "scripts/check-chart.sh"; grep -E "FAIL" /tmp/check-chart.out | head -5; }
echo "checks failed: $fails, skipped: $skipped"
[ "$fails" = 0 ]
