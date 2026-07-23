import jwt from 'jsonwebtoken'
import crypto from 'crypto'

export interface UserTokenPayload {
  sub: string // user_id
  deviceId: string
  jti: string
}

const USER_TOKEN_TTL_SEC = 30 * 24 * 3600 // 30 天, 见 design 段 8.3

export function signUserToken(userId: string, deviceId: string, secret: string): string {
  return jwt.sign(
    { sub: userId, deviceId },
    secret,
    { expiresIn: USER_TOKEN_TTL_SEC, jwtid: crypto.randomUUID() },
  )
}

export function verifyUserToken(token: string, secret: string): UserTokenPayload {
  const payload = jwt.verify(token, secret) as jwt.JwtPayload
  if (typeof payload.sub !== 'string' || typeof payload.deviceId !== 'string') {
    throw new Error('invalid user token payload')
  }
  return { sub: payload.sub, deviceId: payload.deviceId, jti: payload.jti ?? '' }
}
