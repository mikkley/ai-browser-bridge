import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import request from 'supertest'
import type { Pool } from 'pg'
import { testDb, truncateAll } from './db.js'
import { createFeishuOAuthRouter } from '../../src/routes/oauth-feishu.js'
import { FeishuClient } from '../../src/lib/feishu.js'
import { verifyUserToken } from '../../src/lib/user-token.js'

const skip = !process.env.DATABASE_URL
const SECRET = 'test-user-token-secret'
const CALLBACK_URL = 'https://bridge.example.com/login/feishu-callback'
const EXTENSION_REDIRECT = 'https://abcdefgh.chromiumapp.org/'

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

describe.skipIf(skip)('/login/feishu (integration)', () => {
  let pool: Pool
  let app: express.Express
  let fetchImpl: ReturnType<typeof vi.fn>

  beforeAll(() => {
    pool = testDb()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await truncateAll(pool)

    fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/oauth/token')) {
        return jsonResponse({ code: 0, access_token: 'ua-1', refresh_token: 'ur-1', expires_in: 7200 })
      }
      if (String(url).includes('/user_info')) {
        return jsonResponse({ code: 0, data: { open_id: 'ou_new_user', name: 'Test Feishu User' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const feishu = new FeishuClient({ appId: 'app-1', appSecret: 'secret-1', fetchImpl })

    app = express()
    app.use(createFeishuOAuthRouter(pool, feishu, { callbackUrl: CALLBACK_URL, userTokenSecret: SECRET }))
  })

  it('rejects an invalid device_id', async () => {
    const res = await request(app).get('/login/feishu').query({ device_id: 'not-a-uuid', redirect_uri: EXTENSION_REDIRECT })
    expect(res.status).toBe(400)
  })

  it('rejects a redirect_uri outside chromiumapp.org', async () => {
    const res = await request(app)
      .get('/login/feishu')
      .query({ device_id: crypto.randomUUID(), redirect_uri: 'https://evil.example.com/' })
    expect(res.status).toBe(400)
  })

  it('redirects to feishu authorize url with a state param', async () => {
    const res = await request(app)
      .get('/login/feishu')
      .query({ device_id: crypto.randomUUID(), redirect_uri: EXTENSION_REDIRECT })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.location)
    expect(location.hostname).toBe('open.feishu.cn')
    expect(location.searchParams.get('state')).toBeTruthy()
  })

  it('full login flow: creates user + device, and redirects back with a valid userToken', async () => {
    const deviceId = crypto.randomUUID()
    const startRes = await request(app).get('/login/feishu').query({ device_id: deviceId, redirect_uri: EXTENSION_REDIRECT })
    const state = new URL(startRes.headers.location).searchParams.get('state')!

    const callbackRes = await request(app).get('/login/feishu-callback').query({ code: 'auth-code-123', state })
    expect(callbackRes.status).toBe(302)

    const redirectUrl = new URL(callbackRes.headers.location)
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(EXTENSION_REDIRECT)
    expect(redirectUrl.searchParams.get('user_name')).toBeTruthy()

    const userToken = redirectUrl.searchParams.get('token')!
    const payload = verifyUserToken(userToken, SECRET)
    expect(payload.deviceId).toBe(deviceId)

    const userRow = await pool.query('SELECT id, lark_open_id FROM users WHERE id = $1', [payload.sub])
    expect(userRow.rows[0].lark_open_id).toBe('ou_new_user')

    const deviceRow = await pool.query('SELECT device_id, user_id FROM bridge_devices WHERE device_id = $1', [deviceId])
    expect(deviceRow.rows[0].user_id).toBe(payload.sub)
  })

  it('logging in again with the same open_id reuses the same user row', async () => {
    const deviceA = crypto.randomUUID()
    const startA = await request(app).get('/login/feishu').query({ device_id: deviceA, redirect_uri: EXTENSION_REDIRECT })
    const stateA = new URL(startA.headers.location).searchParams.get('state')!
    const cbA = await request(app).get('/login/feishu-callback').query({ code: 'code-a', state: stateA })
    const userIdA = verifyUserToken(new URL(cbA.headers.location).searchParams.get('token')!, SECRET).sub

    const deviceB = crypto.randomUUID()
    const startB = await request(app).get('/login/feishu').query({ device_id: deviceB, redirect_uri: EXTENSION_REDIRECT })
    const stateB = new URL(startB.headers.location).searchParams.get('state')!
    const cbB = await request(app).get('/login/feishu-callback').query({ code: 'code-b', state: stateB })
    const userIdB = verifyUserToken(new URL(cbB.headers.location).searchParams.get('token')!, SECRET).sub

    expect(userIdA).toBe(userIdB)

    const users = await pool.query('SELECT id FROM users WHERE lark_open_id = $1', ['ou_new_user'])
    expect(users.rows).toHaveLength(1)
  })

  it('rejects a callback with an unknown or reused state', async () => {
    const res = await request(app).get('/login/feishu-callback').query({ code: 'x', state: 'never-issued' })
    expect(res.status).toBe(400)
  })
})
