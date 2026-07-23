# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

Chrome 插件 + Relay 服务，让服务器端 AI Agent 能静默操作用户浏览器（不抢鼠标）。**SaaS 化多租户模型**：relay 与父目录 `marketing-agent` 共享 Docker Compose 栈 + Postgres + 飞书 app；用户在插件里飞书 SSO 登录，生成 **Personal Access Token (PAT)** 交给任意 AI 项目，AI 拿 PAT 就能操控该用户对应设备的浏览器。没有 OAuth client 注册，没有 device flow —— token 本身就是完整凭据。

设计全文见 [`docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md`](docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md)。

## 架构

```
AI Agent (任意项目, 服务器端)
    ↓  POST /command  Bearer <bpt_xxx PAT>
marketing-bridge (relay, Docker service, 加入 marketing_internal network)
    ↑  WebSocket /ws?deviceId=<uuid>&accessKey=<key>[&userToken=<jwt>]
Chrome Extension (MV3)
    ↓  chrome.scripting.executeScript   ← 静默执行，不抢鼠标
用户的 Chrome（已登录，状态完整）

marketing-bridge ⇄ marketing-pg (共享 marketing_v01 库, bridge_* 前缀表, 复用 users 表)
```

### 核心设计原则
- **不抢鼠标**：所有页面操作通过 `chrome.scripting.executeScript`，不用 CDP `Input.dispatchMouseEvent`
- **PAT (Personal Access Token) 模型**：用户在插件里登录后自己生成 `bpt_xxx` token（选权限范围），复制给任意 AI 项目用。AI 端接入成本 = 一个 `Authorization: Bearer` 头，没有 client 注册、没有 OAuth 授权页
- **登录 ≠ 授权范围**：飞书 SSO 只用来把 `deviceId`（插件本地生成的 UUID，永不变）绑定到 `user_id`；具体能调哪些 action 由 PAT 自带的 `scopes` 决定
- **匿名连接收不到 command**：ws 握手没带有效 `userToken` 时仍可连上（心跳保活），但 `SessionStore.isOnline()` 只认已认证连接 —— 用户登出/未登录的设备，AI 拿着有效 PAT 也调不动
- **ACCESS_KEY 降级为 bootstrap 票据**：只用于 ws 握手防扫端口爬虫，不再代表任何操作权限

## 身份模型

| 概念 | 生成方式 | 存储位置 | 用途 |
|------|---------|---------|------|
| `deviceId` (= 旧 `clientId`) | 插件首次启动 `crypto.randomUUID()` | `chrome.storage.local.clientId` | ws 握手身份；飞书登录后绑定到 `user_id`（`bridge_devices` 表） |
| `BRIDGE_ACCESS_KEY` | 部署时随机生成 | relay env + 插件 `src/config.ts`（gitignore） | ws 握手 bootstrap 票据，防爬虫 |
| `BRIDGE_JWT_SECRET` | 部署时随机生成，**独立于父目录 `JWT_SECRET`** | relay env（未设时自动生成存 `.data/config.json`） | 签 `userToken`（插件专用，30 天有效） |
| `userToken` | 飞书登录成功后 `/login/feishu-callback` 签发 | `chrome.storage.local.userToken` | 插件调 `/api/me/*` + ws 握手带上代表"已登录" |
| `bpt_xxx` (PAT) | 用户在 popup 点"生成 Token"→ `POST /api/me/tokens` | 明文只在生成响应里出现一次，服务端只存 `SHA-256(明文)` | **给 AI 用**：`Authorization: Bearer bpt_xxx` 调 `/command` |

**两种 token 不要混淆**：`userToken` 是插件自己用的（登录态），`bpt_xxx` 是给 AI 的（授权态）。

## 数据模型

共享父目录 `marketing-agent` 的 `marketing_v01` 库。`users` 表直接复用（`lib/users.ts` 里 lookup-or-create，逻辑独立实现，不跨服务 import backend 代码）。新增 3 张表（migration: `db/migrations/001_bridge_init.sql`，`IF NOT EXISTS` 幂等）：

- `bridge_devices` — `device_id` ↔ `user_id` 绑定 + `device_name`（用户自己在 popup 填）
- `bridge_pairing_tokens` — PAT 的 `token_hash` / `scopes` / `revoked_at` / `expires_at`
- `bridge_audit` — 每次 `/command` 调用落一行（`action`/`status`/`duration_ms`）

## 开发命令

```bash
# Relay 开发（热重载）
cd relay
npm install
DATABASE_URL=postgresql://... BRIDGE_ACCESS_KEY=... BRIDGE_JWT_SECRET=... \
  FEISHU_APP_ID=... FEISHU_APP_SECRET=... BRIDGE_FEISHU_REDIRECT_URI=... npm run dev

# Relay 测试 (真实 pg, 不是 mock —— 起临时容器建表, 跑完记得关)
../scripts/test-db-up.sh
DATABASE_URL="postgresql://postgres:test@localhost:55432/bridge_test" npm test
../scripts/test-db-down.sh    # 用完必须停, 别留着占端口

# Relay 生产构建
npm run build && npm run start

# Extension（产物输出到 extension/dist/）
cd extension
cp src/config.example.ts src/config.ts   # 第一次：填 RELAY_WS_URL + BRIDGE_ACCESS_KEY
npm install && npm run build
npm run dev   # watch 模式
```

**本地全栈联调**：这个 repo 现在是父目录 `local-agent` 的 git subtree，跟 marketing-agent 共用一套 compose：

```bash
cd .. && docker compose -f docker-compose.local.yml -p marketing-v01 --env-file .env.local up -d --build local-bridge
```

## HTTP API

| 端点 | 认证 | 说明 |
|------|------|------|
| `POST /command` | Bearer `bpt_xxx` (PAT) | AI Agent 下发命令，返回 `{ok, result}` |
| `GET /login/feishu` | 无（插件用 `chrome.identity.launchWebAuthFlow` 调）| `?device_id=&redirect_uri=` → 302 到飞书授权页 |
| `GET /login/feishu-callback` | 无（飞书回调）| 换 code → lookup-or-create user → upsert device → 302 回插件带 `userToken` |
| `GET /api/me` | Bearer userToken | 当前用户 + 当前设备信息 |
| `GET /api/me/devices` | Bearer userToken | 我的所有设备（未 disabled） |
| `PATCH /api/me/devices/:id` | Bearer userToken | 改设备名 `{device_name}` |
| `GET /api/me/tokens` | Bearer userToken | 当前设备下的 PAT 列表（不含明文/hash） |
| `POST /api/me/tokens` | Bearer userToken | `{label, scopes, expiresInDays?}` → 返回 `{jti, prefix, plaintext}`（明文只此一次）|
| `DELETE /api/me/tokens/:jti` | Bearer userToken | 撤销 PAT |
| `GET /api/me/audit` | Bearer userToken | 当前用户最近 N 条 `/command` 调用记录 |
| `GET /health` | 无 | 健康检查，返回在线 session 数 |

⚠️ **老的 `/device/authorize` `/device/approve` `/device/token` `/token/agent` `/token/revoke` 端点已删除**（无老用户，直接推倒重来，见 design 段 10）。

## 插件支持的 Action

| Action | 关键参数 | 说明 |
|--------|---------|------|
| `execute` | `scriptId`, `scriptParams?`, `tabId?` | 白名单预定义脚本 |
| `evalScript` | `script`, `tabId?` | 任意 JS，需 relay 层 `ALLOWED_ACTIONS` 开启 |
| `navigate` | `url`, `newTab?`, `tabId?` | 默认新建 tab 加入 AI Group |
| `extract` | `type: text\|html\|title`, `tabId?`, `waitFor?`, `waitTimeout?` | 提取页面内容 |
| `waitForSelector` | `selector`, `tabId?`, `timeout?`, `visible?` | 等 SPA 异步渲染 |
| `cookies` | `domain` | 获取 cookies |
| `tabs` | — | 列出所有 tab |
| `screenshot` | `windowId?` | 截图（PNG dataURL）|

**双层闸门**：请求的 action 必须**同时**在服务器 `ALLOWED_ACTIONS` env 白名单**和** PAT 自己的 `scopes` 里，缺一不可（`routes/command.ts`）。

### ⚠️ evalScript 的 CSP 限制
`evalScript` 在目标 tab 的 MAIN world 里通过 `(0, eval)(scriptString)` 执行，受目标页面 CSP 约束（小红书/B站/微博等大多数中文社媒可用；Twitter/X、GitHub 等严格 CSP 站点会被拒）。这个限制源于 Chrome MV3 + 页面 CSP 的双重约束，无法在 bridge 侧绕过。

## 关键环境变量（relay）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | **必填** | 共享 marketing-agent 的 pg，`postgresql://.../marketing_v01` |
| `BRIDGE_ACCESS_KEY` | **必填** | ws 握手 bootstrap 票据 |
| `BRIDGE_JWT_SECRET` | 未设时自动生成存 `.data/config.json` | 签 userToken，跟父目录 `JWT_SECRET` 独立 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | **必填** | 复用父目录同一个飞书 app |
| `BRIDGE_FEISHU_REDIRECT_URI` | **必填** | 需在飞书 app 后台加白名单 |
| `PORT` | 3020 | HTTP/WS 监听端口 |
| `PUBLIC_URL` | 无（走 Cloudflare Tunnel） | 生产设置跳过 tunnel |
| `ALLOWED_ACTIONS` | `navigate,extract,cookies,tabs,screenshot,execute,waitForSelector` | 服务器层 action 白名单 |
| `RATE_LIMIT_RPM` | 30 | 每 device 每分钟最大命令数，0 不限制 |
| `JITTER_MIN_MS` / `JITTER_MAX_MS` | 500 / 3000 | 命令下发前随机等待 |

## 关键技术决策

### PAT 模型而非 OAuth
内部信任模型下（所有 AI 项目都是团队内部开发的，所有用户都在飞书租户内），OAuth authorization code / client 注册 / PKCE 是过度设计。用户主动生成一个 32 字节随机 token（`bpt_` + 32 字符 base64url + 4 字符校验和）交给 AI，token 即凭据。安全边界是"用户明确同意"这一步（生成 token 的动作本身）+ 随时可撤销。

### 匿名 ws 连接 vs 认证 ws 连接
`SessionStore`（`lib/sessions.ts`）区分两种连接态：握手带了合法 `userToken` 才标记 `authenticated`，`isOnline()` 只认这种连接。匿名连接（没登录，或登出后）仍可连 ws 保活，但 `/command` 派发不到它头上（`503 device_offline`），即使 PAT 本身没过期没撤销。这是独立于 PAT 撤销的第二道闸门——登出 = 立即失效，不用逐个撤销 token。

### 三个 router 挂同一个 app 时中间件必须限定路径
`createMeRouter` 内部 `router.use(requireUserToken(secret))` 如果不加路径前缀，会拦住**同一个 express app 里挂载的其它 router**（包括 `/command`），因为 Express 里 `router.use(mw)` 不限路径时对所有流经这个 router 的请求生效。**必须写成 `router.use('/api/me', mw)`**。这个坑只有把三个 router 拼到一起测才能发现——`tests/integration/app-composition.spec.ts` 专门测这个组合场景，别删。

### 编译时把 ACCESS_KEY 烤进插件
`extension/src/config.ts` 被 gitignore，部署者按 `config.example.ts` 填好后 `npm run build`。

### MV3 Service Worker keepalive
Chrome MV3 的 service worker 30s 无活动会被杀。用 `chrome.alarms`（0.4min 间隔）保活；登录/登出（`userToken` 变化）也会触发立即重连，让认证态马上生效。

### 单连接策略
`SessionStore`: `Map<deviceId, {ws, authenticated}>` 只持有同一 deviceId 的最新一条 ws，新连接来时无条件踢旧连接。不支持多设备并行接收命令。

## Docker / 部署

Bridge 通过 **git subtree** 合入父目录 `local-agent` repo（保留独立 repo `github.com/mikkley/ai-browser-bridge` 用于未来独立开源，双向可 `git subtree push/pull` 同步）。

- `relay/Dockerfile`：多阶段构建，build 阶段含 optionalDependencies（`cloudflared` 类型声明需要），运行阶段 `--omit=optional` 精简
- 父目录 `docker-compose.local.yml` / `docker-compose.production.yml` 里的 `local-bridge` / `marketing-bridge` service
- 父目录 `infra/nginx/marketing-agent.conf` 的 `/bridge/` location 反代（剥前缀，bridge 内部路由不知道 `/bridge` 这层）
- 父目录 `.github/workflows/deploy.yml` 的 migration 循环额外跑 `db/migrations/*.sql`（挂在 marketing-pg 的 `/bridge-migrations` volume）
- pg volumes 里同时挂了 `initdb.d` 一次性脚本（新库首次建表用）+ 整个目录（deploy 时幂等重跑用）

## 安全注意事项
- `.data/` 目录存放 `BRIDGE_JWT_SECRET` 兜底、公网 URL，已 gitignore，绝不提交
- `extension/src/config.ts` 已 gitignore，绝不提交（里面有真实 ACCESS_KEY）
- PAT 明文只在生成响应里出现一次，服务端 `bridge_pairing_tokens.token_hash` 只存 SHA-256，拿到库也还原不出明文
- `bridge_audit` 落库记录每条命令的 `user_id`/`device_id`/`token_jti`/`action`/`status`/`duration_ms`

## 仓库内其他文档
- `docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md`：完整设计文档（数据模型/授权流程/部署/迁移策略）
- `docs/AI_INTEGRATION.md`：给 AI 开发者的接入指南（拿用户的 PAT 后怎么调 `/command`）
- `README.md` / `README.zh.md`：用户向安装手册（装插件 → 飞书登录 → 生成 PAT）
- `AGENT_FULL.md` / `AGENT_MINIMAL.md` / `INTEGRATION.md` / `DEPLOYMENT.md` / `PLATFORM_COMMANDS.md` / `examples/*`：**描述的是已删除的旧 device-flow/agent-jwt 模型，待后续清理/重写**，先看 `docs/AI_INTEGRATION.md`

## 代码规模与脚本边界
- relay 与 extension 各为独立 npm 包，没有 root `package.json`、没有 monorepo 工具
- relay 有 vitest 测试（`relay/tests/`），单元测试不需要 db，集成测试需要 `DATABASE_URL`（见上面开发命令，用 `scripts/test-db-up.sh` 起临时容器）；extension 没有测试，靠 `npm run build`（`tsc --noEmit && vite build`）做类型检查
- relay 入口 `relay/src/server.ts`，extension 后台 `extension/src/background.ts` —— 先读它们再改任何配套
