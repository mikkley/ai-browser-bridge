import { describe, it, expect, beforeEach } from 'vitest'
import { checkRateLimit, resetRateLimit } from '../../src/lib/rate-limit.js'

describe('rate-limit', () => {
  beforeEach(() => resetRateLimit())

  it('allows requests under the limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit('device-a', 5).allowed).toBe(true)
    }
  })

  it('blocks the request once the limit is hit', () => {
    for (let i = 0; i < 3; i++) checkRateLimit('device-b', 3)
    const result = checkRateLimit('device-b', 3)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('rpm=0 disables rate limiting entirely', () => {
    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit('device-c', 0).allowed).toBe(true)
    }
  })

  it('tracks separate windows per key', () => {
    for (let i = 0; i < 3; i++) checkRateLimit('device-d', 3)
    expect(checkRateLimit('device-d', 3).allowed).toBe(false)
    expect(checkRateLimit('device-e', 3).allowed).toBe(true)
  })
})
