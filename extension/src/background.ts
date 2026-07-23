import { RELAY_WS_URL, BRIDGE_ACCESS_KEY } from './config'
import { getOp, listScrapers } from './scrapers'

// ── 持久 clientId (= deviceId) ───────────────────────────────────────────
// 首次启动生成 UUID 存 chrome.storage.local，永久持有
// 登录飞书后这个 UUID 会在 bridge 侧绑定到 user_id (见 bridge_devices 表), 浏览器重启不换身份
async function getOrCreateClientId(): Promise<string> {
  const r = await chrome.storage.local.get('clientId')
  if (typeof r.clientId === 'string' && r.clientId.length > 0) return r.clientId
  const id = (crypto.randomUUID && crypto.randomUUID()) || fallbackUuid()
  await chrome.storage.local.set({ clientId: id })
  return id
}

// 兜底：极少数旧 chromium 没有 crypto.randomUUID
function fallbackUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ── WebSocket 连接管理 ────────────────────────────────────────────────────

let ws: WebSocket | null = null
let retryDelay = 2000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const MAX_RETRY = 60_000

async function connect() {
  // Reentrancy guard：已有 ws 且在 OPEN/CONNECTING 状态，绝不创建第二个
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  const clientId = await getOrCreateClientId()
  const { userToken } = await chrome.storage.local.get('userToken')
  let url = `${RELAY_WS_URL}?deviceId=${encodeURIComponent(clientId)}&accessKey=${encodeURIComponent(BRIDGE_ACCESS_KEY)}`
  if (typeof userToken === 'string' && userToken.length > 0) {
    url += `&userToken=${encodeURIComponent(userToken)}`
  }

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
    chrome.storage.local.set({ connected: true })
  }

  ws.onmessage = async (event) => {
    let msg: { id: string; action: string; params: Record<string, unknown> }
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }

    // 用户主权暂停开关：storage.paused === true 时拒绝所有 agent 命令
    const { paused } = await chrome.storage.local.get('paused')
    if (paused === true) {
      ws?.send(JSON.stringify({ id: msg.id, ok: false, error: 'User paused AI access' }))
      return
    }

    const result = await handleCommand(msg.action, msg.params)
    ws?.send(JSON.stringify({ id: msg.id, ...result }))
  }

  ws.onclose = () => {
    ws = null
    chrome.action.setIcon({ path: 'icons/icon48.png' }).catch(() => {})
    chrome.storage.local.set({ connected: false })
    scheduleReconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  console.log(`[Bridge] Reconnecting in ${retryDelay / 1000}s...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY)
}

// 登录/登出会改 userToken —— 必须立刻重连才能让"认证连接"状态生效
// (匿名连接收不到 command, 见 relay/src/lib/sessions.ts)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.userToken) {
    ws?.close()
    ws = null
    retryDelay = 2000
    connect()
  }
})

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
      case 'evalScript':
        return await cmdEvalScript(params)
      case 'navigate':
        return await cmdNavigate(params)
      case 'extract':
        return await cmdExtract(params)
      case 'waitForSelector':
        return await cmdWaitForSelector(params)
      case 'cookies':
        return await cmdCookies(params)
      case 'tabs':
        return await cmdTabs(params)
      case 'screenshot':
        return await cmdScreenshot(params)
      case 'scraper.list':
        return await cmdScraperList()
      case 'scraper.run':
        return await cmdScraperRun(params)
      default:
        return { ok: false, error: `Unknown action: ${action}` }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// 白名单 handler map：agent 只能调用枚举的预定义操作
type ScriptHandler = (params: Record<string, unknown>) => unknown
const ALLOWED_SCRIPTS: Record<string, ScriptHandler> = {
  'page.getTitle': () => document.title,
  'page.getText': () => document.body.innerText,
  'page.getHtml': () => document.documentElement.outerHTML,
  'page.getUrl': () => location.href,
}

// execute：只允许 ALLOWED_SCRIPTS 中的预定义脚本（多用户生产环境使用）
async function cmdExecute(params: Record<string, unknown>): Promise<CommandResult> {
  const tabId = await resolveTabId(params)
  const scriptId = params.scriptId as string
  if (!scriptId) return { ok: false, error: 'scriptId is required' }

  const handler = ALLOWED_SCRIPTS[scriptId]
  if (!handler) return { ok: false, error: `Script not in whitelist: ${scriptId}` }

  const scriptParams = (params.scriptParams ?? {}) as Record<string, unknown>
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: handler,
    args: [scriptParams],
    world: 'MAIN',
  })
  return { ok: true, data: results[0]?.result }
}

// evalScript：执行任意 JS，仅供 opencli adapter 内部使用
//
// ⚠️ CSP 限制：`(0, eval)` 在 MAIN world 受目标页面 CSP 约束。
async function cmdEvalScript(params: Record<string, unknown>): Promise<CommandResult> {
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

// ── AI Tab Group 管理 ────────────────────────────────────────────────────

const AI_GROUP_TITLE = 'AI Agent'
const AI_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'blue'

async function getAiGroupInWindow(windowId: number): Promise<number> {
  const stored = await chrome.storage.local.get('aiGroupId')
  const storedId: number | undefined = stored.aiGroupId
  if (storedId === undefined) return -1

  try {
    const group = await chrome.tabGroups.get(storedId)
    return group.windowId === windowId ? storedId : -1
  } catch {
    return -1
  }
}

async function addTabToAiGroup(tabId: number, windowId: number): Promise<void> {
  let groupId = await getAiGroupInWindow(windowId)

  if (groupId === -1) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] })
    await chrome.tabGroups.update(groupId, { title: AI_GROUP_TITLE, color: AI_GROUP_COLOR })
    await chrome.storage.local.set({ aiGroupId: groupId })
  } else {
    await chrome.tabs.group({ groupId, tabIds: [tabId] })
  }
}

// 行为约定（关键：永远不抢用户当前 tab）：
//   - 显式传 tabId        → 在该 tab 上 update url（用于 AI 自己创建过的 tab 后续跳转）
//   - 显式传 newTab:true  → 创建新 tab 并加入 AI Tab Group
//   - 都没传              → 视为 newTab:true（默认新建，绝不覆盖用户在看的页面）
async function cmdNavigate(params: Record<string, unknown>): Promise<CommandResult> {
  const url = params.url as string
  if (!url) return { ok: false, error: 'url is required' }

  const createNew = params.newTab === true || params.tabId === undefined

  let tabId: number
  if (createNew) {
    const tab = await chrome.tabs.create({ url, active: false })
    tabId = tab.id!
    await addTabToAiGroup(tabId, tab.windowId!)
  } else {
    tabId = params.tabId as number
    await chrome.tabs.update(tabId, { url })
  }

  await waitForTabLoad(tabId)
  return { ok: true, data: { tabId } }
}

// SPA 友好：可选 waitFor 参数 — 在 extract 之前先等指定 selector 出现
async function cmdExtract(params: Record<string, unknown>): Promise<CommandResult> {
  const tabId = await resolveTabId(params)

  if (typeof params.waitFor === 'string' && params.waitFor.length > 0) {
    const waitRes = await waitForSelectorOnTab(
      tabId,
      params.waitFor,
      typeof params.waitTimeout === 'number' ? params.waitTimeout : 10000,
    )
    if (!waitRes.matched) {
      return { ok: false, error: `Timeout waiting for selector: ${params.waitFor}` }
    }
  }

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

// 用于等待 SPA 异步渲染完成
async function cmdWaitForSelector(params: Record<string, unknown>): Promise<CommandResult> {
  const selector = params.selector as string
  if (!selector) return { ok: false, error: 'selector is required' }

  const tabId = await resolveTabId(params)
  const timeout = typeof params.timeout === 'number' ? params.timeout : 10000
  const visible = params.visible === true

  const result = await waitForSelectorOnTab(tabId, selector, timeout, visible)
  if (!result.matched) {
    return { ok: false, error: `Timeout (${timeout}ms) waiting for selector: ${selector}` }
  }
  return { ok: true, data: result }
}

async function waitForSelectorOnTab(
  tabId: number,
  selector: string,
  timeoutMs: number,
  visibleOnly: boolean = false,
): Promise<{ matched: boolean; count: number; elapsed: number }> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [selector, timeoutMs, visibleOnly],
    func: async (sel: string, timeout: number, visible: boolean) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const els = document.querySelectorAll(sel)
        if (els.length > 0) {
          if (!visible) return { matched: true, count: els.length, elapsed: Date.now() - start }
          const vis = Array.from(els).filter((el) => {
            const r = (el as HTMLElement).getBoundingClientRect()
            const cs = getComputedStyle(el as HTMLElement)
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
          })
          if (vis.length > 0) return { matched: true, count: vis.length, elapsed: Date.now() - start }
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      return { matched: false, count: 0, elapsed: Date.now() - start }
    },
  })
  return results[0]?.result ?? { matched: false, count: 0, elapsed: 0 }
}

async function cmdCookies(params: Record<string, unknown>): Promise<CommandResult> {
  const domain = params.domain as string
  if (!domain) return { ok: false, error: 'domain is required' }
  const cookies = await chrome.cookies.getAll({ domain })
  return { ok: true, data: cookies }
}

async function cmdTabs(_params: Record<string, unknown>): Promise<CommandResult> {
  const tabs = await chrome.tabs.query({})
  return {
    ok: true,
    data: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
  }
}

async function cmdScreenshot(params: Record<string, unknown>): Promise<CommandResult> {
  const windowId = params.windowId as number | undefined
  const dataUrl = windowId === undefined
    ? await chrome.tabs.captureVisibleTab({ format: 'png' })
    : await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  return { ok: true, data: dataUrl }
}

// ── Scraper (内置社媒选择器库, 见 scrapers/) ─────────────────────────────

async function cmdScraperList(): Promise<CommandResult> {
  return { ok: true, data: listScrapers() }
}

async function cmdScraperRun(params: Record<string, unknown>): Promise<CommandResult> {
  const platform = params.platform as string
  const op = params.op as string
  const args = (params.args ?? {}) as Record<string, unknown>
  if (!platform || !op) return { ok: false, error: 'platform and op are required' }

  const fn = getOp(platform, op)
  if (!fn) return { ok: false, error: `unknown scraper: ${platform}.${op}` }

  // scraper 内部会 navigate, 需要一个 tab. 显式传 tabId 就用, 否则挂 AI Tab Group
  let tabId: number
  if (typeof params.tabId === 'number') {
    tabId = params.tabId
  } else {
    // 新建 tab 加入 AI group, scraper 内部 navigate 会覆盖它
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
    tabId = tab.id!
    await addTabToAiGroup(tabId, tab.windowId!)
  }

  const result = await fn({ tabId, args })
  return result
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

// 解析 tabId：
//   - 显式 params.tabId 优先
//   - 否则在 AI Tab Group 里挑最近活跃的 tab
//   - AI Group 不存在或为空 → 抛错（提示先 navigate 创建 tab）
async function resolveTabId(params: Record<string, unknown>): Promise<number> {
  if (params.tabId) return params.tabId as number

  const stored = await chrome.storage.local.get('aiGroupId')
  const aiGroupId: number | undefined = stored.aiGroupId
  if (aiGroupId === undefined) {
    throw new Error('No AI tab. Call navigate first (with newTab:true or no tabId) to create one.')
  }

  try {
    await chrome.tabGroups.get(aiGroupId)
  } catch {
    throw new Error('AI tab group no longer exists. Call navigate to create a new one.')
  }

  const tabs = await chrome.tabs.query({ groupId: aiGroupId })
  if (tabs.length === 0) {
    throw new Error('AI tab group is empty. Call navigate to create a tab.')
  }

  const sorted = tabs
    .filter((t): t is chrome.tabs.Tab & { id: number } => typeof t.id === 'number')
    .sort((a, b) => ((b as unknown as { lastAccessed?: number }).lastAccessed ?? b.id) -
                    ((a as unknown as { lastAccessed?: number }).lastAccessed ?? a.id))
  if (sorted.length === 0) throw new Error('AI tab has no id')
  return sorted[0].id
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    const timer = setTimeout(finish, 5000)
  })
}

// popup 点了 reconnect 按钮（清掉重连退避，立即再连一次）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'reconnect') {
    ws?.close()
    ws = null
    retryDelay = 2000
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    connect()
    sendResponse({ ok: true })
    return true
  }
})

// ── 启动 ──────────────────────────────────────────────────────────────────

connect()

export {}
