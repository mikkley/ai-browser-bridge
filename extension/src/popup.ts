const relayUrlInput = document.getElementById('relayUrl') as HTMLInputElement
const tokenInput = document.getElementById('token') as HTMLInputElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const statusDiv = document.getElementById('status') as HTMLDivElement

// 读取已保存的配置
chrome.storage.local.get(['relayUrl', 'token'], (result) => {
  if (result.relayUrl) relayUrlInput.value = result.relayUrl
  if (result.token) tokenInput.value = result.token
})

saveBtn.addEventListener('click', async () => {
  const relayUrl = relayUrlInput.value.trim()
  const token = tokenInput.value.trim()

  if (!relayUrl || !token) {
    statusDiv.textContent = 'Please fill in both fields'
    statusDiv.className = 'disconnected'
    return
  }

  await chrome.storage.local.set({ relayUrl, token })
  statusDiv.textContent = 'Saved! Connecting...'
  statusDiv.className = ''

  // 通知 background 重新连接
  chrome.runtime.sendMessage({ action: 'reconnect' })

  setTimeout(() => {
    statusDiv.textContent = 'Settings saved ✓'
    statusDiv.className = 'connected'
  }, 1000)
})
