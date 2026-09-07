import { describe, it, expect } from 'bun:test'
import { isUsableDataCache } from './dataCache'

const ok = { statsCache: { dailyActivity: [] }, sessions: [], projects: [] }

describe('isUsableDataCache', () => {
  it('accepts a snapshot carrying the fields the render path dereferences', () => {
    expect(isUsableDataCache(ok)).toBe(true)
    // Extra keys are fine — this is a shape check, not a schema, and a NEWER payload read by an
    // older build must still be usable.
    expect(isUsableDataCache({ ...ok, harnesses: ['claude'], somethingNew: 1 })).toBe(true)
  })

  it('rejects the snapshot that actually bricked the app', () => {
    // Verified in the browser: this exact shape throws
    // "Cannot read properties of undefined (reading 'dailyActivity')" in computeDerivedStats,
    // and the boundary's Reload re-reads it.
    expect(isUsableDataCache({ sessions: [], projects: [] })).toBe(false)
  })

  it('rejects a statsCache that is not an object', () => {
    expect(isUsableDataCache({ ...ok, statsCache: null })).toBe(false)
    expect(isUsableDataCache({ ...ok, statsCache: [] })).toBe(false)
    expect(isUsableDataCache({ ...ok, statsCache: 'x' })).toBe(false)
  })

  it('rejects missing or non-array sessions/projects — every surface maps over them', () => {
    expect(isUsableDataCache({ statsCache: {}, projects: [] })).toBe(false)
    expect(isUsableDataCache({ statsCache: {}, sessions: [] })).toBe(false)
    expect(isUsableDataCache({ ...ok, sessions: {} })).toBe(false)
    expect(isUsableDataCache({ ...ok, projects: null })).toBe(false)
  })

  it('rejects anything that is not an object, without throwing', () => {
    for (const junk of [null, undefined, 'a string', 42, true, [], [ok]]) {
      expect(isUsableDataCache(junk)).toBe(false)
    }
  })

  it('an empty but complete snapshot is usable — empty is not the same as malformed', () => {
    // A machine with no sessions yet must still paint from cache rather than being forced through
    // the loading screen on every reopen.
    expect(isUsableDataCache({ statsCache: {}, sessions: [], projects: [] })).toBe(true)
  })
})
