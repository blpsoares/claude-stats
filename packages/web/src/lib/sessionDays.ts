/**
 * sessionDays.ts — what to call each day band, relative to the reader's clock.
 *
 * The `day` dimension keys on `YYYY-MM-DD` and stops there deliberately: "today" and "yesterday"
 * are not properties of a date, they are properties of when somebody is looking. A string table
 * that resolved them would resolve them once and be wrong after midnight.
 *
 * So the naming happens here, at render time, from a `now` the caller passes in — which also makes
 * it testable without mocking a clock.
 */

import { dayKey } from '@agentistics/tui/control/session-fleet'

export interface DayWords {
  today: string
  yesterday: string
}

export const DAY_WORDS: Record<'pt' | 'en', DayWords> = {
  en: { today: 'Today', yesterday: 'Yesterday' },
  pt: { today: 'Hoje', yesterday: 'Ontem' },
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Names for today and yesterday only.
 *
 * Every other day keeps its `YYYY-MM-DD` key, which is already something a person can read and is
 * unambiguous in a way "Monday" is not once you are more than a week back. Naming a third day would
 * mean deciding where the naming stops, and every stopping point is arbitrary.
 *
 * Yesterday is computed by stepping back one day on the CALENDAR (`setDate(-1)`), not by subtracting
 * 24 hours: across a daylight-saving boundary a day is 23 or 25 hours long, and the arithmetic
 * version silently names the wrong date twice a year.
 */
export function dayLabels(lang: 'pt' | 'en', now: number): Record<string, string> {
  const w = DAY_WORDS[lang]
  const today = dayKey(now)
  const prev = new Date(now)
  prev.setDate(prev.getDate() - 1)
  const yesterday = dayKey(prev.getTime())
  const out: Record<string, string> = {}
  if (today) out[today] = w.today
  if (yesterday) out[yesterday] = w.yesterday
  return out
}

/** How many whole calendar days back a band is, for ordering. Absent for a key that is not a date. */
export function daysAgo(key: string, now: number): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return undefined
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return Math.round((start.getTime() - then) / DAY_MS)
}
