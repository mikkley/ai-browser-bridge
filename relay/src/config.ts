import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'

const CONFIG_PATH = path.join(process.cwd(), '.data', 'config.json')

interface Config {
  jwtSecret: string
  relaySecret: string
}

// 读取或初始化持久化配置
export function loadConfig(): Config {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  }

  // 首次启动：自动生成密钥，无需手动配置
  const config: Config = {
    jwtSecret: crypto.randomBytes(48).toString('hex'),
    relaySecret: crypto.randomBytes(32).toString('hex'),
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  console.log('🔐 Generated new secrets → .data/config.json')
  return config
}

// 生成 connect code：base64(JSON{ url, token })
export function makeConnectCode(relayWsUrl: string, userId: string, jwtSecret: string): string {
  const token = jwt.sign({ userId }, jwtSecret, { expiresIn: '365d' })
  const payload = JSON.stringify({ url: relayWsUrl, token })
  return 'bridge_' + Buffer.from(payload).toString('base64url')
}

// 解析 connect code → { url, token }
export function parseConnectCode(code: string): { url: string; token: string } {
  const raw = code.replace(/^bridge_/, '')
  return JSON.parse(Buffer.from(raw, 'base64url').toString())
}
