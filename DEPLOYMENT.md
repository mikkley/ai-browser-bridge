# 部署与交付指引

> ⚠️ **已过期 (2026-07-22)**：部署形态已改成合入父目录 `marketing-agent` 的 Docker Compose（共享 pg + 飞书 app），不再是独立 relay + Cloudflare Tunnel。device flow / agent-jwt 授权部分已删除，改成 PAT 模型。请看 `CLAUDE.md` 的「Docker / 部署」章节 + [`docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md`](docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md)。

本文档面向 ai-browser-bridge 的部署者：自己跑 relay、把插件交付给用户、把 bridge 接到 AI agent（含 opencli 集成）。

适用场景：**1 个 AI Agent 接多个用户的浏览器；同一用户可被多个 AI 对接（不同时间段）；同一时刻每个用户只被一个 AI 操作。**

---

## 0. 总览

```
┌─────────────────────────────────┐
│  你的服务器（一台 1C1G VPS）     │
│  跑 relay/ 整个目录              │
│  https://bridge.your.com        │
└──────────────┬──────────────────┘
               │
       ┌───────┴────────┐
       │                │
┌──────▼────────┐  ┌───▼──────────────────┐
│ 用户的 Chrome │  │ AI Agent 服务器        │
│ 装一个浏览器  │  │ 直接 fetch RELAY_URL   │
│ 插件即可      │  │ 不需要装 bridge 代码   │
└───────────────┘  └──────────────────────┘
```

三端要的东西完全不同 —— 用户拿打包产物、AI 拿凭据、你部署 relay 全套。

---

## 1. 部署 Relay（你的服务器）

### 1.1 系统要求

- Node.js ≥ 18
- 公网域名 + TLS（浏览器插件连 wss 必须 TLS）
  - **境外 / 港澳服务器**：可用 nip.io：`<dashed-ip>.nip.io` 自动解析到 IP，Let's Encrypt 支持，永久免费、零成本
  - **境内服务器（阿里云 / 腾讯云 / 华为云等）**：必须用**已备案**的真实域名。阿里云会主动巡查 IP 上的 80/443 入向流量，未备案 IP（即使套了 nip.io）会被直接屏蔽公网入向 —— 服务能跑但外网连不上。备案下来后绑域名 + Caddy 自动签 Let's Encrypt 即可。换非标端口也躲不过巡查
  - 不想等备案的过渡方案：Cloudflare Tunnel（见 `relay/src/tunnel.ts`，已设为 optionalDependencies），或临时用海外小机器跑 relay
- 1C1G 起步够用（瓶颈是 ws 连接数，不是 CPU）

### 1.2 启动

```bash
# 把整个 relay/ 目录上传到服务器（推荐用 tar 管道，避开 macOS rsync 兼容问题）
tar czf - --exclude='node_modules' --exclude='.data' --exclude='dist' relay \
  | ssh root@<server> 'cd /opt/ai-browser-bridge && tar xzf -'

# 服务器上装依赖、build
ssh root@<server>
cd /opt/ai-browser-bridge/relay

# 境内服务器：用淘宝镜像 + 跳过 postinstall（cloudflared 二进制下载会卡 GitHub releases）
# cloudflared 是 optionalDependencies，设了 PUBLIC_URL 后根本不会用到
npm config set registry https://registry.npmmirror.com
npm install --ignore-scripts --no-audit --no-fund
npm run build

# 第一次：生成 ACCESS_KEY，存好（待会儿要烤进插件）
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
# 例如得到：fWssOUF9rxPAcJ957CYDgMvKtQBcq44B

# 用环境变量启动（缺 BRIDGE_ACCESS_KEY 时进程直接退出）
PUBLIC_URL=https://your-domain.com \
BRIDGE_ACCESS_KEY=fWssOUF9rxPAcJ957CYDgMvKtQBcq44B \
  npm start
```

首次启动会在 `.data/config.json` 自动生成两把密钥（`jwtSecret` / `relaySecret`）。**记下控制台打印的 `Access key` 和 `Relay secret`**：access key 要烤进插件 zip，relay secret 给 AI Agent 端做内部签发。

> 🌏 **境内部署提示**：`cloudflared` 这个 npm 依赖的 postinstall 会从 GitHub releases 下载二进制，境内常常卡死。它已被声明为 `optionalDependencies` —— 设了 `PUBLIC_URL` 的部署不会调用 tunnel，安装时加 `--ignore-scripts` 直接跳过即可。

### 1.3 反向代理（必要）

Caddy（推荐，自动 Let's Encrypt 证书）：

```caddy
your-domain.com {
    reverse_proxy localhost:3000
}
```

Anolis / Alibaba Cloud Linux 3 / RHEL 系装 Caddy：
```bash
dnf install -y caddy
# Caddyfile 放 /etc/caddy/Caddyfile
systemctl enable --now caddy
```

Caddy **默认就支持 WebSocket 反代**，不需要额外配置 upgrade header。Caddy 的自动 HTTPS 会把 80 重定向到 443 + 自动签发并续期 TLS 证书。

Nginx 替代：
```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    # ssl_certificate ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

### 1.4 进程守护

systemd 单元（`/etc/systemd/system/ai-browser-bridge.service`）：
```ini
[Unit]
Description=AI Browser Bridge Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-browser-bridge/relay
Environment=NODE_ENV=production
Environment=PUBLIC_URL=https://your-domain.com
Environment=BRIDGE_ACCESS_KEY=<your-access-key>
Environment=ALLOWED_ACTIONS=navigate,extract,cookies,tabs,screenshot,execute,evalScript,waitForSelector
Environment=PORT=3000
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

> ⚠️ `ALLOWED_ACTIONS` 加 `evalScript` 才能让 opencli adapter 工作，但同时也意味着持有 agent-jwt 的人能在用户浏览器执行任意 JS。如果你不打算用 opencli，把这一项去掉。
>
> 🔧 **Node 路径**：如果服务器用 conda / nvm / fnm 管理 Node，`/usr/bin/node` 不存在。用 `which node && readlink -f $(which node)` 找到真实路径填到 `ExecStart`。例如 conda 环境通常是 `/root/miniconda3/bin/node`。

启动：
```bash
systemctl daemon-reload
systemctl enable --now ai-browser-bridge
journalctl -u ai-browser-bridge -f   # 看实时日志
```

### 1.5 健康检查 & 阿里云安全组

```bash
curl https://your-domain.com/health
# {"ok":true,"sessions":0}
```

> ☁️ **阿里云用户**：除了系统防火墙，**ECS 安全组**还要在控制台手动放行入方向 TCP `80` 和 `443`（来源 `0.0.0.0/0`）。否则 Caddy 签 Let's Encrypt 证书的 HTTP-01 challenge 会失败，外网也连不上 wss。

---

## 2. 把插件交付给用户

### 2.1 打包

```bash
cd extension
# 第一次：填入 ACCESS_KEY（gitignore，不会进 git，但会烤进 dist/）
cp src/config.example.ts src/config.ts
# 编辑 src/config.ts，把 RELAY_WS_URL 改成你的 wss://your-domain.com/ws，
# BRIDGE_ACCESS_KEY 填和 relay 一样的那串
npm install
npm run build
```

把以下内容**整体打成 zip** 给用户：

```
ai-browser-bridge-extension/
├── manifest.json
├── popup.html
├── dist/
│   ├── background.js     ← ACCESS_KEY 已烤进里面
│   └── popup.js
└── icons/
    ├── icon16.png  /  icon16_active.png
    ├── icon48.png  /  icon48_active.png
    └── icon128.png /  icon128_active.png
```

不要包含 `src/`、`node_modules/`、`package.json`、`vite.config.ts`、`tsconfig.json`。**`src/config.ts` 里有真实 ACCESS_KEY，绝不要 commit**（已 gitignore）。

### 2.2 用户安装步骤（写到给用户的说明里）

1. 解压 zip 到任意位置（**不要删除这个文件夹**，删了插件就没了）
2. Chrome 打开 `chrome://extensions/`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选刚才解压出的目录
5. 插件出现在工具栏，几秒后图标自动变绿（连上 relay 了，零配置）

### 2.3 没有"配对"步骤

零身份化模型：插件首次启动会自动 `crypto.randomUUID()` 生成 `clientId` 存进 `chrome.storage.local`，然后用 ACCESS_KEY（编译时已烤进 dist）连 relay。用户什么都不用粘。

用户点插件图标可以看到自己的 `clientId`（一串 UUID），把它发给 AI 操作者 —— 这个就是 AI 端的 `userId`。`clientId` 永远不变（除非用户清了 chrome storage 或换浏览器）。

### 2.4 长期分发（可选）

要免去"开发者模式 + 加载已解压"的步骤：上 Chrome Web Store 发一次，给用户的就只是一个安装链接。企业内部用就 zip 直发就够。

---

## 3. AI Agent 端集成

**AI Agent 服务器不需要这个 repo 的任何代码。** 给 AI 三样东西：

| 信息 | 来源 |
|---|---|
| `RELAY_URL` | `https://bridge.your.com` |
| `RELAY_SECRET` | relay 启动日志，或 `BRIDGE_ACCESS_KEY=... npm run info` |
| 允许操作的 `userId` 列表（即用户的 `clientId`） | 用户在自己的插件 popup 里复制后发给你 |

> ℹ️ **没有 user-jwt / connectCode 概念了**。每个用户的浏览器有一个长期不变的 `clientId`（UUID，由插件本地生成），这就是 AI 端要传的 `userId`。AI Agent 端**不需要**持有 `BRIDGE_ACCESS_KEY` —— 那东西只用于插件 ws 握手和 popup 调 `/device/approve` `/audit`。

> ⚡ **场景驱动的选型**：先决定 agent 怎么拿到访问权，再看代码示例。
>
> | 你的 agent 是 | 推荐路径 | 是否需要 RELAY_SECRET |
> |---|---|---|
> | 第三方 AI（如 ChatGPT / Claude / Kimi 对话场景）| **§3.0 Device Flow** | ❌ 不需要 |
> | 你自己的多用户 SaaS 后端 | §3.1 直接签发 | ✅ 后端持有 |
> | 你/同事内部小工具 | §3.1 直接签发（手动签）| ✅ 你 ssh 服务器 |

### 3.0 Device Authorization Flow（用户主动授权，不需要 RELAY_SECRET）

适用于**临时性、对话式**场景：用户在跟 AI 聊天时突然让 AI 操作浏览器，AI 之前没访问权。AI 不该有 RELAY_SECRET，授权由用户主动给。

#### 时序

```
AI agent → POST /device/authorize {agentId} → relay 返 user_code "ABCD-1234" + device_code
   ↓
AI agent 告诉用户："请在 Chrome 插件 popup 输这串：ABCD-1234"
   ↓
用户：点插件 → "Authorize an AI agent" → 输码 → 选时长（默认 1 小时）→ Approve
   ↓
AI agent 轮询 POST /device/token → 拿到短期 agent-jwt
   ↓
AI agent 用 agent-jwt 调 /command 操作浏览器（默认 1 小时内有效）
```

#### AI Agent 代码

```js
// 1. 请求授权（无需 RELAY_SECRET）
const { user_code, device_code, expires_in, interval } = await fetch(`${RELAY_URL}/device/authorize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: 'kol-analyzer' }),
}).then(r => r.json())

// 2. 把 user_code 显示给用户
console.log(`请在 Chrome 插件 popup 里输入授权码：${user_code}（${expires_in/60}分钟内有效）`)

// 3. 轮询拿 token
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let token, userId
const deadline = Date.now() + expires_in * 1000
while (Date.now() < deadline) {
  await sleep(interval * 1000)
  const r = await fetch(`${RELAY_URL}/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code }),
  }).then(r => r.json())
  if (r.ok) { token = r.token; userId = r.userId; break }
  if (r.error === 'expired_token' || r.error === 'access_denied') throw new Error(r.error)
  // 'authorization_pending' → 继续等
}
if (!token) throw new Error('用户未在限期内授权')

// 4. 用 token 调 /command（默认 1 小时内有效，不续期）
await fetch(`${RELAY_URL}/command`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, action: 'tabs', params: {} }),
})
```

#### 安全特性

- ✅ AI 永远不持有 RELAY_SECRET
- ✅ 授权来自用户**显式同意**（在浏览器插件输码 + 选时长）
- ✅ token 短期（默认 1 小时，最长 7 天，由用户在 popup 选）
- ✅ device_code / user_code 10 分钟内未授权自动过期
- ✅ user_code 单次使用（拿到 token 后立即标记 consumed）
- ✅ 用户能在 popup 看到是哪个 `agentId` 在请求授权

#### 用户体验话术（AI 给用户说什么）

> "我需要操作你的浏览器才能完成这个任务。请打开 Chrome 右上角的 AI Browser Bridge 插件，点 'Authorize an AI agent'，输入这串授权码：**ABCD-1234**（10 分钟内有效）。"

### 3.1 直接调 API（部署者主动签发）

```js
// 启动时为每个允许操作的用户拿一个 agent-jwt（绑定 userId，90d 有效）
const { token } = await fetch(`${RELAY_URL}/token/agent`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agentId: 'my-ai-agent',
    allowedUserId: 'user_123',
    secret: RELAY_SECRET,
  }),
}).then(r => r.json())

// 之后下发命令
const res = await fetch(`${RELAY_URL}/command`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user_123',
    action: 'navigate',
    params: { url: 'https://www.xiaohongshu.com', newTab: true },
  }),
}).then(r => r.json())
// res = { ok: true, data: { tabId: 123 } }
```

支持的 action 见 `CLAUDE.md` 的 "插件支持的 Action" 表。

#### AI Agent 端必须处理的几种返回

bridge 返回的不止 `{ok:true, data:...}` 一种，agent 代码必须分支处理 —— 否则用户暂停 / 浏览器掉线 / token 越权时会出现"agent 一直转圈跑废步骤"的故障。

| HTTP | body / error | 含义 | agent 应该怎么做 |
|---|---|---|---|
| 200 | `{ok:true, data}` | 正常 | 继续下一步 |
| 200 | `{ok:false, error:'User paused AI access'}` | 🛑 **用户主动暂停了 AI 操作权** | 不要重试，把任务暂存或退出，等用户在 popup 上点 Resume |
| 200 | `{ok:false, error:'Timeout (...) waiting for selector: ...'}` | waitForSelector 超时 | selector 不存在或页面没加载完，可能要换 selector 或拉长 timeout |
| 200 | `{ok:false, error:'No AI tab. Call navigate first ...'}` | 当前没有 AI tab 可用 | 先调 navigate 创建一个 |
| 401 | `{error:'Invalid agent token'}` | token 错 / 已被吊销 / jwtSecret 轮换 | 通知部署者，agent 自己解决不了 |
| 403 | `{error:'Forbidden: userId mismatch'}` | agent-jwt 绑的 userId 跟请求的不符 | 编排错误，检查 token 池映射 |
| 403 | `{error:'Action not allowed: ...'}` | relay 的 ALLOWED_ACTIONS 没开这个 action | 通知部署者放开权限 |
| 429 | `{error:'Rate limit exceeded', retryAfterMs}` | 触发频控 | 按 `retryAfterMs` sleep 后重试 |
| 503 | `{error:'User browser not connected'}` | 用户浏览器离线（关了 / 网断了 / 插件没启动）| 等 30s-N 分钟后重试，或通知调用者 |

最关键：**`'User paused AI access'` 不能重试** —— 用户主动按下了暂停键。如果 agent 不停重试，会污染 audit log、给用户带来骚扰感。识别这个 error 后让任务**等待用户操作**或**直接终止**。

```js
// 推荐封装
async function call(action, params) {
  const res = await fetch(`${RELAY_URL}/command`, { ... })
  const json = await res.json()
  if (json.error === 'User paused AI access') {
    throw new UserPausedError()  // 上层捕获 → 暂停整个工作流
  }
  if (!json.ok) {
    throw new BridgeError(json.error)
  }
  return json.data
}
```

#### 操作 SPA 应用（小红书/B站/腾讯互选等都是 SPA）

`navigate` 后 Chrome 上报的 `complete` 状态只代表**初始 HTML 加载完**，业务数据是 SPA 后续 fetch 拉来再渲染的。直接 `extract` 会拿到空骨架。**正确的序列是 navigate → waitForSelector → extract**：

```js
// 步骤 1：navigate 创建 AI tab，拿到 tabId
const navRes = await call('navigate', { url: 'https://huxuan.qq.com/creator-square' })
const tabId = navRes.data.tabId

// 步骤 2：等业务内容渲染完成（看页面里哪个 selector 是数据出现的标志）
await call('waitForSelector', {
  tabId,
  selector: '.creator-card',     // 选一个只有数据加载完才会出现的元素
  timeout: 15000,                // 默认 10s，慢页面拉到 15-30s
  visible: true,                 // 可选：只接受可见元素，过滤掉 display:none 占位
})

// 步骤 3：extract 拿真实 DOM
const extractRes = await call('extract', { tabId, type: 'html' })
```

`extract` 也可以一步把 wait 合并进去（语义糖）：
```js
await call('extract', {
  tabId,
  type: 'html',
  waitFor: '.creator-card',     // 等价于先 waitForSelector 再 extract
  waitTimeout: 15000,
})
```

**SPA 内部路由切换**（在已存在 tab 里点 a 标签换路由，URL 变但不重新加载页面）—— bridge 没有内置这个，因为 chrome 的 onUpdated 不会触发。用 `evalScript` 模拟点击 + `waitForSelector` 等新内容：
```js
// 假设页面上有路由链接
await call('evalScript', { tabId, script: 'document.querySelector("a[href=\'/dashboard\']").click()' })
await call('waitForSelector', { tabId, selector: '.dashboard-loaded' })
await call('extract', { tabId, type: 'html' })
```

#### 登录态绑 React state 的 SPA（huxuan、企业后台等）

很多企业级 SPA（腾讯互选、内部 admin 系统）用的是 react-router + redux/zustand store 的组合，URL 里包含 `advertiser_id` / `org_id` 这类账户标识，但这个标识**不在 cookie 也不在 URL 持久 state 里**，是用户登录后由内部接口拉取再持久到 react state。

直接 navigate 这种 URL 一定失败 —— SPA 的 router guard 看到没有对应 state 就把你打回登录页或匿名首页。Playwright/CDP 也会遇到同样问题，**这不是 bridge 的限制**。

正确做法：**用户提供登录态，AI 接管抓取**。

```js
// 1. 用户先自己在浏览器里手动进入目标后台（一次性）
//    比如登录 huxuan → 进广告主后台 → 点"创作者广场"

// 2. AI 通过 tabs 找到那个已登录的 tab
const tabsRes = await call('tabs')
const targetTab = tabsRes.data.find(t =>
  t.url.includes('your-saas.com') && t.url.includes('/data-page')
)

// 3. 在那个 tab 上 waitForSelector + extract / evalScript 结构化提取
await call('waitForSelector', { tabId: targetTab.id, selector: '.data-row' })
const data = await call('evalScript', {
  tabId: targetTab.id,
  script: '(()=>{return JSON.stringify([...document.querySelectorAll(".data-row")].map(r=>({...})))})()',
})
```

这是 bridge 的**最佳使用场景** —— 用户提供身份，AI 利用真实会话抓数据，既不需要逆向 SPA，也不抢屏。

### 3.2 用 opencli 做社媒采集（推荐）

如果 AI 的任务是采集小红书/B站/微博/抖音/TikTok 内容，**强烈建议走 opencli**，不要自己写 selector。opencli 把这些平台的搜索/评论/用户主页 API 都封装好了，配合 bridge 就是远端用户浏览器跑 opencli。

#### 3.2.1 在 AI 服务器装 opencli

```bash
# 假设 opencli 已经发布到 npm 或私有源
npm install -g @opencli/cli
# 或从源码安装：cd /path/to/opencli && npm install && npm link
```

#### 3.2.2 启动 adapter（HTTP daemon）

`examples/adapter.mjs` 是这个 repo 里的一个文件，把它拷到 AI 服务器：

```bash
RELAY_URL=https://bridge.your.com \
RELAY_SECRET=<from-relay-info> \
USER_ID=user_123 \
AGENT_ID=opencli \
node adapter.mjs
# 监听 :19826
```

每个用户开一个 adapter 进程（端口要错开：19826、19827...），或者把 adapter 改造成多用户路由。

#### 3.2.3 调 opencli 命令

```bash
# 小红书搜索
OPENCLI_DAEMON_PORT=19826 opencli xiaohongshu search "AI眼镜" --limit 20

# B站视频评论
OPENCLI_DAEMON_PORT=19826 opencli bilibili comments BV1WtAGzYEBm --limit 50

# 微博搜索
OPENCLI_DAEMON_PORT=19826 opencli weibo search "宠物" --limit 10
```

完整命令见 `PLATFORM_COMMANDS.md`（同一仓库内），或 opencli 自身的 `SKILL.md`。

> ⚠️ **opencli 的 `exec` 会被翻译成 bridge 的 `evalScript`，受目标页面 CSP 约束**。中文社媒（小红书、B站、微博、抖音）都没问题；Twitter/X、GitHub、Stripe 等严格 CSP 站点会被拒绝。详见 `examples/adapter.mjs` 头注释。

### 3.3 多用户场景的工程纪律

你说的"1 AI 接多个用户"场景，按下面三点做就稳：

1. **每个用户一个 agent-jwt**，绑定 `allowedUserId`，AI 内存里维护 `Map<userId, agentJwt>`
2. **每个用户一个 adapter 进程**（如果用 opencli），端口区分
3. **AI 内部按用户串行调度**，不要并发对同一用户下命令 —— relay 默认 30 RPM 限流，但更重要的是同用户的浏览器 active tab 只有一个，多 AI 抢 tab 会读到错的页面

### 3.4 多 AI 对接同一用户

天然支持：每个 AI 申请自己的 agent-jwt（绑定同一个 `allowedUserId`），命令通过 `commandId` 串行下发互不干扰。**但 tab 是共享的**——AI 之间要约定不要同时操作；建议每个 AI 用 `navigate { newTab: true }` 创建自己的 tab，后续操作显式带 `tabId`。

---

## 4. 凭据管理

| 凭据 | 长度 | 谁持有 | 怎么吊销 |
|---|---|---|---|
| `BRIDGE_ACCESS_KEY` | 24 字节 base64url | relay env + 所有插件 zip | 改 env 重启 relay 并重新打包/分发插件 zip（旧 zip 全部失效）|
| `RELAY_SECRET` | 32 字节 hex | 你 + AI 端 | 删 `.data/config.json` 重启（会让所有现存 token 失效）|
| agent-jwt | 90d（device flow 默认 1h） | AI Agent | `POST /token/revoke` |
| `clientId` | UUID | 用户的浏览器（chrome.storage） | 用户清 chrome storage 或重装插件时换号 |

吊销示例：
```bash
curl -X POST https://bridge.your.com/token/revoke \
  -H 'Content-Type: application/json' \
  -d '{"token":"eyJhbGc...","secret":"<RELAY_SECRET>"}'
```

吊销记录写入 `.data/revoked.json`，relay 重启后仍然生效。

---

## 5. 监控与排查

| 现象 | 排查方向 |
|---|---|
| 用户图标一直灰色 | 1) 检查 relay 公网 URL：`curl https://bridge.your.com/health` 2) 插件 popup 看到 `clientId` 但状态 Not connected → 检查插件 `src/config.ts` 里 ACCESS_KEY 和 relay env 是否一致 3) DevTools 看插件 background console 是否报 4001 (Invalid access key) / 4002 (Invalid clientId) |
| AI 调 `/command` 返回 503 | 用户浏览器没在线（`{ok:true,sessions:N}` 看 N）|
| AI 调 `/command` 返回 401 | agent-jwt 错或被吊销，重新申请 |
| AI 调 `/command` 返回 403 `userId mismatch` | agent-jwt 绑定的是 user A，请求传的 userId 是 user B |
| popup 点 Approve 报 `clientId is not online` | 插件 ws 当前没连上，先点 Reconnect 按钮等图标变绿再 Approve |
| popup 调 `/audit` 返回 401 `Invalid access key` | 编译时 ACCESS_KEY 和 relay 不一致，重新打包插件 |
| `evalScript` 报 CSP 错 | 目标站点 CSP 严格，opencli 的 `exec` 走不通；改用具名脚本走 `execute` |

审计日志在 `.data/audit.log`，每条命令都有记录（agentId / userId / action / ok）。

---

## 6. 升级与回滚

- relay：拉新代码 → `npm install --ignore-scripts && npm run build && systemctl restart ai-browser-bridge`。`.data/` 不动，密钥和会话不丢
- 插件：重新打包给用户。**重大版本升级时要让用户重装**（删旧的，加载新的）。`clientId` 保存在 chrome.storage，重装/重载不丢；只有用户主动清 chrome 数据才会重置
- AI Agent 端：因为没装这个 repo 的代码，不存在升级

---

## 7. 给 AI Agent 端打包交付

把以下三样打成 zip 发给 AI 开发者，凭据**单独发**（不要塞进包里）：

```
agent-integration-pack/
├── DEPLOYMENT.md         ← 重点看 §3 §4 §5
├── PLATFORM_COMMANDS.md  ← opencli 各平台命令清单
├── adapter.mjs           ← 从 examples/adapter.mjs 拷贝
└── README.txt            ← 三步走：装 opencli → 起 adapter → 跑命令
```

`README.txt` 模板：

```text
集成 ai-browser-bridge 三步走：

1. 装 opencli：
     npm install -g @opencli/cli   （或从源码 npm link）

2. 起 adapter（每用户一个进程）：
     RELAY_URL=https://bridge.your.com \
     RELAY_SECRET=<另发> \
     USER_ID=<用户id> \
     AGENT_ID=<你的agent名> \
     node adapter.mjs

3. 调命令：
     OPENCLI_DAEMON_PORT=19826 opencli xiaohongshu search "AI眼镜"

详见 DEPLOYMENT.md §3、PLATFORM_COMMANDS.md。
凭据 RELAY_URL / RELAY_SECRET / USER_ID 列表请向部署者索取。
```

打包脚本（在 repo 根目录跑）：

```bash
mkdir -p /tmp/agent-integration-pack
cp DEPLOYMENT.md PLATFORM_COMMANDS.md /tmp/agent-integration-pack/
cp examples/adapter.mjs /tmp/agent-integration-pack/
# 写 README.txt（按上面模板）
cd /tmp && zip -r agent-integration-pack.zip agent-integration-pack/
```
