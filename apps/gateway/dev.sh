#!/usr/bin/env bash
# Runs the gateway on http://localhost:8080 (or $PORT) for local development, with a
# throwaway Postgres in Docker and the toolbox MCP server as its one upstream.
# It serves ../dashboard/dist when that has been built.
#   ./dev.sh         start (or restart)        ./dev.sh stop    stop and drop the database
# Login: admin@urumi.local / dev-admin-pw. Every value below is for local use only.
# Chat needs a real key: LLM_API_KEY=sk-or-... ./dev.sh
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
RUN="${TMPDIR:-/tmp}/urumi-dev"
mkdir -p "$RUN"

stop() {
  for pid in "$RUN"/*.pid; do
    [ -f "$pid" ] && kill "$(cat "$pid")" 2>/dev/null || true
    rm -f "$pid"
  done
}
stop
if [ "${1:-start}" = stop ]; then
  docker rm -f urumi-dev-pg >/dev/null 2>&1 || true
  rm -rf "$RUN"
  exit 0
fi

docker inspect urumi-dev-pg >/dev/null 2>&1 ||
  docker run -d --name urumi-dev-pg -e POSTGRES_USER=gateway -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=gateway \
    -p 127.0.0.1:55432:5432 postgres:17-alpine >/dev/null
docker start urumi-dev-pg >/dev/null
until docker exec urumi-dev-pg pg_isready -U gateway >/dev/null 2>&1; do sleep 1; done

# Kept between restarts: stored upstream credentials are encrypted with it.
[ -f "$RUN/encryption-key" ] || openssl rand -base64 32 >"$RUN/encryption-key"

(cd ../toolbox-mcp && TOOLBOX_API_KEY=dev-toolbox-key PORT=3911 exec node src/index.ts) >"$RUN/toolbox.log" 2>&1 &
echo $! >"$RUN/toolbox.pid"

DATABASE_URL=postgres://gateway:dev@127.0.0.1:55432/gateway \
  SESSION_SECRET=dev-session-secret \
  ENCRYPTION_KEY="$(cat "$RUN/encryption-key")" \
  ADMIN_EMAIL=admin@urumi.local ADMIN_PASSWORD=dev-admin-pw \
  PORT="$PORT" UPSTREAM_HEALTH_INTERVAL_MS=2000 \
  SEED_SERVERS='[{"slug":"toolbox","name":"Toolbox","url":"http://127.0.0.1:3911/mcp","authType":"header","authHeader":"X-Api-Key","credential":"dev-toolbox-key"},{"slug":"dead","name":"Dead Server","url":"http://127.0.0.1:3999/mcp"}]' \
  DASHBOARD_DIR="$(cd .. && pwd)/dashboard/dist" \
  LLM_API_KEY="${LLM_API_KEY:-}" \
  node src/index.ts >"$RUN/gateway.log" 2>&1 &
echo $! >"$RUN/gateway.pid"

for _ in $(seq 1 30); do
  curl -sf "localhost:$PORT/readyz" >/dev/null 2>&1 && echo "gateway ready: http://localhost:$PORT  (logs: $RUN)" && exit 0
  sleep 1
done
echo "gateway did not become ready; see $RUN/gateway.log" >&2
tail -20 "$RUN/gateway.log" >&2
exit 1
