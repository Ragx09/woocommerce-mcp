#!/usr/bin/env bash
# Builds our images, tags them by content (image id), imports them into k3d and writes the tags
# to .images.env (sourced by deploy.sh). Same code → same tag → helm upgrade restarts nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
: > .images.env
for svc in ${SERVICES:-woo-mcp gateway}; do
  docker build -q -t "$svc:build" -f "services/$svc/Dockerfile" . >/dev/null
  tag="sha-$(docker image inspect --format '{{.Id}}' "$svc:build" | cut -d: -f2 | cut -c1-12)"
  docker tag "$svc:build" "$svc:$tag"
  k3d image import "$svc:$tag" -c mcp >/dev/null 2>&1
  echo "${svc//-/_}_tag=$tag" >> .images.env
  echo "image $svc:$tag imported"
done
