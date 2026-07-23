import { WebSocket } from 'ws'
import { v4 as uuidv4 } from 'uuid'

export class DeviceOfflineError extends Error {
  constructor() {
    super('device_offline')
  }
}

export class DeviceTimeoutError extends Error {
  constructor() {
    super('device_timeout')
  }
}

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  ws: WebSocket
  // 该 ws 握手时是否带了有效 userToken —— 匿名连接只挂着收心跳, 不参与 command 派发
  // (登出/未登录设备无法被 AI 操控, 见 design 段 6.5)
  authenticated: boolean
}

// deviceId -> 最新一条 ws 连接 (单连接策略: 新连接踢旧的)
export class SessionStore {
  private sessions = new Map<string, Session>()
  private pending = new Map<string, PendingCommand>()

  constructor(private readonly commandTimeoutMs: number = 30_000) {}

  // 返回被替换掉的旧连接 (调用方负责 close 它)
  set(deviceId: string, ws: WebSocket, authenticated: boolean): WebSocket | undefined {
    const old = this.sessions.get(deviceId)
    this.sessions.set(deviceId, { ws, authenticated })
    return old?.ws
  }

  delete(deviceId: string, ws: WebSocket): void {
    if (this.sessions.get(deviceId)?.ws === ws) this.sessions.delete(deviceId)
  }

  // 只有认证过 (登录设备) 的在线连接才算 "online" —— 匿名连接不算
  isOnline(deviceId: string): boolean {
    const session = this.sessions.get(deviceId)
    return !!session && session.authenticated && session.ws.readyState === WebSocket.OPEN
  }

  size(): number {
    return this.sessions.size
  }

  handleMessage(raw: string): void {
    let msg: { id: string; ok: boolean; data?: unknown; error?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const cmd = this.pending.get(msg.id)
    if (!cmd) return
    clearTimeout(cmd.timer)
    this.pending.delete(msg.id)
    msg.ok ? cmd.resolve(msg.data) : cmd.reject(new Error(msg.error ?? 'Unknown'))
  }

  send(deviceId: string, action: string, params: unknown): Promise<unknown> {
    if (!this.isOnline(deviceId)) {
      return Promise.reject(new DeviceOfflineError())
    }
    const ws = this.sessions.get(deviceId)!.ws
    return new Promise((resolve, reject) => {
      const id = uuidv4()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DeviceTimeoutError())
      }, this.commandTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, action, params }))
    })
  }
}
