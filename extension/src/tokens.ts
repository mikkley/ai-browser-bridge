import { apiFetch } from './api-client'

export interface DeviceToken {
  jti: string
  token_prefix: string
  label: string
  scopes: string[]
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

export const AVAILABLE_SCOPES = [
  'navigate',
  'extract',
  'waitForSelector',
  'cookies',
  'tabs',
  'screenshot',
  'execute',
  'evalScript',
  'scraper.list',
  'scraper.run',
] as const

export async function listTokens(): Promise<DeviceToken[]> {
  const res = await apiFetch<{ tokens: DeviceToken[] }>('/api/me/tokens')
  return res.tokens
}

// 明文只在这次调用的返回值里出现一次, 调用方负责立刻展示给用户复制, 不要持久化
export async function createToken(
  label: string,
  scopes: string[],
  expiresInDays?: number,
): Promise<{ jti: string; prefix: string; plaintext: string }> {
  return apiFetch('/api/me/tokens', {
    method: 'POST',
    body: JSON.stringify({ label, scopes, expiresInDays }),
  })
}

export async function revokeToken(jti: string): Promise<void> {
  await apiFetch(`/api/me/tokens/${jti}`, { method: 'DELETE' })
}
