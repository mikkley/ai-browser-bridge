import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import request from 'supertest'
import type { Pool } from 'pg'
import { testDb, truncateAll } from './db.js'
import { createFeishuOAuthRouter } from '../../src/routes/oauth-feishu.js'
import { createMeRouter } from '../../src/routes/me.js'
import { createCommandRouter } from '../../src/routes/command.js'
import { SessionStore } from '../../src/lib/sessions.js'
import { FeishuClient } from '../../src/lib/feishu.js'
import { generatePairingToken } from '../../src/lib/pat.js'
import { signUserToken } from '../../src/lib/user-token.js'

// server.ts 把三个 router 挂在同一个 app 上 (跟这里的顺序一致) —— 只分别测每个 router
// 挡不住"某个 router 的中间件没限定路径, 拦住了另一个 router 的请求"这类组合 bug
// (2026-07-22 真容器 smoke test 就是这么抓到 requireUserToken 没限定 /api/me 前缀的)
const skip = !process.env.DATABASE_URL
const SECRET = 'compose-test-secret'

describe.skipIf(skip)('full app composition (all routers mounted together, like server.ts)', () => {
  let pool: Pool
  let app: express.Express
  let sessions: SessionStore
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
    const feishu = new FeishuClient({ appId: 'app', appSecret: 'secret' })

    app = express()
    app.use(express.json())
    app.use(createFeishuOAuthRouter(pool, feishu, { callbackUrl: 'https://bridge.example.com/login/feishu-callback', userTokenSecret: SECRET }))
    app.use(createMeRouter(pool, SECRET))
    app.use(
      createCommandRouter(pool, sessions, {
        allowedActions: new Set(['extract']),
        rateLimitRpm: 0,
        jitterMinMs: 0,
        jitterMaxMs: 0,
      }),
    )

    const userRes = await pool.query(`INSERT INTO users (username, lark_open_id) VALUES ('compose-user', 'ou_compose') RETURNING id`)
    userId = userRes.rows[0].id
    deviceId = crypto.randomUUID()
    await pool.query(`INSERT INTO bridge_devices (device_id, user_id) VALUES ($1, $2)`, [deviceId, userId])
  })

  it('POST /command with a valid PAT works even though /api/me requires a different token type', async () => {
    const generated = generatePairingToken()
    const jti = crypto.randomUUID()
    await pool.query(
      `INSERT INTO bridge_pairing_tokens (jti, user_id, device_id, token_hash, token_prefix, label, scopes)
       VALUES ($1,$2,$3,$4,$5,'x',$6)`,
      [jti, userId, deviceId, generated.hash, generated.prefix, ['extract']],
    )
    sessions.set(deviceId, { readyState: 1, send: () => {}, close: () => {} } as any, true)

    const res = await request(app).post('/command').set('Authorization', `Bearer ${generated.plaintext}`).send({ action: 'extract' })
    // 503 device_offline 也算过 —— 关键是不能是 401 invalid_token (证明没被 /api/me 的中间件拦住)
    expect(res.status).not.toBe(401)
  })

  it('GET /api/me still requires a userToken (command PAT does not work here)', async () => {
    const generated = generatePairingToken()
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${generated.plaintext}`)
    expect(res.status).toBe(401)
  })

  it('GET /api/me with a valid userToken works', async () => {
    const userToken = signUserToken(userId, deviceId, SECRET)
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(200)
  })

  it('POST /command is not affected by an unrelated request to /login/feishu first', async () => {
    await request(app).get('/login/feishu').query({ device_id: crypto.randomUUID(), redirect_uri: 'https://abc.chromiumapp.org/' })

    const generated = generatePairingToken()
    const jti = crypto.randomUUID()
    await pool.query(
      `INSERT INTO bridge_pairing_tokens (jti, user_id, device_id, token_hash, token_prefix, label, scopes)
       VALUES ($1,$2,$3,$4,$5,'x',$6)`,
      [jti, userId, deviceId, generated.hash, generated.prefix, ['extract']],
    )
    const res = await request(app).post('/command').set('Authorization', `Bearer ${generated.plaintext}`).send({ action: 'extract' })
    expect(res.status).not.toBe(401)
  })
})
