import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import fs from 'fs'
import path from 'path'
import { resolveJwtSecret } from './config.js'
import { startTunnel } from './tunnel.js'
import { getDb, closeDb } from './lib/pg.js'
import { SessionStore } from './lib/sessions.js'
import { FeishuClient } from './lib/feishu.js'
import { createFeishuOAuthRouter } from './routes/oauth-feishu.js'
import { createMeRouter } from './routes/me.js'
import { createCommandRouter } from './routes/command.js'
import { createAdminRouter } from './routes/admin.js'
import { createOpencliRouter } from './routes/opencli.js'
import { isOpencliAvailable } from './opencli/runner.js'
import { verifyUserToken } from './lib/user-token.js'

const STATE_PATH = path.join(process.cwd(), '.data', 'state.json')
const PORT = Number(process.env.PORT) || 3000
const COMMAND_TIMEOUT = 30_000

// ── 必填环境变量 ──────────────────────────────────────────────────────────

const ACCESS_KEY = process.env.BRIDGE_ACCESS_KEY
if (!ACCESS_KEY) {
  console.error('❌ BRIDGE_ACCESS_KEY env var is required. Generate one with:')
  console.error("   node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\"")
  process.exit(1)
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL env var is required (shares marketing-agent pg, see CLAUDE.md)')
  process.exit(1)
}

const FEISHU_APP_ID = process.env.FEISHU_APP_ID
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error('❌ FEISHU_APP_ID / FEISHU_APP_SECRET env vars are required (复用 marketing-agent 的飞书 app)')
  process.exit(1)
}

const BRIDGE_FEISHU_REDIRECT_URI = process.env.BRIDGE_FEISHU_REDIRECT_URI
if (!BRIDGE_FEISHU_REDIRECT_URI) {
  console.error('❌ BRIDGE_FEISHU_REDIRECT_URI env var is required (需在飞书 app 后台加白名单)')
  process.exit(1)
}

const JWT_SECRET = resolveJwtSecret()

// 允许下发的 action 白名单 (服务器层闸门, token scopes 是第二层), 默认不含 evalScript
const ALLOWED_ACTIONS = new Set(
  (process.env.ALLOWED_ACTIONS ?? 'navigate,extract,cookies,tabs,screenshot,execute,waitForSelector').split(',').map((s) => s.trim()),
)

const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 30)
const JITTER_MIN_MS = Number(process.env.JITTER_MIN_MS ?? 500)
const JITTER_MAX_MS = Number(process.env.JITTER_MAX_MS ?? 3000)

// POST /opencli 开关. 开着才允许 agent 用 opencli 的 177 网站命令 (relay 侧跑,
// agent 端零安装). 关掉 = relay 退回纯链接器, 只提供 /command low-level 原语.
const ENABLE_OPENCLI = process.env.ENABLE_OPENCLI !== 'false'
// 一条 opencli 命令的总超时 (内部 5-15 次 WS 派发 + 页面等待, 比单条 command 长)
const OPENCLI_TIMEOUT_MS = Number(process.env.OPENCLI_TIMEOUT_MS ?? 120_000)

// 常量时间字符串比较 (防 timing attack; access key 长度可控所以足够)
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── 依赖组装 ──────────────────────────────────────────────────────────────

const db = getDb()
const sessions = new SessionStore(COMMAND_TIMEOUT)
const feishu = new FeishuClient({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET })

// ── HTTP API ──────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size() })
})

app.use(createFeishuOAuthRouter(db, feishu, { callbackUrl: BRIDGE_FEISHU_REDIRECT_URI, userTokenSecret: JWT_SECRET }))
app.use(createMeRouter(db, JWT_SECRET))
app.use(createAdminRouter(db, JWT_SECRET))
app.use(
  createCommandRouter(db, sessions, {
    allowedActions: ALLOWED_ACTIONS,
    rateLimitRpm: RATE_LIMIT_RPM,
    jitterMinMs: JITTER_MIN_MS,
    jitterMaxMs: JITTER_MAX_MS,
  }),
)
app.use(
  createOpencliRouter(db, sessions, {
    enabled: ENABLE_OPENCLI,
    rateLimitRpm: RATE_LIMIT_RPM,
    commandTimeoutMs: OPENCLI_TIMEOUT_MS,
  }),
)

// ── WebSocket Server（Extension 连进来）──────────────────────────────────
// 握手: ?deviceId=<uuid>&accessKey=<key>[&userToken=<jwt>]
// accessKey 是 bootstrap 票据 (防扫端口爬虫); userToken 决定这条连接是否算"已登录", 见 design 段 6.5

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url!, 'http://localhost')
  const accessKey = url.searchParams.get('accessKey') || ''
  const deviceId = url.searchParams.get('deviceId') || ''
  const userToken = url.searchParams.get('userToken') || ''

  if (!safeEqual(accessKey, ACCESS_KEY)) {
    ws.close(4001, 'Invalid access key')
    return
  }
  if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
    ws.close(4002, 'Invalid deviceId')
    return
  }

  let authenticated = false
  if (userToken) {
    try {
      const payload = verifyUserToken(userToken, JWT_SECRET)
      if (payload.deviceId !== deviceId) throw new Error('deviceId mismatch')
      const row = await db.query(
        'SELECT device_id FROM bridge_devices WHERE device_id = $1 AND user_id = $2 AND disabled_at IS NULL',
        [deviceId, payload.sub],
      )
      if (!row.rows[0]) throw new Error('device not bound or disabled')
      authenticated = true
      void db.query('UPDATE bridge_devices SET last_seen_at = now() WHERE device_id = $1', [deviceId])
    } catch (err) {
      ws.close(4003, `Invalid userToken: ${(err as Error).message}`)
      return
    }
  }

  // 同一 deviceId 已有连接: 踢旧的, 保证只有一个活跃 session
  const old = sessions.set(deviceId, ws, authenticated)
  old?.close(4000, 'Replaced by new connection')

  console.log(`✅ [${deviceId}] connected (authenticated=${authenticated}, online=${sessions.size()})`)

  ws.on('message', (raw) => sessions.handleMessage(raw.toString()))

  ws.on('close', () => {
    sessions.delete(deviceId, ws)
    console.log(`❌ [${deviceId}] disconnected (online: ${sessions.size()})`)
  })

  ws.on('error', (err) => console.error(`[${deviceId}] error:`, err.message))
})

// ── 启动 ──────────────────────────────────────────────────────────────────

async function main() {
  await new Promise<void>((resolve) => server.listen(PORT, resolve))
  console.log(`\n🚀 AI Browser Bridge Relay`)
  console.log(`${'─'.repeat(50)}`)

  let publicWsUrl = process.env.PUBLIC_URL
    ? process.env.PUBLIC_URL.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + '/ws'
    : null

  if (!publicWsUrl) {
    console.log('🌐 Starting Cloudflare Tunnel...')
    try {
      publicWsUrl = await startTunnel(PORT)
      console.log(`🌐 Public URL:  ${publicWsUrl}`)
    } catch (err) {
      publicWsUrl = `ws://localhost:${PORT}/ws`
      console.log(`⚠️  Tunnel failed, using local: ${publicWsUrl}`)
    }
  } else {
    console.log(`🌐 Public URL:  ${publicWsUrl}`)
  }

  app.locals.publicWsUrl = publicWsUrl
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify({ publicWsUrl }, null, 2))

  console.log(`\n🔑 Access key (extension/src/config.ts 中的 BRIDGE_ACCESS_KEY):`)
  console.log(`   ${ACCESS_KEY}`)

  // opencli 状态显式打出来 — 排查 "POST /opencli 返 501" 时第一眼能看到原因
  if (!ENABLE_OPENCLI) {
    console.log(`\n🧩 opencli: 已通过 ENABLE_OPENCLI=false 关闭`)
  } else if (isOpencliAvailable()) {
    console.log(`\n🧩 opencli: 可用 (POST /opencli), 命令超时 ${OPENCLI_TIMEOUT_MS}ms`)
  } else {
    console.log(`\n⚠️  opencli: ENABLE_OPENCLI 开着但 @jackwener/opencli 没装, POST /opencli 会返 501`)
  }
  console.log(`${'─'.repeat(50)}\n`)
}

process.on('SIGTERM', async () => {
  await closeDb()
  process.exit(0)
})

main().catch(console.error)
