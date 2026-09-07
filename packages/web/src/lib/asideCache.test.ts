import { describe, expect, it } from 'bun:test'
import { asideKey, createAsideCache, keyOfSession } from './asideCache'

describe('asideCache', () => {
  it('hands back what was written, and says it is fresh', () => {
    const c = createAsideCache(4, 1000)
    c.write('s1 prs', [1, 2, 3], 0)
    expect(c.read<number[]>('s1 prs', 500)).toEqual({ value: [1, 2, 3], stale: false })
  })

  it('nothing cached is not the same as a stale value', () => {
    // The panel branches on `value`, not on `stale`: with a value it draws and refreshes behind it,
    // without one it must actually wait for the read. Collapsing the two would put a spinner over
    // an answer already in hand, which is the reload being fixed.
    const c = createAsideCache(4, 1000)
    expect(c.read('s1 prs')).toEqual({ stale: true })
    expect(c.read<number[]>('s1 prs').value).toBeUndefined()
  })

  it('a value past the TTL is STALE and still returned', () => {
    const c = createAsideCache(4, 1000)
    c.write('s1 skills', ['a'], 0)
    const out = c.read<string[]>('s1 skills', 5000)
    expect(out.stale).toBe(true)
    expect(out.value).toEqual(['a'])
  })

  it('evicts the least recently READ session whole, never one of its tabs', () => {
    // Dropping one topic of a session that is still open would make that tab reload while its
    // siblings did not — the same surprise in miniature.
    const c = createAsideCache(2, 10_000)
    c.write('a prs', 1, 0)
    c.write('a skills', 2, 0)
    c.write('b prs', 3, 1)
    c.read('a prs', 5) // `a` is now the most recently used
    c.write('c prs', 4, 6) // over the cap: `b` is the oldest use

    expect(c.read('a prs', 7).value).toBe(1)
    expect(c.read('a skills', 7).value).toBe(2)
    expect(c.read('c prs', 7).value).toBe(4)
    expect(c.read('b prs', 7).value).toBeUndefined()
  })

  it('forgetSession removes every topic of that session and nothing else', () => {
    const c = createAsideCache(4, 10_000)
    c.write('s1 prs', 1, 0)
    c.write('s1 skill body', 2, 0)
    c.write('s2 prs', 3, 0)
    c.forgetSession('s1')
    expect(c.read('s1 prs').value).toBeUndefined()
    expect(c.read('s1 skill body').value).toBeUndefined()
    expect(c.read('s2 prs').value).toBe(3)
  })

  it('a session id is matched WHOLE — `abc` never claims `abcd`', () => {
    expect(keyOfSession(asideKey('abcd', 'prs'), 'abc')).toBe(false)
    expect(keyOfSession(asideKey('abc', 'prs'), 'abc')).toBe(true)
    const c = createAsideCache(4, 10_000)
    c.write(asideKey('abcd', 'prs'), 1, 0)
    c.forgetSession('abc')
    expect(c.read(asideKey('abcd', 'prs')).value).toBe(1)
  })

  it('a detail keys separately, so one skill body never answers for another', () => {
    const c = createAsideCache(4, 10_000)
    c.write(asideKey('s1', 'skill', 'deploy'), 'A', 0)
    c.write(asideKey('s1', 'skill', 'review'), 'B', 0)
    expect(c.read(asideKey('s1', 'skill', 'deploy')).value).toBe('A')
    expect(c.read(asideKey('s1', 'skill', 'review')).value).toBe('B')
  })
})
