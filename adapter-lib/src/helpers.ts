import { BridgePage, type BridgePageOptions } from './bridge-page.js'

/**
 * 跑一条 opencli 命令.
 *
 * 前提: 调用方已经 import 了目标 command 文件让 opencli registry 注册,
 * 因为 opencli 用 `discovery.ts` 扫 fs 收集命令, 那个逻辑在浏览器/无
 * ~/.opencli 目录的环境下跑不了, 需要手动 import.
 *
 * 例:
 *   import '@jackwener/opencli/dist/clis/xiaohongshu/search.js'   // 副作用注册
 *   import { runOpencliCommand } from '@bluefocus/bridge-opencli-adapter'
 *
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
  // 动态 import 让 adapter-lib 不硬依赖 @jackwener/opencli (peer dep)
  // 用 @ts-ignore 因为 peer dep 可选装, tsc 不 resolve
  let registryMod: { getRegistry: () => Map<string, { func: (page: unknown, args: Record<string, unknown>) => Promise<unknown> }> }
  try {
    // @ts-ignore -- peer dep, 运行时才装
    registryMod = (await import('@jackwener/opencli/registry')) as never
  } catch (err) {
    throw new Error(
      `未找到 @jackwener/opencli, 请先在 agent 项目里 npm install: ${(err as Error).message}`,
    )
  }

  const registry = registryMod.getRegistry()
  const key = `${site}.${name}`
  const cmd = registry.get(key)
  if (!cmd) {
    throw new Error(
      `opencli command '${key}' 没找到. 请先在 agent 里 import ` +
        `'@jackwener/opencli/dist/clis/${site}/${name}.js' 触发副作用注册.`,
    )
  }

  const page = new BridgePage(opts)
  return await cmd.func(page, args)
}

/**
 * 列出当前已注册的 opencli 命令 (调用方 import 了多少个就有多少个).
 * 用于 admin/debug — agent 不建议动态发现, 该 import 什么在 agent
 * build 时就应该固定.
 */
export async function listRegisteredCommands(): Promise<string[]> {
  // @ts-ignore -- peer dep
  const registryMod = (await import('@jackwener/opencli/registry')) as never as {
    getRegistry: () => Map<string, unknown>
  }
  return Array.from(registryMod.getRegistry().keys())
}
