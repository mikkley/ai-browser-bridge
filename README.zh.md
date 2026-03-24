# ai-browser-bridge

轻量级 Chrome 插件，将 AI Agent 与用户浏览器连接起来——静默操作 DOM，不抢占鼠标。

## 工作原理

```
AI Agent（服务器端）
    ↓  POST /command
Relay 中转服务             ← 部署在任意服务器
    ↑  WebSocket（浏览器主动连出，无防火墙问题）
Chrome 插件               ← 用户只需安装这一个
    ↓  chrome.scripting.executeScript
用户的 Chrome（已登录，鼠标不受影响）
```

用户只需安装插件并粘贴一串 connect code，无需安装任何命令行工具，无需任何技术配置。

## 快速上手

### 1. 部署 Relay 服务

```bash
git clone https://github.com/mikkley/ai-browser-bridge
cd ai-browser-bridge/relay
npm install
npm run dev
```

首次启动时会自动生成密钥，并通过 Cloudflare Tunnel 获取公网地址：

```
🚀 AI Browser Bridge Relay
──────────────────────────────────────────────────
🌐 公网地址：wss://abc123.trycloudflare.com/ws
🔑 Admin connect code：
   bridge_eyJ1cmwiOiJ3c3M6Ly...

🔐 Relay secret：xxxxxxxx
📋 生成用户 connect code：npm run token -- <userId>
──────────────────────────────────────────────────
```

> **生产环境：** 设置 `PUBLIC_URL=https://your-domain.com` 可跳过 Cloudflare Tunnel，使用固定域名。

### 2. 为每个用户生成 Connect Code

```bash
npm run token -- user123
# 输出：bridge_eyJ1cmwiOiJ3c3M6Ly...
```

### 3. 用户安装插件

1. 在 Chrome 中以开发者模式加载 `extension/` 目录
2. 点击插件图标 → 粘贴 connect code → 点击连接
3. 完成——AI Agent 现在可以访问用户浏览器了

---

## 项目结构

```
ai-browser-bridge/
├── extension/                  # Chrome 插件（MV3）
│   ├── manifest.json
│   ├── popup.html              # 单字段粘贴 connect code
│   └── src/
│       ├── background.ts       # WebSocket 客户端 + 命令处理
│       └── popup.ts            # 连接 UI
│
├── relay/                      # 中转服务（Node.js + TypeScript）
│   └── src/
│       ├── server.ts           # WebSocket Hub + HTTP API
│       ├── config.ts           # 首次启动自动生成密钥
│       ├── tunnel.ts           # Cloudflare Quick Tunnel
│       └── cli.ts              # npm run token / npm run info
│
├── .env.example
├── .gitignore                  # .data/（密钥）已排除
└── README.md
```

---

## 插件支持的操作

所有操作均为静默执行，不占用鼠标：

| Action | 说明 |
|--------|------|
| `execute` | 在页面中执行任意 JS（`element.click()` 等） |
| `navigate` | 在当前或新 Tab 中打开 URL |
| `extract` | 获取页面 `text`、`html` 或 `title` |
| `cookies` | 获取指定域名的 cookies |
| `tabs` | 列出当前打开的所有 Tab |
| `screenshot` | 截取当前可见区域为 PNG |

## Agent 调用示例

```bash
# 向指定用户的浏览器下发命令
curl -X POST https://your-relay.com/command \
  -H "Authorization: Bearer <agent-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "action": "extract",
    "params": { "type": "text" }
  }'
```

## CLI 工具

```bash
npm run token -- <userId>   # 为指定用户生成 connect code
npm run info                # 查看当前 Relay 地址和配置
```

## 安全设计

- 所有连接均通过 JWT 认证（首次启动自动生成）
- `.data/` 目录（密钥和状态）已加入 `.gitignore`，不会提交到代码库
- 通过 userId 实现用户间会话隔离
- 生成 token 需要 relay secret，防止未授权访问

## 参考项目

- [opencli](https://github.com/jackwener/opencli) — 将任意网站、Electron 应用或本地 CLI 工具转变为命令行接口，支持 50+ 平台适配器。本项目的浏览器操作理念与 opencli 的站点适配方式保持兼容，服务端可直接复用 opencli 的适配器逻辑来驱动插件执行。

## License

MIT
