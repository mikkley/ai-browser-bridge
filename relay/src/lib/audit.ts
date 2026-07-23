import type { Db } from './pg.js'

export interface AuditEntry {
  userId?: string | null
  deviceId?: string | null
  tokenJti?: string | null
  action: string
  targetUrl?: string | null
  durationMs?: number | null
  status: 'ok' | 'error' | 'refused' | 'timeout'
  errorMsg?: string | null
  requestIp?: string | null
}

// 审计写入失败不应该打断主流程 (command 已经执行/拒绝了), 只记日志
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO bridge_audit
         (user_id, device_id, token_jti, action, target_url, duration_ms, status, error_msg, request_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.userId ?? null,
        entry.deviceId ?? null,
        entry.tokenJti ?? null,
        entry.action,
        entry.targetUrl ?? null,
        entry.durationMs ?? null,
        entry.status,
        entry.errorMsg ?? null,
        entry.requestIp ?? null,
      ],
    )
  } catch (err) {
    console.error('[audit] write failed:', (err as Error).message)
  }
}
