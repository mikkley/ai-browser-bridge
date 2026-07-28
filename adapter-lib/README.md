# @bluefocus/bridge-opencli-adapter

让 AI Agent 通过 [ai-browser-bridge](https://github.com/mikkley/ai-browser-bridge) 用 [OpenCLI](https://github.com/jackwener/OpenCLI) 的 177+ 网站命令操控远程用户浏览器 (小红书 / 抖音 / B站 / 微博 / 知乎 / GitHub / ...) 。

## 定位

OpenCLI 抽象了每条命令的执行契约: `(page, kwargs) => result`, 其中 `page` 是一个 `IPage` 接口 (goto / evaluate / getCookies / fetchJson / click / ...) 。默认 opencli 走 CDP / debugger, 需要用户装 opencli 官方 Chrome 扩展 + 本地 daemon。

本 lib 提供一个 **BridgePage** —— 把 `IPage` 的核心方法翻译成对 ai-browser-bridge relay 的 HTTP call。这样 AI agent 拿一个用户的 PAT (bpt_xxx) 就能跑 opencli 命令, **完全走用户已装的 bridge 扩展**, 不需要 opencli 官方扩展 / 不需要 opencli daemon 。

## 安装

在你的 AI Agent 项目里:

```bash
npm install @bluefocus/bridge-opencli-adapter @jackwener/opencli
```

## 使用

```ts
import { runOpencliCommand } from '@bluefocus/bridge-opencli-adapter'

// 副作用注册需要的 opencli 命令 (opencli 的 discovery 依赖 fs 用不了, 手动 import)
import '@jackwener/opencli/dist/clis/xiaohongshu/search.js'
import '@jackwener/opencli/dist/clis/xiaohongshu/comments.js'

// 1) 先通过 bridge 的 low-level API 打开一个 tab, 拿到 tabId
const bridgeUrl = 'https://agent.imcagent.qzz.io/bridge'
const pat = process.env.BRIDGE_PAT!   // 用户在插件 popup 生成的 bpt_xxx

const navRes = await fetch(`${bridgeUrl}/command`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'navigate', params: { url: 'about:blank', newTab: true } }),
}).then((r) => r.json())
const tabId = (navRes.result as { tabId: number }).tabId

// 2) 跑 opencli 命令 (BridgePage 内部会做 5-15 次 HTTP call 到 bridge)
const notes = await runOpencliCommand(
  'xiaohongshu',
  'search',
  { query: 'AI眼镜', limit: 30 },
  { bridgeUrl, pat, tabId },
)

console.log(notes)  // [{ rank, title, author, likes, published_at, url }, ...]
```

## API

### `BridgePage`

实现 opencli `IPage` 的子集. 直接给 opencli command 的 `func(page, args)` 用.

```ts
import { BridgePage } from '@bluefocus/bridge-opencli-adapter'

const page = new BridgePage({ bridgeUrl, pat, tabId })
await page.goto('https://www.xiaohongshu.com/search_result?keyword=xxx')
const rows = await page.evaluate(`document.querySelectorAll('.note-item').length`)
```

**支持的 IPage 方法**:

- ✅ `goto(url, opts?)` — 让当前 tab 跳转
- ✅ `evaluate(jsOrFn, ...args)` — 浏览器里 eval, 支持字符串或函数
- ✅ `evaluateWithArgs(js, args)` — 内嵌 args 安全 eval (opencli 防 injection)
- ✅ `getCookies({domain|url})` — 拿指定 domain 的 cookies
- ✅ `fetchJson(url, opts?)` — 在浏览器上下文里 fetch JSON (带 tab cookies)

**未支持**:

- ❌ `snapshot()` — 依赖 CDP AX tree, 扩展环境没 debugger 权限
- ❌ `click(ref, opts)` `dblClick` `hover` `focus` `setChecked` `uploadFiles` — 依赖 opencli 自己的 selector reference 格式 (AX tree), 抛 `BridgePageNotImplementedError`

**mitigation**: 涉及交互的命令 (click/upload/hover) 现在不支持. 对于纯读类命令 (search / list / detail / feed / *-stats 等 opencli 命令), 已经覆盖大部分.

### `runOpencliCommand(site, name, args, opts)`

Helper: 查 opencli registry 拿 command, 用 BridgePage 跑.

### `listRegisteredCommands()`

Debug: 列出当前进程 opencli registry 里已注册的命令 (你 import 了多少就有多少).

## 常见问题

**Q: opencli 命令找不到, 报 "no command registered"?**
A: opencli 的命令是通过 side-effect 副作用注册的, 需要**手动 import** 目标命令的 `.js` 文件, 例如:
```ts
import '@jackwener/opencli/dist/clis/xiaohongshu/search.js'
```
opencli 有 fs-based discovery 但在浏览器/无 `~/.opencli/` 环境下跑不了, 只能静态 import.

**Q: 一条命令跑得慢?**
A: BridgePage 每次 `page.evaluate` 都是一次 HTTP call 到 bridge. 一条 opencli 命令内部通常 5-15 次 evaluate, 累积 1-3 秒延迟. 对于采集/爬取任务, 相比"等 SPA 渲染 + 滚动加载"的原生延迟, 这部分可忽略.

**Q: 命令报 `BridgePageNotImplementedError`?**
A: 该命令用了 opencli 的高级 IPage 方法 (click / snapshot / uploadFiles), bridge 扩展环境不支持. 可选:
1. 换用只读类 opencli 命令 (grep `func:` 里只有 goto / evaluate / getCookies / fetchJson 的)
2. 让用户手动完成这一步操作后, 再用 bridge 采集结果

**Q: 用户浏览器插件必须装什么?**
A: 只装 [ai-browser-bridge 扩展](https://github.com/mikkley/ai-browser-bridge). **不要装 opencli 官方扩展** — 两者会冲突.

## License

MIT
