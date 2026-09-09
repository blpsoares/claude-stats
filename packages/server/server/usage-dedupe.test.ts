import { describe, expect, it } from 'bun:test'
import { countUsage, dedupeUsage } from './usage-dedupe'

const u = (i: number, o: number, cr = 0, cw = 0) => ({
  input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw,
})

describe('countUsage', () => {
  it('counts one API response once, however many lines carry it', () => {
    // Measured: 148 usage lines over 79 distinct ids on one real session, every repeat identical.
    const seen = new Set<string>()
    expect(countUsage('msg_1', seen)).toBe(true)
    expect(countUsage('msg_1', seen)).toBe(false)
    expect(countUsage('msg_1', seen)).toBe(false)
    expect(countUsage('msg_2', seen)).toBe(true)
  })

  it('counts a record with NO id, always', () => {
    // What cannot be shown to be a duplicate is not one — dropping it would trade an over-count
    // for an under-count, which is the worse direction for a bill.
    const seen = new Set<string>()
    expect(countUsage(undefined, seen)).toBe(true)
    expect(countUsage(undefined, seen)).toBe(true)
    expect(countUsage('', seen)).toBe(true)
    expect(countUsage(42, seen)).toBe(true)
  })
})

describe('dedupeUsage', () => {
  it('sums one response once — the defect, in miniature', () => {
    const out = dedupeUsage([
      { id: 'msg_1', usage: u(10, 5, 100, 2) },
      { id: 'msg_1', usage: u(10, 5, 100, 2) },
      { id: 'msg_1', usage: u(10, 5, 100, 2) },
      { id: 'msg_2', usage: u(1, 1, 1, 1) },
    ])
    expect(out).toEqual(u(11, 6, 101, 3))
  })

  it('takes the LAST record for an id', () => {
    // Identical in every sample measured, so this changes nothing today — and if a partial usage
    // is ever written before the final one, the last is the complete one. Taking the first would
    // under-report exactly then.
    expect(dedupeUsage([
      { id: 'msg_1', usage: u(1, 1) },
      { id: 'msg_1', usage: u(10, 10) },
    ])).toEqual(u(10, 10))
  })

  it('keeps every anonymous record', () => {
    expect(dedupeUsage([
      { usage: u(1, 1) },
      { usage: u(2, 2) },
      { id: 'msg_1', usage: u(3, 3) },
    ])).toEqual(u(6, 6))
  })

  it('ignores a line with no usage at all', () => {
    expect(dedupeUsage([{ id: 'msg_1' }, { id: 'msg_2', usage: u(1, 1) }])).toEqual(u(1, 1))
  })
})
