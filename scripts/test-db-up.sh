#!/usr/bin/env bash
# 起一个临时 postgres 容器供 relay 集成测试用, 建好 users(测试用假表) + bridge_* 表
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER_NAME=bridge-test-pg
# 55432 被 content-review-dev-pg 占过, 默认换 55439. 冲突时用 BRIDGE_TEST_PG_PORT 覆盖.
PORT="${BRIDGE_TEST_PG_PORT:-55439}"

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# 先探端口 — docker 自己报的 "driver failed programming external connectivity"
# 很难看懂, 且容器会留在 Created 状态让后续 psql 报 "password authentication failed",
# 排查成本高. 这里直接给出是谁占着 + 怎么绕。
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ 端口 $PORT 已被占用. 占用者:" >&2
  docker ps --format '   {{.Names}}\t{{.Image}}\t{{.Ports}}' | grep ":$PORT->" >&2 \
    || lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  echo "" >&2
  echo "换个端口重试: BRIDGE_TEST_PG_PORT=55440 $0" >&2
  echo "(别停占用的容器 — 可能是别的项目在用)" >&2
  exit 1
fi

docker run -d --name "$CONTAINER_NAME" -p "$PORT:5432" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bridge_test \
  postgres:16-alpine >/dev/null

echo "waiting for postgres to be ready..."
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
sleep 0.5

docker exec -i "$CONTAINER_NAME" psql -U postgres -d bridge_test < relay/tests/integration/fixtures/users-table.sql
docker exec -i "$CONTAINER_NAME" psql -U postgres -d bridge_test < db/migrations/001_bridge_init.sql

echo "DATABASE_URL=postgresql://postgres:test@localhost:$PORT/bridge_test"
