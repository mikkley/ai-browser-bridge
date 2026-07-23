import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import request from 'supertest'
import { WebSocket } from 'ws'
import type { Pool } from 'pg'
import { testDb, truncateAll } from './db.js'
import { createCommandRouter } from '../../src/routes/command.js'
import { SessionStore } from '../../src/lib/sessions.js'
import { generatePairingToken } from '../../src/lib/pat.js'

const skip = !process.env.DATABASE_URL

describe.skipIf(skip)('POST /command (integration)', () => {
  let pool: Pool
  let sessions: SessionStore
  let app: express.Express
  let userId: string
  let deviceId: string

  beforeAll(() => {
    pool = testDb()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    sessions = new SessionStore(200)
    app = express()
    app.use(express.json())
    app.use(
      createCommandRouter(pool, sessions, {
        allowedActions: new Set(['navigate', 'extract', 'waitForSelector', 'cookies', 'tabs', 'screenshot', 'execute']),
        rateLimitRpm: 0,
        jitterMinMs: 0,
        jitterMaxMs: 0,
      }),
    )

    const userRes = await pool.query(`INSERT INTO users (username, lark_open_id) VALUES ('test-user', 'ou_test') RETURNING id`)
    userId = userRes.rows[0].id
    deviceId = crypto.randomUUID()
    await pool.query(`INSERT INTO bridge_devices (device_id, user_id, device_name) VALUES ($1, $2, 'test device')`, [deviceId, userId])
  })

  async function issueToken(scopes: string[]): Promise<string> {
    const generated = generatePairingToken()
    const jti = crypto.randomUUID()
    await pool.query(
      `INSERT INTO bridge_pairing_tokens (jti, user_id, device_id, token_hash, token_prefix, label, scopes)
       VALUES ($1,$2,$3,$4,$5,'test token',$6)`,
      [jti, userId, deviceId, generated.hash, generated.prefix, scopes],
    )
    return generated.plaintext
  }

  it('returns 401 for a malformed bearer token', async () => {
    const res = await request(app).post('/command').set('Authorization', 'Bearer not-a-real-token').send({ action: 'extract' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('invalid_token')
  })

  it('returns 401 when the token is well-formed but unknown', async () => {
    const fake = generatePairingToken().plaintext
    const res = await request(app).post('/command').set('Authorization', `Bearer ${fake}`).send({ action: 'extract' })
    expect(res.status).toBe(401)
  })

  it('returns 403 when action is not in token scopes', async () => {
    const token = await issueToken(['extract'])
    const res = await request(app).post('/command').set('Authorization', `Bearer ${token}`).send({ action: 'navigate' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('action_not_in_scope')
  })

  it('returns 503 when the device is offline', async () => {
    const token = await issueToken(['extract'])
    const res = await request(app).post('/command').set('Authorization', `Bearer ${token}`).send({ action: 'extract' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('device_offline')
  })

  it('dispatches to the device and returns the result when online, and writes an audit row', async () => {
    const token = await issueToken(['extract'])
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => {
        const msg = JSON.parse(raw)
        setImmediate(() => sessions.handleMessage(JSON.stringify({ id: msg.id, ok: true, data: 'page text' })))
      },
      close: () => {},
    } as unknown as WebSocket
    sessions.set(deviceId, fakeWs, true)

    const res = await request(app)
      .post('/command')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'extract', params: { type: 'text' } })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, result: 'page text' })

    const audit = await pool.query('SELECT status, action FROM bridge_audit WHERE device_id = $1', [deviceId])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0].status).toBe('ok')
    expect(audit.rows[0].action).toBe('extract')
  })

  it('an anonymous (unauthenticated) ws session is treated as offline', async () => {
    const token = await issueToken(['extract'])
    const fakeWs = { readyState: WebSocket.OPEN, send: () => {}, close: () => {} } as unknown as WebSocket
    sessions.set(deviceId, fakeWs, false) // 匿名连接

    const res = await request(app).post('/command').set('Authorization', `Bearer ${token}`).send({ action: 'extract' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('device_offline')
  })

  it('revoked token is rejected', async () => {
    const token = await issueToken(['extract'])
    await pool.query('UPDATE bridge_pairing_tokens SET revoked_at = now() WHERE device_id = $1', [deviceId])
    const res = await request(app).post('/command').set('Authorization', `Bearer ${token}`).send({ action: 'extract' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('token_revoked')
  })

  it('expired token is rejected', async () => {
    const token = await issueToken(['extract'])
    await pool.query(`UPDATE bridge_pairing_tokens SET expires_at = now() - interval '1 hour' WHERE device_id = $1`, [deviceId])
    const res = await request(app).post('/command').set('Authorization', `Bearer ${token}`).send({ action: 'extract' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('token_expired')
  })

  it('rejects an action not present in server ALLOWED_ACTIONS even if it were in scopes', async () => {
    const generated = generatePairingToken()
    const jti = crypto.randomUUID()
    await pool.query(
      `INSERT INTO bridge_pairing_tokens (jti, user_id, device_id, token_hash, token_prefix, label, scopes)
       VALUES ($1,$2,$3,$4,$5,'test token',$6)`,
      [jti, userId, deviceId, generated.hash, generated.prefix, ['evalScript']],
    )
    const res = await request(app).post('/command').set('Authorization', `Bearer ${generated.plaintext}`).send({ action: 'evalScript' })
    expect(res.status).toBe(403)
  })
})
