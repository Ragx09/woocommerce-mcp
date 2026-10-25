#!/usr/bin/env bash
# BON-16 checklist test: the README's stand-out section names every stand-out item and the bonus, and every file,
# script and directory it points to exists; the runbook and video plan cover every item; no placeholder text is left.
set -uo pipefail
cd "$(dirname "$0")/.."
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails+1)); }
section="$(sed -n '/^## Bonus \/ stand-out items attempted/,$p' README.md)"
[ -n "$section" ] || { fail "README has no stand-out section"; exit 1; }

# 1. all nine items and the bonus are listed
for item in "1) Production-like VPS" "2) Tool permissions" "3) OAuth" "4) Handling many tools" "5) Hosted MCP servers" "6) Security hardening" "7) Scaling" "8) Observability" "9) Upgrades" "Bonus: multi-store"; do
  grep -qF "| $item" <<<"$section" && pass "README lists: $item" || fail "README does not list: $item"
done
# 2. every row has a status word
bad="$(grep -E '^\| ([1-9]\)|Bonus)' <<<"$section" | grep -vE '\| (verified on k3d|built, cluster run pending|prepared|foundation verified)' || true)"
[ -z "$bad" ] && pass "every stand-out row states its verification status" || fail "rows without a status: $(echo "$bad" | cut -c1-60 | head -3)"
# 3. every referenced path exists
missing=0
while IFS= read -r ref; do
  path="${ref%%#*}"; path="${path%% *}"
  case "$path" in *'<'*|*'*'*|*' '*|http*|'') continue ;; esac
  if [ ! -e "$path" ] && [ ! -e "docs/$path" ]; then echo "      missing: $path"; missing=$((missing+1)); fi
done < <(grep -oE '`[A-Za-z0-9_./-]+\.(md|sh|mjs|py|yaml|yml|ts|tsx)`|`(charts|services|apps|scripts|vps-setup|brand|docs)/[A-Za-z0-9_./-]*`|\]\([A-Za-z0-9_./#-]+\)' <<<"$section" | sed -E 's/^`//; s/`$//; s/^\]\(//; s/\)$//')
[ "$missing" = 0 ] && pass "every path named in the stand-out section exists" || fail "$missing path(s) named in the README do not exist"
# 4. runbook and video plan cover the items
for kw in "REQ-DOD" "BON-08" "Hosted MCP server by image" "Multi-store" "Observability and scaling"; do
  grep -qF "$kw" docs/DEMO_RUNBOOK.md && pass "runbook covers: $kw" || fail "runbook misses: $kw"
done
for kw in "Tool permissions" "OAuth" "Hosted servers" "multi-store" "Scaling and observability" "Local → VPS" "Chat agent" "MCP internals" "Security posture" "Kubernetes"; do
  grep -qF "$kw" docs/VIDEO_PLAN.md && pass "video plan covers: $kw" || fail "video plan misses: $kw"
done
# 5. SYSTEM_DESIGN and THREAT_MODEL mention the new components
grep -q "provisioner" docs/SYSTEM_DESIGN.md && grep -q "hosted-<slug>" docs/SYSTEM_DESIGN.md && pass "SYSTEM_DESIGN covers provisioner, stores and hosted servers" || fail "SYSTEM_DESIGN misses the provisioner/hosted servers"
for t in T-29 T-30 T-31 T-32; do grep -q "^| $t " THREAT_MODEL.md && pass "THREAT_MODEL has $t" || fail "THREAT_MODEL misses $t"; done
# 6. every REQ-SO / REQ-BON id is in the traceability matrix with a status
for r in 01 02 03 04 05 06 07 08 09; do grep -q "^| REQ-SO-$r |" docs/REQUIREMENTS_TRACEABILITY.md && pass "traceability has REQ-SO-$r" || fail "traceability misses REQ-SO-$r"; done
for r in 01 02 03 04 05 06 07 08; do grep -q "^| REQ-BON-$r |" docs/REQUIREMENTS_TRACEABILITY.md && pass "traceability has REQ-BON-$r" || fail "traceability misses REQ-BON-$r"; done
# 7. no leftovers
! grep -nE "Not attempted yet|TODO|TBD|XXX" README.md docs/VIDEO_PLAN.md docs/SYSTEM_DESIGN.md >/dev/null && pass "no TODO/TBD/'not attempted yet' text left" || { fail "leftover placeholder text:"; grep -nE "Not attempted yet|TODO|TBD|XXX" README.md docs/VIDEO_PLAN.md docs/SYSTEM_DESIGN.md | head -3; }
echo "failures: $fails"
[ "$fails" = 0 ]
