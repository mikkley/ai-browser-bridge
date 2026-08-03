import { Router } from 'express'
import type { Db } from '../lib/pg.js'
import { requireAdminUser } from '../lib/auth-middleware.js'

// admin 后台端点: 只有 users.role='admin' 的用户能调
// 查全局跨用户数据, 用来看谁在用 bridge / 有多活跃 / 有没有异常
export function createAdminRouter(db: Db, userTokenSecret: string): Router {
  const router = Router()
  router.use('/admin', requireAdminUser(userTokenSecret, db))

  // 顶层 dashboard 数字
  router.get('/admin/stats', async (_req, res) => {
    const now = new Date()
    const day = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
    const week = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()

    const q = async <T extends Record<string, string | null> = Record<string, string | null>>(
      sql: string,
      params: unknown[] = [],
    ) => (await db.query<T>(sql, params)).rows[0]

    const [devices, tokens, callsDay, callsWeek, sessions] = await Promise.all([
      q<{ total: string; active: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE last_seen_at > $1)::text AS active
         FROM bridge_devices WHERE disabled_at IS NULL`,
        [week],
      ),
      q<{ total: string; live: string }>(
        `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE revoked_at IS NULL)::text AS live
         FROM bridge_pairing_tokens`,
      ),
      q<{ total: string; ok: string; err: string; avg_ms: string | null }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE status='ok')::text AS ok,
                COUNT(*) FILTER (WHERE status<>'ok')::text AS err,
                COALESCE(ROUND(AVG(duration_ms))::text, '0') AS avg_ms
         FROM bridge_audit WHERE ts > $1`,
        [day],
      ),
      q<{ total: string }>(`SELECT COUNT(*)::text AS total FROM bridge_audit WHERE ts > $1`, [week]),
      q<{ users: string }>(
        `SELECT COUNT(DISTINCT user_id)::text AS users FROM bridge_audit WHERE ts > $1`,
        [week],
      ),
    ])

    res.json({
      ok: true,
      stats: {
        devices: { total: Number(devices?.total ?? 0), active_7d: Number(devices?.active ?? 0) },
        tokens: { total: Number(tokens?.total ?? 0), live: Number(tokens?.live ?? 0) },
        calls_24h: {
          total: Number(callsDay?.total ?? 0),
          ok: Number(callsDay?.ok ?? 0),
          err: Number(callsDay?.err ?? 0),
          avg_ms: Number(callsDay?.avg_ms ?? 0),
        },
        calls_7d: Number(callsWeek?.total ?? 0),
        active_users_7d: Number(sessions?.users ?? 0),
      },
    })
  })

  // 谁在用: 所有绑过设备的用户, 附最后活跃 / 设备数 / 活 token 数 / 近 7 天调用数
  router.get('/admin/users', async (_req, res) => {
    const result = await db.query(
      `SELECT
         u.id, u.username, u.display_name, u.lark_open_id, u.role,
         (SELECT COUNT(*) FROM bridge_devices d WHERE d.user_id = u.id AND d.disabled_at IS NULL) AS devices,
         (SELECT COUNT(*) FROM bridge_pairing_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS live_tokens,
         (SELECT MAX(last_seen_at) FROM bridge_devices d WHERE d.user_id = u.id) AS last_seen_at,
         (SELECT COUNT(*) FROM bridge_audit a WHERE a.user_id = u.id AND a.ts > now() - interval '7 days') AS calls_7d
       FROM users u
       WHERE u.id IN (SELECT DISTINCT user_id FROM bridge_devices)
       ORDER BY last_seen_at DESC NULLS LAST`,
    )
    res.json({ ok: true, users: result.rows })
  })

  // 全局审计: 跨用户查最近调用, 可按 user_id / action / status 过滤
  router.get('/admin/audit', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500)
    const filters: string[] = []
    const params: unknown[] = []
    if (typeof req.query.user_id === 'string' && req.query.user_id) {
      params.push(req.query.user_id)
      filters.push(`a.user_id = $${params.length}`)
    }
    if (typeof req.query.action === 'string' && req.query.action) {
      params.push(req.query.action)
      filters.push(`a.action = $${params.length}`)
    }
    if (typeof req.query.status === 'string' && req.query.status) {
      params.push(req.query.status)
      filters.push(`a.status = $${params.length}`)
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    params.push(limit)
    const result = await db.query(
      `SELECT a.ts, a.action, a.status, a.duration_ms, a.error_msg, a.request_ip,
              u.username, t.label AS token_label
       FROM bridge_audit a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN bridge_pairing_tokens t ON t.jti = a.token_jti
       ${where}
       ORDER BY a.ts DESC LIMIT $${params.length}`,
      params,
    )
    res.json({ ok: true, entries: result.rows })
  })

  return router
}
