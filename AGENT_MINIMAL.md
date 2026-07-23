# ai-browser-bridge — AI Agent 集成（最小版）

> ⚠️ **已过期 (2026-07-22)**：协议已改成 PAT 模型 (`Authorization: Bearer bpt_xxx`)，本文档描述的授权流程不再适用。请看 [`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)。

你是被授权操作某个用户浏览器的 AI Agent。下面是你**唯一需要知道**的协议。完整版（含 opencli 集成、SPA 操作技巧、社媒采集命令）见 `AGENT_FULL.md`。

---

## 你拿到的凭据（由部署者单独提供）

| 名字 | 用途 |
|---|---|
| `RELAY_URL` | bridge relay 的 https 入口，所有 API 都打这个 base |
| `agent-jwt` | 长期 token（默认 90 天），绑定一个特定的 `userId` |
| `userId` | 你被授权操作的那个用户浏览器的 ID（UUID，是用户在 Chrome 插件 popup 里复制给部署者的）|

**不要**问部署者要 `BRIDGE_ACCESS_KEY` 或 `RELAY_SECRET` —— 你用不到，那是插件和部署者侧的。

如果你的场景是**用户在跟你聊天时临时授权**而不是部署者预先签发，跳到本文末尾"Device Flow"那一节。

---

## 唯一要调的 API：`POST /command`

```js
const res = await fetch(`${RELAY_URL}/command`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${AGENT_JWT}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    userId: USER_ID,         // 你绑定的那个用户
    action: 'navigate',      // 见下面 action 列表
    params: { url: 'https://www.example.com', newTab: true },
  }),
})
const json = await res.json()
// { ok: true, data: {...} }  或  { ok: false, error: '...' }
```

---

## 支持的 action

| action | params | 返回 data | 说明 |
|---|---|---|---|
| `navigate` | `{ url, newTab?, tabId? }` | `{ tabId }` | 默认新建 tab 加入"AI Agent"分组；传 `tabId` 才会复用已有 tab |
| `tabs` | — | `[{ id, url, title, active }]` | 列出所有 tab |
| `extract` | `{ type: 'text'\|'html'\|'title', tabId?, waitFor?, waitTimeout? }` | string | 提取页面内容；可选 `waitFor` 等 selector 出现再提取（SPA 必备）|
| `waitForSelector` | `{ selector, tabId?, timeout?, visible? }` | `{ matched, count, elapsed }` | 等 selector 出现，默认 10s 超时 |
| `execute` | `{ scriptId, scriptParams?, tabId? }` | 由脚本决定 | 跑插件内置白名单脚本：`page.getTitle`/`page.getText`/`page.getHtml`/`page.getUrl` |
| `evalScript` | `{ script, tabId? }` | 脚本返回值 | 跑任意 JS（**需要 relay 开了权限，且目标页面 CSP 允许 unsafe-eval**）|
| `cookies` | `{ domain }` | `Cookie[]` | 拿指定域名 cookies |
| `screenshot` | `{ windowId? }` | PNG dataURL string | 截当前活动窗口 |

省略 `tabId` 时，所有操作落到 AI tab 分组里最近活跃的 tab。**第一次操作前必须先 `navigate` 创建 AI tab**，否则会报 `No AI tab. Call navigate first`。

---

## 返回值必须处理的几种分支

| HTTP | body | 含义 | 你该怎么做 |
|---|---|---|---|
| 200 | `{ ok: true, data }` | 正常 | 继续 |
| 200 | `{ ok: false, error: 'User paused AI access' }` | 🛑 **用户在插件里按了暂停** | **不要重试**。暂存任务，告诉调用方"用户暂停了"，等他点 Resume |
| 200 | `{ ok: false, error: 'Timeout (...) waiting for selector: ...' }` | waitForSelector 超时 | 换 selector 或拉长 timeout 重试 |
| 200 | `{ ok: false, error: 'No AI tab. Call navigate first ...' }` | 还没有 AI tab | 先调 navigate |
| 401 | `{ error: 'Invalid agent token' }` | token 错/被吊销/jwt secret 换了 | 找部署者，自己解决不了 |
| 403 | `{ error: 'Forbidden: userId mismatch' }` | 你传的 userId 跟 token 绑定的不一致 | 检查代码里 userId 和 token 的对应关系 |
| 403 | `{ error: 'Action not allowed: ...' }` | relay 禁用了这个 action | 找部署者放开 |
| 429 | `{ error: 'Rate limit exceeded', retryAfterMs }` | 触发限流（默认 30/min/用户）| sleep `retryAfterMs` 再试 |
| 503 | `{ error: 'User browser not connected' }` | 用户浏览器离线（关了 / 网断了 / 插件没启动）| 等用户上线再试，或汇报给调用方 |

`'User paused AI access'` 是**最关键的一条**：用户主动按了暂停键。如果你不停重试会污染 audit log、骚扰用户。识别后**让任务等用户操作或直接终止**。

推荐封装：

```js
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
  if (json.error?.startsWith('Rate limit')) {
    await sleep(json.retryAfterMs || 5000)
    return call(action, params)
  }
  if (!json.ok) throw new Error(json.error)
  return json.data
}
```

---

## 操作 SPA 的标准序列（小红书/B站/腾讯互选这种）

`navigate` 完成 ≠ 数据加载完，SPA 的真实内容是后续 fetch 拉来再渲染的。直接 extract 会拿到空骨架。**正确序列：navigate → waitForSelector → extract**。

```js
const { tabId } = await call('navigate', { url: 'https://www.xiaohongshu.com/explore' })

await call('waitForSelector', {
  tabId,
  selector: '.note-item',   // 选一个"数据加载完才出现"的元素
  timeout: 15000,
  visible: true,
})

const html = await call('extract', { tabId, type: 'html' })
```

也可以把 wait 合到 extract 里（语义糖）：

```js
await call('extract', {
  tabId,
  type: 'html',
  waitFor: '.note-item',
  waitTimeout: 15000,
})
```

**SPA 内部路由切换**（点链接换路由、URL 变但页面不重载）—— bridge 没有内置事件，用 `evalScript` 模拟点击 + 再 `waitForSelector`。

---

## Device Flow（用户临时授权场景）

如果你**没有**预先拿到的 `agent-jwt`，而是用户在跟你聊天时临时让你操作他的浏览器，走这条路：

```js
// 1. 申请授权（不需要任何 secret）
const r1 = await fetch(`${RELAY_URL}/device/authorize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: 'my-agent-name' }),
}).then(r => r.json())
const { user_code, device_code, expires_in, interval } = r1

// 2. 告诉用户：请在 Chrome 插件 popup 点 "Authorize an AI agent"，输入 user_code
console.log(`授权码：${user_code}（${expires_in / 60} 分钟内有效）`)

// 3. 轮询拿 token
let token, userId
const deadline = Date.now() + expires_in * 1000
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, interval * 1000))
  const r2 = await fetch(`${RELAY_URL}/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code }),
  }).then(r => r.json())
  if (r2.ok) { token = r2.token; userId = r2.userId; break }
  if (r2.error === 'expired_token' || r2.error === 'access_denied') throw new Error(r2.error)
  // 'authorization_pending' → 继续
}
if (!token) throw new Error('用户未在 10 分钟内授权')

// 4. 用 token 调 /command（默认 1 小时有效，用户在 popup 可选 15min / 1h / 4h / 1 天）
```

device flow 拿到的 token 短期有效（默认 1 小时），过期后要重新走流程让用户再授权一次。
