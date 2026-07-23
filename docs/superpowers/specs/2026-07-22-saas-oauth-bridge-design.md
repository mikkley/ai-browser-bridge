# ai-browser-bridge SaaS 化 & 父目录 Docker 合并 · 设计文档

- **状态**：待评审
- **日期**：2026-07-22
- **作者**：MK
- **相关代码库**：`ai-browser-bridge`（本 repo）+ `marketing-agent`（父 repo）

## 1. 背景与目标

### 1.1 现状

- `ai-browser-bridge` = Chrome 扩展 + Node.js relay，让服务器端 AI Agent 静默操作用户已登录的浏览器
- 权限模型：一份共享 `BRIDGE_ACCESS_KEY` 烤进插件 zip，谁拿到 zip 谁就是 root；`clientId` 由插件首次启动随机生成，匿名
- 部署形态：relay 是裸 Node 进程 + Cloudflare Quick Tunnel，无 Dockerfile；与父目录 `marketing-agent` 的 Docker Compose 栈完全分离
- 目前主要给 `marketing-agent` 一个 AI 后端用，其他 AI 项目无接入路径

### 1.2 目标

1. **通用化**：任何 AI agent（marketing-agent / diary agent / 未来的 IMC 内部 agent）都能对接同一个 bridge，凭 PAT 操控某个用户的浏览器
2. **共享 Docker 服务器**：bridge 变成 `marketing-agent` compose stack 的一个 service，共享 pg / 网络 / cloudflared tunnel
3. **用户身份化**：用飞书 SSO 登录，一台浏览器对应一个（user, device）绑定，权限颗粒度到设备
4. **重启部署**：没有老用户，直接推倒重来，不留兼容层

### 1.3 非目标

- 不做多 identity provider（飞书以外）—— future work
- 不做开发者自助注册 client —— PAT 模型下用户自己发 token，不需要 client 注册
- 不做请求签名（HMAC）—— HTTPS + Bearer 已足够（内部信任模型）
- 不改造 Chrome 扩展"不抢鼠标"的核心机制

## 2. 关键决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 通用化方向 | 服务端多 AI 接入 | 用户明确诉求 |
| 用户体系 | 飞书 SSO；bridge 共享 marketing-agent 的飞书 app + users 表；代码解耦 | 复用现有资产，避免用户二次登录 |
| 授权模型 | Personal Access Token（PAT）：用户主动生成 → 交给 AI | OAuth code flow 对内部使用过度设计 |
| AI 认证 | `Authorization: Bearer bpt_xxx` + HTTPS | 最简接入，内部信任模型足够 |
| 部署形态 | 完全合入父目录 Docker Compose | 共享 pg / tunnel / nginx，一体化运维 |
| Repo 协作 | git subtree 合入父 repo，双向可同步 | 父 push 自动部署 + 保留独立 repo 未来独立开源路径 |
| 数据库 | 共享 `marketing_v01` 库，bridge 表全部 `bridge_` 前缀 | 避免跨库查询，users 表天然可读 |
| JWT secret | 独立 `BRIDGE_JWT_SECRET`（不复用 backend） | Blast radius 隔离 |
| ACCESS_KEY | 保留但降级为"ws 握手 bootstrap 票据"，不再决定权限 | 兼容现有 ws 握手逻辑 |
| 老 API | 直接删除（`/device/authorize` / `/token/agent` / `.data/*.log`） | 无老用户 |

## 3. 术语

| 术语 | 含义 |
|---|---|
| **device** | 一次插件安装 = 一个 device，由 `chrome.storage.local.deviceId`（UUID）标识；不同浏览器/机器上的插件是不同的 device |
| **user** | 一个飞书用户 = `users.id`（UUID）；一个 user 可以拥有多台 device |
| **userToken** | Bridge 签发的、给插件本身用的 JWT；用来调 `/api/me/*` 和 ws 握手带身份 |
| **PAT / bpt_ token** | 用户在插件里为某台 device 生成的 access token，交给 AI 用；格式 `bpt_<32字符base64url><4字符校验和>` |
| **ACCESS_KEY** | 部署时烤进插件的共享反爬钥匙；只用于 ws 握手 bootstrap，不再决定权限 |

## 4. 整体架构

```
┌─ Chrome 扩展 (用户本地) ────────────────────┐
│  popup: 飞书登录 / 设备管理 / PAT 生成撤销
│  background: chrome.scripting.executeScript 静默执行
│  chrome.storage.local: deviceId + userToken + userInfo
└──────────────┬──────────────────────────────┘
               │ WSS /ws?deviceId=<uuid>&accessKey=<bootstrap>[&userToken=<jwt>]
               ▼
┌─ marketing-bridge (Docker service, marketing_internal) ──────┐
│                                                              │
│  WebSocket Layer: sessions Map<deviceId, ws> (单连接策略)     │
│                                                              │
│  HTTP Layer                                                  │
│    面向 AI:      POST /command  (Bearer bpt_xxx)              │
│    面向用户:     GET  /login/feishu                            │
│                 GET  /login/feishu-callback                   │
│                 GET/POST/DELETE /api/me/*                     │
│                                                              │
│  中间件: PAT verifier → (user_id, device_id, scopes)          │
│         userToken verifier → user_id                          │
└──────────────┬───────────────────────────────────────────────┘
               │ 同 network 直连 pg
               ▼
       marketing-pg (共享)
         ├─ users (共享, 加密飞书 token 已有)
         ├─ bridge_devices (新)
         ├─ bridge_pairing_tokens (新)
         └─ bridge_audit (新)
```

**关键不变量**：
- 不抢鼠标（`chrome.scripting.executeScript` 静默执行）
- 单连接策略（同 deviceId 新连接踢旧）
- device 匿名 ws 可连接但拒绝所有 `/command`

## 5. 数据模型

**共享 pg 库 `marketing_v01`；bridge 所有表以 `bridge_` 前缀 namespace；`users` 表直接复用父目录已有**。

### 5.1 `bridge_devices`

```sql
CREATE TABLE bridge_devices (
  device_id     UUID PRIMARY KEY,                        -- 插件 crypto.randomUUID()
  user_id       UUID NOT NULL REFERENCES users(id),
  device_name   TEXT,                                    -- NULL = 首次绑定后未命名, 插件收到 NULL 时弹命名对话框
  user_agent    TEXT,                                    -- 首次连时抓
  bound_at      TIMESTAMPTZ DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  disabled_at   TIMESTAMPTZ                              -- 撤销设备时打
);
CREATE INDEX ON bridge_devices (user_id) WHERE disabled_at IS NULL;
```

### 5.2 `bridge_pairing_tokens`（PAT）

```sql
CREATE TABLE bridge_pairing_tokens (
  jti           UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  device_id     UUID NOT NULL REFERENCES bridge_devices(device_id),
  token_hash    TEXT NOT NULL,                           -- SHA-256(明文), 明文不落库
  token_prefix  TEXT NOT NULL,                           -- "bpt_a1b2c3d4" 前 12 位, popup 里给用户看
  label         TEXT NOT NULL,                           -- 用户填的 "for 传播洞察"
  scopes        TEXT[] NOT NULL CHECK (array_length(scopes, 1) >= 1),
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  last_used_ip  TEXT,
  expires_at    TIMESTAMPTZ,                             -- NULL = 永不过期
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX ON bridge_pairing_tokens (user_id, device_id) WHERE revoked_at IS NULL;
```

### 5.3 `bridge_audit`

```sql
CREATE TABLE bridge_audit (
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
CREATE INDEX ON bridge_audit (user_id, ts DESC);
CREATE INDEX ON bridge_audit (token_jti, ts DESC);
```

### 5.4 Token 格式

`bpt_<32字符base64url随机><4字符校验和>` 总长 40 字符（`bpt_` 4 + 明文 32 + 校验和 4）。

- 明文形态举例：`bpt_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6XYZW`
- 生成算法：`payload = base64url(crypto.randomBytes(24))` = 32 字符；`checksum = SHA256(payload).slice(0,4)`；明文 = `bpt_` + payload + checksum
- 落库：`token_prefix = "bpt_" + payload[:8]`（前 12 字符供 UI 展示）+ `token_hash = SHA-256(明文完整字符串)`
- 校验和用于用户复制粘贴时快速校验错字，不用于安全

### 5.5 Migration 文件

`ai-browser-bridge/db/migrations/001_bridge_init.sql`：全部建表 + 索引，一次搞定，全 `IF NOT EXISTS` 幂等。

## 6. 认证 & 授权流程

### 6.1 用户登录 bridge（插件端触发）

```
1. 插件 popup 点 [飞书登录]
2. auth.ts 调用 chrome.identity.launchWebAuthFlow({
     url: `${BRIDGE_URL}/login/feishu?device_id=${myDeviceId}
           &redirect_uri=https://<extension-id>.chromiumapp.org/`,
     interactive: true
   })
3. Chrome 弹独立窗口 → 用户走飞书 OAuth
4. bridge 处理 /login/feishu-callback:
   - 拿飞书 access_token → 拉 user_info → 拿 lark_open_id
   - lookup or create users 行 (复用父目录 users 表结构)
   - upsert bridge_devices (device_id, user_id, ua) - 首次时 device_name = ""
   - 签发 userToken (JWT, 30 天, 用 BRIDGE_JWT_SECRET 签)
   - 302 到 https://<extension-id>.chromiumapp.org/?token=<xxx>&user_name=<x>
5. Chrome 捕获 redirect, launchWebAuthFlow 回调把 URL 交给插件
6. 插件解析 token → chrome.storage.local.userToken = token
7. 若 device_name 为空 → popup 弹"给这台设备起个名字" → PATCH /api/me/devices/:id
8. background 断开当前 ws, 用新 userToken 重连 (进入实名连接)
```

### 6.2 生成 PAT

```
1. Popup Token 管理页, 点 [+ 新建 Token]
2. 填 label (必填) + 勾 scopes (默认全选) + 可选过期时间 → 提交
3. POST /api/me/tokens (Bearer userToken)
4. 服务端:
   - crypto.randomBytes(24) → base64url → prefix "bpt_" + 4字符校验和 → 明文
   - SHA-256(明文) → token_hash
   - 写入 bridge_pairing_tokens
5. 返回 { jti, prefix, plaintext } → 弹一次性 modal
6. 用户复制明文, 关闭 modal 后明文永不再显示
```

### 6.3 AI 调用 `/command`

```
POST /command
Authorization: Bearer bpt_a1b2c3d4e5f6...
Content-Type: application/json

{ "action": "extract", "params": { "type": "text", "tabId": 123 } }

服务端处理:
1. Parse token → SHA-256 → 查 bridge_pairing_tokens
2. 校验: not revoked / not expired / action ∈ scopes
3. sessions.get(device_id) → 若离线 → 503 device_offline
4. ws send command → 等 result (超时 30s)
5. 写 bridge_audit (成功/失败/耗时)
6. 返回 { ok: true, result: ... } | { ok: false, error: ... }
```

### 6.4 撤销 PAT

- 用户在 popup 点撤销 → DELETE `/api/me/tokens/:jti`（Bearer userToken）
- 服务端 UPDATE `revoked_at = now()` + 从 in-memory hot cache 清掉
- 下次 AI 用该 token 立即返回 401

### 6.5 ws 握手 & 单连接

```
GET /ws?deviceId=<uuid>&accessKey=<key>[&userToken=<jwt>]

1. 校验 accessKey === BRIDGE_ACCESS_KEY, 否则 close 1008
2. 若无 userToken → 匿名连接 (可挂但收不到 command, 仅心跳)
3. 若有 userToken → 验签 (BRIDGE_JWT_SECRET) + 查 bridge_devices 确认 (device_id, user_id) 匹配, 不匹配 → close 1008
4. sessions.get(device_id) 存在 → 旧 ws close 1000 "session_replaced"
5. sessions.set(device_id, new_ws), 写 bridge_devices.last_seen_at
```

## 7. AI 端调用协议

### 7.1 Endpoints（AI 用到的）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/command` | 下发命令；Body `{ action, params }`；返回 `{ ok, result }` |
| GET  | `/health` | 健康检查 |

**AI 不直接调 `/api/me/*`**，那些是插件专用。

### 7.2 支持的 Action

保持与现有 relay 一致，无破坏性改动：

- `execute` - 白名单预定义脚本（`ALLOWED_SCRIPTS` in `extension/src/background.ts`）
- `evalScript` - 任意 JS（受目标页 CSP 限制，`ALLOWED_ACTIONS` env 决定是否开启）
- `navigate` - 打开 URL
- `extract` - 提取 text/html/title；可选 `waitFor` selector
- `waitForSelector` - 等 SPA 元素渲染
- `cookies` - 拉指定 domain 的 cookies
- `tabs` - 列出 tabs
- `screenshot` - PNG dataURL

### 7.3 错误码

| HTTP | code | 含义 |
|---|---|---|
| 401 | `invalid_token` / `token_revoked` / `token_expired` | Token 问题 |
| 403 | `action_not_in_scope` | action 不在 PAT scopes 里 |
| 503 | `device_offline` | 目标设备 ws 未连 |
| 504 | `device_timeout` | 命令派发超时（30s） |
| 429 | `rate_limited` | 触发限速（`RATE_LIMIT_RPM`） |
| 400 | `invalid_action` / `invalid_params` | 请求本身错 |

## 8. 插件端改动

### 8.1 新增文件

- `extension/src/auth.ts`：`launchWebAuthFlow` 登录 / `logout` / `getUserInfo`
- `extension/src/tokens.ts`：`listTokens` / `createToken` / `revokeToken`
- `extension/src/api-client.ts`：`/api/me/*` fetch 封装，自动带 `Authorization: Bearer <userToken>`

### 8.2 修改文件

- `extension/manifest.json`：加 `"permissions": ["identity"]`
- `extension/src/background.ts`：ws 握手 URL 拼 `&userToken=`；移除现有的 device flow / access-key-only 逻辑
- `extension/src/popup.ts` + `popup.html`：三视图路由（未登录 / 已登录 / Token 管理）
- `extension/src/config.ts`：`RELAY_WS_URL` 改成 `wss://.../bridge/ws`；`RELAY_API_URL` 新增

### 8.3 存储（chrome.storage.local）

| Key | 含义 |
|---|---|
| `deviceId` | UUID，首启生成，永不变 |
| `userToken` | 登录后 bridge 签发的 JWT，30 天有效 |
| `userInfo` | `{ name, avatar_url }`，popup 展示用 |
| `deviceName` | 用户为这台设备起的名，用于 popup 展示（副本，pg 里也有） |

## 9. 部署架构

### 9.1 Docker Compose 改动（父目录）

新增 service `local-bridge`（生产 `marketing-bridge`）：

```yaml
local-bridge:
  build:
    context: ./ai-browser-bridge/relay      # subtree 后相对路径可用
    dockerfile: Dockerfile
  container_name: marketing-v01-bridge
  ports:
    - "3020:3020"
  environment:
    PORT: 3020
    DATABASE_URL: postgresql://postgres:postgres@local-pg:5432/marketing_v01
    BRIDGE_ACCESS_KEY: ${BRIDGE_ACCESS_KEY}
    BRIDGE_JWT_SECRET: ${BRIDGE_JWT_SECRET}
    FEISHU_APP_ID: ${FEISHU_APP_ID}
    FEISHU_APP_SECRET: ${FEISHU_APP_SECRET}
    BRIDGE_FEISHU_REDIRECT_URI: ${BRIDGE_FEISHU_REDIRECT_URI}
    BRIDGE_PUBLIC_URL: ${BRIDGE_PUBLIC_URL}
    ALLOWED_ACTIONS: navigate,extract,waitForSelector,cookies,tabs,screenshot,execute
    NODE_ENV: development
    TZ: Asia/Shanghai
  depends_on:
    local-pg:
      condition: service_healthy
  networks:
    - marketing_v01
```

### 9.2 Bridge Dockerfile

`ai-browser-bridge/relay/Dockerfile`（多阶段构建）：

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
ENV NODE_ENV=production PORT=3020
EXPOSE 3020
CMD ["node", "dist/server.js"]
```

`.dockerignore`：`.data/` `dist/` `node_modules/` `tests/`

### 9.3 网络 & 域名

- **内网调用**：`marketing-agent-service` → `http://marketing-bridge:3020/command`（不走公网）
- **公网入口**：nginx 加 `location /bridge/ { proxy_pass http://marketing-bridge:3020/; ... proxy_set_header Upgrade $http_upgrade; }`
- **公网域名**：`agent.imcagent.qzz.io/bridge/*`
- **飞书 app 后台**：加 `https://agent.imcagent.qzz.io/bridge/login/feishu-callback` 到 redirect URI 白名单

### 9.4 端口分配

| Service | Container port |
|---|---|
| marketing-pg | 5432（本地映射 5434） |
| marketing-backend | 3000 |
| marketing-ui | 3001 |
| marketing-agent-service | 3010 |
| **marketing-bridge** | **3020** |

### 9.5 Repo 协作：git subtree

**一次性合入**（在父 repo 里）：

```bash
cd /Users/zhouyifan/Documents/bluefocus/local-agent
# 父 .gitignore 里删掉 ai-browser-bridge/ 那行
# 先备份现有 bridge 里的 uncommitted 改动 (先 push 到 bridge repo 或 stash)
cd ai-browser-bridge && git status  # 确认干净
cd ..
rm -rf ai-browser-bridge  # 移除 gitignored 目录, 交给 subtree 重建

git remote add bridge-upstream https://github.com/mikkley/ai-browser-bridge.git
git fetch bridge-upstream
git subtree add --prefix=ai-browser-bridge bridge-upstream main --squash
```

**日常维护**：
- 改 bridge 代码：直接在父 repo `ai-browser-bridge/` 目录下改 → 父 repo commit → 父 repo push（deploy.yml 自动跑）
- 反向同步到 bridge 独立 repo（可选，用于开源发布）：
  ```bash
  git subtree push --prefix=ai-browser-bridge bridge-upstream main
  ```
- 从 bridge repo 拉最新（如果有别人在 bridge repo 提交）：
  ```bash
  git subtree pull --prefix=ai-browser-bridge bridge-upstream main --squash
  ```

### 9.6 生产部署 deploy.yml 改动

父 repo `.github/workflows/deploy.yml`：

- rsync 步骤不需要改（subtree 后 `ai-browser-bridge/` 在父 repo 里）
- migration loop 追加 bridge 目录：
  ```bash
  for m in $(ls infra/db/migrations/*.sql ai-browser-bridge/db/migrations/*.sql | sort); do
    docker exec marketing-pg psql -U $POSTGRES_USER -d $POSTGRES_DB -f $m
  done
  ```
- 加一步 build marketing-bridge：`docker compose -f docker-compose.production.yml -p marketing-agent up -d --build marketing-bridge`
- 加健康检查：`curl -f http://localhost:3020/health`

## 10. 迁移策略（重启版）

**无老用户，直接推倒**：

### 10.1 删除的代码路径

| 现有 | 处置 |
|---|---|
| `POST /device/authorize` / `/device/approve` / `/device/token` | 删除 |
| `POST /token/agent` | 删除 |
| `POST /token/revoke` 原逻辑 | 重写，只支持 PAT |
| `.data/audit.log` 文件写 | 删除，改写 pg `bridge_audit` |
| `.data/revoked.json` jti 黑名单 | 删除，改用 pg `revoked_at` |
| `.data/agent-jwt-secret` / `relay-secret` 相关代码 | 删除 |

### 10.2 新加代码路径

- `relay/src/routes/oauth-feishu.ts`：`/login/feishu` + `/login/feishu-callback`
- `relay/src/routes/me.ts`：`/api/me/*` 全部
- `relay/src/routes/command.ts`：重写 PAT 校验 + audit 写入
- `relay/src/lib/pat.ts`：token 生成 / 校验 / hash
- `relay/src/lib/pg.ts`：pg 连接池 + query 封装
- `relay/src/lib/feishu.ts`：飞书 API 客户端（拿 access_token + user_info）
- `relay/src/lib/audit.ts`：异步写 bridge_audit

## 11. 测试策略

### 11.1 单元测试（vitest）

`ai-browser-bridge/relay/tests/`：

- `pat.spec.ts`：生成格式 / SHA-256 一致 / revoked / expired / scope 不匹配
- `ws-session.spec.ts`：单连接策略 / 匿名连接拒 command / userToken 连接更新 last_seen_at
- `command.spec.ts`：有效 PAT / 无效 PAT → 401 / scope 外 → 403 / device 离线 → 503
- `feishu-callback.spec.ts`：lookup-or-create user / device upsert / 302 URL / KEK 加密
- `oauth-launch-url.spec.ts`：URL 参数拼接

### 11.2 集成测试

`ai-browser-bridge/scripts/e2e.sh`：起 pg + bridge → psql seed → curl `/command` 全流程。

### 11.3 手动 E2E checklist

`chrome.identity.launchWebAuthFlow` 只能真 Chrome 里跑，每次改 auth 相关代码手动跑一遍：

```
□ 装插件 → popup 显示未登录
□ 飞书登录 → 弹窗完成 → popup 显示用户名头像
□ 首次登录弹设备命名 → 保存
□ 生成 PAT → 一次性明文弹窗 → 复制
□ 关掉 modal → 明文再也看不到
□ curl + Bearer bpt_xxx 调 /command extract → 成功
□ 换个 action 不在 scope → 403
□ popup 撤销 → curl 同 token → 401
□ 换电脑装同插件 → 生成第二台 PAT → 两个 PAT 独立
□ 登出 → chrome.storage 清 userToken → ws 匿名重连 → curl 该设备的 PAT → 503 device_offline (未撤销 token 也拿不到设备, 因为匿名连接不算 online)
```

### 11.4 CI

Bridge subtree 后仍保留独立 repo（用于反向同步），独立 repo 的 GHA 跑 vitest + tsc + docker build smoke，不部署。部署统一走父 repo 的 deploy.yml。

## 12. 交付文档清单

MVP 上线同步产出：

- `ai-browser-bridge/docs/AI_INTEGRATION.md` - 给 AI 开发者的接入指南（endpoint 列表 / schema / 三种语言示例 / 错误码 / 重试策略）
- `ai-browser-bridge/docs/USER_GUIDE.md` - 给最终用户的使用手册（装插件 / 登录 / 生成 PAT / 常见问题）
- `local-agent/infra/skills/ai-browser-bridge/SKILL.md` - marketing-agent 侧 skill，让 agent-service 自动发现并调用
- 更新 `ai-browser-bridge/README.md` + `README.zh.md`（定位改为"SaaS 化 browser bridge"）
- 更新 `ai-browser-bridge/CLAUDE.md`（反映新架构，删掉老 device flow / ACCESS_KEY-based 权限描述）

## 13. Future Work（不进 MVP）

- **多 IDP 支持**：`/login/*` 抽象成 provider 层，加 GitHub / Google / 邮箱 magic link
- **开发者自助注册 client**：如果未来放开对外，加 admin 后台的 client 管理页
- **请求签名（HMAC）**：对高敏感 AI 加签选项，防 token 泄露后重放
- **多设备并行接收**：现在同一个 device_id 单连接，未来支持一个 user 的多台 device 同时收 broadcast 命令
- **workflow registry**：`WORKFLOW_PRD.md` 里草案，把 AI 探索出的多步路径持久化 + 跨项目共享
- **Rate limit 按 PAT 细颗粒**：现在按 device，未来按 token（不同 PAT 不同 quota）

## 14. Open Questions

- `bridge_audit` 增长会不会失控？MVP 阶段先不加清理，观察规模后再决定（预估每 device 每天 <1000 条，年增长 GB 级不会）
- 飞书 app 后台的 redirect URI 白名单是否有数量上限？两条（原 marketing-agent + 新 bridge）应该没问题，但要在动手前确认一下
- Bridge Dockerfile 用 `node:20-alpine` 会不会遇到 native 依赖问题？现在 relay 只依赖 `ws` `express` `jsonwebtoken` `uuid` `cloudflared`（optional），alpine 应该 OK；`cloudflared` 生产不用（走内网），可移入 devDependency
