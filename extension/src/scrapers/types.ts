// 内置社媒 scraper 类型契约
//
// 每个 platform 是一个 namespace (xhs / bilibili / douyin / ...), 里面有若干 op
// (search / getVideoComments / ...) 。op 是纯浏览器端 async 函数, 输入用户参数,
// 内部通过 chrome.scripting / chrome.tabs 操作已登录浏览器, 返回结构化数据。
//
// bridge action `scraper.run { platform, op, args }` 走到 background.ts,
// 从下面的 registry 查到函数, 执行, 返 { ok, data }。

export interface ScraperContext {
  /** 已解析好的目标 tab, 由 background.ts 传入 (通常来自 resolveTabId 或 navigate 新建) */
  tabId: number
  /** 用户传的参数, 每个 op 自己校验 */
  args: Record<string, unknown>
}

export type ScraperResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string }

export type ScraperOp = (ctx: ScraperContext) => Promise<ScraperResult>

export interface OpMeta {
  name: string
  description: string
  args: Array<{ name: string; type: 'string' | 'number' | 'boolean'; required?: boolean; default?: unknown; description?: string }>
}

export interface PlatformScrapers {
  meta: {
    platform: string
    description: string
    domain: string // 主域名, agent 判断"这个 URL 属于哪个 platform"用
  }
  ops: Record<string, ScraperOp>
  opsMeta: Record<string, OpMeta>
}
