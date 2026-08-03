import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BridgePage, type BridgePageOptions } from './bridge-page.js'

const require = createRequire(import.meta.url)
let opencliRootCache: string | null = null

/**
 * @jackwener/opencli 的 package.json `exports` 严格限制了外部 import 路径 —
 * 只有 `.` `./registry` `./errors` `./types` 等在白名单里。`./clis/*.js`
 * 不可直接 import。绕过办法: 通过一个已 export 的 subpath (`registry`)
 * 找到 dist 位置, 上溯到包 root, 拼绝对路径用 file:// URL import。
 */
function getOpencliRoot(): string {
  if (opencliRootCache) return opencliRootCache
  const regPath = require.resolve('@jackwener/opencli/registry')
  // registry 在 dist/src/registry-api.js, 上 2 层到 opencli 根
  opencliRootCache = path.resolve(path.dirname(regPath), '..', '..')
  return opencliRootCache
}

/**
 * 触发一条 opencli 命令的副作用注册. 只需在进程生命周期内调一次.
 * Agent 端不需要提前 static import — 第一次 runOpencliCommand 会自动 load.
 */
export async function loadOpencliCommand(site: string, name: string): Promise<void> {
  const file = path.join(getOpencliRoot(), 'clis', site, `${name}.js`)
  await import(pathToFileURL(file).href)
}

interface RegistryModule {
  getRegistry: () => Map<string, { func: (page: unknown, args: Record<string, unknown>) => Promise<unknown> }>
}

/**
 * 跑一条 opencli 命令.
 *
 * - 内部用 BridgePage 让 opencli 通过 bridge relay 操控用户浏览器
 * - registry key 是 `site/name` (opencli 用 slash 分隔, 不是 dot)
 * - 第一次调用会自动 loadOpencliCommand(site, name) 副作用注册
 *
 * 例:
 *   const notes = await runOpencliCommand(
 *     'xiaohongshu', 'search',
 *     { query: 'AI眼镜', limit: 30 },
 *     { bridgeUrl, pat, tabId }
 *   )
 */
export async function runOpencliCommand(
  site: string,
  name: string,
  args: Record<string, unknown>,
  opts: BridgePageOptions,
): Promise<unknown> {
  let registryMod: RegistryModule
  try {
    // @ts-ignore -- peer dep, 运行时才装
    registryMod = (await import('@jackwener/opencli/registry')) as RegistryModule
  } catch (err) {
    throw new Error(`未找到 @jackwener/opencli, 请先 npm install: ${(err as Error).message}`)
  }

  const key = `${site}/${name}`
  let cmd = registryMod.getRegistry().get(key)
  if (!cmd) {
    // 第一次调用: 自动 load 触发副作用注册
    await loadOpencliCommand(site, name)
    cmd = registryMod.getRegistry().get(key)
    if (!cmd) {
      throw new Error(
        `opencli command '${key}' 加载后仍未注册. 检查 @jackwener/opencli/clis/${site}/${name}.js 是否存在.`,
      )
    }
  }

  const page = new BridgePage(opts)
  return await cmd.func(page, args)
}

export async function listRegisteredCommands(): Promise<string[]> {
  // @ts-ignore -- peer dep
  const registryMod = (await import('@jackwener/opencli/registry')) as RegistryModule
  return Array.from(registryMod.getRegistry().keys())
}
