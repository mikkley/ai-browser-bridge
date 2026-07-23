// 小红书 scraper 原型 (search 一个 op 作为端到端示范, 参考 opencli xhs adapter)
//
// 小红书搜索结果页 URL 模式:
//   https://www.xiaohongshu.com/search_result?keyword=<encoded>&source=web_explore_feed
//
// 页面结构 (2026-07 观察, 会随小红书改版失效):
//   .feeds-page section.note-item     — 每个笔记卡片
//     a.cover                          — 笔记链接 (href 是 /explore/<note-id>)
//     .footer .title                   — 标题
//     .footer .author                  — 作者名
//     .footer .like-wrapper .count     — 点赞数
//
// 抓取策略: 打开搜索页 → 等 .note-item 出现 → 滚动加载到 limit → 抽字段

import type { PlatformScrapers, ScraperOp } from './types.js'
import { scraperNavigate, scraperWaitForSelector, runInTab, requireArg, optionalArg } from './utils.js'

interface XhsSearchNote {
  id: string
  title: string
  url: string
  author: string
  likes: number | null
  coverUrl: string | null
}

const xhsSearch: ScraperOp = async (ctx) => {
  try {
    const keyword = requireArg<string>(ctx.args, 'keyword', 'string')
    const limit = optionalArg<number>(ctx.args, 'limit', 'number', 20)

    const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`
    await scraperNavigate(ctx.tabId, url)

    const found = await scraperWaitForSelector(ctx.tabId, 'section.note-item', 10_000)
    if (!found.matched) {
      return { ok: false, error: '搜索结果加载超时, 可能需要登录或改版了' }
    }

    // 滚动到能覆盖 limit 个笔记 (每次滚 800px, 最多滚 15 次)
    const items = await runInTab(
      ctx.tabId,
      async (target: number) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
        for (let i = 0; i < 15; i++) {
          const cnt = document.querySelectorAll('section.note-item').length
          if (cnt >= target) break
          window.scrollBy(0, 800)
          await sleep(700)
        }

        const nodes = Array.from(document.querySelectorAll('section.note-item')).slice(0, target)
        return nodes.map((el) => {
          const a = el.querySelector<HTMLAnchorElement>('a.cover')
          const href = a?.getAttribute('href') ?? ''
          const idMatch = href.match(/\/explore\/([a-z0-9]+)/i) || href.match(/\/search_result\/([a-z0-9]+)/i)
          const title = el.querySelector('.footer .title, .title')?.textContent?.trim() ?? ''
          const author = el.querySelector('.footer .author, .author-wrapper .name')?.textContent?.trim() ?? ''
          const likesText = el.querySelector('.footer .like-wrapper .count, .like-wrapper .count')?.textContent?.trim() ?? ''
          const likes = parseLikes(likesText)
          const img = el.querySelector<HTMLImageElement>('img')
          return {
            id: idMatch?.[1] ?? '',
            title,
            url: href.startsWith('http') ? href : `https://www.xiaohongshu.com${href}`,
            author,
            likes,
            coverUrl: img?.src ?? null,
          }
        })

        function parseLikes(s: string): number | null {
          if (!s) return null
          const m = s.trim().match(/^([\d.]+)\s*(万|w|W)?$/)
          if (!m) return null
          const n = parseFloat(m[1])
          return m[2] ? Math.round(n * 10000) : Math.round(n)
        }
      },
      [limit],
    )

    return { ok: true, data: (items ?? []) as XhsSearchNote[] }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export const xhs: PlatformScrapers = {
  meta: {
    platform: 'xhs',
    description: '小红书 (Xiaohongshu)',
    domain: 'xiaohongshu.com',
  },
  ops: {
    search: xhsSearch,
  },
  opsMeta: {
    search: {
      name: 'search',
      description: '按关键词搜索笔记, 抓前 N 条基础字段 (id/title/url/author/likes)',
      args: [
        { name: 'keyword', type: 'string', required: true, description: '搜索关键词' },
        { name: 'limit', type: 'number', default: 20, description: '返回条数, 默认 20, 建议 <=50' },
      ],
    },
  },
}
