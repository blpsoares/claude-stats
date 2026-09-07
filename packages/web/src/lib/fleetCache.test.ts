import { describe, it, expect } from 'bun:test'
import { stripVolatile, cacheIsUsable, VOLATILE_ROW_FIELDS, FLEET_CACHE_MAX_AGE_MS } from './fleetCache'

describe('stripVolatile', () => {
  const payload = {
    rows: [{ id: 'a', title: 'T', state: 'working', lastLines: ['$ secret'], chatTurns: [{ text: 'sk-live' }] }],
    sessions: [{ id: 'a', title: 'T', approvalLines: ['1. Yes'], dialogOptions: [{ number: 1 }] }],
    attention: 1,
  }

  it('never remembers the SCREEN — that is what a session is saying right now', () => {
    // Painting yesterday's terminal under a live-looking row would be a session's own words, wrong.
    const out = stripVolatile(payload) as never as typeof payload
    for (const f of VOLATILE_ROW_FIELDS) {
      expect(JSON.stringify(out)).not.toContain(f)
    }
    expect(JSON.stringify(out)).not.toContain('sk-live')
    expect(JSON.stringify(out)).not.toContain('$ secret')
  })

  it('keeps identity and placement — what the list draws', () => {
    const out = stripVolatile(payload) as never as typeof payload
    expect(out.rows[0]!.id).toBe('a')
    expect(out.rows[0]!.title).toBe('T')
    expect(out.rows[0]!.state).toBe('working')
    expect(out.attention).toBe(1)
  })

  it('survives a payload with no rows, junk rows, or missing arrays', () => {
    expect(() => stripVolatile({} as never)).not.toThrow()
    expect(() => stripVolatile({ rows: [null, 'x', 7] } as never)).not.toThrow()
    expect(() => stripVolatile({ rows: 'not an array' } as never)).not.toThrow()
  })

  it('does not mutate the payload it was given', () => {
    const live = { rows: [{ id: 'a', lastLines: ['x'] }], sessions: [] }
    stripVolatile(live)
    expect(live.rows[0]!.lastLines).toEqual(['x'])
  })
})

describe('cacheIsUsable', () => {
  const now = 1_000_000_000

  it('paints a recent snapshot', () => {
    expect(cacheIsUsable(now - 1000, now)).toBe(true)
    expect(cacheIsUsable(now - (FLEET_CACHE_MAX_AGE_MS - 1), now)).toBe(true)
  })

  it('refuses one old enough to be a lie with a timestamp', () => {
    // A fleet from last week describes sessions that have since ended or been reopened under new
    // ids.
    expect(cacheIsUsable(now - FLEET_CACHE_MAX_AGE_MS, now)).toBe(false)
    expect(cacheIsUsable(now - 7 * 24 * 3600_000, now)).toBe(false)
  })

  it('refuses a stamp from the FUTURE rather than trusting it forever', () => {
    expect(cacheIsUsable(now + 1, now)).toBe(false)
  })

  it('refuses junk without throwing', () => {
    for (const junk of [undefined, 0, -1, NaN, Infinity, 'x' as never, null as never]) {
      expect(cacheIsUsable(junk as never, now)).toBe(false)
    }
  })
})
