import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const CONFIG_PATH = path.join(process.cwd(), '.data', 'config.json')

interface Config {
  jwtSecret: string // 签 userToken 用, BRIDGE_JWT_SECRET 环境变量的本地兜底
}

// 读取或初始化持久化配置 (仅在没有设置 BRIDGE_JWT_SECRET 时用到)
function loadConfig(): Config {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config
  }
  const config: Config = { jwtSecret: crypto.randomBytes(48).toString('hex') }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  console.log('🔐 Generated fallback BRIDGE_JWT_SECRET → .data/config.json')
  return config
}

// 生产部署应显式设置 BRIDGE_JWT_SECRET env; 本地开发没设时自动生成并持久化
export function resolveJwtSecret(): string {
  return process.env.BRIDGE_JWT_SECRET || loadConfig().jwtSecret
}
