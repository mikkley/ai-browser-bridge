import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import request from 'supertest'
import type { Pool } from 'pg'
import { testDb, truncateAll } from './db.js'
import { createMeRouter } from '../../src/routes/me.js'
import { signUserToken } from '../../src/lib/user-token.js'

const skip = !process.env.DATABASE_URL
const SECRET = 'test-user-token-secret'

describe.skipIf(skip)('/api/me (integration)', () => {
  let pool: Pool
  let app: express.Express
  let userId: string
  let deviceId: string
  let userToken: string

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
    app.use(createMeRouter(pool, SECRET))

    const userRes = await pool.query(`INSERT INTO users (username, lark_open_id) VALUES ('me-user', 'ou_me') RETURNING id`)
    userId = userRes.rows[0].id
    deviceId = crypto.randomUUID()
    await pool.query(`INSERT INTO bridge_devices (device_id, user_id) VALUES ($1, $2)`, [deviceId, userId])
    userToken = signUserToken(userId, deviceId, SECRET)
  })

  it('rejects requests without a bearer token', async () => {
    const res = await request(app).get('/api/me')
    expect(res.status).toBe(401)
  })

  it('rejects a userToken signed with the wrong secret', async () => {
    const bad = signUserToken(userId, deviceId, 'wrong-secret')
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${bad}`)
    expect(res.status).toBe(401)
  })

  it('GET /api/me returns user + device info', async () => {
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe('me-user')
    expect(res.body.device.device_id).toBe(deviceId)
  })

  it('GET /api/me/devices lists only own non-disabled devices', async () => {
    await pool.query(
      `INSERT INTO bridge_devices (device_id, user_id, disabled_at) VALUES ($1, $2, now())`,
      [crypto.randomUUID(), userId],
    )
    const res = await request(app).get('/api/me/devices').set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(200)
    expect(res.body.devices).toHaveLength(1)
  })

  it('PATCH /api/me/devices/:id renames the device', async () => {
    const res = await request(app)
      .patch(`/api/me/devices/${deviceId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ device_name: 'MK-MacBook-Chrome' })
    expect(res.status).toBe(200)
    const row = await pool.query('SELECT device_name FROM bridge_devices WHERE device_id = $1', [deviceId])
    expect(row.rows[0].device_name).toBe('MK-MacBook-Chrome')
  })

  it('POST /api/me/tokens creates a token and returns plaintext exactly once', async () => {
    const res = await request(app)
      .post('/api/me/tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ label: 'for 传播洞察', scopes: ['extract', 'navigate'] })
    expect(res.status).toBe(200)
    expect(res.body.plaintext).toMatch(/^bpt_/)

    const row = await pool.query('SELECT scopes, label FROM bridge_pairing_tokens WHERE jti = $1', [res.body.jti])
    expect(row.rows[0].label).toBe('for 传播洞察')
    expect(row.rows[0].scopes).toEqual(['extract', 'navigate'])
  })

  it('POST /api/me/tokens rejects unknown scopes', async () => {
    const res = await request(app)
      .post('/api/me/tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ label: 'x', scopes: ['deleteEverything'] })
    expect(res.status).toBe(400)
  })

  it('POST /api/me/tokens rejects an empty label', async () => {
    const res = await request(app)
      .post('/api/me/tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ label: '  ', scopes: ['extract'] })
    expect(res.status).toBe(400)
  })

  it('GET /api/me/tokens never leaks plaintext or hash', async () => {
    await request(app).post('/api/me/tokens').set('Authorization', `Bearer ${userToken}`).send({ label: 'x', scopes: ['extract'] })
    const res = await request(app).get('/api/me/tokens').set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(200)
    expect(res.body.tokens).toHaveLength(1)
    expect(res.body.tokens[0]).not.toHaveProperty('plaintext')
    expect(res.body.tokens[0]).not.toHaveProperty('token_hash')
  })

  it('DELETE /api/me/tokens/:jti revokes the token', async () => {
    const created = await request(app).post('/api/me/tokens').set('Authorization', `Bearer ${userToken}`).send({ label: 'x', scopes: ['extract'] })
    const del = await request(app).delete(`/api/me/tokens/${created.body.jti}`).set('Authorization', `Bearer ${userToken}`)
    expect(del.status).toBe(200)
    const row = await pool.query('SELECT revoked_at FROM bridge_pairing_tokens WHERE jti = $1', [created.body.jti])
    expect(row.rows[0].revoked_at).not.toBeNull()
  })

  it('cannot revoke another users token', async () => {
    const created = await request(app).post('/api/me/tokens').set('Authorization', `Bearer ${userToken}`).send({ label: 'x', scopes: ['extract'] })

    const otherUser = await pool.query(`INSERT INTO users (username) VALUES ('other-user') RETURNING id`)
    const otherDevice = crypto.randomUUID()
    await pool.query(`INSERT INTO bridge_devices (device_id, user_id) VALUES ($1, $2)`, [otherDevice, otherUser.rows[0].id])
    const otherToken = signUserToken(otherUser.rows[0].id, otherDevice, SECRET)

    const del = await request(app).delete(`/api/me/tokens/${created.body.jti}`).set('Authorization', `Bearer ${otherToken}`)
    expect(del.status).toBe(404)

    const row = await pool.query('SELECT revoked_at FROM bridge_pairing_tokens WHERE jti = $1', [created.body.jti])
    expect(row.rows[0].revoked_at).toBeNull()
  })

  it('GET /api/me/audit returns recent entries for the user only', async () => {
    await pool.query(
      `INSERT INTO bridge_audit (user_id, device_id, action, status) VALUES ($1, $2, 'extract', 'ok')`,
      [userId, deviceId],
    )
    const res = await request(app).get('/api/me/audit').set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(1)
  })
})
