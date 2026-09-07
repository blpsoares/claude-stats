/**
 * The path a 300px column can read. Its own test file because `webview/main.ts` reaches for
 * `document` at import time and cannot be loaded outside a browser — the function is exported from
 * there for the panel and re-tested here through a copy of nothing: it is imported directly.
 */
import { describe, expect, it } from 'bun:test'

// Imported by path rather than from `main.ts`: that module mounts a DOM on import.
import { shortenPath } from './paths'

describe('shortenPath', () => {
  it('writes the home directory as ~', () => {
    expect(shortenPath('/home/bryan/agentistics')).toBe('~/agentistics')
    expect(shortenPath('/Users/bryan/agentistics')).toBe('~/agentistics')
  })

  it('elides the middle, keeping what identifies a directory', () => {
    // The root and the last two segments are what a person reads; the run between them is what a
    // sidebar has no room for.
    expect(shortenPath('/home/bryan/aipe-blpsoares/agentistics/.worktrees/web--jane'))
      .toBe('~/…/.worktrees/web--jane')
  })

  it('leaves a short path alone', () => {
    expect(shortenPath('/srv/app')).toBe('/srv/app')
    expect(shortenPath('/home/bryan/a/b')).toBe('~/a/b')
  })

  it('is total — junk comes back untouched', () => {
    expect(shortenPath('')).toBe('')
    expect(shortenPath('relative/thing')).toBe('relative/thing')
  })
})
