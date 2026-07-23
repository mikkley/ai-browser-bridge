import { RELAY_HTTP_BASE } from './relay-http-base'
import { apiFetch } from './api-client'

export interface MeResponse {
  user: { id: string; username: string; role: string }
  device: { device_id: string; device_name: string | null; bound_at: string; last_seen_at: string | null }
}

// 首次启动生成 UUID 存 chrome.storage.local，永久持有 (与 background.ts 里旧的 getOrCreateClientId 同一个值)
export async function getOrCreateDeviceId(): Promise<string> {
  const r = await chrome.storage.local.get('clientId')
  if (typeof r.clientId === 'string' && r.clientId.length > 0) return r.clientId
  const id = crypto.randomUUID()
  await chrome.storage.local.set({ clientId: id })
  return id
}

// chrome.identity.launchWebAuthFlow → bridge /login/feishu → 飞书 SSO → 回跳拿 userToken
export async function loginWithFeishu(): Promise<{ userName: string }> {
  const deviceId = await getOrCreateDeviceId()
  const redirectUri = chrome.identity.getRedirectURL() // https://<extension-id>.chromiumapp.org/
  const authUrl =
    `${RELAY_HTTP_BASE}/login/feishu?device_id=${encodeURIComponent(deviceId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`

  const resultUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true })
  if (!resultUrl) throw new Error('Login cancelled')

  const parsed = new URL(resultUrl)
  const token = parsed.searchParams.get('token')
  const userName = parsed.searchParams.get('user_name')
  if (!token || !userName) throw new Error('Login failed: missing token in callback URL')

  await chrome.storage.local.set({ userToken: token, userName })
  return { userName }
}

// 只清本地 userToken —— 不撤销已发出的 PAT, 不影响服务端的 device 绑定 (撤销 token 走 tokens.ts)
export async function logout(): Promise<void> {
  await chrome.storage.local.remove(['userToken', 'userName'])
}

export async function isLoggedIn(): Promise<boolean> {
  const { userToken } = await chrome.storage.local.get('userToken')
  return typeof userToken === 'string' && userToken.length > 0
}

export async function getMe(): Promise<MeResponse | null> {
  try {
    return await apiFetch<MeResponse>('/api/me')
  } catch {
    return null
  }
}

export async function renameDevice(deviceId: string, name: string): Promise<void> {
  await apiFetch(`/api/me/devices/${deviceId}`, {
    method: 'PATCH',
    body: JSON.stringify({ device_name: name }),
  })
}
