import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { loadConfig, makeConnectCode } from './config.js'
import { startTunnel } from './tunnel.js'
import fs from 'fs'
import path from 'path'

const STATE_PATH = path.join(process.cwd(), '.data', 'state.json')

// ── 初始化配置（首次自动生成密钥）────────────────────────────────────────
const config = loadConfig()
const JWT_SECRET = config.jwtSecret
const RELAY_SECRET = config.relaySecret
const PORT = Number(process.env.PORT) || 3000
const COMMAND_TIMEOUT = 30_000

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, WebSocket>()   // userId → WebSocket
const pending = new Map<string, PendingCommand>() // commandId → pending

// ── Auth ──────────────────────────────────────────────────────────────────

function verifyToken(token: string): string {
  const payload = jwt.verify(token, JWT_SECRET) as { userId: string }
  return payload.userId
}

// ── HTTP API ──────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size })
})

// 生成用户 connect code（需要 relay secret 保护）
app.post('/token', (req, res) => {
  const { userId, secret } = req.body
  if (secret !== RELAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  // publicWsUrl 由启动时注入
  const code = makeConnectCode(app.locals.publicWsUrl, userId, JWT_SECRET)
  res.json({ connectCode: code })
})

// Agent 下发命令
app.post('/command', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' })
  }
  try {
    verifyToken(authHeader.slice(7))
  } catch {
    return res.status(401).json({ error: 'Invalid token' })
  }

  const { userId, action, params } = req.body
  if (!userId || !action) {
    return res.status(400).json({ error: 'userId and action are required' })
  }

  const ws = sessions.get(userId)
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: 'User browser not connected' })
  }

  try {
    const data = await sendCommand(ws, action, params)
    res.json({ ok: true, data })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

function sendCommand(ws: WebSocket, action: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = uuidv4()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Command timed out'))
    }, COMMAND_TIMEOUT)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, action, params }))
  })
}

// ── WebSocket Server（Extension 连进来）──────────────────────────────────

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url!, `http://localhost`)
  const token = url.searchParams.get('token')

  if (!token) { ws.close(4001, 'Missing token'); return }

  let userId: string
  try {
    userId = verifyToken(token)
  } catch {
    ws.close(4001, 'Invalid token'); return
  }

  // 同一用户重复连接，关掉旧的
  sessions.get(userId)?.close(4000, 'Replaced by new connection')
  sessions.set(userId, ws)
  console.log(`✅ [${userId}] connected  (online: ${sessions.size})`)

  ws.on('message', (raw) => {
    let msg: { id: string; ok: boolean; data?: unknown; error?: string }
    try { msg = JSON.parse(raw.toString()) } catch { return }
    const cmd = pending.get(msg.id)
    if (!cmd) return
    clearTimeout(cmd.timer)
    pending.delete(msg.id)
    msg.ok ? cmd.resolve(msg.data) : cmd.reject(new Error(msg.error ?? 'Unknown'))
  })

  ws.on('close', () => {
    sessions.delete(userId)
    console.log(`❌ [${userId}] disconnected (online: ${sessions.size})`)
  })

  ws.on('error', (err) => console.error(`[${userId}] error:`, err.message))
})

// ── 启动 ──────────────────────────────────────────────────────────────────

async function main() {
  await new Promise<void>((resolve) => server.listen(PORT, resolve))
  console.log(`\n🚀 AI Browser Bridge Relay`)
  console.log(`${'─'.repeat(50)}`)

  // 优先使用环境变量指定的公网地址（生产部署时设置）
  let publicWsUrl = process.env.PUBLIC_URL
    ? process.env.PUBLIC_URL.replace(/^https?:\/\//, 'wss://') + '/ws'
    : null

  if (!publicWsUrl) {
    console.log('🌐 Starting Cloudflare Tunnel...')
    try {
      publicWsUrl = await startTunnel(PORT)
      console.log(`🌐 Public URL:  ${publicWsUrl}`)
    } catch (err) {
      // 内网/已有公网 IP 时 tunnel 可选
      publicWsUrl = `wss://localhost:${PORT}/ws`
      console.log(`⚠️  Tunnel failed, using local: ${publicWsUrl}`)
    }
  } else {
    console.log(`🌐 Public URL:  ${publicWsUrl}`)
  }

  app.locals.publicWsUrl = publicWsUrl

  // 保存公网 URL 供 CLI 工具读取
  fs.writeFileSync(STATE_PATH, JSON.stringify({ publicWsUrl }, null, 2))

  // 打印管理员 connect code（用于测试）
  const adminCode = makeConnectCode(publicWsUrl, 'admin', JWT_SECRET)
  console.log(`\n🔑 Admin connect code:`)
  console.log(`   ${adminCode}`)
  console.log(`\n🔐 Relay secret (用于生成用户 token):`)
  console.log(`   ${RELAY_SECRET}`)
  console.log(`\n📋 生成用户 connect code:`)
  console.log(`   npm run token -- <userId>`)
  console.log(`${'─'.repeat(50)}\n`)
}

main().catch(console.error)
