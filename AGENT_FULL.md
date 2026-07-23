# ai-browser-bridge — AI Agent 集成（完整版）

> ⚠️ **已过期 (2026-07-22)**：本文档描述的 `agent-jwt` / `/token/agent` / device flow 已被删除，改成 PAT 模型 (`Authorization: Bearer bpt_xxx`)。请看 [`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)。opencli adapter 集成部分（`examples/adapter.mjs`）待后续更新。

你是接入 ai-browser-bridge 的 AI Agent，目标是通过部署者的 relay 服务**静默操作**某个用户的 Chrome 浏览器（不抢用户的鼠标），常用于社媒数据采集 / SaaS 后台抓取 / 跑用户的登录态。

本文档是你需要的**全部**信息：协议、错误处理、SPA 操作技巧、opencli 集成、社媒命令清单、多用户工程纪律。一份读完就够。

---

## 1. 你和 bridge 的关系

```
你（AI Agent，服务器）
   │  HTTPS：POST /command  Bearer <agent-jwt>
   ▼
bridge relay（部署者维护，公网 https/wss）
   │  WebSocket：浏览器主动连出
   ▼
用户的 Chrome + AI Browser Bridge 插件（已登录态完整）
   │  chrome.scripting.executeScript （静默执行，不抢鼠标）
   ▼
小红书 / B站 / 微博 / 你公司的 SaaS 后台 / ……
```

你**不需要**这个 repo 的任何代码，只需要 fetch 一个 HTTPS API。

---

## 2. 你需要的凭据（部署者单独发，不要写进文档里）

| 凭据 | 拿到方式 | 用途 |
|---|---|---|
| `RELAY_URL` | 例如 `https://bridge.example.com` | 所有 API base |
| `agent-jwt` | 部署者用 `RELAY_SECRET` 调 `/token/agent` 签好后发给你 | 调 `/command` 的 Bearer token |
| `userId` | 用户从 Chrome 插件 popup 复制后发给部署者，再转给你 | 你被授权操作的浏览器 ID（UUID）|

**你不需要也不应该持有** `BRIDGE_ACCESS_KEY`（插件 ws 握手用）和 `RELAY_SECRET`（部署者内部签发用）。

如果你的场景是"用户在对话中临时授权"而不是部署者预签发，看本文 §9 Device Flow。

---

## 3. 唯一要调的 API：`POST /command`

```js
const res = await fetch(`${RELAY_URL}/command`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${AGENT_JWT}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    userId: USER_ID,
    action: 'navigate',
    params: { url: 'https://www.xiaohongshu.com', newTab: true },
  }),
})
const json = await res.json()
// { ok: true, data: { tabId: 123 } }  或  { ok: false, error: '...' }
```

---

## 4. 全部 action

| action | params | 返回 data | 说明 |
|---|---|---|---|
| `navigate` | `{ url, newTab?, tabId? }` | `{ tabId }` | 默认新建 tab 加入"AI Agent"分组；传 `tabId` 才复用已有 tab。**永远不会抢用户当前看的 tab** |
| `tabs` | — | `[{ id, url, title, active }]` | 列所有 tab |
| `extract` | `{ type, tabId?, waitFor?, waitTimeout? }` | string | `type` 取 `text`/`html`/`title`。可选 `waitFor` selector 先等再提取 |
| `waitForSelector` | `{ selector, tabId?, timeout?, visible? }` | `{ matched, count, elapsed }` | 等 selector 出现，timeout 默认 10000ms；`visible:true` 只接受可见元素 |
| `execute` | `{ scriptId, scriptParams?, tabId? }` | 由脚本决定 | 跑插件内置白名单脚本，scriptId 可取：`page.getTitle` / `page.getText` / `page.getHtml` / `page.getUrl` |
| `evalScript` | `{ script, tabId? }` | 脚本返回值 | 跑任意 JS。**双重门槛**：relay 必须开了这个 action，且目标页面 CSP 必须允许 `unsafe-eval` |
| `cookies` | `{ domain }` | `Cookie[]` | 取该域名下所有 cookies |
| `screenshot` | `{ windowId? }` | PNG dataURL | 截当前活动窗口 |

**`tabId` 省略时**：所有操作落到"AI Agent" tab 分组里最近活跃的 tab。**第一次操作前必须先 `navigate`** 创建 AI tab，否则报 `No AI tab. Call navigate first`。

**`execute` vs `evalScript`**：
- `execute` 只允许插件内置的 4 个具名脚本（无 CSP 问题，任何站点都能跑）
- `evalScript` 接受任意字符串，由 `(0, eval)(s)` 在 MAIN world 执行

---

## 5. ⚠️ evalScript 的 CSP 限制

`evalScript` 在目标 tab 的 MAIN world 通过 `(0, eval)(scriptString)` 执行。**目标页面的 CSP 决定能否执行**：

- ✅ 无 CSP 或允许 `unsafe-eval` 的站点 —— 小红书、B 站、微博、抖音、知乎等中文社媒
- ❌ 严格 CSP —— Twitter/X、GitHub、Google 多数产品、Stripe 等

被 CSP 拒时的错误：

```
Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script
```

绕不过去（Chrome MV3 + 页面 CSP 的双重约束）。要操作严格 CSP 站点，只能让部署者在插件 `ALLOWED_SCRIPTS` 注册具名函数，然后你走 `execute` 通道。

---

## 6. 必须处理的返回分支

| HTTP | body | 含义 | 你该怎么做 |
|---|---|---|---|
| 200 | `{ ok: true, data }` | 正常 | 继续 |
| 200 | `{ ok: false, error: 'User paused AI access' }` | 🛑 **用户在插件里按了暂停** | **不要重试**。暂存任务，告诉调用方"用户暂停了"，等他在 popup 点 Resume |
| 200 | `{ ok: false, error: 'Timeout (...) waiting for selector: ...' }` | waitForSelector 超时 | 换 selector 或拉长 timeout |
| 200 | `{ ok: false, error: 'No AI tab. Call navigate first ...' }` | 当前没 AI tab | 先 navigate |
| 401 | `{ error: 'Invalid agent token' }` | token 错/吊销/jwtSecret 轮换 | 找部署者 |
| 403 | `{ error: 'Forbidden: userId mismatch' }` | 你传的 userId 跟 token 绑定的不一致 | 检查 token 池 |
| 403 | `{ error: 'Action not allowed: ...' }` | relay 禁用了这个 action（默认禁 evalScript）| 找部署者放开 |
| 429 | `{ error: 'Rate limit exceeded', retryAfterMs }` | 触发限流（默认 30/min/用户）| sleep `retryAfterMs` 后重试 |
| 503 | `{ error: 'User browser not connected' }` | 用户浏览器离线（关了 / 网断 / 插件没启动）| 等用户上线或汇报给调用方 |

**最关键**：`'User paused AI access'` **不能重试**。用户主动按下了暂停键，重试会污染 audit log、骚扰用户。识别后让任务**等待用户操作**或**直接终止**。

推荐封装：

```js
class UserPausedError extends Error {}
class BridgeError extends Error {}

async function call(action, params) {
  const res = await fetch(`${RELAY_URL}/command`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AGENT_JWT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId: USER_ID, action, params }),
  })
  const json = await res.json()
  if (json.error === 'User paused AI access') throw new UserPausedError()
  if (res.status === 429) {
    await sleep(json.retryAfterMs || 5000)
    return call(action, params)
  }
  if (!json.ok) throw new BridgeError(json.error)
  return json.data
}
```

---

## 7. 操作 SPA 的标准序列

`navigate` 触发的 `complete` 状态只代表**初始 HTML 加载完**，业务数据是 SPA 后续 fetch 拉来再渲染的。直接 `extract` 会拿到空骨架。

**正确序列：navigate → waitForSelector → extract**

```js
// 创建 AI tab
const { tabId } = await call('navigate', { url: 'https://huxuan.qq.com/creator-square' })

// 等业务内容渲染完成（选一个"数据加载完才出现"的 selector）
await call('waitForSelector', {
  tabId,
  selector: '.creator-card',
  timeout: 15000,
  visible: true,
})

// 拿真实 DOM
const html = await call('extract', { tabId, type: 'html' })
```

可以把 wait 合到 extract（语义糖）：

```js
await call('extract', {
  tabId,
  type: 'html',
  waitFor: '.creator-card',
  waitTimeout: 15000,
})
```

**SPA 内部路由切换**（点链接换路由、URL 变但页面不重载）—— bridge 没有内置事件，用 `evalScript` 模拟点击 + 再 `waitForSelector` 等新内容：

```js
await call('evalScript', { tabId, script: 'document.querySelector("a[href=\'/dashboard\']").click()' })
await call('waitForSelector', { tabId, selector: '.dashboard-loaded' })
await call('extract', { tabId, type: 'html' })
```

---

## 8. 登录态绑 React state 的 SPA（huxuan、企业后台）

很多企业级 SPA（腾讯互选、内部 admin 系统）的 URL 含 `advertiser_id` / `org_id` 这类账户标识，但这个标识**不在 cookie 也不在 URL 持久 state**，是登录后内部接口拉来持久到 react state 的。

直接 navigate 这种 URL **一定失败** —— router guard 看到没对应 state 会把你打回登录页或匿名首页。Playwright/CDP 也一样，**这不是 bridge 限制**。

正确做法：**用户提供登录态，AI 接管抓取**：

```js
// 1. 用户先自己在浏览器手动进入目标后台（一次性）
//    例如登录 huxuan → 进广告主后台 → 点"创作者广场"

// 2. AI 用 tabs 找到那个已登录的 tab
const tabs = await call('tabs')
const target = tabs.find(t => t.url.includes('huxuan.qq.com') && t.url.includes('/creator-square'))

// 3. 在那个 tab 上 waitForSelector + extract / evalScript
await call('waitForSelector', { tabId: target.id, selector: '.data-row' })
const data = await call('evalScript', {
  tabId: target.id,
  script: '(()=>JSON.stringify([...document.querySelectorAll(".data-row")].map(r=>({title:r.querySelector(".title")?.innerText}))))()',
})
```

这是 bridge 的**最佳使用场景** —— 用户提供身份，AI 利用真实会话抓数据，不需要逆向 SPA，不抢屏。

---

## 9. Device Flow（用户临时授权场景）

如果你**没有预先拿到的 `agent-jwt`**，而是用户在对话中临时让你操作他的浏览器：

```js
// 1. 申请授权（不需任何 secret）
const r1 = await fetch(`${RELAY_URL}/device/authorize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: 'my-agent-name' }),
}).then(r => r.json())
// { device_code, user_code: 'ABCD-1234', expires_in, interval, verification_uri: 'browser-extension-popup' }

// 2. 告诉用户：在 Chrome 插件 popup 点 "Authorize an AI agent"，输 user_code，选时长
console.log(`授权码：${r1.user_code}（${r1.expires_in / 60} 分钟内有效）`)

// 3. 轮询拿 token
const sleep = ms => new Promise(r => setTimeout(r, ms))
let token, userId
const deadline = Date.now() + r1.expires_in * 1000
while (Date.now() < deadline) {
  await sleep(r1.interval * 1000)
  const r2 = await fetch(`${RELAY_URL}/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: r1.device_code }),
  }).then(r => r.json())
  if (r2.ok) { token = r2.token; userId = r2.userId; break }
  if (r2.error === 'expired_token' || r2.error === 'access_denied') throw new Error(r2.error)
  // 'authorization_pending' → 继续
}
if (!token) throw new Error('用户未在 10 分钟内授权')

// 4. 用 token 调 /command（默认 1 小时，用户在 popup 可选 15min / 1h / 4h / 1 天）
```

**给用户的话术模板**：

> "我需要操作你的浏览器才能完成这个任务。请打开 Chrome 右上角的 AI Browser Bridge 插件，点 'Authorize an AI agent'，输入这串授权码：**ABCD-1234**（10 分钟内有效）。"

安全特性：
- 你永远不持有 RELAY_SECRET
- 授权来自用户**显式同意**
- token 短期有效，过期后必须重新走流程

---

## 10. 用 opencli 做社媒采集（推荐）

如果你的任务是采集小红书/B站/微博/抖音/TikTok 内容，**强烈建议走 opencli**，不要自己写 selector。opencli 把这些平台的搜索/评论/用户主页 API 都封装好了。

### 10.1 在你的服务器装 opencli + adapter

```bash
# 装 opencli（部署者会告诉你具体的安装方式）
npm install -g @opencli/cli

# 起 adapter（每个目标用户一个进程）
RELAY_URL=https://bridge.example.com \
RELAY_SECRET=<部署者给你的> \
USER_ID=<用户的 clientId> \
AGENT_ID=opencli \
node adapter.mjs
# 监听 :19826
```

⚠️ **只有走 opencli 路径**才需要 `RELAY_SECRET`（adapter 内部用来签 agent-jwt）。如果走 §3 直接调 `/command` 不需要。

多用户场景：每个用户开一个 adapter 进程，端口错开（19826 / 19827 / …）。

### 10.2 调命令

```bash
# 小红书搜索
OPENCLI_DAEMON_PORT=19826 opencli xiaohongshu search "AI眼镜" --limit 20

# B 站视频评论
OPENCLI_DAEMON_PORT=19826 opencli bilibili comments BV1WtAGzYEBm --limit 50

# 微博搜索
OPENCLI_DAEMON_PORT=19826 opencli weibo search "宠物" --limit 10
```

### 10.3 平台命令清单

#### 小红书

```bash
opencli xiaohongshu search "关键词" --limit 20         # 搜笔记
opencli xiaohongshu comments <note-id> --limit 20      # 笔记评论（主评论）
opencli xiaohongshu user <user-id>                     # 用户主页笔记列表
# note-id 从 URL 提取，如 /explore/69aadbcb000000002202f131
```

#### B 站

```bash
opencli bilibili search "关键词" --limit 20            # 搜视频
opencli bilibili comments <bvid> --limit 20            # 视频评论（官方 API + WBI 签名，最稳定）
opencli bilibili user-videos <uid>                     # 用户投稿
# bvid 格式：BV1WtAGzYEBm
```

#### 微博

```bash
opencli weibo search "关键词" --limit 10               # 搜帖子
opencli weibo post <mblogid>                           # 单条帖子（含 numeric id）
opencli weibo comments <numeric-id> --limit 20         # 评论（必须用 numeric id，不是 mblogid）
# 先用 weibo post <mblogid> 拿 numeric id
```

#### 其他平台

`zhihu / twitter / youtube / instagram / reddit / tiktok / douyin` 调用方式同上。完整命令以 opencli 仓库自身的 `SKILL.md` 为准。

### 10.4 输出格式

```bash
opencli xiaohongshu search "AI眼镜" --limit 5                     # 默认表格
opencli xiaohongshu search "AI眼镜" --limit 5 -f csv > out.csv    # CSV
opencli bilibili comments BV1xxx -f json > comments.json          # JSON
```

### 10.5 频控（自动）

opencli 自带 `rate-limiter`，每条命令后随机 sleep 5~30s：

```bash
OPENCLI_RATE_MIN=3 OPENCLI_RATE_MAX=15 opencli ...    # 调整间隔
OPENCLI_NO_RATE=1 opencli ...                          # 本地调试跳过
```

### 10.6 典型批量采集

```bash
# 1. 搜索
OPENCLI_DAEMON_PORT=19826 opencli bilibili search "AI眼镜" --limit 10 -f json > search.json

# 2. 逐一抓评论
for bvid in $(jq -r '.[].bvid' search.json); do
  OPENCLI_DAEMON_PORT=19826 opencli bilibili comments "$bvid" --limit 20 -f csv >> all_comments.csv
done
```

### 10.7 平台稳定性

| 平台 | 稳定性 | 注意事项 |
|---|---|---|
| B 站 | 高 | 官方 API + WBI 签名，不受 DOM 变化影响 |
| 小红书 | 中 | 需用户已登录；DOM 变更可能让命令失效 |
| 微博 | 中 | search 第一条常是营销帖，先用 `post` 确认；评论必须用 numeric id |
| 抖音/TikTok | 中 | 视频评论受平台分桶影响，部分内容可能限制访问 |

**通用风险**：高频操作仍有封号风险，rate-limiter 降低风险但不能消除。生产环境单用户每分钟 ≤ 10 次命令（relay 默认 30 RPM 是上限，不是建议值）。

---

## 11. 多用户工程纪律

如果你是"1 AI 接多个用户"，按这三点做：

1. **每个用户一个 agent-jwt**，绑定 `allowedUserId`，内存里维护 `Map<userId, agentJwt>`
2. **每个用户一个 adapter 进程**（用 opencli 时），端口错开
3. **同一用户串行调度**，不要并发对同一用户下命令 —— relay 默认 30 RPM 限流，但更重要的是浏览器 active tab 只有一个，并发会读到错的页面

**多 AI 对接同一用户**：天然支持。每个 AI 申请自己的 agent-jwt（绑同一 `allowedUserId`），命令通过 `commandId` 串行下发互不干扰。**但 tab 共享** —— 建议每个 AI 用 `navigate { newTab: true }` 创建自己的 tab，后续操作显式带 `tabId`。

---

## 12. 自检 / 排错

| 现象 | 排查 |
|---|---|
| `/command` 一直返 503 `User browser not connected` | 用户浏览器没在线，让部署者确认用户那边状态（或先 `curl ${RELAY_URL}/health` 看 sessions 数）|
| 返 401 `Invalid agent token` | token 错或被吊销，找部署者重发 |
| 返 403 `userId mismatch` | 你传的 userId 跟 token 绑定的不一致，检查映射 |
| 返 403 `Action not allowed: evalScript` | relay 默认禁 evalScript，找部署者打开 `ALLOWED_ACTIONS=...,evalScript` |
| evalScript 报 `unsafe-eval` | 目标站点 CSP 严格，bridge 绕不过去，见 §5 |
| extract 拿到空白页 | 没等 SPA 渲染完，参照 §7 加 waitForSelector |
| 一直 `'User paused AI access'` | 用户在插件 popup 点了 Pause，他需要点 Resume 才能恢复 |

---

## 13. adapter.mjs 完整源码（供参考 / 直接拷贝）

```js
import http from 'http'

const RELAY_URL    = process.env.RELAY_URL    || 'http://localhost:3000'
const RELAY_SECRET = process.env.RELAY_SECRET
const USER_ID      = process.env.USER_ID      || 'admin'
const AGENT_ID     = process.env.AGENT_ID     || 'opencli'
const PORT         = parseInt(process.env.PORT || '19826', 10)

if (!RELAY_SECRET) {
  console.error('❌ 缺少 RELAY_SECRET 环境变量')
  process.exit(1)
}

let agentToken = null
async function getAgentToken() {
  if (agentToken) return agentToken
  const res = await fetch(`${RELAY_URL}/token/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT_ID, allowedUserId: USER_ID, secret: RELAY_SECRET }),
  })
  const json = await res.json()
  if (!json.token) throw new Error('Failed to get agent token: ' + JSON.stringify(json))
  agentToken = json.token
  return agentToken
}

function translate(cmd) {
  switch (cmd.action) {
    case 'exec':       return { action: 'evalScript', script: cmd.code, tabId: cmd.tabId }
    case 'navigate':   return { action: 'navigate', url: cmd.url, tabId: cmd.tabId, newTab: cmd.newTab }
    case 'tabs':       return { action: 'tabs' }
    case 'cookies':    return { action: 'cookies', domain: cmd.domain }
    case 'screenshot': return { action: 'screenshot', windowId: cmd.windowId }
    default:           return null
  }
}

async function sendToRelay(relayAction) {
  const token = await getAgentToken()
  const { action, ...params } = relayAction
  const res = await fetch(`${RELAY_URL}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId: USER_ID, action, params }),
  })
  return res.json()
}

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (!req.headers['x-opencli']) { send(403, { ok: false, error: 'missing X-OpenCLI header' }); return }
  if (req.method === 'GET' && req.url === '/status') {
    send(200, { ok: true, extensionConnected: true, adapter: 'ai-browser-bridge', userId: USER_ID, relay: RELAY_URL })
    return
  }
  if (req.method === 'POST' && req.url === '/command') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body)
        if (!cmd.id) { send(400, { ok: false, error: 'Missing command id' }); return }
        const relayAction = translate(cmd)
        if (!relayAction) { send(200, { id: cmd.id, ok: false, error: `Unsupported action: ${cmd.action}` }); return }
        const result = await sendToRelay(relayAction)
        send(200, { id: cmd.id, ok: result.ok, data: result.data, error: result.error })
      } catch (err) {
        send(500, { ok: false, error: err.message })
      }
    })
    return
  }
  send(404, { error: 'Not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🌉 ai-browser-bridge opencli adapter on :${PORT}`)
})
```
