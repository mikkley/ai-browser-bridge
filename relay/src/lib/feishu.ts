// 飞书 OAuth v2 (标准 authorization_code flow) 客户端
// 复用父目录 marketing-agent 的飞书 app (FEISHU_APP_ID/FEISHU_APP_SECRET), 但代码独立实现 (见 design 段 6.1)

const FEISHU_BASE_URL = 'https://open.feishu.cn'

export interface FeishuUserInfo {
  open_id: string
  union_id?: string
  name: string
  avatar_url?: string
}

export interface FeishuTokenResult {
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface FeishuClientConfig {
  appId: string
  appSecret: string
  fetchImpl?: typeof fetch // 测试时注入 mock
}

export class FeishuOAuthError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'FeishuOAuthError'
  }
}

export class FeishuClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: FeishuClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  // 用授权码换 user_access_token
  async exchangeCode(code: string, redirectUri: string): Promise<FeishuTokenResult> {
    const res = await this.fetchImpl(`${FEISHU_BASE_URL}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })
    const json = (await res.json()) as {
      code?: number
      msg?: string
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!res.ok || json.code || !json.access_token) {
      throw new FeishuOAuthError(`exchangeCode failed: ${json.msg ?? res.status}`, json)
    }
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? '',
      expires_in: json.expires_in ?? 0,
    }
  }

  // 拿 user_access_token 之后查用户身份
  async getUserInfo(userAccessToken: string): Promise<FeishuUserInfo> {
    const res = await this.fetchImpl(`${FEISHU_BASE_URL}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    })
    const json = (await res.json()) as {
      code?: number
      msg?: string
      data?: { open_id: string; union_id?: string; name: string; avatar_url?: string }
    }
    if (!res.ok || json.code || !json.data) {
      throw new FeishuOAuthError(`getUserInfo failed: ${json.msg ?? res.status}`, json)
    }
    return json.data
  }

  buildAuthorizeUrl(redirectUri: string, state: string): string {
    const url = new URL(`${FEISHU_BASE_URL}/open-apis/authen/v1/index`)
    url.searchParams.set('app_id', this.config.appId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    return url.toString()
  }
}
