import { expect, test } from 'bun:test'
import { linePoints, trendChart } from './trendLines'

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
