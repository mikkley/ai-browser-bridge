const codeInput = document.getElementById('code') as HTMLTextAreaElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const statusDiv = document.getElementById('status') as HTMLDivElement
const dot = document.getElementById('dot') as HTMLSpanElement
const connText = document.getElementById('connText') as HTMLSpanElement

// 解析 connect code
function parseConnectCode(code: string): { url: string; token: string } | null {
  try {
    const raw = code.trim().replace(/^bridge_/, '')
    return JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

// 读取已保存配置，显示连接状态
chrome.storage.local.get(['connectCode', 'connected'], (result) => {
  if (result.connectCode) codeInput.value = result.connectCode
  updateStatus(result.connected === true)
})

function updateStatus(connected: boolean) {
  dot.className = 'dot' + (connected ? ' on' : '')
  connText.textContent = connected ? 'Connected' : 'Not connected'
}

saveBtn.addEventListener('click', async () => {
  const code = codeInput.value.trim()
  if (!code) {
    statusDiv.textContent = 'Please paste your connect code'
    statusDiv.className = 'err'
    return
  }

  const parsed = parseConnectCode(code)
  if (!parsed) {
    statusDiv.textContent = 'Invalid connect code'
    statusDiv.className = 'err'
    return
  }

  await chrome.storage.local.set({ connectCode: code, relayUrl: parsed.url, token: parsed.token })
  chrome.runtime.sendMessage({ action: 'reconnect' })

  statusDiv.textContent = 'Connecting...'
  statusDiv.className = ''

  setTimeout(() => {
    statusDiv.textContent = 'Saved ✓'
    statusDiv.className = 'ok'
    updateStatus(true)
  }, 1200)
})
