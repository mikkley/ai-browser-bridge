#!/usr/bin/env bash
# 起一个临时 postgres 容器供 relay 集成测试用, 建好 users(测试用假表) + bridge_* 表
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER_NAME=bridge-test-pg
PORT=55432

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

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
