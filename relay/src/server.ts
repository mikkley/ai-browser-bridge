import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'

const PORT = Number(process.env.PORT) || 3000
const JWT_SECRET = process.env.JWT_SECRET

if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET is required in environment variables')
  process.exit(1)
}

// 每条命令的超时时间（ms）
const COMMAND_TIMEOUT = 30_000

// 等待响应的 pending commands：commandId → { resolve, reject, timer }
interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// userId → WebSocket 连接
const sessions = new Map<string, WebSocket>()
const pending = new Map<string, PendingCommand>()

// ── Auth ────────────────────────────────────────────────────────────────────

function verifyToken(token: string): string {
  const payload = jwt.verify(token, JWT_SECRET as string) as { userId: string }
  return payload.userId
}

// ── HTTP API for AI Agent ───────────────────────────────────────────────────

const app = express()
app.use(express.json())

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size })
})

// 生成 extension 用的连接 token（给你自己的后台调用）
app.post('/token', (req, res) => {
  const { userId, secret } = req.body
  // 用一个 RELAY_SECRET 保护此接口，防止外部随意生成 token
  if (secret !== process.env.RELAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const token = jwt.sign({ userId }, JWT_SECRET as string, { expiresIn: '30d' })
  res.json({ token })
})

// Agent 下发命令接口
// POST /command  { userId, action, params }
app.post('/command', async (req, res) => {
  // 验证 Agent 调用权限
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' })
  }
  let agentId: string
  try {
    agentId = verifyToken(authHeader.slice(7))
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

  // 发命令，等回调
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

// ── WebSocket Server for Extension ─────────────────────────────────────────

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  // Extension 连接时需要在 query string 带 token
  const url = new URL(req.url!, `http://localhost`)
  const token = url.searchParams.get('token')

  if (!token) {
    ws.close(4001, 'Missing token')
    return
  }

  let userId: string
  try {
    userId = verifyToken(token)
  } catch {
    ws.close(4001, 'Invalid token')
    return
  }

  // 同一用户重复连接时，关掉旧连接
  const existing = sessions.get(userId)
  if (existing && existing.readyState === WebSocket.OPEN) {
    existing.close(4000, 'Replaced by new connection')
  }

  sessions.set(userId, ws)
  console.log(`✅ Extension connected: ${userId} (total: ${sessions.size})`)

  ws.on('message', (raw) => {
    let msg: { id: string; ok: boolean; data?: unknown; error?: string }
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    const cmd = pending.get(msg.id)
    if (!cmd) return

    clearTimeout(cmd.timer)
    pending.delete(msg.id)

    if (msg.ok) {
      cmd.resolve(msg.data)
    } else {
      cmd.reject(new Error(msg.error ?? 'Unknown error'))
    }
  })

  ws.on('close', () => {
    sessions.delete(userId)
    console.log(`❌ Extension disconnected: ${userId} (total: ${sessions.size})`)
  })

  ws.on('error', (err) => {
    console.error(`Extension error [${userId}]:`, err.message)
  })
})

server.listen(PORT, () => {
  console.log(`🚀 Relay server running on port ${PORT}`)
})
