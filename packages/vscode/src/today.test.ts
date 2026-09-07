import { describe, expect, it } from 'bun:test'
import { dayKey, shortTokens, todayTotals } from './today'
import type { SessionMeta } from '@agentistics/core'

function session(start: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: start + Math.random(),
    project_path: '/w/p',
    start_time: start,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 9_000,
    cache_creation_input_tokens: 850,
    model: 'claude-sonnet-4-6',
    ...over,
  } as SessionMeta
}

const NOW = new Date('2026-09-01T12:00:00.000Z')

describe('todayTotals', () => {
  it('sums only today, by the UTC day the dashboard also uses', () => {
    const out = todayTotals([
      session('2026-09-01T02:00:00.000Z'),
      session('2026-09-01T23:30:00.000Z'),
      session('2026-08-31T23:30:00.000Z'),
    ], NOW)
    expect(out.sessions).toBe(2)
  })

  it('counts all four token counters, not the conversational pair', () => {
    // input+output alone is under 1% of the real volume: a two-term sum is off by ~300x while the
    // cost printed beside it disagrees by ~10x.
    const out = todayTotals([session('2026-09-01T02:00:00.000Z')], NOW)
    expect(out.tokens).toBe(100 + 50 + 9_000 + 850)
  })

  it('prices the cache rather than zeroing it', () => {
    const out = todayTotals([session('2026-09-01T02:00:00.000Z')], NOW)
    // Any positive figure proves the cache counters reached the pricing table; the exact rate is
    // `calcCost`'s business and is pinned by its own tests.
    expect(out.costUSD).toBeGreaterThan(0)
  })

  it('is a real zero on a day with nothing, never an absent answer', () => {
    expect(todayTotals([], NOW)).toEqual({ costUSD: 0, tokens: 0, sessions: 0 })
  })

  it('ignores a session with no start time rather than filing it under today', () => {
    expect(todayTotals([session('')], NOW).sessions).toBe(0)
  })

  it('never lets an unpriceable session subtract from the day', () => {
    // `sessionCostUSD` answers null when nothing can be priced — that is "unknown", not "free",
    // and it must not turn into a NaN that poisons the whole total.
    const out = todayTotals([
      session('2026-09-01T02:00:00.000Z', {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        model: undefined,
      }),
    ], NOW)
    expect(Number.isFinite(out.costUSD)).toBe(true)
  })
})

describe('dayKey', () => {
  it('is the UTC day', () => {
    expect(dayKey(new Date('2026-09-01T23:30:00.000Z'))).toBe('2026-09-01')
    expect(dayKey(new Date('2026-09-02T00:30:00.000Z'))).toBe('2026-09-02')
  })
})

describe('shortTokens', () => {
  it('rounds down, so nothing reads as a figure it has not reached', () => {
    expect(shortTokens(999)).toBe('999')
    expect(shortTokens(51_789)).toBe('51.7k')
    expect(shortTokens(1_299_999)).toBe('1.2M')
    expect(shortTokens(0)).toBe('0')
  })
})
