const windows = new Map<string, number[]>()

export function checkRateLimit(key: string, rpm: number): { allowed: boolean; retryAfterMs?: number } {
  if (rpm === 0) return { allowed: true }

  const now = Date.now()
  const windowMs = 60_000
  const timestamps = (windows.get(key) ?? []).filter((t) => now - t < windowMs)

  if (timestamps.length >= rpm) {
    const oldest = timestamps[0]!
    return { allowed: false, retryAfterMs: windowMs - (now - oldest) }
  }

  timestamps.push(now)
  windows.set(key, timestamps)
  return { allowed: true }
}

// 测试用: 清空所有限速窗口
export function resetRateLimit(): void {
  windows.clear()
}
