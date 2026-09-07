import { expect, test, describe } from 'bun:test'
import { dayLabels, daysAgo } from './sessionDays'

/** A fixed local noon, so the assertions do not depend on when the suite runs. */
const NOON = new Date(2026, 8, 2, 12, 0, 0).getTime()

describe('dayLabels', () => {
  test('names today and yesterday, in both languages', () => {
    expect(dayLabels('en', NOON)['2026-09-02']).toBe('Today')
    expect(dayLabels('en', NOON)['2026-09-01']).toBe('Yesterday')
    expect(dayLabels('pt', NOON)['2026-09-02']).toBe('Hoje')
    expect(dayLabels('pt', NOON)['2026-09-01']).toBe('Ontem')
  })

  test('names nothing else — every other band keeps its readable date key', () => {
    const labels = dayLabels('en', NOON)
    expect(Object.keys(labels).sort()).toEqual(['2026-09-01', '2026-09-02'])
  })

  test('yesterday steps back on the calendar, so a month boundary is not off by one', () => {
    const firstOfMonth = new Date(2026, 8, 1, 9, 0, 0).getTime()
    expect(dayLabels('en', firstOfMonth)['2026-08-31']).toBe('Yesterday')
  })
})

describe('daysAgo', () => {
  test('counts whole calendar days back', () => {
    expect(daysAgo('2026-09-02', NOON)).toBe(0)
    expect(daysAgo('2026-09-01', NOON)).toBe(1)
    expect(daysAgo('2026-08-26', NOON)).toBe(7)
  })

  test('a future day counts negative, so it sorts ahead of today rather than to the bottom', () => {
    // A clock skew between machines really can put a session slightly in the future, and burying it
    // at the end of the list is the one place it would never be looked for.
    expect(daysAgo('2026-09-03', NOON)).toBe(-1)
  })

  test('a key that is not a date has no answer — the unfiled band, which is not a day', () => {
    expect(daysAgo('', NOON)).toBeUndefined()
    expect(daysAgo('no date recorded', NOON)).toBeUndefined()
  })
})
