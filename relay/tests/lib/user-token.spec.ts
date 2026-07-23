import { describe, it, expect } from 'vitest'
import { signUserToken, verifyUserToken } from '../../src/lib/user-token.js'

describe('user-token', () => {
  const secret = 'test-secret'

  it('signs and verifies a round trip', () => {
    const token = signUserToken('user-1', 'device-1', secret)
    const payload = verifyUserToken(token, secret)
    expect(payload.sub).toBe('user-1')
    expect(payload.deviceId).toBe('device-1')
    expect(payload.jti).toBeTruthy()
  })

  it('rejects a token signed with a different secret', () => {
    const token = signUserToken('user-1', 'device-1', secret)
    expect(() => verifyUserToken(token, 'wrong-secret')).toThrow()
  })

  it('rejects a malformed token', () => {
    expect(() => verifyUserToken('not-a-jwt', secret)).toThrow()
  })

  it('two tokens for the same user/device have different jti', () => {
    const a = verifyUserToken(signUserToken('u', 'd', secret), secret)
    const b = verifyUserToken(signUserToken('u', 'd', secret), secret)
    expect(a.jti).not.toBe(b.jti)
  })
})
