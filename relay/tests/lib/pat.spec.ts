import { describe, it, expect } from 'vitest'
import { generatePairingToken, hashToken, isValidTokenFormat, isKnownAction, KNOWN_ACTIONS } from '../../src/lib/pat.js'

describe('pat', () => {
  it('generates a token with the bpt_ prefix and correct length', () => {
    const t = generatePairingToken()
    expect(t.plaintext.startsWith('bpt_')).toBe(true)
    // bpt_ (4) + payload (32) + checksum (4) = 40
    expect(t.plaintext.length).toBe(40)
  })

  it('prefix is bpt_ + first 8 chars of payload', () => {
    const t = generatePairingToken()
    const payload = t.plaintext.slice(4, 4 + 32)
    expect(t.prefix).toBe('bpt_' + payload.slice(0, 8))
  })

  it('hash is deterministic sha256 hex of the plaintext', () => {
    const t = generatePairingToken()
    expect(hashToken(t.plaintext)).toBe(t.hash)
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('two generated tokens are never equal', () => {
    const a = generatePairingToken()
    const b = generatePairingToken()
    expect(a.plaintext).not.toBe(b.plaintext)
  })

  it('accepts a freshly generated token as valid format', () => {
    const t = generatePairingToken()
    expect(isValidTokenFormat(t.plaintext)).toBe(true)
  })

  it('rejects tokens without the bpt_ prefix', () => {
    expect(isValidTokenFormat('xyz_abcdefgh')).toBe(false)
  })

  it('rejects tokens with tampered checksum', () => {
    const t = generatePairingToken()
    const tampered = t.plaintext.slice(0, -1) + (t.plaintext.at(-1) === 'A' ? 'B' : 'A')
    expect(isValidTokenFormat(tampered)).toBe(false)
  })

  it('rejects tokens with wrong length', () => {
    expect(isValidTokenFormat('bpt_tooshort')).toBe(false)
  })

  it('isKnownAction matches the KNOWN_ACTIONS list', () => {
    for (const action of KNOWN_ACTIONS) {
      expect(isKnownAction(action)).toBe(true)
    }
    expect(isKnownAction('deleteEverything')).toBe(false)
  })
})
