// opencli 命令加载 + 执行.
//
// @jackwener/opencli 的 package.json exports 白名单不含 ./clis/*, 所以不能直接
// import '@jackwener/opencli/clis/xiaohongshu/search.js'. 绕过办法: 通过已 export
// 的 ./registry 定位 dist 位置, 上溯包 root, 拼绝对路径用 file:// URL import.
//
// registry key 是 `site/name` (slash), 不是 dot.

import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionStore } from '../lib/sessions.js'
import { WSPage } from './ws-page.js'

const require = createRequire(import.meta.url)
let opencliRootCache: string | null = null

export class OpencliNotAvailableError extends Error {
  constructor(reason: string) {
    super(`opencli 不可用: ${reason}`)
    this.name = 'OpencliNotAvailableError'
  }
}

export class OpencliCommandNotFoundError extends Error {
  constructor(readonly site: string, readonly op: string) {
    super(`opencli 命令 '${site}/${op}' 不存在. 检查 site/op 拼写, 或该网站没有这个命令.`)
    this.name = 'OpencliCommandNotFoundError'
  }
}

function getOpencliRoot(): string {
  if (opencliRootCache) return opencliRootCache
  try {
    const regPath = require.resolve('@jackwener/opencli/registry')
    // registry 在 dist/src/registry-api.js, 上 2 层到包 root
    opencliRootCache = path.resolve(path.dirname(regPath), '..', '..')
    return opencliRootCache
  } catch (err) {
    throw new OpencliNotAvailableError(`@jackwener/opencli 没装: ${(err as Error).message}`)
  }
}

interface RegistryModule {
  getRegistry: () => Map<string, { func: (page: unknown, args: Record<string, unknown>) => Promise<unknown> }>
}

async function getRegistry(): Promise<RegistryModule['getRegistry']> {
  try {
    const mod = (await import('@jackwener/opencli/registry')) as RegistryModule
    return mod.getRegistry
  } catch (err) {
    throw new OpencliNotAvailableError(`registry import 失败: ${(err as Error).message}`)
  }
}

/** 副作用注册一条命令. 幂等 (Node module cache), 重复调不会重复注册. */
async function loadCommand(site: string, op: string): Promise<void> {
  const file = path.join(getOpencliRoot(), 'clis', site, `${op}.js`)
  try {
    await import(pathToFileURL(file).href)
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('ERR_MODULE_NOT_FOUND') || msg.includes('Cannot find module')) {
      throw new OpencliCommandNotFoundError(site, op)
    }
    throw err
  }
}

/**
 * 跑一条 opencli 命令, 用 WSPage 直接走 device 的 WS 连接.
 *
 * @param tabId 目标 tab. 调用方 (端点) 先派发一次 navigate 拿到.
 */
export async function runOpencli(
  sessions: SessionStore,
  deviceId: string,
  tabId: number,
  site: string,
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const getReg = await getRegistry()
  const key = `${site}/${op}`

  let cmd = getReg().get(key)
  if (!cmd) {
    await loadCommand(site, op)
    cmd = getReg().get(key)
    if (!cmd) throw new OpencliCommandNotFoundError(site, op)
  }

  const page = new WSPage(sessions, deviceId, tabId)
  return await cmd.func(page, args)
}

/** 列出当前进程已注册的 opencli 命令 (只含被 load 过的). 调试用. */
export async function listLoadedCommands(): Promise<string[]> {
  const getReg = await getRegistry()
  return Array.from(getReg().keys())
}

/** opencli 是否可用 (装了没). 端点启动时探测一次. */
export function isOpencliAvailable(): boolean {
  try {
    getOpencliRoot()
    return true
  } catch {
    return false
  }
}
