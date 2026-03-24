// Content script：监听来自 web 页面的配对消息
// 使用方：在任意页面执行 window.postMessage({type:'bridge-pair', connectCode:'bridge_ey...'}, '*')
// 该消息会被转发到 background，background 自动保存配置并重连

window.addEventListener('message', (event) => {
  if (
    event.source !== window ||
    !event.data ||
    event.data.type !== 'bridge-pair' ||
    typeof event.data.connectCode !== 'string'
  ) {
    return
  }

  const { connectCode } = event.data

  // 转发给 background
  chrome.runtime.sendMessage({ type: 'pair', connectCode }, (response) => {
    if (chrome.runtime.lastError) return

    // 把结果回传给 web 页面，方便页面知道配对是否成功
    window.postMessage(
      { type: 'bridge-pair-result', ok: response?.ok, error: response?.error },
      '*'
    )
  })
})
