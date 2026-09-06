/**
 * sessionSpan.ts — PURE: does a session belong to a date range?
 *
 * IT WAS ITS START TIME, AND A SESSION IS NOT AN INSTANT. Reported as "no filtro de data eu queria
 * que o today realmente funcionasse, pq atualmente só consigo ver o dia anterior a hoje e eu queria
 * realmente ver o dia atual em progresso".
 *
 * Measured on this machine, and it is not a rounding error: the session that has been doing all of
 * today's work started on **2026-09-03** and is still running (`end_time` 2026-09-06T17:15). Filed
 * by its start, every hour of it counts on the 3rd. `/api/data` held 657 sessions and NOT ONE with a
 * start_time of today, while four assistants were live — so "today" was empty and the newest thing
 * on screen was yesterday. That is the whole complaint, and the timezone is a separate, smaller one.
 *
 * A session OVERLAPS a range when it started before the range ended and ended after the range
 * began. That is the only reading under which a conversation running across three days appears on
 * all three, which is what a person means by "what happened today".
 *
 * A RUNNING SESSION HAS NO END, and its absence must read as "still going" rather than as "ended at
 * its start". Treating a missing `end_time` as the start instant is what would keep today empty for
 * exactly the sessions today is about.
 *
 * IT NEVER WIDENS A RANGE THAT ASKED FOR ONE INSTANT: the comparison is against the range the
 * caller built, so a one-day filter still selects one day — it simply also selects the sessions that
 * were alive during it.
 */

/** Parse an ISO instant, or `null`. Total — a filter may not throw over a malformed timestamp. */
export function instantOf(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export interface SessionSpan {
  start_time?: string
  /** Absent on a session that is still running — see the header. */
  end_time?: string
}

/**
 * Was this session ALIVE at any point inside `[startMs, endMs]`?
 *
 * `false` when it carries no usable start: a session that cannot say when it happened cannot be
 * claimed by a date range, and guessing "now" would put every unreadable record in today.
 */
export function sessionInRange(s: SessionSpan, startMs: number, endMs: number): boolean {
  const from = instantOf(s.start_time)
  if (from === null) return false
  // A session with no end is still going, so its span reaches to the end of any range being asked
  // about. `Infinity` states that rather than picking a sentinel that a later comparison could
  // silently treat as a real instant.
  const to = instantOf(s.end_time) ?? Number.POSITIVE_INFINITY
  // The end may legitimately precede the start in a malformed record; the span is read forgivingly
  // rather than dropped, because dropping it hides real work over a field nobody looks at.
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  return lo <= endMs && hi >= startMs
}
