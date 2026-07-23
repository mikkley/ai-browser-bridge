import { loginWithFeishu, logout, isLoggedIn, getMe, renameDevice, getOrCreateDeviceId } from './auth'
import { listTokens, createToken, revokeToken, AVAILABLE_SCOPES, type DeviceToken } from './tokens'
import { apiFetch } from './api-client'

// ── DOM 引用 ──────────────────────────────────────────────────────────────
const dot = document.getElementById('dot') as HTMLSpanElement
const connText = document.getElementById('connText') as HTMLSpanElement

const viewLoggedOut = document.getElementById('view-loggedout') as HTMLDivElement
const viewLoggedIn = document.getElementById('view-loggedin') as HTMLDivElement
const viewTokens = document.getElementById('view-tokens') as HTMLDivElement

const loginBtn = document.getElementById('loginBtn') as HTMLButtonElement
const loginStatus = document.getElementById('loginStatus') as HTMLDivElement

const userNameEl = document.getElementById('userName') as HTMLSpanElement
const deviceNameInput = document.getElementById('deviceNameInput') as HTMLInputElement
const saveDeviceNameBtn = document.getElementById('saveDeviceNameBtn') as HTMLButtonElement
const reconnectBtn = document.getElementById('reconnectBtn') as HTMLButtonElement
const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement
const pauseBanner = document.getElementById('pauseBanner') as HTMLDivElement
const gotoTokensBtn = document.getElementById('gotoTokensBtn') as HTMLButtonElement
const tokenCountEl = document.getElementById('tokenCount') as HTMLSpanElement
const logoutBtn = document.getElementById('logoutBtn') as HTMLButtonElement
const auditBtn = document.getElementById('auditBtn') as HTMLButtonElement
const auditDiv = document.getElementById('audit') as HTMLDivElement

const backBtn = document.getElementById('backBtn') as HTMLButtonElement
const plaintextPanel = document.getElementById('plaintextPanel') as HTMLDivElement
const plaintextCode = document.getElementById('plaintextCode') as HTMLElement
const copyPlaintextBtn = document.getElementById('copyPlaintextBtn') as HTMLButtonElement
const dismissPlaintextBtn = document.getElementById('dismissPlaintextBtn') as HTMLButtonElement
const tokenListEl = document.getElementById('tokenList') as HTMLDivElement
const tokenLabelInput = document.getElementById('tokenLabelInput') as HTMLInputElement
const scopeCheckboxesEl = document.getElementById('scopeCheckboxes') as HTMLDivElement
const createTokenBtn = document.getElementById('createTokenBtn') as HTMLButtonElement
const createTokenStatus = document.getElementById('createTokenStatus') as HTMLDivElement

// ── 视图路由 ──────────────────────────────────────────────────────────────
type View = 'loggedout' | 'loggedin' | 'tokens'

function showView(view: View) {
  viewLoggedOut.hidden = view !== 'loggedout'
  viewLoggedIn.hidden = view !== 'loggedin'
  viewTokens.hidden = view !== 'tokens'
}

async function refreshView() {
  if (!(await isLoggedIn())) {
    showView('loggedout')
    return
  }
  const me = await getMe()
  if (!me) {
    // userToken 失效 (过期/被后台清了) —— 退回未登录态
    await logout()
    showView('loggedout')
    return
  }
  userNameEl.textContent = me.user.username
  deviceNameInput.value = me.device.device_name ?? ''
  showView('loggedin')
  refreshTokenCount()
}

// ── 连接状态 ──────────────────────────────────────────────────────────────
function updateStatus(connected: boolean) {
  dot.className = 'dot' + (connected ? ' on' : '')
  connText.textContent = connected ? 'Connected' : 'Not connected'
}

chrome.storage.local.get('connected', (r) => updateStatus(r.connected === true))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.connected) updateStatus(changes.connected.newValue === true)
})

reconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'reconnect' })
  reconnectBtn.textContent = 'Reconnecting…'
  setTimeout(() => (reconnectBtn.textContent = 'Reconnect'), 1500)
})

// ── 登录 / 登出 ───────────────────────────────────────────────────────────
loginBtn.addEventListener('click', async () => {
  loginStatus.textContent = '打开飞书登录…'
  loginStatus.className = ''
  loginBtn.disabled = true
  try {
    await loginWithFeishu()
    loginStatus.textContent = ''
    await refreshView()
  } catch (err) {
    loginStatus.textContent = `登录失败: ${(err as Error).message}`
    loginStatus.className = 'err'
  } finally {
    loginBtn.disabled = false
  }
})

logoutBtn.addEventListener('click', async () => {
  await logout()
  showView('loggedout')
})

saveDeviceNameBtn.addEventListener('click', async () => {
  const name = deviceNameInput.value.trim()
  if (!name) return
  const deviceId = await getOrCreateDeviceId()
  try {
    await renameDevice(deviceId, name)
    saveDeviceNameBtn.textContent = '✓'
    setTimeout(() => (saveDeviceNameBtn.textContent = '保存'), 1200)
  } catch (err) {
    saveDeviceNameBtn.textContent = '失败'
    setTimeout(() => (saveDeviceNameBtn.textContent = '保存'), 1500)
  }
})

// ── Pause / Resume AI access ────────────────────────────────────────────
function renderPauseUI(paused: boolean) {
  if (paused) {
    pauseBtn.textContent = 'Resume AI access'
    pauseBtn.className = 'success'
    pauseBanner.className = 'active'
  } else {
    pauseBtn.textContent = 'Pause AI access'
    pauseBtn.className = 'danger'
    pauseBanner.className = 'inactive'
  }
}

chrome.storage.local.get('paused', (r) => renderPauseUI(r.paused === true))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.paused) renderPauseUI(changes.paused.newValue === true)
})

pauseBtn.addEventListener('click', async () => {
  const { paused } = await chrome.storage.local.get('paused')
  await chrome.storage.local.set({ paused: !paused })
})

// ── AI 操作审计 (走 /api/me/audit) ───────────────────────────────────────
interface AuditEntry {
  ts: string
  action: string
  status: 'ok' | 'error' | 'refused' | 'timeout'
  error_msg?: string | null
  duration_ms?: number | null
}

async function loadAudit() {
  auditDiv.hidden = false
  auditDiv.innerHTML = '<div class="empty">Loading...</div>'
  try {
    const res = await apiFetch<{ entries: AuditEntry[] }>('/api/me/audit?limit=50')
    if (!res.entries.length) {
      auditDiv.innerHTML = '<div class="empty">No activity yet.</div>'
      return
    }
    auditDiv.innerHTML = res.entries.map(renderAuditEntry).join('')
  } catch (err) {
    auditDiv.innerHTML = `<div class="empty">Failed: ${escapeHtml((err as Error).message)}</div>`
  }
}

function renderAuditEntry(e: AuditEntry): string {
  const t = new Date(e.ts).toLocaleString('zh-CN', { hour12: false })
  const isBad = e.status !== 'ok'
  const badge = isBad ? '<span class="bad">⚠</span> ' : ''
  const errSuffix = e.error_msg ? ` <span class="bad">${escapeHtml(e.error_msg)}</span>` : ''
  return `<div class="row">${badge}<span class="action">${escapeHtml(e.action)}</span>${errSuffix}<div class="meta">${t}</div></div>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

auditBtn.addEventListener('click', () => {
  if (auditDiv.hidden) {
    loadAudit()
    auditBtn.textContent = 'Hide AI activity'
  } else {
    auditDiv.hidden = true
    auditBtn.textContent = 'View AI activity'
  }
})

// ── Token 管理 ────────────────────────────────────────────────────────────

for (const scope of AVAILABLE_SCOPES) {
  const label = document.createElement('label')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.value = scope
  checkbox.checked = true // 默认全选, 用户按需取消
  label.appendChild(checkbox)
  label.appendChild(document.createTextNode(scope))
  scopeCheckboxesEl.appendChild(label)
}

function selectedScopes(): string[] {
  return Array.from(scopeCheckboxesEl.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')).map((c) => c.value)
}

async function refreshTokenCount() {
  try {
    const tokens = await listTokens()
    tokenCountEl.textContent = String(tokens.filter((t) => !t.revoked_at).length)
  } catch {
    tokenCountEl.textContent = '?'
  }
}

async function loadTokenList() {
  tokenListEl.innerHTML = '<div class="empty">Loading...</div>'
  try {
    const tokens = await listTokens()
    if (!tokens.length) {
      tokenListEl.innerHTML = '<div class="empty">还没有生成过 Token</div>'
      return
    }
    tokenListEl.innerHTML = ''
    for (const t of tokens) {
      tokenListEl.appendChild(renderTokenRow(t))
    }
  } catch (err) {
    tokenListEl.innerHTML = `<div class="empty">加载失败: ${escapeHtml((err as Error).message)}</div>`
  }
}

function renderTokenRow(t: DeviceToken): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'token-row'

  const top = document.createElement('div')
  top.className = 'row-flex'

  const prefix = document.createElement('span')
  prefix.className = 'prefix'
  prefix.textContent = `${t.token_prefix}… (${t.label})`
  top.appendChild(prefix)

  if (!t.revoked_at) {
    const revokeBtn = document.createElement('button')
    revokeBtn.className = 'small danger'
    revokeBtn.textContent = '撤销'
    revokeBtn.addEventListener('click', async () => {
      revokeBtn.disabled = true
      revokeBtn.textContent = '撤销中…'
      try {
        await revokeToken(t.jti)
        await loadTokenList()
        await refreshTokenCount()
      } catch {
        revokeBtn.disabled = false
        revokeBtn.textContent = '失败'
      }
    })
    top.appendChild(revokeBtn)
  }
  row.appendChild(top)

  const meta = document.createElement('div')
  meta.className = 'meta'
  const scopesText = `scopes: ${t.scopes.length}项`
  const lastUsed = t.last_used_at ? `最后使用: ${new Date(t.last_used_at).toLocaleString('zh-CN', { hour12: false })}` : '从未使用'
  const status = t.revoked_at ? ' · 已撤销' : ''
  meta.textContent = `${scopesText} · ${lastUsed}${status}`
  row.appendChild(meta)

  return row
}

gotoTokensBtn.addEventListener('click', () => {
  showView('tokens')
  plaintextPanel.hidden = true
  loadTokenList()
})

backBtn.addEventListener('click', () => {
  showView('loggedin')
  refreshTokenCount()
})

createTokenBtn.addEventListener('click', async () => {
  const label = tokenLabelInput.value.trim()
  const scopes = selectedScopes()

  if (!label) {
    createTokenStatus.textContent = '请填写 Token 用途'
    createTokenStatus.className = 'err'
    return
  }
  if (scopes.length === 0) {
    createTokenStatus.textContent = '请至少勾选一项允许的操作'
    createTokenStatus.className = 'err'
    return
  }

  createTokenBtn.disabled = true
  createTokenStatus.textContent = '生成中…'
  createTokenStatus.className = ''

  try {
    const result = await createToken(label, scopes)
    plaintextCode.textContent = result.plaintext
    plaintextPanel.hidden = false
    tokenLabelInput.value = ''
    createTokenStatus.textContent = ''
    await loadTokenList()
    await refreshTokenCount()
  } catch (err) {
    createTokenStatus.textContent = `失败: ${(err as Error).message}`
    createTokenStatus.className = 'err'
  } finally {
    createTokenBtn.disabled = false
  }
})

copyPlaintextBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(plaintextCode.textContent || '')
  const orig = copyPlaintextBtn.textContent
  copyPlaintextBtn.textContent = '✓'
  setTimeout(() => (copyPlaintextBtn.textContent = orig), 1200)
})

dismissPlaintextBtn.addEventListener('click', () => {
  plaintextPanel.hidden = true
  plaintextCode.textContent = '' // 明文用完即焚, DOM 里不留痕迹
})

// ── 初始化 ────────────────────────────────────────────────────────────────
void refreshView()

export {}
