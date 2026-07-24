import { describe, it, expect, vi } from 'vitest'
import { BridgePage, BridgePageError, BridgePageNotImplementedError } from '../src/bridge-page.js'

function mockFetch(response: unknown, opts: { ok?: boolean; status?: number } = {}) {
  return vi.fn().mockResolvedValue({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => response,
  } as Response)
}

const baseOpts = () => ({
  bridgeUrl: 'https://bridge.example.com/bridge',
  pat: 'bpt_test1234567890',
  tabId: 12345,
})

describe('BridgePage', () => {
  it('goto POSTs navigate with url + tabId + Bearer PAT', async () => {
    const fetchImpl = mockFetch({ ok: true, result: { tabId: 12345 } })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })
    await page.goto('https://xiaohongshu.com/search_result')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://bridge.example.com/bridge/command')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer bpt_test1234567890')

    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.action).toBe('navigate')
    expect(body.params.url).toBe('https://xiaohongshu.com/search_result')
    expect(body.params.tabId).toBe(12345)
  })

  it('evaluate(string) sends the raw script', async () => {
    const fetchImpl = mockFetch({ ok: true, result: 42 })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })

    const result = await page.evaluate('1 + 41')
    expect(result).toBe(42)

    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.action).toBe('evalScript')
    expect(body.params.script).toBe('1 + 41')
  })

  it('evaluate(fn, args) stringifies fn + args into IIFE', async () => {
    const fetchImpl = mockFetch({ ok: true, result: 6 })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })

    const result = await page.evaluate((a: number, b: number) => a * b, 2, 3)
    expect(result).toBe(6)

    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.params.script).toContain('.apply(null,')
    expect(body.params.script).toContain('[2,3]')
  })

  it('evaluateWithArgs wraps js with pre-serialized args (opencli 用它防 injection)', async () => {
    const fetchImpl = mockFetch({ ok: true, result: 'hello' })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })

    await page.evaluateWithArgs('args.msg', { msg: 'hello' })
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.params.script).toContain('const args = {"msg":"hello"}')
    expect(body.params.script).toContain('return (args.msg)')
  })

  it('getCookies({domain}) routes to bridge cookies action', async () => {
    const fetchImpl = mockFetch({ ok: true, result: [{ name: 'a', value: '1' }] })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })

    const cookies = await page.getCookies({ domain: 'xiaohongshu.com' })
    expect(cookies).toHaveLength(1)

    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.action).toBe('cookies')
    expect(body.params.domain).toBe('xiaohongshu.com')
  })

  it('getCookies({url}) extracts hostname', async () => {
    const fetchImpl = mockFetch({ ok: true, result: [] })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })

    await page.getCookies({ url: 'https://www.xiaohongshu.com/explore/xxx' })
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.params.domain).toBe('www.xiaohongshu.com')
  })

  it('getCookies() with no args throws invalid_args', async () => {
    const page = new BridgePage({ ...baseOpts(), fetchImpl: mockFetch({}) })
    await expect(page.getCookies()).rejects.toBeInstanceOf(BridgePageError)
  })

  it('fetchJson wraps fetch call in browser context with args', async () => {
    const fetchImpl = mockFetch({ ok: true, result: { data: 'ok' } })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })

    await page.fetchJson('https://api.example.com/x', { method: 'GET' })
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.action).toBe('evalScript')
    expect(body.params.script).toContain('fetch(args.url')
    expect(body.params.script).toContain('https://api.example.com/x')
  })

  it('bridge returns ok:false → throws BridgePageError with code', async () => {
    const fetchImpl = mockFetch({ ok: false, error: { code: 'token_revoked', message: 'revoked' } }, { ok: true })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })

    await expect(page.evaluate('1')).rejects.toMatchObject({ code: 'token_revoked' })
  })

  it('HTTP non-200 → throws BridgePageError with status', async () => {
    const fetchImpl = mockFetch({ ok: false, error: { code: 'server_error', message: 'x' } }, { ok: false, status: 500 })
    const page = new BridgePage({ ...baseOpts(), fetchImpl })

    await expect(page.evaluate('1')).rejects.toMatchObject({ status: 500 })
  })

  it('unimplemented methods throw BridgePageNotImplementedError', async () => {
    const page = new BridgePage({ ...baseOpts(), fetchImpl: mockFetch({}) })
    await expect(page.snapshot()).rejects.toBeInstanceOf(BridgePageNotImplementedError)
    await expect(page.click()).rejects.toBeInstanceOf(BridgePageNotImplementedError)
    await expect(page.uploadFiles()).rejects.toBeInstanceOf(BridgePageNotImplementedError)
  })
})
