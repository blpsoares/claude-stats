/**
 * trendLines.ts — PURE: several harnesses' daily activity, on one set of axes.
 *
 * The strip beside the calendar answers "how did the window I am looking at move", and the calendar
 * cannot answer it per harness: a heat cell is one colour, so a day where Claude ran forty sessions
 * and Antigravity ran two looks exactly like a day where the reverse happened. A line each is the
 * cheapest thing that separates them.
 *
 * FOUR RULES, and none of them belongs in JSX:
 *
 * 1. ONE AXIS FOR EVERYONE. Every series is placed on the same day span and the same scale, or the
 *    overlay is decoration — two lines whose peaks touch the same height while meaning 40 and 2 say
 *    the opposite of the truth.
 * 2. A QUIET DAY IS A ZERO, NOT A GAP. A line that skips a day draws a segment between two dates
 *    that are not adjacent, which is a slope that never happened.
 * 3. A HARNESS WITH NOTHING IN THE WINDOW IS ABSENT — no line, no legend entry. A flat line along
 *    the axis reads as "measured, and it was zero", which is a different claim from "not here".
 * 4. THE SPAN IS THE UNION, and it is capped from the RECENT end. A harness last seen in April must
 *    not stretch the axis across five empty months to accommodate itself; if it falls outside the
 *    window it is simply absent, by rule 3.
 */

export interface TrendPoint { date: string; sessions: number }
export interface TrendSeries {
  harness: string
  /** One point per day of the shared span, oldest first. */
  points: TrendPoint[]
  /** That harness's own tallest day, for the legend. */
  peak: number
  /** Its total over the span — what the legend orders by. */
  total: number
}

export interface TrendChart {
  /** The shared day axis, oldest first. Empty when there is nothing to draw. */
  days: string[]
  series: TrendSeries[]
  /** The tallest day of ANY series — the shared vertical scale. Never 0 when `series` is non-empty. */
  peak: number
}

interface DayInput { date: string; sessions: number }

const DAY_MS = 86_400_000

function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return out
  for (let t = a; t <= b; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

/**
 * Build the chart.
 *
 * `cap` bounds the number of days for the same reason the calendar is bounded: a year is 365 marks
 * in a strip a few hundred pixels wide, which is a smear. The OLDEST are dropped — a trend beside a
 * live fleet is asked about the recent end.
 */
export function trendChart(
  byHarness: Readonly<Record<string, readonly DayInput[]>>,
  cap = 90,
): TrendChart {
  const folded = new Map<string, Map<string, number>>()
  for (const [harness, days] of Object.entries(byHarness)) {
    const m = new Map<string, number>()
    for (const d of days) {
      if (!isDay(d.date) || !(d.sessions > 0)) continue
      m.set(d.date, (m.get(d.date) ?? 0) + d.sessions)
    }
    if (m.size > 0) folded.set(harness, m)
  }
  if (folded.size === 0) return { days: [], series: [], peak: 0 }

  const all: string[] = []
  for (const m of folded.values()) all.push(...m.keys())
  all.sort()
  const first = all[0]!
  const last = all[all.length - 1]!
  let days = daysBetween(first, last)
  if (days.length > cap) days = days.slice(days.length - cap)

  const inWindow = new Set(days)
  const series: TrendSeries[] = []
  let peak = 0
  for (const [harness, m] of folded) {
    let total = 0
    let own = 0
    const points = days.map(date => {
      const n = m.get(date) ?? 0
      total += n
      if (n > own) own = n
      return { date, sessions: n }
    })
    // Rule 3, applied after the window is known: a harness whose only days fell outside it is not
    // drawn flat at zero, it is not drawn.
    if (total === 0 || ![...m.keys()].some(d => inWindow.has(d))) continue
    if (own > peak) peak = own
    series.push({ harness, points, peak: own, total })
  }
  series.sort((a, b) => b.total - a.total || a.harness.localeCompare(b.harness))
  return series.length === 0 ? { days: [], series: [], peak: 0 } : { days, series, peak }
}

/**
 * A series as an SVG polyline, in a 0..width x 0..height box.
 *
 * A single point still draws — as a one-pixel horizontal segment rather than nothing — because a
 * harness that ran on exactly one day of the window did run, and an invisible line is rule 3's
 * answer to a different question.
 */
export function linePoints(
  s: TrendSeries, peak: number, width: number, height: number,
): string {
  const n = s.points.length
  if (n === 0 || peak <= 0) return ''
  const step = n === 1 ? 0 : width / (n - 1)
  if (n === 1) {
    const y = (height - (s.points[0]!.sessions / peak) * height).toFixed(1)
    return `${(0).toFixed(1)},${y} ${width.toFixed(1)},${y}`
  }
  return s.points.map((p, i) => {
    const y = height - (p.sessions / peak) * height
    return `${(i * step).toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}
