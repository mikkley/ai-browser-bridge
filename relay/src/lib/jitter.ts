export function jitterDelay(minMs: number, maxMs: number): Promise<void> {
  if (minMs === 0 && maxMs === 0) return Promise.resolve()
  const ms = minMs + Math.random() * (maxMs - minMs)
  return new Promise((resolve) => setTimeout(resolve, ms))
}
