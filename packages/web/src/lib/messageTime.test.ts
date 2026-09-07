import { describe, expect, it } from 'bun:test'
import { messageTime } from './messageTime'

/** A fixed "now" so every case is deterministic wherever this runs. */
const NOW = new Date('2026-09-06T15:00:00').getTime()
const at = (local: string) => new Date(local).toISOString()

describe('messageTime', () => {
  it('today is the hour alone — the WhatsApp stamp', () => {
    const out = messageTime(at('2026-09-06T14:32:00'), 'pt', NOW)!
    expect(out.label).toMatch(/^\d{2}:\d{2}$/)
    expect(out.label).toContain('32')
  })

  it('yesterday says so — the hour alone would be ambiguous', () => {
    // A session workspace renders a conversation reopened over weeks as one scroll, so a bare
    // `14:32` says nothing about WHICH 14:32.
    expect(messageTime(at('2026-09-05T14:32:00'), 'pt', NOW)!.label).toStartWith('ontem ')
    expect(messageTime(at('2026-09-05T14:32:00'), 'en', NOW)!.label).toStartWith('yesterday ')
  })

  it('within the week it is the weekday, beyond it the date', () => {
    expect(messageTime(at('2026-09-02T09:00:00'), 'en', NOW)!.label).toMatch(/^[A-Za-z]{3} \d/)
    // Eight days back: a weekday no longer locates anything.
    expect(messageTime(at('2026-08-29T09:00:00'), 'pt', NOW)!.label).toMatch(/^\d{2}\/\d{2} /)
  })

  it('the YEAR joins only once it differs', () => {
    expect(messageTime(at('2026-01-04T09:00:00'), 'pt', NOW)!.label).not.toContain('2026')
    expect(messageTime(at('2025-12-30T09:00:00'), 'pt', NOW)!.label).toContain('2025')
  })

  it('compares DAYS, not elapsed hours', () => {
    // 23:50 and 00:10 are twenty minutes apart and one day apart to a reader. An elapsed-hours rule
    // would call a message from ten minutes ago "yesterday" and one from 20 hours ago "today".
    const now = new Date('2026-09-06T00:10:00').getTime()
    expect(messageTime(at('2026-09-05T23:50:00'), 'pt', now)!.label).toStartWith('ontem ')
    expect(messageTime(at('2026-09-06T00:05:00'), 'pt', now)!.label).toMatch(/^\d{2}:\d{2}$/)
  })

  it('a message from the FUTURE keeps the plain hour rather than being labelled', () => {
    // That is a clock disagreement, not a message from tomorrow. Inventing "tomorrow" for a machine
    // a minute ahead would be worse than saying less; the `title` carries the whole instant anyway.
    expect(messageTime(at('2026-09-07T09:00:00'), 'pt', NOW)!.label).toMatch(/^\d{2}:\d{2}$/)
  })

  it('an unusable instant is ABSENT, never invented', () => {
    // The bubble then draws no stamp. "Now" would be a confident wrong answer about the one thing
    // the stamp exists to state.
    expect(messageTime(undefined, 'pt', NOW)).toBeNull()
    expect(messageTime('', 'pt', NOW)).toBeNull()
    expect(messageTime('not a date', 'pt', NOW)).toBeNull()
  })

  it('always carries the whole instant for a title', () => {
    const out = messageTime(at('2026-08-01T14:32:00'), 'pt', NOW)!
    expect(out.full).toContain('2026')
    expect(out.full.length).toBeGreaterThan(out.label.length)
  })

  it('never throws, whatever it is handed', () => {
    for (const v of ['', 'x', '2026-13-45T99:99:99Z', '0000', undefined]) {
      expect(() => messageTime(v as string | undefined, 'en', NOW)).not.toThrow()
    }
  })
})
