import { describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import { SessionStore, DeviceOfflineError, DeviceTimeoutError } from '../../src/lib/sessions.js'

function fakeWs(readyState: number = WebSocket.OPEN) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket
}

describe('SessionStore', () => {
  it('an authenticated online device is reported online', () => {
    const store = new SessionStore()
    store.set('dev-1', fakeWs(), true)
    expect(store.isOnline('dev-1')).toBe(true)
  })

  it('an anonymous connection is NOT reported online (cannot receive commands)', () => {
    const store = new SessionStore()
    store.set('dev-1', fakeWs(), false)
    expect(store.isOnline('dev-1')).toBe(false)
  })

  it('a closed ws is not reported online even if authenticated', () => {
    const store = new SessionStore()
    store.set('dev-1', fakeWs(WebSocket.CLOSED), true)
    expect(store.isOnline('dev-1')).toBe(false)
  })

  it('single-connection policy: new connection replaces and returns the old ws', () => {
    const store = new SessionStore()
    const old = fakeWs()
    const fresh = fakeWs()
    store.set('dev-1', old, true)
    const replaced = store.set('dev-1', fresh, true)
    expect(replaced).toBe(old)
    expect(store.isOnline('dev-1')).toBe(true)
  })

  it('delete only removes if the ws reference still matches (avoids racing close events)', () => {
    const store = new SessionStore()
    const old = fakeWs()
    const fresh = fakeWs()
    store.set('dev-1', old, true)
    store.set('dev-1', fresh, true) // fresh replaces old
    store.delete('dev-1', old) // stale close event for old ws — should be a no-op
    expect(store.isOnline('dev-1')).toBe(true)
    store.delete('dev-1', fresh)
    expect(store.isOnline('dev-1')).toBe(false)
  })

  it('send() rejects with DeviceOfflineError when device is not authenticated-online', async () => {
    const store = new SessionStore()
    await expect(store.send('missing-device', 'extract', {})).rejects.toBeInstanceOf(DeviceOfflineError)
  })

  it('send() resolves when the ws replies with ok:true', async () => {
    const store = new SessionStore()
    const ws = fakeWs()
    store.set('dev-1', ws, true)

    const promise = store.send('dev-1', 'extract', { type: 'text' })
    const sentRaw = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    const sent = JSON.parse(sentRaw)
    expect(sent.action).toBe('extract')

    store.handleMessage(JSON.stringify({ id: sent.id, ok: true, data: 'hello' }))
    await expect(promise).resolves.toBe('hello')
  })

  it('send() rejects when the ws replies with ok:false', async () => {
    const store = new SessionStore()
    const ws = fakeWs()
    store.set('dev-1', ws, true)

    const promise = store.send('dev-1', 'extract', {})
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)
    store.handleMessage(JSON.stringify({ id: sent.id, ok: false, error: 'boom' }))
    await expect(promise).rejects.toThrow('boom')
  })

  it('send() times out with DeviceTimeoutError if no reply arrives', async () => {
    const store = new SessionStore(10) // 10ms timeout for the test
    store.set('dev-1', fakeWs(), true)
    await expect(store.send('dev-1', 'extract', {})).rejects.toBeInstanceOf(DeviceTimeoutError)
  })

  it('handleMessage ignores malformed JSON without throwing', () => {
    const store = new SessionStore()
    expect(() => store.handleMessage('not json')).not.toThrow()
  })
})
