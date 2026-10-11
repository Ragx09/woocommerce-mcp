#!/usr/bin/env bash
# Deletes the local cluster and ALL its data (PVCs live inside the k3d node container).
set -euo pipefail
k3d cluster delete mcp
