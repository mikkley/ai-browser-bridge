import { RELAY_HTTP_BASE } from './relay-http-base'

export interface ApiError {
  code: string
  message: string
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: ApiError,
  ) {
    super(apiError.message)
  }
}

async function getUserToken(): Promise<string | null> {
  const { userToken } = await chrome.storage.local.get('userToken')
  return typeof userToken === 'string' && userToken.length > 0 ? userToken : null
}

// 带 userToken 的 bridge /api/me/* 请求封装
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getUserToken()
  if (!token) throw new Error('Not logged in')

  const res = await fetch(`${RELAY_HTTP_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.ok === false) {
    throw new ApiClientError(res.status, json.error ?? { code: 'unknown', message: `HTTP ${res.status}` })
  }
  return json as T
}
