import crypto from 'crypto'
import type { Db } from './pg.js'
import type { FeishuUserInfo } from './feishu.js'

export interface BridgeUser {
  id: string
  username: string
  role: string
}

// lookup-or-create by lark_open_id, 复用父目录 marketing-agent 的 users 表
// 用户名策略独立实现 (不依赖 email scope), 与 backend/src/routes/auth.js 的逻辑保持同构但代码不共享
export async function lookupOrCreateUser(db: Db, lark: FeishuUserInfo): Promise<BridgeUser> {
  const existing = await db.query<BridgeUser>(
    'SELECT id, username, role FROM users WHERE lark_open_id = $1',
    [lark.open_id],
  )
  if (existing.rows[0]) {
    await db.query(
      'UPDATE users SET display_name = COALESCE($2, display_name), last_active_at = NOW() WHERE id = $1',
      [existing.rows[0].id, lark.name || null],
    )
    return existing.rows[0]
  }

  const baseUsername = `lark_${lark.open_id.slice(-8)}`.toLowerCase()
  let candidate = baseUsername
  let suffix = 0
  // 防用户名冲突 (username 是 NOT NULL UNIQUE)
  while (true) {
    const exist = await db.query('SELECT id FROM users WHERE username = $1', [candidate])
    if (!exist.rows[0]) break
    suffix += 1
    candidate = `${baseUsername}-${suffix}`
    if (suffix > 50) {
      candidate = `lark_${crypto.randomBytes(4).toString('hex')}`
      break
    }
  }

  const ins = await db.query<BridgeUser>(
    `INSERT INTO users (username, display_name, lark_open_id, role)
     VALUES ($1, $2, $3, 'user') RETURNING id, username, role`,
    [candidate, lark.name || candidate, lark.open_id],
  )
  return ins.rows[0]!
}
