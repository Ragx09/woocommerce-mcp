#!/usr/bin/env bash
# T-11: secret scan with gitleaks (pinned image, read-only mounts) over
#   1. the whole git history, and
#   2. every file git could commit now (tracked + untracked-not-ignored; .env and other ignored files are
#      where secrets are supposed to live, so they are not scanned).
# Findings are printed redacted. Config: .gitleaks.toml (default rules + reviewed false positives).
set -euo pipefail
cd "$(dirname "$0")/.."
img=zricethezav/gitleaks:v8.28.0
tree="$(mktemp -d)"; trap 'rm -rf "$tree"' EXIT
git ls-files -z -co --exclude-standard | xargs -0 cp --parents -t "$tree" 2>/dev/null || true
rc=0
docker run --rm -v "$PWD:/repo:ro" "$img" git /repo --config /repo/.gitleaks.toml --redact --no-banner || rc=1
docker run --rm -v "$tree:/tree:ro" -v "$PWD/.gitleaks.toml:/cfg.toml:ro" "$img" dir /tree --config /cfg.toml --redact --no-banner || rc=1
[ $rc = 0 ] && echo "PASS  secret scan (git history + committable files)" || echo "FAIL  secret scan"
exit $rc
