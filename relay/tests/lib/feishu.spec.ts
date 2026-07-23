import { describe, it, expect, vi } from 'vitest'
import { FeishuClient, FeishuOAuthError } from '../../src/lib/feishu.js'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('FeishuClient', () => {
  it('exchangeCode returns tokens on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ code: 0, access_token: 'ua-1', refresh_token: 'ur-1', expires_in: 7200 }),
    )
    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', fetchImpl })
    const result = await client.exchangeCode('code-123', 'https://bridge/callback')
    expect(result).toEqual({ access_token: 'ua-1', refresh_token: 'ur-1', expires_in: 7200 })
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/open-apis/authen/v2/oauth/token'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('exchangeCode throws FeishuOAuthError when feishu returns a business error code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 20001, msg: 'invalid code' }))
    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', fetchImpl })
    await expect(client.exchangeCode('bad-code', 'https://bridge/callback')).rejects.toBeInstanceOf(FeishuOAuthError)
  })

  it('exchangeCode throws when http status is not ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ msg: 'server error' }, false, 500))
    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', fetchImpl })
    await expect(client.exchangeCode('code', 'https://bridge/callback')).rejects.toBeInstanceOf(FeishuOAuthError)
  })

  it('getUserInfo returns user data on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ code: 0, data: { open_id: 'ou_123', name: 'MK', avatar_url: 'https://x/y.png' } }),
    )
    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', fetchImpl })
    const info = await client.getUserInfo('ua-1')
    expect(info.open_id).toBe('ou_123')
    expect(info.name).toBe('MK')
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/open-apis/authen/v1/user_info'),
      expect.objectContaining({ headers: { Authorization: 'Bearer ua-1' } }),
    )
  })

  it('getUserInfo throws FeishuOAuthError when data is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 0 }))
    const client = new FeishuClient({ appId: 'app', appSecret: 'secret', fetchImpl })
    await expect(client.getUserInfo('ua-1')).rejects.toBeInstanceOf(FeishuOAuthError)
  })

  it('buildAuthorizeUrl includes app_id, redirect_uri and state', () => {
    const client = new FeishuClient({ appId: 'app-42', appSecret: 'secret' })
    const url = new URL(client.buildAuthorizeUrl('https://bridge/callback', 'state-xyz'))
    expect(url.searchParams.get('app_id')).toBe('app-42')
    expect(url.searchParams.get('redirect_uri')).toBe('https://bridge/callback')
    expect(url.searchParams.get('state')).toBe('state-xyz')
  })
})
