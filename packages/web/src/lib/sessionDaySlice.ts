/**
 * sessionDaySlice.ts — PURE: what a session did INSIDE a date range.
 *
 * A session is a SPAN and its four counters are LIFETIME totals, so a date filter could only ever
 * file the whole of it somewhere. Both available answers are wrong and neither is a rounding error:
 *
 *   - on the day it STARTED — "today" is nearly empty for anyone whose session has been open since
 *     Tuesday, which is the normal way this product is used;
 *   - on every day it TOUCHES — measured at **86x** on a real machine, because seven sessions that
 *     merely reached into today brought 4.446.955.424 tokens with them against a true 51.465.608.
 *
 * `SessionMeta.daily` is the third answer, and it is a measurement rather than a rule: the parser
 * already walks every turn and every turn carries its own timestamp, so the split is real. This
 * module spends it.
 *
 * A SESSION WITHOUT `daily` KEEPS THE OLD RULE. The store is full of records written before that
 * field existed, and several harnesses' adapters do not produce it. Falling back to the whole
 * session for those would reintroduce the 86x on exactly the sessions that cannot be checked, so
 * they fall back to being filed on their start day — the answer this product has always given.
 *
 * The day key is `slice(0, 10)` on an ISO instant, UTC, matching `tagSessionDay`,
 * `stats-cache.json`'s own day series and the parser that wrote the field. Two day rules exist in
 * this repo and mixing them drifts a session across a boundary.
 */

export interface DayUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  messages: number
}

/** The subset of a session this module reads. Structural, so `SessionMeta` stays the source. */
export interface SliceableSession {
  start_time?: string
  daily?: Record<string, DayUsage>
}

export const EMPTY_DAY: DayUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  messages: 0,
}

/** The ISO day an instant belongs to, or `''`. The one place this rule is written for the web. */
export function dayKey(iso: string | undefined): string {
  return iso && iso.length >= 10 ? iso.slice(0, 10) : ''
}

/** Every ISO day from `start` to `end` inclusive. Bounded so a broken range cannot spin. */
export function daysBetween(startMs: number, endMs: number, max = 400): string[] {
  const out: string[] = []
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return out
  const DAY = 86_400_000
  // Anchored to UTC midnight so the count of days does not depend on where the browser sits.
  let t = Math.floor(startMs / DAY) * DAY
  for (let i = 0; i < max && t <= endMs; i++, t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/**
 * What this session did within `days`, or `null` when it cannot be sliced.
 *
 * `null` is the honest answer for a record with no `daily`, and the caller must then apply the
 * start-day rule rather than assuming zero — a session that cannot be split is not a session that
 * did nothing.
 */
export function sliceSession(s: SliceableSession, days: ReadonlySet<string>): DayUsage | null {
  const daily = s.daily
  if (!daily) return null
  const out: DayUsage = { ...EMPTY_DAY }
  for (const key of Object.keys(daily)) {
    if (!days.has(key)) continue
    const d = daily[key]
    if (!d) continue
    out.input_tokens += d.input_tokens || 0
    out.output_tokens += d.output_tokens || 0
    out.cache_read_input_tokens += d.cache_read_input_tokens || 0
    out.cache_creation_input_tokens += d.cache_creation_input_tokens || 0
    out.messages += d.messages || 0
  }
  return out
}

/** Did this session do anything inside `days`? `false` for a sliceable session that did nothing. */
export function activeInDays(s: SliceableSession, days: ReadonlySet<string>): boolean {
  if (!s.daily) return days.has(dayKey(s.start_time))
  for (const key of Object.keys(s.daily)) {
    if (!days.has(key)) continue
    const d = s.daily[key]
    // A day the session merely EXISTED through, with no turn on it, is not activity. The parser
    // only ever creates a day entry for a turn, so any entry here is real work — but a zeroed one
    // could arrive from an older writer, and counting it would put a session in a day it sat out.
    if (d && (d.messages > 0 || d.input_tokens > 0 || d.output_tokens > 0
      || d.cache_read_input_tokens > 0 || d.cache_creation_input_tokens > 0)) return true
  }
  return false
}
