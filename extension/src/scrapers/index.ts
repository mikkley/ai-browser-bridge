// scraper registry — 所有内置 platform 在这里 export
// 加新平台: 建 platformName.ts → 实现 PlatformScrapers → 在下面 register

import type { PlatformScrapers } from './types.js'
import { xhs } from './xhs.js'

export const SCRAPERS: Record<string, PlatformScrapers> = {
  xhs,
}

// scraper.list 端返回的元数据 (不返 op 函数本身)
export function listScrapers() {
  return Object.entries(SCRAPERS).map(([platform, s]) => ({
    platform,
    description: s.meta.description,
    domain: s.meta.domain,
    ops: Object.values(s.opsMeta),
  }))
}

export function getOp(platform: string, op: string) {
  return SCRAPERS[platform]?.ops[op]
}
