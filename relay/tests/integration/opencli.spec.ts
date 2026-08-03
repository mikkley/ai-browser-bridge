import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import request from 'supertest'
import { WebSocket } from 'ws'
import type { Pool } from 'pg'
import { testDb, truncateAll } from './db.js'
import { createOpencliRouter } from '../../src/routes/opencli.js'
import { SessionStore } from '../../src/lib/sessions.js'
import { generatePairingToken } from '../../src/lib/pat.js'

const skip = !process.env.DATABASE_URL
const FULL_SCOPES = ['navigate', 'evalScript', 'cookies']

// 假 device: navigate 返 {tabId}, 其他 action 返固定值.
// opencli 命令内部的 evaluate 走同一条路, 所以真跑命令时也是这个 mock 在应答.
function fakeDevice(sessions: SessionStore, tabId = 4242) {
  return {
    readyState: WebSocket.OPEN,
    send: (raw: string) => {
      const msg = JSON.parse(raw)
      const data = msg.action === 'navigate' ? { tabId } : 'mock-result'
      setImmediate(() => sessions.handleMessage(JSON.stringify({ id: msg.id, ok: true, data })))
    },
    close: () => {},
  } as unknown as WebSocket
}

describe.skipIf(skip)('POST /opencli (integration)', () => {
  let pool: Pool
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
    sessions = new SessionStore(500)

    const userRes = await pool.query(
      `INSERT INTO users (username, lark_open_id) VALUES ('opencli-user', 'ou_opencli') RETURNING id`,
    )
    userId = userRes.rows[0].id
    deviceId = crypto.randomUUID()
    await pool.query(`INSERT INTO bridge_devices (device_id, user_id, device_name) VALUES ($1, $2, 'dev')`, [
      deviceId,
      userId,
    ])
  })

  function makeApp(enabled = true, commandTimeoutMs = 5_000) {
    const app = express()
    app.use(express.json())
    app.use(createOpencliRouter(pool, sessions, { enabled, rateLimitRpm: 0, commandTimeoutMs }))
    return app
  }

  async function issueToken(scopes: string[]): Promise<string> {
    const generated = generatePairingToken()
    await pool.query(
      `INSERT INTO bridge_pairing_tokens (jti, user_id, device_id, token_hash, token_prefix, label, scopes)
       VALUES ($1,$2,$3,$4,$5,'opencli test',$6)`,
      [crypto.randomUUID(), userId, deviceId, generated.hash, generated.prefix, scopes],
    )
    return generated.plaintext
  }

  it('returns 501 when ENABLE_OPENCLI is off', async () => {
    const token = await issueToken(FULL_SCOPES)
    const res = await request(makeApp(false))
      .post('/opencli')
      .set('Authorization', `Bearer ${token}`)
      .send({ site: 'xiaohongshu', op: 'search' })
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('opencli_disabled')
  })

  it('returns 401 without a token', async () => {
    const res = await request(makeApp()).post('/opencli').send({ site: 'xiaohongshu', op: 'search' })
    expect(res.status).toBe(401)
  })

  it('returns 401 for a revoked token', async () => {
    const token = await issueToken(FULL_SCOPES)
    await pool.query('UPDATE bridge_pairing_tokens SET revoked_at = now() WHERE device_id = $1', [deviceId])
    const res = await request(makeApp())
      .post('/opencli')
      .set('Authorization', `Bearer ${token}`)
      .send({ site: 'xiaohongshu', op: 'search' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('token_revoked')
  })

  it('returns 400 when site or op is missing', async () => {
    const token = await issueToken(FULL_SCOPES)
    const res = await request(makeApp()).post('/opencli').set('Authorization', `Bearer ${token}`).send({ site: 'xiaohongshu' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_request')
  })

  // site/op 会拼进文件路径 (clis/<site>/<op>.js), 必须挡 traversal
  it('rejects path traversal in site / op', async () => {
    const token = await issueToken(FULL_SCOPES)
    for (const payload of [
      { site: '../../etc', op: 'passwd' },
      { site: 'xiaohongshu', op: '../../../server' },
      { site: 'xiao/hongshu', op: 'search' },
    ]) {
      const res = await request(makeApp()).post('/opencli').set('Authorization', `Bearer ${token}`).send(payload)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('invalid_request')
    }
  })

  it('returns 403 listing exactly which scopes are missing', async () => {
    const token = await issueToken(['navigate']) // 缺 evalScript + cookies
    const res = await request(makeApp())
      .post('/opencli')
      .set('Authorization', `Bearer ${token}`)
      .send({ site: 'xiaohongshu', op: 'search' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('action_not_in_scope')
    expect(res.body.error.message).toContain('evalScript')
    expect(res.body.error.message).toContain('cookies')
    expect(res.body.error.message).not.toContain('缺: navigate')
  })

  it('returns 503 when the device is offline', async () => {
    const token = await issueToken(FULL_SCOPES)
    const res = await request(makeApp())
      .post('/opencli')
      .set('Authorization', `Bearer ${token}`)
      .send({ site: 'xiaohongshu', op: 'search' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('device_offline')
  })

  it('an anonymous ws session counts as offline', async () => {
    const token = await issueToken(FULL_SCOPES)
    sessions.set(deviceId, fakeDevice(sessions), false) // authenticated=false
    const res = await request(makeApp())
      .post('/opencli')
      .set('Authorization', `Bearer ${token}`)
      .send({ site: 'xiaohongshu', op: 'search' })
    expect(res.status).toBe(503)
  })

  it('returns 404 for an unknown site/op and audits it as refused', async () => {
    const token = await issueToken(FULL_SCOPES)
    sessions.set(deviceId, fakeDevice(sessions), true)
    const res = await request(makeApp())
      .post('/opencli')
      .set('Authorization', `Bearer ${token}`)
      .send({ site: 'definitely-not-a-real-site', op: 'nope' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('command_not_found')

    const audit = await pool.query(`SELECT action, status FROM bridge_audit WHERE device_id = $1`, [deviceId])
    expect(audit.rows[0].action).toBe('opencli:definitely-not-a-real-site/nope')
    expect(audit.rows[0].status).toBe('refused')
  })

  it('audit action is prefixed opencli: so it is distinguishable from /command rows', async () => {
    const token = await issueToken(['navigate'])
    await request(makeApp()).post('/opencli').set('Authorization', `Bearer ${token}`).send({ site: 'weibo', op: 'search' })
    const audit = await pool.query(`SELECT action FROM bridge_audit WHERE device_id = $1`, [deviceId])
    expect(audit.rows[0].action).toBe('opencli:weibo/search')
  })

  it('runs a real registered opencli command end-to-end against the mock device', async () => {
    // xiaohongshu/search 是真 opencli 命令. 这里 device 是 mock, 所以命令内部
    // page.evaluate 拿到的是 'mock-result' 而不是真笔记 —— 它大概率会抛错 (解析失败),
    // 但那说明"加载命令 → 建 tab → 调 func → 走 WSPage → 派发到 device"整条链路是通的.
    // 真数据验证只能人工在浏览器里做 (见 PR 描述的 test plan).
    const token = await issueToken(FULL_SCOPES)
    sessions.set(deviceId, fakeDevice(sessions), true)

    const res = await request(makeApp())
      .post('/opencli')
      .set('Authorization', `Bearer ${token}`)
      .send({ site: 'xiaohongshu', op: 'search', args: { query: 'test', limit: 5 } })

    // 关键: 不是 404 (命令加载成功了), 不是 403/503 (闸门都过了)
    expect(res.status).not.toBe(404)
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(503)
    // tabId 回给调用方了 (说明 navigate 派发成功)
    expect(res.body.tabId).toBe(4242)

    const audit = await pool.query(`SELECT action FROM bridge_audit WHERE device_id = $1`, [deviceId])
    expect(audit.rows[0].action).toBe('opencli:xiaohongshu/search')
  })
})
