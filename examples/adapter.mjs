/**
 * opencli → ai-browser-bridge adapter
 *
 * ⚠️ 已过期 (2026-07-22): 走的是已删除的 /token/agent + agent-jwt 认证。
 * 新协议是 PAT 模型 (Authorization: Bearer bpt_xxx), 见 ../docs/AI_INTEGRATION.md。
 * 这个 adapter 需要改成读一个 BRIDGE_PAT env 直接当 Bearer token 用, 待更新。
 *
 * 让 opencli CLI 通过 ai-browser-bridge relay 控制远程用户的浏览器。
 *
 * 原理：
 *   opencli CLI → OPENCLI_DAEMON_PORT=19826 → 本文件（本地 HTTP）
 *   → 翻译协议 → 远程 relay → WebSocket → 用户的 ai-browser-bridge 插件 → Chrome
 *
 * 用法：
 *   RELAY_URL=https://your-relay.com \
 *   RELAY_SECRET=xxx \
 *   USER_ID=user123 \
 *   node examples/adapter.mjs
 *
 *   # 另一个终端：
 *   OPENCLI_DAEMON_PORT=19826 opencli xhs search "AI眼镜"
 *
 * ⚠️ evalScript 的 CSP 限制
 *   opencli 的 `exec` 命令会被翻译成 bridge 的 `evalScript`，最终在浏览器
 *   MAIN world 走 `(0, eval)(scriptString)`。这受目标页面 CSP 约束：
 *     ✅ 无 CSP 或允许 unsafe-eval 的站点（小红书、B站、微博、抖音等中文社媒）
 *     ❌ 严格 CSP 站点（Twitter/X、GitHub、Google 多数产品、Stripe 等）
 *   被 CSP 拒绝时报错形如：
 *     "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source"
 *   解决方式只能是改用具名函数（在 extension 的 ALLOWED_SCRIPTS 注册后走 execute 通道），
 *   bridge 侧无法绕过 Chrome MV3 + 页面 CSP 的双重约束。
 *
 *   另外 relay 默认不允许 evalScript，需要启动时设置：
 *     ALLOWED_ACTIONS=navigate,extract,cookies,tabs,screenshot,execute,evalScript
 */

import http from 'http'

const RELAY_URL    = process.env.RELAY_URL    || 'http://localhost:3000'
const RELAY_SECRET = process.env.RELAY_SECRET
const USER_ID      = process.env.USER_ID      || 'admin'
const AGENT_ID     = process.env.AGENT_ID     || 'opencli'
const PORT         = parseInt(process.env.PORT || '19826', 10)

if (!RELAY_SECRET) {
  console.error('❌ 缺少 RELAY_SECRET 环境变量')
  console.error('   从 relay 启动日志或 npm run info 获取')
  process.exit(1)
}

// ── 获取 relay agent token ────────────────────────────────────────────────
// /command 端点用 verifyAgentToken 校验，要求 role: 'agent'。
// 必须走 /token/agent 申请绑定 USER_ID 的 agent-jwt，不能用 connectCode 里的 user-jwt。
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

// ── 翻译 opencli action → relay action ───────────────────────────────────
function translate(cmd) {
  switch (cmd.action) {
    case 'exec':
      // opencli: { action:'exec', code:'...' }
      // relay:   { action:'evalScript', script:'...' }（需要 relay 开启 evalScript 权限）
      return { action: 'evalScript', script: cmd.code, tabId: cmd.tabId }

    case 'navigate':
      return { action: 'navigate', url: cmd.url, tabId: cmd.tabId, newTab: cmd.newTab }

    case 'tabs':
      return { action: 'tabs' }

    case 'cookies':
      return { action: 'cookies', domain: cmd.domain }

    case 'screenshot':
      return { action: 'screenshot', windowId: cmd.windowId }

    default:
      return null
  }
}

// ── 发命令到 relay ─────────────────────────────────────────────────────────
async function sendToRelay(relayAction) {
  const token = await getAgentToken()
  const { action, ...params } = relayAction
  // relay 协议：{ userId, action, params: {...} }
  const res = await fetch(`${RELAY_URL}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ userId: USER_ID, action, params }),
  })
  return res.json()
}

// ── HTTP Server（模拟 opencli daemon）────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // opencli daemon 安全头检查（宽松版，支持本地 CLI）
  if (!req.headers['x-opencli']) {
    send(403, { ok: false, error: 'Forbidden: missing X-OpenCLI header' })
    return
  }

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
        if (!relayAction) {
          send(200, { id: cmd.id, ok: false, error: `Unsupported action: ${cmd.action}` })
          return
        }

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
  console.log(`\n🌉 ai-browser-bridge opencli adapter`)
  console.log(`${'─'.repeat(45)}`)
  console.log(`📡 Relay:   ${RELAY_URL}`)
  console.log(`👤 User ID: ${USER_ID}`)
  console.log(`🔌 Port:    ${PORT}`)
  console.log(`\n使用方式（另开终端）:`)
  console.log(`  OPENCLI_DAEMON_PORT=${PORT} opencli xhs search "AI眼镜"`)
  console.log(`  OPENCLI_DAEMON_PORT=${PORT} opencli doctor`)
  console.log(`${'─'.repeat(45)}\n`)
})
