import { describe, expect, it, test } from 'bun:test'
import { formatDay, linePoints, trendChart, trendTicks } from './trendLines'

const d = (date: string, sessions: number) => ({ date, sessions })

test('every series lands on the same axis and the same scale', () => {
  const c = trendChart({
    claude: [d('2026-01-01', 40), d('2026-01-03', 10)],
    kimi: [d('2026-01-02', 2)],
  })
  expect(c.days).toEqual(['2026-01-01', '2026-01-02', '2026-01-03'])
  expect(c.series.every(s => s.points.length === 3)).toBe(true)
  // The shared peak is Claude's 40 — kimi's 2 must not be drawn as tall as it.
  expect(c.peak).toBe(40)
})

test('a quiet day inside the span is a zero, not a gap', () => {
  const c = trendChart({ claude: [d('2026-01-01', 3), d('2026-01-03', 1)] })
  expect(c.series[0]!.points.map(p => p.sessions)).toEqual([3, 0, 1])
})

test('a harness with nothing is ABSENT — never a flat line at zero', () => {
  const c = trendChart({ claude: [d('2026-01-01', 3)], gemini: [] })
  expect(c.series.map(s => s.harness)).toEqual(['claude'])
})

test('a harness whose days all fall outside the capped window is absent too', () => {
  const old: { date: string; sessions: number }[] = []
  for (let i = 0; i < 40; i++) {
    old.push(d(new Date(Date.UTC(2026, 2, 1) + i * 86_400_000).toISOString().slice(0, 10), 1))
  }
  const c = trendChart({
    gemini: [d('2026-01-05', 9)],
    claude: old,
  }, 20)
  expect(c.days.length).toBe(20)
  expect(c.series.map(s => s.harness)).toEqual(['claude'])
})

test('nothing at all yields nothing — no invented range', () => {
  expect(trendChart({})).toEqual({ days: [], series: [], peak: 0 })
  expect(trendChart({ claude: [d('nonsense', 5)] }).series.length).toBe(0)
})

test('the legend order is by volume, ties by name', () => {
  const c = trendChart({
    kimi: [d('2026-01-01', 5)],
    codex: [d('2026-01-01', 5)],
    claude: [d('2026-01-01', 50)],
  })
  expect(c.series.map(s => s.harness)).toEqual(['claude', 'codex', 'kimi'])
})

test('a single day still draws — a flat segment, not nothing', () => {
  const c = trendChart({ claude: [d('2026-01-01', 4)] })
  const pts = linePoints(c.series[0]!, c.peak, 100, 50)
  expect(pts).toBe('0.0,0.0 100.0,0.0')
})

test('the polyline puts the peak at the top and a zero on the floor', () => {
  const c = trendChart({ claude: [d('2026-01-01', 10), d('2026-01-02', 0), d('2026-01-03', 5)] })
  expect(linePoints(c.series[0]!, c.peak, 100, 50)).toBe('0.0,0.0 50.0,50.0 100.0,25.0')
})

describe('formatDay — the reader\'s own notation, not the storage key', () => {
  it('writes a Portuguese date the Portuguese way', () => {
    expect(formatDay('2026-09-05', 'pt')).toBe('05/09/2026')
    expect(formatDay('2026-09-05', 'pt', false)).toBe('05/09')
  })

  it('writes an English one the English way', () => {
    expect(formatDay('2026-09-05', 'en')).toBe('Sep 5, 2026')
    expect(formatDay('2026-09-05', 'en', false)).toBe('Sep 5')
  })

  /**
   * `new Date('2026-09-05')` is UTC midnight, and rendering THAT in a local zone west of Greenwich
   * gives the day before. The string already names the day; there is nothing to convert.
   */
  it('never goes through Date, so a timezone cannot move the day', () => {
    expect(formatDay('2026-01-01', 'pt')).toBe('01/01/2026')
    expect(formatDay('2026-12-31', 'en', false)).toBe('Dec 31')
  })

  it('returns anything it cannot read untouched, rather than mangling it', () => {
    expect(formatDay('', 'pt')).toBe('')
    expect(formatDay('not-a-day', 'pt')).toBe('not-a-day')
    expect(formatDay('2026-9-5', 'pt')).toBe('2026-9-5')
  })
})

describe('trendTicks — a scale, where there was a caption', () => {
  const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)

  it('marks the two ends, which is what a span is read from', () => {
    expect(trendTicks(days(3))).toEqual([
      { day: '2026-09-01', at: 0 },
      { day: '2026-09-03', at: 1 },
    ])
  })

  it('adds a middle only once there is room for it', () => {
    expect(trendTicks(days(4))).toHaveLength(2)
    const five = trendTicks(days(5))
    expect(five).toHaveLength(3)
    expect(five[1]).toEqual({ day: '2026-09-03', at: 0.5 })
  })

  it('a single day is ONE tick, not the same date at both ends', () => {
    expect(trendTicks(days(1))).toEqual([{ day: '2026-09-01', at: 0.5 }])
  })

  it('never more than three, however long the window', () => {
    expect(trendTicks(days(90))).toHaveLength(3)
    // And the ends are still the real ends.
    expect(trendTicks(days(90))[0]!.day).toBe('2026-09-01')
  })

  it('says nothing about an empty window', () => {
    expect(trendTicks([])).toEqual([])
  })
})
