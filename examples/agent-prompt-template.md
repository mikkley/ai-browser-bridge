# AI Agent Prompt Template — Bridge Integration (PAT model)

把这段塞到任何需要操作用户浏览器的 AI 系统提示里。

## 简版（直接复制给 AI 用作 system prompt）

```
你可以通过 ai-browser-bridge 操作用户已登录的真实浏览器。

授权模型:
  用户在 Chrome 插件 popup 里飞书 SSO 登录 → 生成一个 bpt_xxx token → 交给你 (BRIDGE_PAT env)。
  你不需要走 OAuth flow, 不需要 client 注册, token 即凭据。
  用户不给 PAT 之前, 不要臆测调用, 先问用户"你的 BRIDGE_PAT 是什么"。

调用 (Bridge URL 由部署方提供, 生产是 https://agent.imcagent.qzz.io/bridge):
  POST <BRIDGE_URL>/command
  Headers: { Authorization: "Bearer bpt_xxx..." }
  Body:    { action, params }
  返回:    { ok: true, result } 或 { ok: false, error: { code, message } }

可用 action:
  - tabs             列出当前浏览器 tab. params: {}
  - navigate         打开 URL, 默认新建 tab (不抢用户当前 tab).
                     params: { url, newTab?, tabId? }
                     返回 { tabId } — 记下给后续调用用
  - waitForSelector  等 SPA 元素渲染出来 (跨 navigate 后必备).
                     params: { selector, tabId, timeout?, visible? }
  - extract          读页面 text/html/title, 可选先 waitFor.
                     params: { type: text|html|title, tabId, waitFor?, waitTimeout? }
  - cookies          按 domain 取 cookies.
                     params: { domain }
  - screenshot       截图 PNG dataURL.
                     params: { windowId? }
  - execute          白名单预定义脚本 (page.getTitle / page.getText / page.getHtml / page.getUrl).
                     params: { scriptId, tabId }
  - evalScript       执行任意 JS (受目标页 CSP 约束, 严格 CSP 站点如 Twitter/GitHub 会被拒).
                     params: { script, tabId }

错误码 (error.code):
  invalid_token / token_revoked / token_expired  → 不要重试, 让用户重新生成 PAT
  action_not_in_scope                            → 让用户重新生成 PAT 时勾上这个 action
  device_offline                                 → 用户浏览器没开或没登录插件, 不要重试, 提示用户
  device_timeout                                 → 可以重试 1 次, 反复超时说明浏览器端有问题
  rate_limited (429, 带 retryAfterMs)             → 按 retryAfterMs 退避重试
  invalid_action / invalid_request               → 请求格式错误, 不要重试, 修参数

操作 SPA 时的标准序列:
  navigate → waitForSelector → extract
  (千万不要 navigate 后立即 extract, 会拿到空骨架)

注意:
  - PAT 不要写死进代码 / 不要落文件 / 不要日志打印. 泄露 = 攻击者能操控用户浏览器直到用户撤销
  - newTab 默认 true 是对的, 不要为省 tabId 而复用用户当前 tab (会抢走用户正在看的页面)
  - 后续操作用 navigate 返回的 tabId 串起来
  - 抓大量数据: 分批 + waitForSelector, 别一把梭 (SPA 只有首屏)
  - 抓 echarts 图表数据用 evalScript 调 window.echarts.getInstanceByDom(el).getOption().dataset[0].source, 不需要 OCR
```

## 完整可跑的 JS 模板

```js
const BRIDGE_URL = process.env.BRIDGE_URL || 'https://agent.imcagent.qzz.io/bridge'
const BRIDGE_PAT = process.env.BRIDGE_PAT  // 用户交给你的 bpt_xxx

class BridgeError extends Error {
  constructor(code, message, retryAfterMs) {
    super(`[${code}] ${message}`)
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

async function call(action, params = {}) {
  const res = await fetch(`${BRIDGE_URL}/command`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BRIDGE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params }),
  })
  const json = await res.json()
  if (!json.ok) {
    throw new BridgeError(json.error?.code ?? 'unknown', json.error?.message ?? `HTTP ${res.status}`, json.error?.retryAfterMs)
  }
  return json.result
}

// 用法: 在用户已登录的小红书里抓某个笔记的评论
async function main() {
  const { tabId } = await call('navigate', { url: 'https://www.xiaohongshu.com/explore/xxxxxxx' })
  await call('waitForSelector', { selector: '.comment-item', tabId, timeout: 8000 })
  const html = await call('extract', { type: 'html', tabId })
  // 从 html 里 parse 评论 (用 cheerio 或 regex)...
}

main().catch(e => {
  if (e.code === 'device_offline') console.error('请打开浏览器并确保插件已登录')
  else if (e.code === 'token_revoked') console.error('用户撤销了 PAT, 请让用户重新生成')
  else console.error(e)
})
```

## 用 opencli 时（推荐给需要抓小红书/抖音/B站等主流社媒的 AI）

opencli 是社区维护的社媒 CLI，内置各家网站的选择器和交互流程。用 `examples/adapter.mjs` 把 opencli 的本地 daemon 端口重定向到远端 bridge：

```bash
# 1. 装 opencli
npm install -g opencli

# 2. 起 adapter (假装成 opencli 本地 daemon)
BRIDGE_URL=https://agent.imcagent.qzz.io/bridge \
BRIDGE_PAT=bpt_xxx... \
node examples/adapter.mjs

# 3. 另开终端跑 opencli (指向 adapter 的端口)
OPENCLI_DAEMON_PORT=19826 opencli doctor
OPENCLI_DAEMON_PORT=19826 opencli xhs search "AI眼镜"
OPENCLI_DAEMON_PORT=19826 opencli bilibili comments <video-url>
```

opencli 内部拆命令 → adapter 翻译成 bridge action → bridge 派发到用户浏览器。AI 端不用自己写小红书选择器。

## FAQ

**Q: PAT 有效期多久？**
A: 用户生成时可以设过期时间，也可以不设（永不过期直到手动撤销）。默认永不过期。

**Q: 用户能实时撤销吗？**
A: 能。用户在 popup 里点撤销 → PAT 立即失效 → 你下次调 command 立刻收 `token_revoked` 401。

**Q: 一个 PAT 能操作多个用户浏览器吗？**
A: 不能。一个 PAT 绑到某个用户的某台设备。要操作另一台设备就要另一个 PAT。

**Q: 用户能限制我的权限吗？**
A: 能。用户生成 PAT 时勾 scopes，只有勾了的 action 你才能调，未勾的会返 `action_not_in_scope` 403。

**Q: AI 端要装什么？**
A: 最少：Node >= 18（自带 fetch），一个 `Authorization: Bearer` 头就能调。想用 opencli 的成熟命令再装 opencli + 跑 `adapter.mjs`。
