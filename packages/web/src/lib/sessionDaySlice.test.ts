import { describe, expect, it } from 'bun:test'
import { activeInDays, dayKey, daysBetween, sliceSession } from './sessionDaySlice'

const day = (n: number) => ({
  input_tokens: n, output_tokens: n, cache_read_input_tokens: n,
  cache_creation_input_tokens: n, messages: n,
})

/** A session open since the 3rd and still running — the shape the whole feature exists for. */
const LONG = {
  start_time: '2026-09-03T23:23:46.121Z',
  daily: {
    '2026-09-03': day(10),
    '2026-09-04': day(1000),
    '2026-09-05': day(800),
    '2026-09-06': day(450),
  },
}

describe('sliceSession', () => {
  it('THE REPORTED CASE: today gets today, not the whole session', () => {
    // Filing the lifetime total on every day it touches measured 86x too high on a real machine.
    const out = sliceSession(LONG, new Set(['2026-09-06']))!
    expect(out.input_tokens).toBe(450)
    expect(out.messages).toBe(450)
  })

  it('a multi-day range sums only the days asked for', () => {
    const out = sliceSession(LONG, new Set(['2026-09-05', '2026-09-06']))!
    expect(out.output_tokens).toBe(1250)
  })

  it('a range the session sat out is ZERO, not its lifetime', () => {
    const out = sliceSession(LONG, new Set(['2026-09-01']))!
    expect(out.input_tokens).toBe(0)
    expect(out.messages).toBe(0)
  })

  it('the days always sum back to the lifetime total', () => {
    // The property that says the split is a measurement and not an apportionment.
    const all = sliceSession(LONG, new Set(Object.keys(LONG.daily)))!
    expect(all.input_tokens).toBe(10 + 1000 + 800 + 450)
  })

  it('a session with NO daily cannot be sliced, and says so', () => {
    // `null`, never zero: a session that cannot be split is not a session that did nothing. The
    // store is full of records written before the field existed.
    expect(sliceSession({ start_time: '2026-09-06T10:00:00Z' }, new Set(['2026-09-06']))).toBeNull()
  })
})

describe('activeInDays', () => {
  it('a long session is active on every day it actually worked', () => {
    expect(activeInDays(LONG, new Set(['2026-09-06']))).toBe(true)
    expect(activeInDays(LONG, new Set(['2026-09-04']))).toBe(true)
    expect(activeInDays(LONG, new Set(['2026-09-01']))).toBe(false)
  })

  it('an unsliceable session falls back to its START day', () => {
    // The rule this product has always given, kept for exactly the records that cannot be checked.
    const plain = { start_time: '2026-09-06T10:00:00Z' }
    expect(activeInDays(plain, new Set(['2026-09-06']))).toBe(true)
    expect(activeInDays(plain, new Set(['2026-09-05']))).toBe(false)
  })

  it('a day with a zeroed entry is not activity', () => {
    // The parser only creates a day for a turn, but an older writer could leave a hollow one, and
    // counting it would place a session in a day it sat out.
    const hollow = { start_time: '2026-09-01T00:00:00Z', daily: { '2026-09-06': day(0) } }
    expect(activeInDays(hollow, new Set(['2026-09-06']))).toBe(false)
  })
})

describe('daysBetween', () => {
  it('is inclusive at both ends', () => {
    const d = daysBetween(Date.parse('2026-09-04T00:00:00Z'), Date.parse('2026-09-06T23:59:59Z'))
    expect(d).toEqual(['2026-09-04', '2026-09-05', '2026-09-06'])
  })

  it('one day is one key', () => {
    expect(daysBetween(Date.parse('2026-09-06T00:00:00Z'), Date.parse('2026-09-06T23:59:59.999Z')))
      .toEqual(['2026-09-06'])
  })

  it('is bounded, and a reversed range yields nothing', () => {
    expect(daysBetween(0, Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(400)
    expect(daysBetween(Date.parse('2026-09-06T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'))).toEqual([])
    expect(daysBetween(NaN, NaN)).toEqual([])
  })
})

describe('dayKey', () => {
  it('is the UTC slice every other day rule in this repo uses', () => {
    expect(dayKey('2026-09-06T23:59:59.999Z')).toBe('2026-09-06')
    expect(dayKey(undefined)).toBe('')
    expect(dayKey('x')).toBe('')
  })
})
