/**
 * opencli → ai-browser-bridge adapter (PAT model, 2026-07-23)
 *
 * 让 opencli CLI 通过 ai-browser-bridge relay 控制远程用户的浏览器。
 * 装在 AI Agent 服务器上, 用户端只装 bridge Chrome 扩展。
 *
 * 拓扑:
 *   opencli CLI  →  OPENCLI_DAEMON_PORT=19826 (本文件, 假装成 opencli 本地 daemon)
 *                →  POST /command Bearer <PAT>  →  bridge relay
 *                →  WSS  →  用户 Chrome 里的 bridge 扩展
 *                →  chrome.scripting.executeScript (静默, 不抢鼠标)
 *
 * 用法:
 *   1. 用户在 popup 生成一个 PAT (bpt_xxx...) 交给你
 *   2. 起 adapter:
 *        BRIDGE_URL=https://agent.imcagent.qzz.io/bridge \
 *        BRIDGE_PAT=bpt_xxx... \
 *        node examples/adapter.mjs
 *   3. 另一个终端 (opencli CLI):
 *        OPENCLI_DAEMON_PORT=19826 opencli xhs search "AI眼镜"
 *        OPENCLI_DAEMON_PORT=19826 opencli doctor
 *
 * 依赖: 就 Node 标准库 http, 无 npm 依赖 (Node >= 18 自带 fetch)。
 *
 * ⚠️ evalScript 的 CSP 限制
 *   opencli 的 `exec` 命令翻译成 bridge 的 `evalScript`, 在浏览器 MAIN world 里
 *   走 `(0, eval)(scriptString)`。受目标页面 CSP 约束:
 *     ✅ 无 CSP 或允许 unsafe-eval 的站点 (小红书 / B站 / 微博 / 抖音等)
 *     ❌ 严格 CSP 站点 (Twitter/X / GitHub / Google 多数产品 / Stripe 等)
 *   报错形如 "Refused to evaluate a string as JavaScript..."; bridge 侧无法绕过
 *   Chrome MV3 + 页面 CSP 的双重约束。
 *
 *   另外 relay 侧默认不允许 evalScript, 需要:
 *     (1) 部署方在 relay env 里设 ALLOWED_ACTIONS 加上 evalScript
 *     (2) 用户生成 PAT 时在 scopes 里勾上 evalScript
 *   两个前提都要满足, 缺一不可。
 */

import http from 'http'

const BRIDGE_URL = process.env.BRIDGE_URL || 'https://agent.imcagent.qzz.io/bridge'
const BRIDGE_PAT = process.env.BRIDGE_PAT
const PORT = parseInt(process.env.PORT || '19826', 10)

if (!BRIDGE_PAT) {
  console.error('❌ 缺少 BRIDGE_PAT 环境变量 (用户在浏览器插件 popup 里生成的 bpt_xxx token)')
  console.error('   用户操作:')
  console.error('     打开插件 popup → 飞书登录 → 管理 Token → 新建 Token')
  console.error('     勾选允许的 scopes → 生成 → 复制明文一次性显示的 bpt_xxx')
  process.exit(1)
}

if (!BRIDGE_PAT.startsWith('bpt_')) {
  console.error('❌ BRIDGE_PAT 格式不对, 应该是 bpt_ 开头的 40 字符 token')
  process.exit(1)
}

// ── 翻译 opencli action → bridge action ─────────────────────────────────
function translate(cmd) {
  switch (cmd.action) {
    case 'exec':
      // opencli: { action:'exec', code:'...' } → bridge: evalScript
      return { action: 'evalScript', params: { script: cmd.code, tabId: cmd.tabId } }

    case 'navigate':
      return { action: 'navigate', params: { url: cmd.url, tabId: cmd.tabId, newTab: cmd.newTab } }

    case 'tabs':
      return { action: 'tabs', params: {} }

    case 'cookies':
      return { action: 'cookies', params: { domain: cmd.domain } }

    case 'screenshot':
      return { action: 'screenshot', params: { windowId: cmd.windowId } }

    // opencli 目前不用以下, 但客户端如果传了也顺手转:
    case 'extract':
      return { action: 'extract', params: { type: cmd.type, tabId: cmd.tabId, waitFor: cmd.waitFor, waitTimeout: cmd.waitTimeout } }

    case 'waitForSelector':
      return { action: 'waitForSelector', params: { selector: cmd.selector, tabId: cmd.tabId, timeout: cmd.timeout, visible: cmd.visible } }

    default:
      return null
  }
}

// ── 发命令到 bridge ─────────────────────────────────────────────────────
// 返回统一格式 { ok, data, error } 给 opencli
async function sendToBridge(bridgeAction) {
  let res
  try {
    res = await fetch(`${BRIDGE_URL}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRIDGE_PAT}`,
      },
      body: JSON.stringify(bridgeAction),
    })
  } catch (err) {
    return { ok: false, error: `network: ${err.message}` }
  }

  let json
  try {
    json = await res.json()
  } catch {
    return { ok: false, error: `bridge returned non-JSON (status ${res.status})` }
  }

  if (res.ok && json.ok) {
    return { ok: true, data: json.result }
  }

  // 细粒度错误映射, 让 opencli 看到有意义的原因
  const code = json.error?.code ?? 'unknown'
  const msg = json.error?.message ?? `HTTP ${res.status}`
  const hint = errorHint(res.status, code)
  return { ok: false, error: hint ? `[${code}] ${msg} — ${hint}` : `[${code}] ${msg}` }
}

function errorHint(status, code) {
  if (status === 401 && code === 'invalid_token') return 'PAT 拼写错误或已被吊销, 让用户重新生成一个'
  if (status === 401 && code === 'token_revoked') return '用户已在 popup 撤销此 PAT, 请重新申请'
  if (status === 401 && code === 'token_expired') return 'PAT 已过期, 让用户重新生成'
  if (status === 403 && code === 'action_not_in_scope') return '用户生成 PAT 时没勾这个 action, 让用户重新生成并勾上'
  if (status === 429) return '触发限速, 建议按响应 retryAfterMs 退避后重试'
  if (status === 503 && code === 'device_offline') return '用户浏览器没打开或没登录插件, 无法重试, 请提示用户'
  if (status === 504) return '设备超时, 可重试一次; 反复超时说明浏览器端有问题'
  return null
}

// ── HTTP Server (假装成 opencli daemon) ─────────────────────────────────
const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // opencli daemon 安全头检查 (opencli CLI 发请求时会带这个头)
  if (!req.headers['x-opencli']) {
    send(403, { ok: false, error: 'Forbidden: missing X-OpenCLI header' })
    return
  }

  if (req.method === 'GET' && req.url === '/status') {
    // 快速探测 bridge relay 通不通
    let bridgeOk = false
    try {
      const r = await fetch(`${BRIDGE_URL}/health`)
      bridgeOk = r.ok
    } catch {}
    send(200, {
      ok: true,
      adapter: 'ai-browser-bridge',
      bridge: BRIDGE_URL,
      bridgeReachable: bridgeOk,
      extensionConnected: bridgeOk, // 严格来说要发探测命令才知道扩展在线, 这里做 doctor 兼容先返 true
    })
    return
  }

  if (req.method === 'POST' && req.url === '/command') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body)
        if (!cmd.id) {
          send(400, { ok: false, error: 'Missing command id' })
          return
        }

        const bridgeAction = translate(cmd)
        if (!bridgeAction) {
          send(200, { id: cmd.id, ok: false, error: `Unsupported action: ${cmd.action}` })
          return
        }

        const result = await sendToBridge(bridgeAction)
        send(200, { id: cmd.id, ...result })
      } catch (err) {
        send(500, { ok: false, error: err.message })
      }
    })
    return
  }

  send(404, { error: 'Not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  const patPreview = `${BRIDGE_PAT.slice(0, 12)}...`
  console.log(`\n🌉 ai-browser-bridge opencli adapter (PAT model)`)
  console.log(`${'─'.repeat(50)}`)
  console.log(`📡 Bridge:  ${BRIDGE_URL}`)
  console.log(`🔑 PAT:     ${patPreview}`)
  console.log(`🔌 Port:    ${PORT}`)
  console.log(`\n使用方式 (另开终端):`)
  console.log(`  OPENCLI_DAEMON_PORT=${PORT} opencli doctor`)
  console.log(`  OPENCLI_DAEMON_PORT=${PORT} opencli xhs search "AI眼镜"`)
  console.log(`${'─'.repeat(50)}\n`)
})
