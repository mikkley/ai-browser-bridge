# ai-browser-bridge — Claude 项目上下文

## 项目定位

轻量级 Chrome 插件 + Relay 服务，让服务器端 AI Agent 能静默操作用户浏览器（不抢鼠标）。用户只需安装插件并完成一次配对，无需 CLI 或技术配置。

## 架构

```
AI Agent (服务器)
    ↓  POST /command  Bearer <agent-jwt>
Relay Server  (Node.js, 可部署在任意 VPS)
    ↑  WebSocket /ws?token=<user-jwt>   ← 浏览器主动连出，无防火墙/NAT 问题
Chrome Extension (MV3)
    ↓  chrome.scripting.executeScript   ← 静默执行，不抢鼠标
用户的 Chrome（已登录，状态完整）
```

### 核心设计原则
- **不抢鼠标**：所有页面操作通过 `chrome.scripting.executeScript`，不用 CDP `Input.dispatchMouseEvent`
- **单 connect code 配对**：`bridge_` + base64url(JSON{url, token})，一串字符搞定
- **零用户教育成本**：插件 + 粘贴 code，或 web 页面 postMessage 自动配对

## 目录结构

```
ai-browser-bridge/
├── extension/              Chrome 插件 (MV3)
│   ├── manifest.json
│   ├── popup.html
│   └── src/
│       ├── background.ts   WebSocket 客户端 + 命令处理 + pairing handler
│       ├── content.ts      postMessage 监听 → 转发 pair 消息给 background
│       └── popup.ts        手动粘贴 connect code 的 UI
│
└── relay/                  中转服务 (Node.js + TypeScript)
    └── src/
        ├── server.ts       WebSocket Hub + HTTP API
        ├── config.ts       首次启动自动生成 JWT secret + relay secret
        ├── tunnel.ts       Cloudflare Quick Tunnel（内网穿透）
        └── cli.ts          npm run token / npm run info
```

## 关键技术决策

### 为什么用 content script postMessage 而非 externally_connectable
- `externally_connectable` 需要在 manifest 里写死允许的域名，对自部署场景不友好
- content script 方案：任意页面执行 `window.postMessage({type:'bridge-pair', connectCode}, '*')` 即可配对，web 端无需知道插件 ID

### 为什么用飞书 union_id 而非 open_id
- `open_id` 是 app 级别的，不同 appId 下同一用户的 open_id 不同
- `union_id` 在同一 ISV 账号下所有应用中保持一致，适合跨 app 用户识别

### Cloudflare Quick Tunnel
- 使用 `cloudflared` npm 包，零配置自动获取公网 `wss://xxx.trycloudflare.com/ws`
- 生产环境设置 `PUBLIC_URL` 环境变量跳过 tunnel，使用固定域名
- TypeScript 类型需双重 cast：`(cloudflared.tunnel(...) as unknown) as {...}`

### MV3 Service Worker keepalive
- Chrome MV3 的 service worker 30s 无活动会被杀
- 用 `chrome.alarms`（0.4min 间隔）保活，alarm 触发时检查 ws 连接状态并重连

## HTTP API

| 端点 | 认证 | 说明 |
|------|------|------|
| `POST /command` | Bearer agent-jwt | AI Agent 下发命令 |
| `POST /token` | body: `{secret}` | 生成用户 connect code |
| `GET /health` | 无 | 健康检查，返回在线 session 数 |

## 插件支持的 Action

| Action | 关键参数 | 说明 |
|--------|---------|------|
| `execute` | `script`, `tabId?` | 在页面中执行任意 JS |
| `navigate` | `url`, `newTab?`, `tabId?` | 导航到 URL |
| `extract` | `type: text\|html\|title`, `tabId?` | 提取页面内容 |
| `cookies` | `domain` | 获取 cookies |
| `tabs` | — | 列出所有 tab |
| `screenshot` | `windowId?` | 截图（PNG dataURL）|

## 飞书配对流程

```
1. 后端：Feishu OAuth → 获取 union_id
2. 后端：POST /token {userId: union_id, secret: RELAY_SECRET} → connectCode
3. 前端：window.postMessage({type:'bridge-pair', connectCode}, '*')
4. content.ts → background.ts → chrome.storage → ws 自动重连
5. 可选：监听 window message {type:'bridge-pair-result', ok, error}
```

## 开发命令

```bash
# Relay
cd relay && npm install && npm run dev

# Extension（需要 Node 18+）
cd extension && npm install && npm run build

# 生成用户 connect code
cd relay && npm run token -- <userId>

# 查看当前配置
cd relay && npm run info
```

## 安全注意事项
- `.data/` 目录存放 JWT secret、relay secret、公网 URL，已 gitignore，绝不提交
- 生产部署时通过环境变量传入 `PUBLIC_URL`，避免每次重启 tunnel URL 变化
- agent-jwt 和 user-jwt 用同一个 JWT_SECRET 签发，但 payload 不同（agent 没有 userId 限制，user 有）
