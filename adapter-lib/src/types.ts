// 直接 import opencli 的 IPage 会引入完整依赖 (fs / os) 让 tsc 编译不过.
// 用局部 subset 声明, 只覆盖我们真实现的方法契约.
// 与 @jackwener/opencli/types 里 IPage 的方法签名对齐 (2026-07 v1.8.6 版本).

export interface BrowserCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface FetchJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  credentials?: 'omit' | 'same-origin' | 'include'
}

// 本 shim 里 evaluate 支持字符串或纯函数 (被 stringify 后 eval).
// 注意: 函数不能有闭包引用外部变量 (会 undefined). 参数只能通过 args 传.
export type BrowserEvaluateFunction<Args extends unknown[] = unknown[], Result = unknown> = (
  ...args: Args
) => Result | Promise<Result>

/**
 * BridgePage 实现的 IPage 子集.
 * 覆盖大部分"读类" opencli 命令 (search / list / detail / get-*).
 * 涉及交互 (click/hover/upload/snapshot) 的命令暂不支持 → 抛 BridgePageNotImplementedError.
 */
export interface IPageSubset {
  goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void>
  evaluate<T = unknown>(js: string): Promise<T>
  evaluate<Args extends unknown[], T>(fn: BrowserEvaluateFunction<Args, T>, ...args: Args): Promise<Awaited<T>>
  evaluateWithArgs(js: string, args: Record<string, unknown>): Promise<unknown>
  fetchJson(url: string, opts?: FetchJsonOptions): Promise<unknown>
  getCookies(opts?: { domain?: string; url?: string }): Promise<BrowserCookie[]>
}
