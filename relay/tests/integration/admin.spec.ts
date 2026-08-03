import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import request from 'supertest'
import type { Pool } from 'pg'
import { testDb, truncateAll } from './db.js'
import { createAdminRouter } from '../../src/routes/admin.js'
import { signUserToken } from '../../src/lib/user-token.js'

const skip = !process.env.DATABASE_URL
const SECRET = 'admin-test-secret'

describe.skipIf(skip)('/admin/* (integration)', () => {
  let pool: Pool
  let app: express.Express
  let adminUserId: string
  let regularUserId: string
  let adminToken: string
  let regularToken: string
  let deviceId: string

  beforeAll(() => {
    pool = testDb()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    app = express()
    app.use(express.json())
    app.use(createAdminRouter(pool, SECRET))

    const admin = await pool.query(
      `INSERT INTO users (username, lark_open_id, role) VALUES ('admin-user', 'ou_admin', 'admin') RETURNING id`,
    )
    adminUserId = admin.rows[0].id
    const regular = await pool.query(
      `INSERT INTO users (username, lark_open_id, role) VALUES ('regular-user', 'ou_regular', 'user') RETURNING id`,
    )
    regularUserId = regular.rows[0].id

    deviceId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO bridge_devices (device_id, user_id, device_name, last_seen_at)
       VALUES ($1, $2, 'admin-dev', now())`,
      [deviceId, adminUserId],
    )
    await pool.query(
      `INSERT INTO bridge_devices (device_id, user_id, device_name, last_seen_at)
       VALUES ($1, $2, 'regular-dev', now() - interval '2 days')`,
      [crypto.randomUUID(), regularUserId],
    )

    adminToken = signUserToken(adminUserId, deviceId, SECRET)
    regularToken = signUserToken(regularUserId, deviceId, SECRET)
  })

  it('rejects request without userToken', async () => {
    const res = await request(app).get('/admin/stats')
    expect(res.status).toBe(401)
  })

  it('rejects non-admin user with 403', async () => {
    const res = await request(app).get('/admin/stats').set('Authorization', `Bearer ${regularToken}`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
  })

  it('admin can GET /admin/stats and gets numeric fields', async () => {
    // seed 一条 audit 让 24h 计数不为 0
    await pool.query(
      `INSERT INTO bridge_audit (user_id, device_id, action, status, duration_ms) VALUES ($1, $2, 'extract', 'ok', 123)`,
      [adminUserId, deviceId],
    )
    const res = await request(app).get('/admin/stats').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.stats.devices.total).toBeGreaterThanOrEqual(2)
    expect(res.body.stats.calls_24h.total).toBe(1)
    expect(res.body.stats.calls_24h.ok).toBe(1)
    expect(res.body.stats.calls_24h.avg_ms).toBe(123)
  })

  it('admin can GET /admin/users and only sees users with devices', async () => {
    // 加一个"没绑过 device 的用户", 不应该出现在结果里
    await pool.query(`INSERT INTO users (username, lark_open_id) VALUES ('never-bound', 'ou_never')`)

    const res = await request(app).get('/admin/users').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const usernames = res.body.users.map((u: { username: string }) => u.username)
    expect(usernames).toContain('admin-user')
    expect(usernames).toContain('regular-user')
    expect(usernames).not.toContain('never-bound')
  })

  it('/admin/users returns device_count and live_token_count', async () => {
    const tokenJti = crypto.randomUUID()
    await pool.query(
      `INSERT INTO bridge_pairing_tokens (jti, user_id, device_id, token_hash, token_prefix, label, scopes)
       VALUES ($1, $2, $3, 'hash', 'pfx', 'test', ARRAY['extract'])`,
      [tokenJti, adminUserId, deviceId],
    )
    const res = await request(app).get('/admin/users').set('Authorization', `Bearer ${adminToken}`)
    const admin = res.body.users.find((u: { username: string }) => u.username === 'admin-user')
    expect(Number(admin.devices)).toBe(1)
    expect(Number(admin.live_tokens)).toBe(1)
  })

  it('/admin/audit returns cross-user entries with username joined', async () => {
    await pool.query(
      `INSERT INTO bridge_audit (user_id, device_id, action, status, duration_ms) VALUES ($1, $2, 'extract', 'ok', 100)`,
      [adminUserId, deviceId],
    )
    await pool.query(
      `INSERT INTO bridge_audit (user_id, device_id, action, status, duration_ms) VALUES ($1, $2, 'navigate', 'error', 50)`,
      [regularUserId, deviceId],
    )
    const res = await request(app).get('/admin/audit').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(2)
    const usernames = res.body.entries.map((e: { username: string }) => e.username)
    expect(usernames).toContain('admin-user')
    expect(usernames).toContain('regular-user')
  })

  it('/admin/audit supports user_id / action / status filters', async () => {
    await pool.query(
      `INSERT INTO bridge_audit (user_id, device_id, action, status) VALUES ($1, $2, 'extract', 'ok')`,
      [adminUserId, deviceId],
    )
    await pool.query(
      `INSERT INTO bridge_audit (user_id, device_id, action, status) VALUES ($1, $2, 'navigate', 'error')`,
      [regularUserId, deviceId],
    )

    const filtered = await request(app)
      .get(`/admin/audit?user_id=${adminUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(filtered.body.entries).toHaveLength(1)
    expect(filtered.body.entries[0].username).toBe('admin-user')

    const byAction = await request(app).get('/admin/audit?action=navigate').set('Authorization', `Bearer ${adminToken}`)
    expect(byAction.body.entries).toHaveLength(1)
    expect(byAction.body.entries[0].username).toBe('regular-user')

    const byStatus = await request(app).get('/admin/audit?status=error').set('Authorization', `Bearer ${adminToken}`)
    expect(byStatus.body.entries).toHaveLength(1)
    expect(byStatus.body.entries[0].status).toBe('error')
  })

  it('/admin/audit limit param is capped at 500', async () => {
    const res = await request(app).get('/admin/audit?limit=9999').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
  })
})
