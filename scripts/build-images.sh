#!/usr/bin/env bash
# Builds our images, tags them by content (image id), imports them into k3d and writes the tags
# to .images.env (sourced by deploy.sh). Same code → same tag → helm upgrade restarts nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
touch .images.env   # keep tags of services not rebuilt this time (SERVICES=gateway …)
for svc in ${SERVICES:-woo-mcp gateway}; do
  # No provenance/SBOM attestations: they embed build timestamps, which change the image id on every
  # build and would restart pods on a no-op `up.sh` (found in INF-15).
  docker build -q --provenance=false --sbom=false -t "$svc:build" -f "services/$svc/Dockerfile" . >/dev/null
  tag="sha-$(docker image inspect --format '{{.Id}}' "$svc:build" | cut -d: -f2 | cut -c1-12)"
  docker tag "$svc:build" "$svc:$tag"
  k3d image import "$svc:$tag" -c mcp >/dev/null 2>&1
  var="${svc//-/_}_tag"
  { grep -v "^$var=" .images.env || true; echo "$var=$tag"; } > .images.env.tmp && mv .images.env.tmp .images.env
  echo "image $svc:$tag imported"
done
