#!/usr/bin/env bash
# Runs the gateway's DB integration tests against a throwaway Postgres in Docker (same image as the chart).
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="$(grep -E '^\s+image: postgres:' charts/platform/values.yaml | awk '{print $2}')"
NAME=gw-pg-int PORT=${PG_TEST_PORT:-15432}
PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" -e POSTGRES_USER=gateway -e POSTGRES_PASSWORD="$PW" "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 60); do docker exec "$NAME" pg_isready -U gateway -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 0.5; done
PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=gateway PGPASSWORD="$PW" PGDATABASE=gateway \
  npm run test:int -w services/gateway "$@"
