import type { NextFunction, Request, Response } from 'express'
import { verifyUserToken } from './user-token.js'
import type { Db } from './pg.js'

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string
    deviceId?: string
  }
}

// 挂在 /api/me/* 路由上: 校验插件带的 userToken, 挂 req.userId / req.deviceId
export function requireUserToken(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) {
      return res.status(401).json({ ok: false, error: { code: 'missing_token', message: 'Missing bearer userToken' } })
    }
    try {
      const payload = verifyUserToken(token, secret)
      req.userId = payload.sub
      req.deviceId = payload.deviceId
      next()
    } catch {
      return res.status(401).json({ ok: false, error: { code: 'invalid_token', message: 'Invalid or expired userToken' } })
    }
  }
}

// 挂在 /admin/* 路由上: 先校验 userToken, 再查库确认 users.role='admin'
// 复用父目录 marketing-agent users 表里已有的 role 字段 (mk 是 admin, 见 010_v02_user_role.sql)
export function requireAdminUser(secret: string, db: Db) {
  const userTokenMw = requireUserToken(secret)
  return (req: Request, res: Response, next: NextFunction) => {
    userTokenMw(req, res, async () => {
      try {
        const result = await db.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [req.userId])
        if (result.rows[0]?.role !== 'admin') {
          return res.status(403).json({ ok: false, error: { code: 'forbidden', message: 'Admin only' } })
        }
        next()
      } catch (err) {
        return res.status(500).json({ ok: false, error: { code: 'internal', message: (err as Error).message } })
      }
    })
  }
}

