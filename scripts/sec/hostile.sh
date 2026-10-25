#!/usr/bin/env bash
# SEC-05: turn the hostile test upstream on, run tests/security/hostile.test.mjs, turn it off again (always).
# Local k3d only: the image is built and imported like ours (scripts/build-images.sh), the chart toggle is
# passed on the command line, never written to a values file.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build -q --provenance=false --sbom=false -t hostile-mcp:build -f services/hostile-mcp/Dockerfile . >/dev/null
tag="sha-$(docker image inspect --format '{{.Id}}' hostile-mcp:build | cut -d: -f2 | cut -c1-12)"
docker tag hostile-mcp:build "hostile-mcp:$tag" && k3d image import "hostile-mcp:$tag" -c mcp >/dev/null 2>&1
off() { echo "== hostile-mcp off"; scripts/deploy.sh local >/dev/null && echo "removed: $(kubectl -n platform get deploy hostile-mcp 2>&1 | grep -c NotFound) (1 = gone)"; }
trap off EXIT
echo "== hostile-mcp on ($tag)"
scripts/deploy.sh local --set hostileMcp.enabled=true --set "hostileMcp.image.tag=$tag" >/dev/null
kubectl -n platform rollout status deploy/hostile-mcp --timeout=120s
kubectl -n platform rollout status deploy/gateway --timeout=300s
mkdir -p docs/evidence/sec-05
HOSTILE=1 npm test -w tests/security -- hostile.test.mjs --reporter=verbose 2>&1 | tee "docs/evidence/sec-05/hostile-$(date +%F).txt"
exit "${PIPESTATUS[0]}"
