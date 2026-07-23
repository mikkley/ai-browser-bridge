// 用法：npx tsx src/cli.ts info

import fs from 'fs'
import path from 'path'

const [, , cmd] = process.argv

const STATE_PATH = path.join(process.cwd(), '.data', 'state.json')

function getPublicUrl(): string {
  if (fs.existsSync(STATE_PATH)) {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    if (state.publicWsUrl) return state.publicWsUrl
  }
  return process.env.PUBLIC_URL
    ? process.env.PUBLIC_URL.replace(/^https?:\/\//, 'wss://') + '/ws'
    : '(server not started yet)'
}

if (cmd === 'info') {
  const publicWsUrl = getPublicUrl()
  console.log(`\n📋 AI Browser Bridge — 当前配置`)
  console.log(`${'─'.repeat(50)}`)
  console.log(`🌐 Public WS URL:   ${publicWsUrl}`)
  console.log(`🔑 Access key:      ${process.env.BRIDGE_ACCESS_KEY ?? '(not set in this shell)'}`)
  console.log(`🗄  Database URL:    ${process.env.DATABASE_URL ?? '(not set in this shell)'}`)
  console.log(`${'─'.repeat(50)}\n`)
  console.log('用法：')
  console.log('  - 编辑 extension/src/config.ts 写入 BRIDGE_ACCESS_KEY / API_BASE_URL，重新打包')
  console.log('  - relay 启动用：BRIDGE_ACCESS_KEY=... DATABASE_URL=... npm start\n')
} else {
  console.error('Usage: npm run info')
  process.exit(1)
}
