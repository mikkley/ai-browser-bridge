// scraper 通用工具: 等元素 / navigate + wait / 抓 __INITIAL_STATE__ / dedupe 等

export async function scraperWaitForSelector(
  tabId: number,
  selector: string,
  timeoutMs: number = 10_000,
): Promise<{ matched: boolean; count: number }> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [selector, timeoutMs],
    func: async (sel: string, timeout: number) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const els = document.querySelectorAll(sel)
        if (els.length > 0) return { matched: true, count: els.length }
        await new Promise((r) => setTimeout(r, 200))
      }
      return { matched: false, count: 0 }
    },
  })
  return results[0]?.result ?? { matched: false, count: 0 }
}

// 让当前 tab 打开一个新 URL, 等 domcontentloaded
export async function scraperNavigate(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url })
  await new Promise<void>((resolve) => {
    let done = false
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete' && !done) {
        done = true
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      if (!done) {
        done = true
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }, 15_000)
  })
}

// 在 tab 里执行任意 fn, 返 fn 的 return value
export async function runInTab<T>(tabId: number, fn: (...args: any[]) => T, args: unknown[] = []): Promise<T | undefined> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args,
    func: fn as (...a: unknown[]) => T,
  })
  return results[0]?.result as T | undefined
}

// 简单参数校验, 不满足抛错让 op 转 { ok: false }
export function requireArg<T>(args: Record<string, unknown>, key: string, type: 'string' | 'number' | 'boolean'): T {
  const v = args[key]
  if (v === undefined || v === null) throw new Error(`missing arg: ${key}`)
  if (typeof v !== type) throw new Error(`arg ${key} should be ${type}, got ${typeof v}`)
  return v as T
}

export function optionalArg<T>(args: Record<string, unknown>, key: string, type: 'string' | 'number' | 'boolean', defaultValue: T): T {
  const v = args[key]
  if (v === undefined || v === null) return defaultValue
  if (typeof v !== type) throw new Error(`arg ${key} should be ${type}, got ${typeof v}`)
  return v as T
}
