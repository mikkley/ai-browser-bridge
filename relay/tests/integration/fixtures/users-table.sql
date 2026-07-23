-- 仅测试用: 模拟父目录 marketing-agent 的 users 表关键字段
-- (真实生产环境这张表由 infra/db/init/001-schema.sql 建, bridge 只读/写, 不管理它的 schema)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  email VARCHAR(255),
  lark_open_id VARCHAR(255),
  role VARCHAR(16) NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_lark ON users(lark_open_id) WHERE lark_open_id IS NOT NULL;
