import { describe, expect, it } from 'bun:test'
import { instantOf, sessionInRange } from './sessionSpan'

const at = (iso: string) => Date.parse(iso)
const DAY_START = at('2026-09-06T00:00:00.000Z')
const DAY_END = at('2026-09-06T23:59:59.999Z')

describe('sessionInRange', () => {
  it('THE REPORTED CASE: a session that started days ago and is still running is in today', () => {
    // Measured: the session doing all of today's work started 2026-09-03 and had not ended. Filed by
    // its start it counted on the 3rd, and "today" was empty while four assistants were live.
    expect(sessionInRange({ start_time: '2026-09-03T23:23:46.121Z' }, DAY_START, DAY_END)).toBe(true)
  })

  it('a session that started days ago and ENDED today is in today', () => {
    expect(sessionInRange(
      { start_time: '2026-09-03T23:23:46.121Z', end_time: '2026-09-06T17:15:41.445Z' },
      DAY_START, DAY_END,
    )).toBe(true)
  })

  it('a session entirely before the range is out, and so is one entirely after', () => {
    // It still selects one day. Overlap widens WHICH sessions are claimed, never the range.
    expect(sessionInRange(
      { start_time: '2026-09-04T10:00:00Z', end_time: '2026-09-05T10:00:00Z' },
      DAY_START, DAY_END,
    )).toBe(false)
    expect(sessionInRange({ start_time: '2026-09-07T10:00:00Z' }, DAY_START, DAY_END)).toBe(false)
  })

  it('touching either edge counts — a range is inclusive at both ends', () => {
    expect(sessionInRange({ start_time: '2026-09-06T23:59:59.999Z' }, DAY_START, DAY_END)).toBe(true)
    expect(sessionInRange(
      { start_time: '2026-09-01T00:00:00Z', end_time: '2026-09-06T00:00:00.000Z' },
      DAY_START, DAY_END,
    )).toBe(true)
  })

  it('a RUNNING session has no end, and that must read as "still going"', () => {
    // Treating a missing end as the start instant is what kept today empty for exactly the sessions
    // today is about.
    expect(sessionInRange({ start_time: '2026-01-01T00:00:00Z' }, DAY_START, DAY_END)).toBe(true)
    expect(sessionInRange({ start_time: '2026-01-01T00:00:00Z', end_time: '' }, DAY_START, DAY_END)).toBe(true)
  })

  it('a session that cannot say WHEN is claimed by no range', () => {
    // Guessing "now" would put every unreadable record in today.
    expect(sessionInRange({}, DAY_START, DAY_END)).toBe(false)
    expect(sessionInRange({ start_time: 'not a date' }, DAY_START, DAY_END)).toBe(false)
    expect(sessionInRange({ start_time: '' }, DAY_START, DAY_END)).toBe(false)
  })

  it('an end BEFORE the start is read forgivingly, never dropped', () => {
    // A malformed field nobody looks at must not hide real work.
    expect(sessionInRange(
      { start_time: '2026-09-06T10:00:00Z', end_time: '2026-09-05T10:00:00Z' },
      DAY_START, DAY_END,
    )).toBe(true)
  })

  it('instantOf is total', () => {
    expect(instantOf('2026-09-06T00:00:00Z')).toBe(DAY_START)
    for (const v of [undefined, '', 'x', '0000-99-99']) expect(instantOf(v)).toBeNull()
  })
})
