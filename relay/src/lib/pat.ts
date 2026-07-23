import crypto from 'crypto'

// bpt_<32字符base64url payload><4字符校验和>, 见 docs/superpowers/specs 段 5.4
const TOKEN_PREFIX = 'bpt_'
const PAYLOAD_BYTES = 24 // -> 32 base64url 字符 (24*8/6, 无 padding)
const CHECKSUM_LEN = 4

export interface GeneratedToken {
  plaintext: string
  prefix: string // 前 12 字符, 供 UI 展示 ("bpt_" + payload 前 8 位)
  hash: string   // SHA-256(plaintext), 落库
}

function checksumOf(payload: string): string {
  return crypto.createHash('sha256').update(payload).digest('base64url').slice(0, CHECKSUM_LEN)
}

export function generatePairingToken(): GeneratedToken {
  const payload = crypto.randomBytes(PAYLOAD_BYTES).toString('base64url')
  const plaintext = TOKEN_PREFIX + payload + checksumOf(payload)
  return {
    plaintext,
    prefix: TOKEN_PREFIX + payload.slice(0, 8),
    hash: hashToken(plaintext),
  }
}

export function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex')
}

// 落库前的快速格式校验 (不查库) —— 挡掉明显不是 bpt_ token 的请求
export function isValidTokenFormat(token: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) return false
  const body = token.slice(TOKEN_PREFIX.length)
  if (body.length !== PAYLOAD_BYTES / 3 * 4 + CHECKSUM_LEN) return false
  const payload = body.slice(0, body.length - CHECKSUM_LEN)
  const checksum = body.slice(body.length - CHECKSUM_LEN)
  return checksum === checksumOf(payload)
}

export const KNOWN_ACTIONS = [
  'navigate',
  'extract',
  'waitForSelector',
  'cookies',
  'tabs',
  'screenshot',
  'execute',
  'evalScript',
  'scraper.list',
  'scraper.run',
] as const
export type KnownAction = (typeof KNOWN_ACTIONS)[number]

export function isKnownAction(action: string): action is KnownAction {
  return (KNOWN_ACTIONS as readonly string[]).includes(action)
}
