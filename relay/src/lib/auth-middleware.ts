import type { NextFunction, Request, Response } from 'express'
import { verifyUserToken } from './user-token.js'

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
