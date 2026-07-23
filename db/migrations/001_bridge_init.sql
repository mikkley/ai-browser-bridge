-- ai-browser-bridge SaaS 化: 设备绑定 + PAT + 审计
-- 依赖父目录 marketing-agent 已有的 users 表 (id UUID PK)
-- 幂等: 全部 IF NOT EXISTS, 可重复执行

CREATE TABLE IF NOT EXISTS bridge_devices (
  device_id     UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  device_name   TEXT,
  user_agent    TEXT,
  bound_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  disabled_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bridge_devices_user_id_idx
  ON bridge_devices (user_id) WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS bridge_pairing_tokens (
  jti           UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  device_id     UUID NOT NULL REFERENCES bridge_devices(device_id),
  token_hash    TEXT NOT NULL,
  token_prefix  TEXT NOT NULL,
  label         TEXT NOT NULL,
  scopes        TEXT[] NOT NULL CHECK (array_length(scopes, 1) >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  last_used_ip  TEXT,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bridge_pairing_tokens_user_device_idx
  ON bridge_pairing_tokens (user_id, device_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS bridge_audit (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID,
  device_id    UUID,
  token_jti    UUID,
  action       TEXT NOT NULL,
  target_url   TEXT,
  duration_ms  INT,
  status       TEXT NOT NULL CHECK (status IN ('ok','error','refused','timeout')),
  error_msg    TEXT,
  request_ip   TEXT
);

CREATE INDEX IF NOT EXISTS bridge_audit_user_ts_idx ON bridge_audit (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS bridge_audit_jti_ts_idx ON bridge_audit (token_jti, ts DESC);
