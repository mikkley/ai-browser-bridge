# examples/

AI Agent 端接入 ai-browser-bridge 的示例代码和 prompt 模板。

## 文件

| 文件 | 用途 |
|---|---|
| [`adapter.mjs`](adapter.mjs) | opencli → bridge 协议适配器. 装在 AI Agent 服务器上, 让 opencli CLI 通过 bridge 操控远程用户浏览器 |
| [`agent-prompt-template.md`](agent-prompt-template.md) | 塞进 AI system prompt 的模板. 覆盖授权/调用/错误处理/SPA/opencli 集成 |
| [`data/`](data/) | 采集数据的示例 CSV (小红书/B站/微博评论) |

## 用 opencli 抓社媒 (推荐给做社媒 AI 的场景)

opencli 是社区维护的社媒 CLI, 内置各大平台的选择器和交互. Bridge 装在 AI 服务器上, 用户端只装 Chrome 插件.

```bash
# 前提: 用户在 Chrome 插件 popup 里已经飞书登录 + 生成了一个 bpt_xxx PAT 给你

# 1. 装 opencli
npm install -g opencli

# 2. 起 adapter (占用本地 19826 端口, 假装是 opencli 本地 daemon)
BRIDGE_URL=https://agent.imcagent.qzz.io/bridge \
BRIDGE_PAT=bpt_xxx... \
node adapter.mjs

# 3. 另开一个终端跑 opencli CLI, 让它把 daemon 请求打到 adapter
OPENCLI_DAEMON_PORT=19826 opencli doctor
OPENCLI_DAEMON_PORT=19826 opencli xhs search "AI眼镜"
OPENCLI_DAEMON_PORT=19826 opencli bilibili comments <video-url>
```

## 直接调 bridge (不用 opencli)

如果只是简单的浏览器动作 (打开网页 / 提取内容 / 截图), 不需要 opencli, 直接一个 HTTP 请求:

```bash
curl -X POST https://agent.imcagent.qzz.io/bridge/command \
  -H "Authorization: Bearer bpt_xxx..." \
  -H "Content-Type: application/json" \
  -d '{"action":"extract","params":{"type":"text"}}'
```

或者用 Node/Python 封装, 见 [`agent-prompt-template.md`](agent-prompt-template.md) 里的示例代码.

## 部署方视角

- 生产 bridge URL: `https://agent.imcagent.qzz.io/bridge`
- 完整 endpoint 列表 + 错误码 + 重试策略: [`../docs/AI_INTEGRATION.md`](../docs/AI_INTEGRATION.md)
- 设计文档: [`../docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md`](../docs/superpowers/specs/2026-07-22-saas-oauth-bridge-design.md)
