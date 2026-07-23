# 业务侧接入指南

> ⚠️ **部分内容已过期 (2026-07-22)**：`/token/agent` `/device/authorize` `/token/revoke` 等端点已删除，改成 PAT 模型。授权/认证相关内容请看 [`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)；本文档里"业务能力边界"的部分仍有效。

本文档面向接入 ai-browser-bridge 的业务项目开发者，说明哪些能力由 bridge 提供、哪些需要业务侧自己实现。

---

## bridge 负责的边界

| 能力 | 说明 |
|------|------|
| WebSocket 保活与重连 | extension 内置，断连自动指数退避重连 |
| 命令路由与超时 | relay 负责，30s 超时自动返回错误 |
| Token 生成与吊销接口 | `/token`、`/token/agent`、`/token/revoke` |
| 频控与 jitter | relay 层，默认 30 RPM，可通过环境变量调整 |
| Tab Group 隔离 | extension 自动管理，AI 新建的 tab 归入蓝色 "AI Agent" 组 |

---

## 业务侧必须实现的功能

### 1. 登录时静默配对

用户登录后，后端生成 connectCode 并通过前端 postMessage 完成配对，用户无需任何操作。

**后端（用户登录成功后）：**
```js
const res = await fetch('https://your-relay.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: user.id, secret: RELAY_SECRET }),
})
const { connectCode } = await res.json()
// 将 connectCode 随登录响应一起返回给前端
```

**前端（页面加载时）：**
```js
// connectCode 由后端下发，注入到页面
window.postMessage({ type: 'bridge-pair', connectCode }, '*')

// 可选：监听配对结果
window.addEventListener('message', (e) => {
  if (e.data?.type === 'bridge-pair-result') {
    console.log(e.data.ok ? '配对成功' : e.data.error)
  }
})
```

---

### 2. Token 过期前静默刷新

user-jwt 有效期 30 天。**每次用户登录时都重新生成 connectCode 并 postMessage**，确保 token 始终有效，避免 extension 在用户不知情的情况下断连。

无需额外的定时刷新逻辑，登录即刷新即可。

---

### 3. 用户注销时吊销 token

用户主动注销或被强制下线时，必须调用吊销接口，防止旧 token 在 30 天内继续有效。

```js
// 用户注销时（后端）
await fetch('https://your-relay.com/token/revoke', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: userJwt, secret: RELAY_SECRET }),
})
```

---

### 4. 登录后检测 extension 是否在线

调用 `/health` 接口获取当前在线 session 数，判断用户是否已安装并连接 extension，未连接时给出引导。

```js
const res = await fetch('https://your-relay.com/health')
const { sessions } = await res.json()
// sessions > 0 表示该 relay 有在线连接（需结合 userId 做更精确判断）
```

> 更精确的方案：在 `/command` 收到 503 `User browser not connected` 时触发引导，比轮询 `/health` 更准确。

**推荐引导文案：**
- 未安装 → "需要安装 AI 浏览器插件才能使用此功能" + 安装链接
- 已安装未配对 → 触发 postMessage 重新配对

---

### 5. 浏览器未连接时的降级处理

relay 在用户浏览器未在线时返回 `503 { error: 'User browser not connected' }`。AI Agent 不能将此错误直接暴露给用户，需要降级处理。

**建议策略：**

```js
const res = await fetch('https://your-relay.com/command', { ... })
if (res.status === 503) {
  // 降级：通知用户打开浏览器插件，或跳过当前步骤
  return { ok: false, reason: 'browser_offline', message: '请确认浏览器插件已开启' }
}
```

---

### 6. AI Agent 下发命令时明确 tabId

extension 默认操作当前 active tab，但用户可能同时开多个标签页导致操作目标错误。**Agent 应始终使用上一步 navigate 返回的 tabId 作为后续命令的操作目标。**

```js
// 第一步：打开目标页面，记录 tabId
const nav = await command('navigate', { url: 'https://example.com', newTab: true })
const { tabId } = nav.data

// 后续步骤：明确传入 tabId
const content = await command('extract', { type: 'text', tabId })
const cookies  = await command('cookies', { domain: 'example.com', tabId })
```

---

## 多项目共用 relay 时的 userId 命名空间

多个业务项目接入同一个 relay 时，不同项目可能存在相同的用户 ID，导致 session 互相覆盖。

**约定：userId 必须加项目前缀。**

```
格式：{project}:{type}:{id}
示例：imc:user:123
      crm:feishu:ou_xxxxx
      ops:admin
```

relay 本身不感知命名空间，由各业务项目自行约定并执行。

---

## 多租户隔离责任 ⚠️

bridge 的 `/command` 端点**只校验 agent-jwt 本身合法 + 绑定的 `allowedUserId` 与请求 `userId` 是否一致**。它**看不到** AI Agent 服务背后的"前端调用者是谁"。

这意味着如果你的 AI Agent 是个**多租户共享服务**，串号风险**完全在 AI Agent 层**：

```
AI Agent 服务（持有一个 token-for-userA 的 jwt）
   ↑              ↑
前端用户 A      前端用户 B（陌生人）

用户 B 调 AI 的 API → AI 内部用 token-for-userA 调 bridge → 操作了 A 的浏览器
```

bridge 只看 `token-for-userA` 是合法的 → 放行，**完全不知道是用户 B 在背后调用**。

### AI Agent 服务必须做的事

1. **按前端用户隔离 agent-jwt**：每个前端用户有自己的 agent-jwt，AI 内部维护 `Map<前端userId, agentJwt>`
2. **不要全局共享一个 agent-jwt**
3. **token 不下发给前端**：agent-jwt 应该只在 AI 后端持有，前端永远拿不到（防止前端伪造 user 越权）
4. **为每个用户单独申请 jwt**：通过 `POST /token/agent` 给每个用户签 agentId 不同的 jwt（便于 audit 区分）

### bridge 提供的辅助能力

- **`POST /device/authorize` + `POST /device/token`**：**Device Flow**（OAuth 2.0 RFC 8628）—— agent 主动请求授权，**不需要 RELAY_SECRET**，由用户在插件 popup 显式输码同意，签发短期（默认 1h）jwt。**第三方 AI 接入应当走这条路**。详见 `DEPLOYMENT.md §3.0`
- **`GET /audit`**（用 user-jwt 认证）：用户能查自己浏览器最近被哪些 agent 操作过。事后可见 ≠ 事前阻止，但能捕获越权
- **插件 popup "View AI activity"**：用户在自己浏览器里可视化最近活动
- **插件 popup "Pause AI access"**：**用户主权开关**。暂停时 ws 保持连接，但所有 agent 命令立即被插件拒绝，返回 `{ok:false, error:'User paused AI access'}`。AI Agent 端必须识别此错误并优雅降级（重试 / 通知调用者 / 暂存任务）
- **插件 popup "Authorize an AI agent"**：用户输入 agent 给的授权码（如 `ABCD-1234`）+ 选时长 → 完成对该 agent 的显式授权
- **`POST /token/revoke`**：发现可疑 jti 立即拉黑

bridge **不**提供：前端用户级隔离、敏感动作二次确认（v2 计划）、用户级 RBAC。

---

## 快速自检清单

接入前确认以下几点：

- [ ] 登录流程中已集成 postMessage 配对
- [ ] 用户注销流程中已调用 `/token/revoke`
- [ ] AI Agent 的 navigate 返回 tabId 已传递给后续命令
- [ ] 已处理 503 错误的降级逻辑
- [ ] userId 已加项目命名空间前缀（多项目共用 relay 时）
- [ ] **AI Agent 后端按前端用户隔离 agent-jwt 池**（不全局共享）
- [ ] **agent-jwt 永远不下发给前端**
