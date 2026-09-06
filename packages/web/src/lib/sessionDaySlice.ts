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

/**
 * The most days a range is ever enumerated into.
 *
 * `daysBetween` STOPS here rather than refusing, so a set of exactly this size may be a complete
 * range or the front of a much longer one — and the caller cannot tell them apart. That ambiguity
 * had a cost: `all` starts at the EPOCH, so the set was 1970-01-01…1971-02-04 and every session
 * carrying a per-day split was tested for membership in a window it could not possibly fall in.
 * Use `activeInWindow` whenever a range reaches this size; it asks the SESSION's own days instead
 * and needs no set at all.
 */
export const MAX_RANGE_DAYS = 400

/** Every ISO day from `start` to `end` inclusive. Bounded so a broken range cannot spin. */
export function daysBetween(startMs: number, endMs: number, max = MAX_RANGE_DAYS): string[] {
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

/** The ISO day an instant in milliseconds belongs to, UTC. `''` when it is not a real instant. */
export function dayKeyOfMs(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''
}

/** A day entry that records real work. The parser only writes one for a turn; an older writer
 *  could leave a hollow one, and counting it would put a session in a day it sat out. */
const worked = (d: DayUsage | undefined): boolean => !!d && (d.messages > 0 || d.input_tokens > 0
  || d.output_tokens > 0 || d.cache_read_input_tokens > 0 || d.cache_creation_input_tokens > 0)

/**
 * Did this session do anything between two instants? The same question as `activeInDays`, asked
 * from the other side — of the SESSION's days rather than of the range's.
 *
 * It exists because a range can be too long to enumerate (see `MAX_RANGE_DAYS`) and `all` always
 * is: it starts at the epoch. A session's own `daily` has a handful of keys whatever the range, so
 * this answers in a couple of comparisons where the set could not answer at all.
 *
 * Day keys are ISO and fixed-width, so comparing them as STRINGS is the same order as comparing
 * the dates — and it keeps the whole test on the one UTC day rule this module documents, with no
 * second parse to drift against it.
 */
export function activeInWindow(s: SliceableSession, startMs: number, endMs: number): boolean {
  const from = dayKeyOfMs(startMs)
  const to = dayKeyOfMs(endMs)
  if (from === '' || to === '' || to < from) return false
  if (!s.daily) {
    const day = dayKey(s.start_time)
    return day !== '' && day >= from && day <= to
  }
  for (const key of Object.keys(s.daily)) {
    if (key < from || key > to) continue
    if (worked(s.daily[key])) return true
  }
  return false
}

/** Did this session do anything inside `days`? `false` for a sliceable session that did nothing. */
export function activeInDays(s: SliceableSession, days: ReadonlySet<string>): boolean {
  if (!s.daily) return days.has(dayKey(s.start_time))
  for (const key of Object.keys(s.daily)) {
    if (!days.has(key)) continue
    // A day the session merely EXISTED through, with no turn on it, is not activity — see `worked`.
    if (worked(s.daily[key])) return true
  }
  return false
}
