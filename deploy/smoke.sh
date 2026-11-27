#!/usr/bin/env bash
# The release bundle as deployed: copy /release out of the image and run it
# with the same Bun the host has. ci runs it with the image loaded as
# ghcr.io/zyx-tw/finance:ci.
set -euo pipefail
image=${1:-ghcr.io/zyx-tw/finance:ci}
dir=$(mktemp -d)
cid=$(docker create "$image" /none)
docker cp "$cid:/release/." "$dir/"
docker rm "$cid" >/dev/null
trap 'docker logs finance || true' EXIT
token=smoke-token-smoke-token-smoke-token-0000

docker run -d --name finance -p 127.0.0.1:8080:8080 -v "$dir:/app:ro" -w /app \
  -e FINANCE_DATA=/tmp/finance -e FINANCE_DIST=/app/dist -e FINANCE_PORT=8080 \
  -e FINANCE_ORIGIN=http://localhost:8080 -e FINANCE_TOKEN=$token \
  oven/bun:1.4.2 bun build/server.js >/dev/null
for i in $(seq 1 30); do curl -s -o /dev/null localhost:8080/healthz && break; sleep 0.5; done

code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
test "$(code localhost:8080/)" = 200
test "$(code localhost:8080/api/v1/summary)" = 401
test "$(code -H "authorization: Bearer $token" localhost:8080/api/v1/summary)" = 200
test "$(code -X POST localhost:8080/mcp)" = 401
trap - EXIT
docker rm -f finance >/dev/null
echo "smoke passed"
