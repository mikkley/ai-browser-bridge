# AI Browser Bridge

Chrome 插件 + Relay 服务，让服务器端 AI Agent 静默操作用户已登录的浏览器（不抢鼠标、不用重新登录）。

## 怎么用（3 步）

### 1. 安装插件

1. `chrome://extensions/` → 打开开发者模式
2. 加载已解压的扩展程序 → 选 `extension/dist`（或拿到的 zip 解压后的目录）
3. 点插件图标，弹出 popup

### 2. 飞书登录 + 生成 Token

1. Popup 里点 **飞书登录**，走完 SSO
2. 给这台设备起个名字（比如 "MK-MacBook-Chrome"）
3. 点 **生成新 Token**，填个用途（比如"给传播洞察用"），勾选允许的操作范围
4. 复制生成的 `bpt_xxx...`（**只显示一次**，关掉面板就再也看不到明文了）

### 3. 把 Token 交给 AI

任何 AI 项目拿到这个 token 就能操控你这台浏览器，接入方式只有一个 HTTP 请求：

```bash
curl -X POST https://<relay-domain>/command \
  -H "Authorization: Bearer bpt_xxx..." \
  -H "Content-Type: application/json" \
  -d '{"action": "extract", "params": {"type": "text"}}'
```

给 AI 开发者的完整接入文档：[`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)

## 架构

```
AI Agent (任意项目, 服务器端)
    ↓  POST /command   Bearer <bpt_xxx PAT>
Relay Server (Node.js, 与 marketing-agent 共享 Docker/Postgres 部署)
    ↑  WebSocket        ← 浏览器主动连出, 无防火墙/NAT 问题
Chrome Extension (MV3)
    ↓  chrome.scripting.executeScript   ← 静默执行, 不抢鼠标
用户的 Chrome（已登录, 状态完整）
```

- 不抢鼠标：所有操作走 `chrome.scripting.executeScript`，不是 CDP 模拟鼠标点击
- Token 即凭据：不需要 OAuth 授权页、不需要 AI 项目注册，用户自己生成 token 给谁就是谁能用
- 随时可撤销：popup 里一键撤销任意 token；登出会让所有 token 立即失效（不用逐个撤销）

## 支持的操作

`navigate` / `extract` / `waitForSelector` / `cookies` / `tabs` / `screenshot` / `execute`（白名单预定义脚本）/ `evalScript`（任意 JS，受目标页 CSP 限制，默认关闭）

详细参数见 [`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md)。

## 开发

```bash
# Relay
cd relay
npm install
DATABASE_URL=... BRIDGE_ACCESS_KEY=... BRIDGE_JWT_SECRET=... \
  FEISHU_APP_ID=... FEISHU_APP_SECRET=... BRIDGE_FEISHU_REDIRECT_URI=... npm run dev

# Extension
cd extension
cp src/config.example.ts src/config.ts   # 填 RELAY_WS_URL + BRIDGE_ACCESS_KEY
npm install && npm run build
```

更多开发/部署细节见 [`CLAUDE.md`](CLAUDE.md) 和设计文档 [`docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md`](docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md)。

## 免责声明

本插件让 AI 代理静默操作你的浏览器，使用前请知晓：

- **账号风险**：网站可能检测到异常自动化行为并限制/封禁账号，高频或大规模自动化操作会显著提高这个风险
- **服务条款**：自动化访问可能违反部分网站（社媒/电商等）的服务条款，合规责任由使用者自行承担
- **数据隐私**：relay 服务在你的 AI Agent 和浏览器之间转发命令与结果，请部署在可信的服务器上，密钥不要进版本库

本项目按现状提供，仅用于合法的自动化用途（个人效率、测试、无障碍）。作者不为滥用或自动化浏览行为造成的任何后果负责。

## License

MIT
