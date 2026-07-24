import type { BrowserCookie, FetchJsonOptions, IPageSubset, BrowserEvaluateFunction } from './types.js'

export interface BridgePageOptions {
  /** Bridge relay URL, 生产是 https://agent.imcagent.qzz.io/bridge */
  bridgeUrl: string
  /** 用户在插件 popup 里生成的 bpt_xxx token */
  pat: string
  /** 已存在的 tab id. Agent 在启动 command 前先调 bridge navigate 创建一个 tab 拿到 id. */
  tabId: number
  /** 单次 command timeout, 默认 60 秒 (opencli 命令内部有多次 evaluate, 累积可能长) */
  timeoutMs?: number
  /** 允许注入的 fetch 实现 (测试时替换) */
  fetchImpl?: typeof fetch
}

export class BridgePageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'BridgePageError'
  }
}

export class BridgePageNotImplementedError extends Error {
  constructor(method: string) {
    super(
      `BridgePage.${method}() 未实现. 该 opencli 命令依赖复杂交互 (CDP AX tree / debugger), ` +
        `bridge 扩展环境不支持. 请换用更简单的 opencli 命令或让用户手动完成这一步.`,
    )
    this.name = 'BridgePageNotImplementedError'
  }
}

/**
 * OpenCLI 的 IPage 在 bridge 扩展环境下的实现.
 *
 * 每个方法都发一次 HTTP call 到 bridge relay → 用户浏览器扩展执行 →
 * 返结果. Agent 用一个 BridgePage 实例跑完整个 opencli 命令 (通常 5-15 次 call).
 *
 * 使用:
 *   const page = new BridgePage({ bridgeUrl, pat, tabId })
 *   const cmd = getRegistry().get('xiaohongshu.search')
 *   const rows = await cmd.func(page, { query: 'AI眼镜', limit: 30 })
 */
export class BridgePage implements IPageSubset {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly opts: BridgePageOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 60_000
  }

  async goto(url: string, _options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void> {
    await this.call('navigate', { url, tabId: this.opts.tabId })
  }

  async evaluate<T = unknown>(js: string): Promise<T>
  async evaluate<Args extends unknown[], T>(fn: BrowserEvaluateFunction<Args, T>, ...args: Args): Promise<Awaited<T>>
  async evaluate(jsOrFn: string | Function, ...args: unknown[]): Promise<unknown> {
    let script: string
    if (typeof jsOrFn === 'string') {
      if (args.length === 0) {
        script = jsOrFn
      } else {
        // 传了 args 但用了字符串脚本: opencli 里通常不这样用, 但兜底一下
        script = `(function() { const args = ${JSON.stringify(args)}; return (${jsOrFn}); })()`
      }
    } else {
      // 函数 → IIFE
      const fnStr = jsOrFn.toString()
      if (args.length === 0) {
        script = `(${fnStr})()`
      } else {
        script = `(${fnStr}).apply(null, ${JSON.stringify(args)})`
      }
    }
    return await this.call('evalScript', { script, tabId: this.opts.tabId })
  }

  async evaluateWithArgs(js: string, args: Record<string, unknown>): Promise<unknown> {
    // 安全序列化 args, opencli 用它防 injection
    const script = `(function() { const args = ${JSON.stringify(args)}; return (${js}); })()`
    return await this.call('evalScript', { script, tabId: this.opts.tabId })
  }

  async getCookies(opts?: { domain?: string; url?: string }): Promise<BrowserCookie[]> {
    let domain = opts?.domain
    if (!domain && opts?.url) domain = new URL(opts.url).hostname
    if (!domain) throw new BridgePageError('getCookies needs domain or url', 'invalid_args')
    return (await this.call('cookies', { domain })) as BrowserCookie[]
  }

  async fetchJson(url: string, opts?: FetchJsonOptions): Promise<unknown> {
    // 在浏览器 tab 里跑 fetch, 带 tab 的 cookies (opencli 需要 authenticated fetch)
    const args = { url, opts: opts ?? {} }
    const js = `
      fetch(args.url, {
        method: args.opts.method || 'GET',
        headers: args.opts.headers || {},
        body: args.opts.body,
        credentials: args.opts.credentials || 'include',
      }).then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('application/json')) return await r.json();
        return await r.text();
      })
    `
    return await this.evaluateWithArgs(js, args)
  }

  // 以下 opencli IPage 高级方法暂不支持. bridge 扩展没 CDP debugger 权限.
  // 依赖这些方法的命令 (通常带 click/hover/upload/snapshot) 需要 fallback 或用户手动.
  async snapshot(): Promise<never> {
    throw new BridgePageNotImplementedError('snapshot')
  }
  async click(): Promise<never> {
    throw new BridgePageNotImplementedError('click')
  }
  async dblClick(): Promise<never> {
    throw new BridgePageNotImplementedError('dblClick')
  }
  async hover(): Promise<never> {
    throw new BridgePageNotImplementedError('hover')
  }
  async focus(): Promise<never> {
    throw new BridgePageNotImplementedError('focus')
  }
  async setChecked(): Promise<never> {
    throw new BridgePageNotImplementedError('setChecked')
  }
  async uploadFiles(): Promise<never> {
    throw new BridgePageNotImplementedError('uploadFiles')
  }

  private async call(action: string, params: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.opts.bridgeUrl}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.pat}`,
        },
        body: JSON.stringify({ action, params }),
        signal: controller.signal,
      })
    } catch (err) {
      throw new BridgePageError(`network: ${(err as Error).message}`, 'network_error')
    } finally {
      clearTimeout(timer)
    }

    let json: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } }
    try {
      json = (await res.json()) as typeof json
    } catch {
      throw new BridgePageError(`bridge returned non-JSON (status ${res.status})`, 'bad_response', res.status)
    }

    if (!res.ok || !json.ok) {
      const code = json.error?.code ?? 'unknown'
      const msg = json.error?.message ?? `HTTP ${res.status}`
      throw new BridgePageError(msg, code, res.status)
    }
    return json.result
  }
}
