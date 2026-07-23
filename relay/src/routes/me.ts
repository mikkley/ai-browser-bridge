import { Router } from 'express'
import crypto from 'crypto'
import type { Db } from '../lib/pg.js'
import { requireUserToken } from '../lib/auth-middleware.js'
import { generatePairingToken, KNOWN_ACTIONS } from '../lib/pat.js'

interface DeviceRow {
  device_id: string
  device_name: string | null
  bound_at: string
  last_seen_at: string | null
}

interface TokenRow {
  jti: string
  token_prefix: string
  label: string
  scopes: string[]
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

// 插件专用端点, 用 userToken 鉴权; 见 design 段 7.1/8
export function createMeRouter(db: Db, userTokenSecret: string): Router {
  const router = Router()
  // 路径限定: 否则这个 router.use() 会拦住同一个 app 里挂载的其它 router (比如 /command)
  router.use('/api/me', requireUserToken(userTokenSecret))

  router.get('/api/me', async (req, res) => {
    const userRes = await db.query<{ id: string; username: string; role: string }>(
      'SELECT id, username, role FROM users WHERE id = $1',
      [req.userId],
    )
    const deviceRes = await db.query<DeviceRow>(
      'SELECT device_id, device_name, bound_at, last_seen_at FROM bridge_devices WHERE device_id = $1 AND user_id = $2',
      [req.deviceId, req.userId],
    )
    if (!userRes.rows[0] || !deviceRes.rows[0]) {
      return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'User or device not found' } })
    }
    res.json({ ok: true, user: userRes.rows[0], device: deviceRes.rows[0] })
  })

  router.get('/api/me/devices', async (req, res) => {
    const result = await db.query<DeviceRow>(
      `SELECT device_id, device_name, bound_at, last_seen_at FROM bridge_devices
       WHERE user_id = $1 AND disabled_at IS NULL ORDER BY bound_at DESC`,
      [req.userId],
    )
    res.json({ ok: true, devices: result.rows })
  })

  router.patch('/api/me/devices/:id', async (req, res) => {
    const { device_name } = req.body ?? {}
    if (typeof device_name !== 'string' || !device_name.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_request', message: 'device_name is required' } })
    }
    const result = await db.query(
      'UPDATE bridge_devices SET device_name = $3 WHERE device_id = $1 AND user_id = $2 RETURNING device_id',
      [req.params.id, req.userId, device_name.trim().slice(0, 128)],
    )
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Device not found' } })
    res.json({ ok: true })
  })

  router.get('/api/me/tokens', async (req, res) => {
    const result = await db.query<TokenRow>(
      `SELECT jti, token_prefix, label, scopes, created_at, last_used_at, expires_at, revoked_at
       FROM bridge_pairing_tokens WHERE user_id = $1 AND device_id = $2 ORDER BY created_at DESC`,
      [req.userId, req.deviceId],
    )
    res.json({ ok: true, tokens: result.rows })
  })

  router.post('/api/me/tokens', async (req, res) => {
    const { label, scopes, expiresInDays } = req.body ?? {}
    if (typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_request', message: 'label is required' } })
    }
    const validScopes = Array.isArray(scopes) &&
      scopes.length > 0 &&
      scopes.every((s: unknown) => typeof s === 'string' && (KNOWN_ACTIONS as readonly string[]).includes(s))
    if (!validScopes) {
      return res.status(400).json({
        ok: false,
        error: { code: 'invalid_request', message: `scopes must be a non-empty subset of ${KNOWN_ACTIONS.join(',')}` },
      })
    }

    const generated = generatePairingToken()
    const expiresAt = typeof expiresInDays === 'number' && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
      : null
    const jti = crypto.randomUUID()

    await db.query(
      `INSERT INTO bridge_pairing_tokens (jti, user_id, device_id, token_hash, token_prefix, label, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [jti, req.userId, req.deviceId, generated.hash, generated.prefix, label.trim().slice(0, 128), scopes, expiresAt],
    )

    // plaintext 只在这一次响应里出现, 服务端不落库
    res.json({ ok: true, jti, prefix: generated.prefix, plaintext: generated.plaintext })
  })

  router.delete('/api/me/tokens/:jti', async (req, res) => {
    const result = await db.query(
      'UPDATE bridge_pairing_tokens SET revoked_at = now() WHERE jti = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING jti',
      [req.params.jti, req.userId],
    )
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Token not found or already revoked' } })
    res.json({ ok: true })
  })

  router.get('/api/me/audit', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200)
    const result = await db.query(
      `SELECT ts, action, status, error_msg, duration_ms FROM bridge_audit
       WHERE user_id = $1 ORDER BY ts DESC LIMIT $2`,
      [req.userId, limit],
    )
    res.json({ ok: true, entries: result.rows })
  })

  return router
}
