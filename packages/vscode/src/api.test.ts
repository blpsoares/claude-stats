import { describe, expect, it } from 'bun:test'
import { isTimeout } from './api'

/**
 * `isTimeout` is what keeps a slow server from being reported as a dead one — see the `slow`
 * `LinkState` and `AgentopClient.fleet`. It has to recognise exactly what `AbortSignal.timeout()`
 * throws and nothing else, or a real connection failure (server not running, wrong port) would
 * read as "just slow" and never offer the "start it" action.
 */
describe('isTimeout', () => {
  it('recognises the DOMException AbortSignal.timeout() rejects fetch with', () => {
    const err = new DOMException('The operation timed out.', 'TimeoutError')
    expect(isTimeout(err)).toBe(true)
  })

  it('does not mistake a connection failure for a timeout', () => {
    const err = new Error('Unable to connect. Is the computer able to access the url?')
    expect(isTimeout(err)).toBe(false)
  })

  it('does not mistake an explicit user abort for a timeout', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError')
    expect(isTimeout(err)).toBe(false)
  })

  it('handles a non-Error thrown value without throwing itself', () => {
    expect(isTimeout('not an error')).toBe(false)
    expect(isTimeout(undefined)).toBe(false)
  })
})
