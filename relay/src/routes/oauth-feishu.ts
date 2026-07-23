import { Router } from 'express'
import crypto from 'crypto'
import type { Db } from '../lib/pg.js'
import { FeishuClient } from '../lib/feishu.js'
import { lookupOrCreateUser } from '../lib/users.js'
import { signUserToken } from '../lib/user-token.js'

interface PendingLogin {
  deviceId: string
  extensionRedirectUri: string
  userAgent: string
  expiresAt: number
}

const STATE_TTL_MS = 10 * 60 * 1000
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// chrome.identity.launchWebAuthFlow 的官方回跳域, 见 design 段 8.1
const EXTENSION_REDIRECT_RE = /^https:\/\/[a-z0-9]+\.chromiumapp\.org\//

export interface FeishuOAuthOptions {
  callbackUrl: string // 我们自己的 /login/feishu-callback 完整 URL, 需在飞书 app 后台白名单里
  userTokenSecret: string
}

// 插件登录入口: GET /login/feishu → 飞书 SSO → GET /login/feishu-callback → 302 回插件
// 见 design 段 6.1
export function createFeishuOAuthRouter(db: Db, feishu: FeishuClient, opts: FeishuOAuthOptions): Router {
  const router = Router()
  const pending = new Map<string, PendingLogin>()

  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [state, p] of pending) {
      if (p.expiresAt < now) pending.delete(state)
    }
  }, 60_000)
  cleanupTimer.unref?.()

  router.get('/login/feishu', (req, res) => {
    const deviceId = String(req.query.device_id || '')
    const redirectUri = String(req.query.redirect_uri || '')
    if (!DEVICE_ID_RE.test(deviceId)) {
      return res.status(400).send('invalid device_id')
    }
    if (!EXTENSION_REDIRECT_RE.test(redirectUri)) {
      return res.status(400).send('invalid redirect_uri')
    }

    const state = crypto.randomBytes(24).toString('base64url')
    pending.set(state, {
      deviceId,
      extensionRedirectUri: redirectUri,
      userAgent: String(req.headers['user-agent'] || ''),
      expiresAt: Date.now() + STATE_TTL_MS,
    })

    res.redirect(feishu.buildAuthorizeUrl(opts.callbackUrl, state))
  })

  router.get('/login/feishu-callback', async (req, res) => {
    const { code, state } = req.query
    if (!code || !state) return res.status(400).send('missing code or state')

    const p = pending.get(String(state))
    if (!p) return res.status(400).send('invalid or expired state, please retry login')
    pending.delete(String(state))

    try {
      const tokenResult = await feishu.exchangeCode(String(code), opts.callbackUrl)
      const lark = await feishu.getUserInfo(tokenResult.access_token)
      const user = await lookupOrCreateUser(db, lark)

      await db.query(
        `INSERT INTO bridge_devices (device_id, user_id, user_agent, last_seen_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (device_id) DO UPDATE
           SET user_id = EXCLUDED.user_id, user_agent = EXCLUDED.user_agent,
               last_seen_at = now(), disabled_at = NULL`,
        [p.deviceId, user.id, p.userAgent],
      )

      const userToken = signUserToken(user.id, p.deviceId, opts.userTokenSecret)
      const redirect = new URL(p.extensionRedirectUri)
      redirect.searchParams.set('token', userToken)
      redirect.searchParams.set('user_name', user.username)
      res.redirect(redirect.toString())
    } catch (err) {
      console.error('[feishu-callback] failed:', (err as Error).message)
      res.status(502).send('Feishu login failed, please try again')
    }
  })

  return router
}
