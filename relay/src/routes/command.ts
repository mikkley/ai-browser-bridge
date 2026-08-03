import { Router } from 'express'
import type { Db } from '../lib/pg.js'
import type { SessionStore } from '../lib/sessions.js'
import { isKnownAction } from '../lib/pat.js'
import { extractBearer, verifyPat, touchToken } from '../lib/pat-verify.js'
import { writeAudit } from '../lib/audit.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { jitterDelay } from '../lib/jitter.js'
import { DeviceTimeoutError } from '../lib/sessions.js'

export interface CommandRouterOptions {
  allowedActions: Set<string>
  rateLimitRpm: number
  jitterMinMs: number
  jitterMaxMs: number
}

// AI 调用入口: Authorization: Bearer bpt_xxx, 见 design 段 6.3 / 7
export function createCommandRouter(db: Db, sessions: SessionStore, opts: CommandRouterOptions): Router {
  const router = Router()

  router.post('/command', async (req, res) => {
    const start = Date.now()
    const verified = await verifyPat(db, extractBearer(req.headers.authorization))
    if (!verified.ok) {
      return res.status(verified.status).json({ ok: false, error: { code: verified.code, message: verified.message } })
    }
    const row = verified.row

    const { action, params } = req.body ?? {}
    if (typeof action !== 'string' || !action) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_action', message: 'action is required' } })
    }

    if (!isKnownAction(action) || !opts.allowedActions.has(action)) {
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action,
        status: 'refused', errorMsg: 'action_not_allowed_by_server',
      })
      return res.status(403).json({ ok: false, error: { code: 'action_not_in_scope', message: `Action not allowed: ${action}` } })
    }
    if (!row.scopes.includes(action)) {
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action,
        status: 'refused', errorMsg: 'action_not_in_token_scope',
      })
      return res.status(403).json({ ok: false, error: { code: 'action_not_in_scope', message: `Action not in token scopes: ${action}` } })
    }

    const rateCheck = checkRateLimit(row.device_id, opts.rateLimitRpm)
    if (!rateCheck.allowed) {
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action,
        status: 'refused', errorMsg: 'rate_limited',
      })
      return res.status(429).json({ ok: false, error: { code: 'rate_limited', message: 'Rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs } })
    }

    if (!sessions.isOnline(row.device_id)) {
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action,
        status: 'error', errorMsg: 'device_offline',
      })
      return res.status(503).json({ ok: false, error: { code: 'device_offline', message: 'Target device is not connected' } })
    }

    await jitterDelay(opts.jitterMinMs, opts.jitterMaxMs)

    try {
      const data = await sessions.send(row.device_id, action, params)
      const durationMs = Date.now() - start
      await writeAudit(db, { userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action, status: 'ok', durationMs })
      void touchToken(db, row.jti, req.ip)
      return res.json({ ok: true, result: data })
    } catch (err) {
      const durationMs = Date.now() - start
      const isTimeout = err instanceof DeviceTimeoutError
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action,
        status: isTimeout ? 'timeout' : 'error', durationMs, errorMsg: (err as Error).message,
      })
      void touchToken(db, row.jti, req.ip)
      return res.status(isTimeout ? 504 : 500).json({
        ok: false,
        error: { code: isTimeout ? 'device_timeout' : 'command_failed', message: (err as Error).message },
      })
    }
  })

  return router
}
