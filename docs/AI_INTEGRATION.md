# AI Browser Bridge — AI 接入指南

给任何想接入 ai-browser-bridge 的 AI Agent / 后端服务看。目标：拿到用户的 PAT 之后，半小时内接完。

## 前置条件

用户必须已经：
1. 安装了 Chrome 插件
2. 在插件 popup 里完成飞书登录
3. 生成过一个 PAT（`bpt_xxx...`），并把明文交给你（贴到你的配置页 / env / 聊天里）

你**不需要**：注册 client、走 OAuth 授权页、知道用户是谁、知道 device_id 是什么。Token 本身就是完整凭据。

## 一次调用说起

```bash
curl -X POST https://<relay-domain>/command \
  -H "Authorization: Bearer bpt_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6XYZW" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "extract",
    "params": { "type": "text" }
  }'
```

成功响应：

```json
{ "ok": true, "result": "页面提取到的文本..." }
```

失败响应：

```json
{ "ok": false, "error": { "code": "device_offline", "message": "Target device is not connected" } }
```

## Endpoint

只有一个你需要调的端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/command` | 下发单个 low-level 命令，`Authorization: Bearer <PAT>` |
| `POST` | `/opencli` | **跑一条 opencli 命令**（177 网站的成熟社媒抓取，零安装）见下方专节 |
| `GET` | `/health` | 健康检查（可选，用于自己的监控） |

其余 `/login/*` `/api/me/*` 是插件专用的，不需要你调。

> **抓小红书/B站/微博这类主流社媒，直接跳到 [`POST /opencli`](#抓主流社媒-postopencli推荐零安装) 一节**——比自己用 low-level 拼选择器省事得多。下面的 action 清单适合冷门网站/内部系统。

## `action` 完整清单

请求体：`{ "action": "<name>", "params": { ... } }`

### `extract` — 提取当前页面内容

```json
{ "action": "extract", "params": { "type": "text", "waitFor": ".post-content", "waitTimeout": 10000 } }
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `type` | `"text" \| "html" \| "title"` | 默认 `text`（`document.body.innerText`）|
| `tabId` | number（可选） | 不传则用 AI Tab Group 里最近活跃的 tab |
| `waitFor` | string（可选） | CSS selector，SPA 异步渲染完再提取 |
| `waitTimeout` | number（可选） | 配合 `waitFor`，默认 10000ms |

返回：`result` 是字符串（页面文本/HTML/标题）。

### `navigate` — 打开一个 URL

```json
{ "action": "navigate", "params": { "url": "https://www.xiaohongshu.com/explore" } }
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string（必填） | |
| `newTab` | boolean（可选） | 不传 = 新建 tab（永远不会覆盖用户正在看的页面），加入 "AI Agent" tab group |
| `tabId` | number（可选） | 传了就在这个已有 tab 上跳转 |

返回：`result: { tabId: number }` —— 记下来给后续 `extract`/`waitForSelector` 用。

### `waitForSelector` — 等 SPA 异步渲染

```json
{ "action": "waitForSelector", "params": { "selector": ".comment-list", "timeout": 10000, "visible": true } }
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `selector` | string（必填） | CSS selector |
| `timeout` | number（可选） | 默认 10000ms |
| `visible` | boolean（可选） | true = 还要求元素可见（非 `display:none`） |
| `tabId` | number（可选） | |

返回：`result: { matched: boolean, count: number, elapsed: number }`。超时时 `ok: false`。

### `cookies` — 拿某个域名的 cookies

```json
{ "action": "cookies", "params": { "domain": "xiaohongshu.com" } }
```

返回：`result` 是 Chrome cookies 数组（含 `name`/`value`/`domain`/`expirationDate` 等）。

### `tabs` — 列出所有 tab

```json
{ "action": "tabs", "params": {} }
```

返回：`result: Array<{ id, url, title, active }>`。

### `screenshot` — 截图

```json
{ "action": "screenshot", "params": { "windowId": 12345 } }
```

`windowId` 不传则截当前活动窗口。返回：`result` 是 PNG dataURL 字符串。

### `execute` — 调用白名单预定义脚本

```json
{ "action": "execute", "params": { "scriptId": "page.getTitle" } }
```

固定脚本清单（插件端硬编码，不能自定义）：`page.getTitle` / `page.getText` / `page.getHtml` / `page.getUrl`。

### `evalScript` — 执行任意 JS（默认关闭）

```json
{ "action": "evalScript", "params": { "script": "document.querySelectorAll('.note-item').length" } }
```

⚠️ **两个前提都要满足才能用**：
1. 部署方在 relay 的 `ALLOWED_ACTIONS` env 里加了 `evalScript`
2. 用户生成 PAT 时勾选了 `evalScript` 这个 scope

⚠️ **目标页面 CSP 决定它能不能跑**：小红书/B站/微博等大多数中文社媒可用；Twitter/X、GitHub 等严格 CSP 站点会被拒（`Refused to evaluate a string as JavaScript...`）。遇到这种站点，换用 `execute` + 具名脚本（需要部署方在插件白名单里加）。

## 错误码

| HTTP | `error.code` | 含义 | 你该怎么办 |
|---|---|---|---|
| 401 | `invalid_token` | token 格式不对/不存在 | 检查是不是完整复制了 `bpt_...`，别多/少字符 |
| 401 | `token_revoked` | 用户已撤销 | 让用户重新生成一个给你 |
| 401 | `token_expired` | 超过设置的过期时间 | 同上 |
| 403 | `action_not_in_scope` | 这个 action 不在 token 允许范围内（服务器白名单或 token scopes 任一未覆盖） | 让用户重新生成 token 时勾上这个 action，或联系部署方开 `ALLOWED_ACTIONS` |
| 429 | `rate_limited` | 触发限速（默认每设备 30 次/分钟），响应带 `retryAfterMs` | 按 `retryAfterMs` 退避重试 |
| 503 | `device_offline` | 用户没登录/浏览器没开/网络断了 | 提示用户"请确认浏览器已打开插件并登录"，不建议无限重试 |
| 504 | `device_timeout` | 命令发下去 30 秒没收到执行结果 | 可以重试一次；反复超时提示用户检查网络 |
| 400 | `invalid_action` / `invalid_request` | 请求体本身错了 | 检查 JSON 格式，看这份文档核对参数名 |

## 重试策略

- `429 rate_limited`：**该重试**，用 `retryAfterMs` 做退避
- `504 device_timeout`：**可以重试 1 次**，反复超时说明设备端有问题，别死循环
- `503 device_offline`：**不建议自动重试**——这不是网络抖动，是用户没在线，重试也没用，等用户主动操作（重新打开插件/重新登录）
- `401`/`403`：**永远不要重试**——重试不会让 token 变得有效，请提示用户重新生成 token

## 三种语言的最小示例

### curl

```bash
curl -X POST https://<relay-domain>/command \
  -H "Authorization: Bearer $PAT" \
  -H "Content-Type: application/json" \
  -d '{"action":"navigate","params":{"url":"https://example.com"}}'
```

### Node.js

```js
async function bridgeCommand(pat, action, params = {}) {
  const res = await fetch('https://<relay-domain>/command', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, params }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`${json.error.code}: ${json.error.message}`)
  return json.result
}

const text = await bridgeCommand(process.env.USER_PAT, 'extract', { type: 'text' })
```

### Python

```python
import requests

def bridge_command(pat: str, action: str, params: dict | None = None):
    res = requests.post(
        "https://<relay-domain>/command",
        headers={"Authorization": f"Bearer {pat}", "Content-Type": "application/json"},
        json={"action": action, "params": params or {}},
        timeout=35,  # command timeout 服务端是 30s, 客户端留点余量
    )
    body = res.json()
    if not body.get("ok"):
        err = body.get("error", {})
        raise RuntimeError(f"{err.get('code')}: {err.get('message')}")
    return body["result"]

text = bridge_command(USER_PAT, "extract", {"type": "text"})
```

## 抓主流社媒: `POST /opencli`（推荐，零安装）

要抓小红书 / B站 / 微博 / 抖音 / 知乎 等 **177 个网站**，别自己写选择器——relay 内置了 [OpenCLI](https://github.com/jackwener/OpenCLI)（社区维护的成熟社媒 CLI，每条命令自带选择器 + 交互流程 + 数据模型 + 边界处理）。

**你的接入成本 = 一个 HTTP 请求**。不用装 opencli，不用 Node 环境，不用起 daemon。

```bash
curl -X POST https://<relay-domain>/opencli \
  -H "Authorization: Bearer bpt_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "site": "xiaohongshu",
    "op": "search",
    "args": { "query": "AI眼镜", "limit": 30 }
  }'
```

成功：`{ "ok": true, "tabId": 4242, "result": [ ...笔记数组... ] }`
失败：`{ "ok": false, "tabId": 4242, "error": { "code": "...", "message": "...", "hint": "..." } }`

（`tabId` 成功失败都返——失败时用户可以去那个 tab 看现场。）

### PAT scope 要求

PAT 必须**同时**含 `navigate` + `evalScript` + `cookies` 三个 scope，缺哪个响应里会说清楚。

为什么要 `evalScript`：opencli 命令确实在用户浏览器里执行 JS（只不过是 opencli 社区维护的开源代码，不是 AI 现编的）。用户勾这个 scope 就是知情授权。

### 常用 site / op

| site | 常用 op |
|---|---|
| `xiaohongshu` | `search` `comments` `feed` `user` `creator-notes` `creator-note-detail` `liked` `saved` |
| `bilibili` | `search` `comments` `user` `feed` |
| `weibo` | `search` `comments` `user` |
| `zhihu` | `search` `comments` `user` |
| `douyin` | `search` `comments` `user` |

**site 用全名**（`xiaohongshu` 不是 `xhs`）。op 清单看 [OpenCLI 仓库的 `clis/<site>/`](https://github.com/jackwener/OpenCLI/tree/main/clis) 目录（每个 `.js` 文件名就是一个 op）。

### `/opencli` 特有错误码

| HTTP | code | 含义 |
|---|---|---|
| 501 | `opencli_disabled` | 部署方设了 `ENABLE_OPENCLI=false` |
| 501 | `opencli_unavailable` | relay 容器里没装 `@jackwener/opencli` |
| 404 | `command_not_found` | site/op 拼错，或该网站没这个命令 |
| 422 | `not_implemented` | **该命令依赖 CDP AX tree**（`click`/`upload`/`snapshot`）——扩展用 `chrome.scripting` 没 debugger 权限。换只读类命令，或让用户手动完成这一步 |
| 504 | `opencli_timeout` | 整条命令超时（默认 120s）。页面慢或 `limit` 太大，减小重试 |
| 400 | `invalid_request` | `site`/`op` 缺失或含非法字符（只允许字母数字下划线连字符） |

其余错误码（401/403/429/503）跟 `/command` 一致。

### 能力边界

**支持**：只读类命令（`search` / `comments` / `feed` / `user` / `*-detail` / `*-stats`）——这些只用 `goto` + `evaluate` + `getCookies` + `fetchJson`。

**不支持**：交互类命令（`publish` / `follow` / `delete-note` / `draft-*`）——依赖 opencli 的 AX tree selector reference 格式，返 `422 not_implemented`。

### `/opencli` vs `/command`

| 场景 | 用 |
|---|---|
| 主流社媒的复杂抓取（搜索/评论/翻页/解析） | **`/opencli`** — 一个请求搞定，选择器 opencli 社区维护 |
| 冷门网站 / 内部后台 / 用户自建 SaaS | **`/command`** — opencli 没适配，自己拼 low-level 原语 |
| 简单动作（打开一个 URL / 读一段文字 / 截图） | **`/command`** — 用不着 opencli 那么重 |

**注意**：`/opencli` 跟 `/command` **共用同一个 rate limit**（每设备默认 30 次/分钟）。一条 opencli 命令只算 **1** 次限速，但内部有 5-15 次浏览器往返，所以实际耗时 1-3 秒。

## 常见工作流：抓一个小红书笔记的评论（用 `/command` 手拼）

```js
const { tabId } = await bridgeCommand(pat, 'navigate', { url: noteUrl })
await bridgeCommand(pat, 'waitForSelector', { selector: '.comment-item', tabId, timeout: 8000 })
const html = await bridgeCommand(pat, 'extract', { type: 'html', tabId })
// html 里解析评论列表...
```

## Rate Limit

默认每台设备（不是每个 token）**30 次/分钟**，部署方可通过 `RATE_LIMIT_RPM` env 调整（0 = 不限）。多个 AI 项目共用同一个用户的浏览器时，限速是按 device 算的总量，不是每个 token 各 30 次——设计密集抓取任务时留意这点。

## 我该怎么拿到 PAT？

你不能"申请"或"生成"用户的 token——这是用户主动操作的结果。集成到你的产品时，建议在设置页放一段说明：

> 「打开 AI Browser Bridge 插件 → 登录 → 生成 Token → 把 token 粘贴到这里」

配一个输入框收 token，其余交互（怎么生成、怎么撤销）都在插件 popup 里，不需要你重新实现。
