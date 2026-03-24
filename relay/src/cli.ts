// 用法：npx tsx src/cli.ts token <userId>
//       npx tsx src/cli.ts info

import { loadConfig, makeConnectCode } from './config.js'
import fs from 'fs'
import path from 'path'

const [,, cmd, arg] = process.argv
const config = loadConfig()

// 读取上次启动时记录的公网 URL
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

if (cmd === 'token') {
  const userId = arg
  if (!userId) {
    console.error('Usage: npm run token -- <userId>')
    process.exit(1)
  }
  const publicWsUrl = getPublicUrl()
  const code = makeConnectCode(publicWsUrl, userId, config.jwtSecret)
  console.log(`\n✅ Connect code for [${userId}]:`)
  console.log(`\n   ${code}\n`)
  console.log('让用户把这串代码粘贴到插件里即可。\n')

} else if (cmd === 'info') {
  const publicWsUrl = getPublicUrl()
  const adminCode = makeConnectCode(publicWsUrl, 'admin', config.jwtSecret)
  console.log(`\n📋 AI Browser Bridge — 当前配置`)
  console.log(`${'─'.repeat(50)}`)
  console.log(`🌐 Public WS URL:   ${publicWsUrl}`)
  console.log(`🔐 Relay secret:    ${config.relaySecret}`)
  console.log(`\n🔑 Admin connect code:`)
  console.log(`   ${adminCode}`)
  console.log(`${'─'.repeat(50)}\n`)

} else {
  console.error('Usage: npm run token -- <userId> | npm run info')
  process.exit(1)
}
