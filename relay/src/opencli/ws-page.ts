// WSPage: opencli IPage 在 relay 进程内的实现.
//
// 跟 adapter-lib 的 BridgePage 区别: BridgePage 每个方法发一次 HTTP 到 relay,
// WSPage 直接调 SessionStore.send() 走已建立的 WS 连接 —— 省掉 5-15 次 HTTP 往返.
//
// 用途: relay 的 POST /opencli 端点里跑 opencli 命令, 让任何能发 HTTP 的 agent
// (不需要装 opencli / 不需要 Node 环境) 都能用 opencli 的 177 网站命令.

import type { SessionStore } from '../lib/sessions.js'

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

export class WSPageNotImplementedError extends Error {
  constructor(method: string) {
    super(
      `IPage.${method}() 不支持 — 该 opencli 命令依赖 CDP AX tree (click/snapshot/upload), ` +
        `bridge 扩展用 chrome.scripting 没有 debugger 权限. 换只读类命令或让用户手动完成这一步.`,
    )
    this.name = 'WSPageNotImplementedError'
  }
}

export class WSPage {
  constructor(
    private readonly sessions: SessionStore,
    private readonly deviceId: string,
    private readonly tabId: number,
  ) {}

  async goto(url: string, _options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void> {
    await this.sessions.send(this.deviceId, 'navigate', { url, tabId: this.tabId })
  }

  async evaluate(js: string): Promise<unknown>
  async evaluate(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown>
  async evaluate(jsOrFn: string | ((...args: unknown[]) => unknown), ...args: unknown[]): Promise<unknown> {
    let script: string
    if (typeof jsOrFn === 'string') {
      script =
        args.length === 0
          ? jsOrFn
          : `(function() { const args = ${JSON.stringify(args)}; return (${jsOrFn}); })()`
    } else {
      const fnStr = jsOrFn.toString()
      script = args.length === 0 ? `(${fnStr})()` : `(${fnStr}).apply(null, ${JSON.stringify(args)})`
    }
    return await this.sessions.send(this.deviceId, 'evalScript', { script, tabId: this.tabId })
  }

  async evaluateWithArgs(js: string, args: Record<string, unknown>): Promise<unknown> {
    const script = `(function() { const args = ${JSON.stringify(args)}; return (${js}); })()`
    return await this.sessions.send(this.deviceId, 'evalScript', { script, tabId: this.tabId })
  }

  async getCookies(opts?: { domain?: string; url?: string }): Promise<BrowserCookie[]> {
    let domain = opts?.domain
    if (!domain && opts?.url) domain = new URL(opts.url).hostname
    if (!domain) throw new Error('getCookies needs domain or url')
    return (await this.sessions.send(this.deviceId, 'cookies', { domain })) as BrowserCookie[]
  }

  async fetchJson(url: string, opts?: FetchJsonOptions): Promise<unknown> {
    // 在浏览器 tab 里 fetch, 带该 tab 的 cookies (opencli 要 authenticated fetch)
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
    return await this.evaluateWithArgs(js, { url, opts: opts ?? {} })
  }

  // 以下依赖 CDP AX tree, bridge 扩展环境不支持
  async snapshot(): Promise<never> {
    throw new WSPageNotImplementedError('snapshot')
  }
  async click(): Promise<never> {
    throw new WSPageNotImplementedError('click')
  }
  async dblClick(): Promise<never> {
    throw new WSPageNotImplementedError('dblClick')
  }
  async hover(): Promise<never> {
    throw new WSPageNotImplementedError('hover')
  }
  async focus(): Promise<never> {
    throw new WSPageNotImplementedError('focus')
  }
  async setChecked(): Promise<never> {
    throw new WSPageNotImplementedError('setChecked')
  }
  async uploadFiles(): Promise<never> {
    throw new WSPageNotImplementedError('uploadFiles')
  }
}
