// ── 配置 ──────────────────────────────────────────────────────────────────

// 从 storage 读取用户配置的 relay 地址和 token
async function getConfig(): Promise<{ relayUrl: string; token: string } | null> {
  const result = await chrome.storage.local.get(['relayUrl', 'token'])
  if (!result.relayUrl || !result.token) return null
  return { relayUrl: result.relayUrl, token: result.token }
}

// ── WebSocket 连接管理 ────────────────────────────────────────────────────

let ws: WebSocket | null = null
let retryDelay = 2000
const MAX_RETRY = 60_000

async function connect() {
  const config = await getConfig()
  if (!config) {
    console.log('[Bridge] No config found, skipping connection')
    return
  }

  const url = `${config.relayUrl}?token=${encodeURIComponent(config.token)}`

  try {
    ws = new WebSocket(url)
  } catch (err) {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    console.log('[Bridge] Connected to relay')
    retryDelay = 2000
    chrome.action.setIcon({ path: 'icons/icon48_active.png' }).catch(() => {})
  }

  ws.onmessage = async (event) => {
    let msg: { id: string; action: string; params: Record<string, unknown> }
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    const result = await handleCommand(msg.action, msg.params)
    ws?.send(JSON.stringify({ id: msg.id, ...result }))
  }

  ws.onclose = () => {
    ws = null
    chrome.action.setIcon({ path: 'icons/icon48.png' }).catch(() => {})
    scheduleReconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }
}

function scheduleReconnect() {
  console.log(`[Bridge] Reconnecting in ${retryDelay / 1000}s...`)
  setTimeout(connect, retryDelay)
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY)
}

// ── keepalive：MV3 service worker 30s 会被杀 ─────────────────────────────

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect()
  }
})

// ── 命令处理 ──────────────────────────────────────────────────────────────

type CommandResult = { ok: true; data: unknown } | { ok: false; error: string }

async function handleCommand(
  action: string,
  params: Record<string, unknown>
): Promise<CommandResult> {
  try {
    switch (action) {
      case 'execute':
        return await cmdExecute(params)
      case 'navigate':
        return await cmdNavigate(params)
      case 'extract':
        return await cmdExtract(params)
      case 'cookies':
        return await cmdCookies(params)
      case 'tabs':
        return await cmdTabs(params)
      case 'screenshot':
        return await cmdScreenshot(params)
      default:
        return { ok: false, error: `Unknown action: ${action}` }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// 在指定 tab 里执行任意 JS（不抢鼠标，静默执行）
// script 作为参数传入页面上下文执行，background 本身不用 eval
async function cmdExecute(params: Record<string, unknown>): Promise<CommandResult> {
  const tabId = await resolveTabId(params)
  const script = params.script as string
  if (!script) return { ok: false, error: 'script is required' }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (s: string) => (0, eval)(s),
    args: [script],
    world: 'MAIN',
  })
  return { ok: true, data: results[0]?.result }
}

// 导航到指定 URL，等待加载完成
async function cmdNavigate(params: Record<string, unknown>): Promise<CommandResult> {
  const url = params.url as string
  if (!url) return { ok: false, error: 'url is required' }

  const createNew = params.newTab === true

  let tabId: number
  if (createNew) {
    const tab = await chrome.tabs.create({ url, active: false })
    tabId = tab.id!
  } else {
    tabId = await resolveTabId(params)
    await chrome.tabs.update(tabId, { url })
  }

  // 等待 tab 加载完毕
  await waitForTabLoad(tabId)
  return { ok: true, data: { tabId } }
}

// 提取页面内容（title、text、HTML）
async function cmdExtract(params: Record<string, unknown>): Promise<CommandResult> {
  const tabId = await resolveTabId(params)
  const type = (params.type as string) ?? 'text'

  let func: () => unknown
  if (type === 'html') {
    func = () => document.documentElement.outerHTML
  } else if (type === 'title') {
    func = () => document.title
  } else {
    func = () => document.body.innerText
  }

  const results = await chrome.scripting.executeScript({ target: { tabId }, func, world: 'MAIN' })
  return { ok: true, data: results[0]?.result }
}

// 获取 cookies
async function cmdCookies(params: Record<string, unknown>): Promise<CommandResult> {
  const domain = params.domain as string
  if (!domain) return { ok: false, error: 'domain is required' }
  const cookies = await chrome.cookies.getAll({ domain })
  return { ok: true, data: cookies }
}

// 列出当前打开的 tabs
async function cmdTabs(_params: Record<string, unknown>): Promise<CommandResult> {
  const tabs = await chrome.tabs.query({})
  return {
    ok: true,
    data: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
  }
}

// 截图
async function cmdScreenshot(params: Record<string, unknown>): Promise<CommandResult> {
  const windowId = params.windowId as number | undefined
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId!, { format: 'png' })
  return { ok: true, data: dataUrl }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

// 解析 tabId：优先用 params.tabId，否则取当前 active tab
async function resolveTabId(params: Record<string, unknown>): Promise<number> {
  if (params.tabId) return params.tabId as number
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab found')
  return tab.id
}

// 等待 tab 加载完成
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    // 5s 超时兜底
    setTimeout(resolve, 5000)
  })
}

// ── 飞书 / Web 页面自动配对 ─────────────────────────────────────────────
// 网页调用：window.postMessage({type:'bridge-pair', connectCode:'bridge_ey...'}, '*')
// content.ts 会将消息转发至此

function parseConnectCode(code: string): { url: string; token: string } | null {
  try {
    const raw = code.trim().replace(/^bridge_/, '')
    return JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'pair' && typeof msg.connectCode === 'string') {
    const parsed = parseConnectCode(msg.connectCode)
    if (!parsed) {
      sendResponse({ ok: false, error: 'Invalid connect code' })
      return true
    }

    chrome.storage.local
      .set({ connectCode: msg.connectCode, relayUrl: parsed.url, token: parsed.token })
      .then(() => {
        // 断开旧连接，用新配置重连
        ws?.close()
        ws = null
        connect()
        sendResponse({ ok: true })
      })
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }))

    return true // 异步 sendResponse
  }

  if (msg.action === 'reconnect') {
    ws?.close()
    ws = null
    connect()
    sendResponse({ ok: true })
    return true
  }
})

// ── 启动 ──────────────────────────────────────────────────────────────────

connect()
