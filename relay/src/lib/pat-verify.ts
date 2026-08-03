// PAT 校验 — /command 和 /opencli 两个端点共用.
// 单独抽出来是因为两处都要跑同一套 40 行 (查库/revoked/expired) + 错误码要一致.

import type { Db } from './pg.js'
import { hashToken, isValidTokenFormat } from './pat.js'

export interface PairingTokenRow {
  jti: string
  user_id: string
  device_id: string
  scopes: string[]
  revoked_at: string | null
  expires_at: string | null
}

export type PatVerifyResult =
  | { ok: true; row: PairingTokenRow }
  | { ok: false; status: number; code: string; message: string }

export function extractBearer(authHeader: string | undefined): string {
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
}

export async function verifyPat(db: Db, token: string): Promise<PatVerifyResult> {
  if (!token || !isValidTokenFormat(token)) {
    return { ok: false, status: 401, code: 'invalid_token', message: 'Missing or malformed bearer token' }
  }

  const result = await db.query<PairingTokenRow>(
    `SELECT jti, user_id, device_id, scopes, revoked_at, expires_at
     FROM bridge_pairing_tokens WHERE token_hash = $1`,
    [hashToken(token)],
  )
  const row = result.rows[0]
  if (!row) {
    return { ok: false, status: 401, code: 'invalid_token', message: 'Token not found' }
  }
  if (row.revoked_at) {
    return { ok: false, status: 401, code: 'token_revoked', message: 'Token has been revoked' }
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 401, code: 'token_expired', message: 'Token has expired' }
  }
  return { ok: true, row }
}

export async function touchToken(db: Db, jti: string, ip: string | undefined): Promise<void> {
  try {
    await db.query('UPDATE bridge_pairing_tokens SET last_used_at = now(), last_used_ip = $2 WHERE jti = $1', [jti, ip ?? null])
  } catch (err) {
    console.error('[pat] touchToken failed:', (err as Error).message)
  }
}
