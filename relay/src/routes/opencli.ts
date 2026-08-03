import { Router } from 'express'
import type { Db } from '../lib/pg.js'
import type { SessionStore } from '../lib/sessions.js'
import { extractBearer, verifyPat, touchToken } from '../lib/pat-verify.js'
import { writeAudit } from '../lib/audit.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { DeviceTimeoutError } from '../lib/sessions.js'
import { runOpencli, OpencliNotAvailableError, OpencliCommandNotFoundError } from '../opencli/runner.js'
import { WSPageNotImplementedError } from '../opencli/ws-page.js'

// opencli 命令内部会用到的 low-level 原语 → 要求 PAT 同时持有这些 scope.
//
// 为什么必须在入口一次性要全集: WSPage 直接调 sessions.send(), 绕过了 /command
// 那条路上的逐 action scope 校验 —— 而 opencli 命令内部会派发什么原语是它的实现
// 细节, relay 事前不可知 (实测 xiaohongshu/search 只用 navigate + evalScript,
// 但别的命令会用 cookies/fetchJson)。所以只能在端点入口要求"opencli 可能用到的
// 全集"作为预授权, 不能事后补校验。
//
// 刻意不新增 'opencli' scope: 那样得改插件 popup 的勾选列表并让所有用户重装扩展,
// 而且要求这三个更诚实 —— opencli 确实在用户浏览器里执行任意 JS。
const REQUIRED_SCOPES = ['navigate', 'evalScript', 'cookies'] as const

export interface OpencliRouterOptions {
  /** 部署方开关. false 时端点直接 501, 用于想保持 relay 纯链接器的部署. */
  enabled: boolean
  rateLimitRpm: number
  /** 一条 opencli 命令的总超时 (内部有 5-15 次 WS 派发, 比单条 command 长得多) */
  commandTimeoutMs: number
}

/**
 * POST /opencli — 让任何能发 HTTP 的 agent 用 opencli 的 177 网站命令.
 *
 * body: { site, op, args? }
 * auth: Authorization: Bearer bpt_xxx (PAT 需含 navigate + evalScript + cookies)
 *
 * 跟 /command 的区别: /command 是单个 low-level 原语, 这里是"一条 opencli 命令"
 * (内部自动 navigate + 多次 evaluate + 滚动翻页 + 解析), agent 端零安装.
 */
export function createOpencliRouter(db: Db, sessions: SessionStore, opts: OpencliRouterOptions): Router {
  const router = Router()

  router.post('/opencli', async (req, res) => {
    if (!opts.enabled) {
      return res.status(501).json({
        ok: false,
        error: { code: 'opencli_disabled', message: 'opencli 端点未启用 (部署方设置 ENABLE_OPENCLI=true 开启)' },
      })
    }

    const start = Date.now()
    const verified = await verifyPat(db, extractBearer(req.headers.authorization))
    if (!verified.ok) {
      return res.status(verified.status).json({ ok: false, error: { code: verified.code, message: verified.message } })
    }
    const row = verified.row

    const { site, op, args } = req.body ?? {}
    if (typeof site !== 'string' || !site || typeof op !== 'string' || !op) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_request', message: 'site 和 op 必填 (string)' } })
    }
    // opencli site/op 会拼进文件路径, 挡掉 traversal
    if (!/^[a-z0-9_-]+$/i.test(site) || !/^[a-z0-9_-]+$/i.test(op)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'invalid_request', message: 'site / op 只能含字母数字下划线连字符' },
      })
    }

    const auditAction = `opencli:${site}/${op}`

    const missing = REQUIRED_SCOPES.filter((s) => !row.scopes.includes(s))
    if (missing.length > 0) {
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action: auditAction,
        status: 'refused', errorMsg: `missing_scopes:${missing.join(',')}`,
      })
      return res.status(403).json({
        ok: false,
        error: {
          code: 'action_not_in_scope',
          message: `opencli 需要 PAT 同时持有 ${REQUIRED_SCOPES.join(' + ')} scope, 当前缺: ${missing.join(', ')}. 请在插件 popup 重新生成 PAT 并勾上这些.`,
        },
      })
    }

    const rateCheck = checkRateLimit(row.device_id, opts.rateLimitRpm)
    if (!rateCheck.allowed) {
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action: auditAction,
        status: 'refused', errorMsg: 'rate_limited',
      })
      return res.status(429).json({
        ok: false,
        error: { code: 'rate_limited', message: 'Rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs },
      })
    }

    if (!sessions.isOnline(row.device_id)) {
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action: auditAction,
        status: 'error', errorMsg: 'device_offline',
      })
      return res.status(503).json({
        ok: false,
        error: { code: 'device_offline', message: 'Target device is not connected' },
      })
    }

    // opencli 命令内部会 goto 目标 URL, 这里只需要先拿一个空白 tab.
    // newTab: true 保证不抢用户当前 tab (见 background.ts cmdNavigate 行为约定).
    let tabId: number
    try {
      const navResult = (await sessions.send(row.device_id, 'navigate', {
        url: 'about:blank',
        newTab: true,
      })) as { tabId?: number }
      if (typeof navResult?.tabId !== 'number') {
        throw new Error('navigate 没返回 tabId')
      }
      tabId = navResult.tabId
    } catch (err) {
      const durationMs = Date.now() - start
      const isTimeout = err instanceof DeviceTimeoutError
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action: auditAction,
        status: isTimeout ? 'timeout' : 'error', durationMs, errorMsg: `tab 创建失败: ${(err as Error).message}`,
      })
      return res.status(isTimeout ? 504 : 500).json({
        ok: false,
        error: {
          code: isTimeout ? 'device_timeout' : 'tab_create_failed',
          message: `创建 tab 失败: ${(err as Error).message}`,
        },
      })
    }

    try {
      const result = await withTimeout(
        runOpencli(sessions, row.device_id, tabId, site, op, (args ?? {}) as Record<string, unknown>),
        opts.commandTimeoutMs,
      )
      const durationMs = Date.now() - start
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action: auditAction,
        status: 'ok', durationMs,
      })
      void touchToken(db, row.jti, req.ip)
      return res.json({ ok: true, tabId, result })
    } catch (err) {
      const durationMs = Date.now() - start
      const mapped = mapError(err)
      await writeAudit(db, {
        userId: row.user_id, deviceId: row.device_id, tokenJti: row.jti, action: auditAction,
        status: mapped.auditStatus, durationMs, errorMsg: (err as Error).message,
      })
      void touchToken(db, row.jti, req.ip)
      return res.status(mapped.status).json({
        ok: false,
        tabId,
        error: { code: mapped.code, message: (err as Error).message, ...(mapped.hint ? { hint: mapped.hint } : {}) },
      })
    }
  })

  return router
}

function mapError(err: unknown): {
  status: number
  code: string
  auditStatus: 'error' | 'timeout' | 'refused'
  hint?: string
} {
  if (err instanceof OpencliNotAvailableError) {
    return { status: 501, code: 'opencli_unavailable', auditStatus: 'error', hint: '部署方需要在 relay 容器里 npm install @jackwener/opencli' }
  }
  if (err instanceof OpencliCommandNotFoundError) {
    return { status: 404, code: 'command_not_found', auditStatus: 'refused', hint: '检查 site/op 拼写. opencli 的 site 用全名 (xiaohongshu 不是 xhs)' }
  }
  if (err instanceof WSPageNotImplementedError) {
    return { status: 422, code: 'not_implemented', auditStatus: 'refused', hint: '该命令依赖 CDP AX tree (click/upload/snapshot), 扩展环境不支持. 换只读类命令或让用户手动完成这一步.' }
  }
  if (err instanceof DeviceTimeoutError) {
    return { status: 504, code: 'device_timeout', auditStatus: 'timeout' }
  }
  if (err instanceof OpencliTimeoutError) {
    return { status: 504, code: 'opencli_timeout', auditStatus: 'timeout', hint: '整条命令超时. 可能页面加载慢或 limit 太大, 减小 limit 重试.' }
  }
  return { status: 500, code: 'opencli_failed', auditStatus: 'error' }
}

class OpencliTimeoutError extends Error {
  constructor(ms: number) {
    super(`opencli 命令超过 ${ms}ms 未完成`)
    this.name = 'OpencliTimeoutError'
  }
}

// 整条命令级超时. SessionStore.send 只管单次派发的超时, 一条 opencli 命令有
// 5-15 次派发 + 页面等待, 需要一个总闸.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OpencliTimeoutError(ms)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
