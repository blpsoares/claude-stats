/**
 * schedule.ts — PURE. Whether a scheduled backup is due, and what a surface is allowed to say.
 *
 * The scheduled run rides along with the daemon `agentop server` already starts — the argument
 * `events/daemon.ts` records, applied to a second job: it is the long-lived thing that already
 * exists, is already covered by `agentop autostart`, and is never a process the user has to
 * remember to start. A backup is not itself long-lived, so a system timer would also have worked;
 * riding along wins because it is ONE mechanism on every platform, and because the server is what
 * produces the metrics — stopped, there is nothing new to save.
 *
 * That choice has a cost, and `scheduleStatus` is where the product pays it honestly: with the
 * server stopped there is no next run, and the status says `inactive-no-server` rather than
 * printing a time that will not arrive. The same N/A-versus-a-confident-0 rule
 * `HARNESS_CAPABILITIES` applies to metrics, applied to a promise.
 */

export type ScheduleId = 'off' | 'daily' | 'weekly' | 'custom'

export const SCHEDULE_IDS: ScheduleId[] = ['off', 'daily', 'weekly', 'custom']

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/**
 * The floor for a custom interval, in hours.
 *
 * A backup here is 112 MB and confirming its upload RE-DOWNLOADS the whole file to hash it. Hourly
 * is already a lot; anything under that is a machine that spends its day backing itself up. The
 * value is CLAMPED rather than refused — a number typed into a field is an intent, and rejecting
 * it outright would leave the schedule on whatever it was.
 */
export const MIN_CUSTOM_HOURS = 1

/**
 * The hour of the local day a `daily` / `weekly` run is anchored to.
 *
 * A cadence with no time of day is a cadence anchored to whenever the machine last happened to run
 * one, which drifts and lands in the middle of the working day. Mid-morning is the default because
 * the machine is on by then and the run is not competing with a login.
 */
export const DEFAULT_HOUR = 10

/** An hour outside 0–23 is not an hour. Clamped, never refused: a field is an intent. */
export function normalizeHour(h: number | undefined): number {
  if (h === undefined || !Number.isFinite(h)) return DEFAULT_HOUR
  return Math.min(23, Math.max(0, Math.trunc(h)))
}

/**
 * `hour:00:00` local, on the local day `dayOffset` days after the one holding `ms`.
 *
 * Anchoring to the DAY rather than to "the next time that hour comes round" is what makes `daily`
 * mean AT MOST ONE PER DAY. The other reading fires an hour after a manual backup taken at 09:00
 * with the anchor at 10:00 — two runs in a morning, from a setting that says "daily".
 *
 * The offset is passed in rather than read here so the module stays pure and testable: the caller
 * hands it `new Date().getTimezoneOffset()`, the same local-clock convention the harness adapters
 * use for activity hours. Sub-hour precision is deliberately dropped — a backup is not a cron job,
 * and "10am" is the whole of what anyone asked for.
 */
export function hourAnchorOnLocalDay(
  ms: number, dayOffset: number, hour: number, tzOffsetMinutes: number,
): number {
  const offset = tzOffsetMinutes * 60_000
  // Shift into a frame where plain arithmetic reads the local clock.
  const local = ms - offset
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS
  return dayStart + dayOffset * DAY_MS + normalizeHour(hour) * HOUR_MS + offset
}

/** null = never fires. A Record so a new id cannot be added without giving it an interval.
 *  `custom` is null HERE because its interval is not a constant — see `intervalMs`. */
export const SCHEDULE_MS: Record<ScheduleId, number | null> = {
  off: null,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  custom: null,
}

/**
 * How long between runs, for a schedule that may carry its own number.
 *
 * In HOURS, which is the one unit that serves both ends of what people actually ask for: "every 6
 * hours" and "every 3 days" are then the same field. Days alone cannot express the first, and
 * minutes would invite a value that runs a 112 MB backup every five of them.
 *
 * An absent or unusable `customHours` falls back to DAILY, never to "never": a schedule the user
 * deliberately switched on must not silently become one that never fires — that breaks the promise
 * in the direction where nobody notices until they need the backup.
 */
export function intervalMs(schedule: ScheduleId, customHours?: number): number | null {
  if (schedule !== 'custom') return SCHEDULE_MS[schedule]
  if (customHours === undefined || !Number.isFinite(customHours)) return DAY_MS
  return Math.max(MIN_CUSTOM_HOURS, customHours) * HOUR_MS
}

export interface ScheduleInput {
  schedule: ScheduleId
  /** Only read when `schedule` is `'custom'`. See `intervalMs`. */
  customHours?: number
  /** The local hour a daily/weekly run is anchored to. Absent reads as `DEFAULT_HOUR`.
   *  Meaningless for `custom`, which is an interval and has no time of day. */
  atHour?: number
  /** `new Date().getTimezoneOffset()` from the caller — see `hourAnchorAfter`. */
  tzOffsetMinutes?: number
  /** ISO of the last run, or null. Unparseable reads as never — a corrupt timestamp must not
   *  suppress backups forever, which is what treating it as "now" would do. */
  lastAt: string | null
  nowMs: number
  serverRunning: boolean
}

export type ScheduleVerdict =
  | { due: true }
  | { due: false; reason: 'off' | 'not-yet' | 'no-server' }

export type ScheduleStatus =
  | { kind: 'off'; nextAtMs: null }
  | { kind: 'inactive-no-server'; nextAtMs: null }
  | { kind: 'next'; nextAtMs: number }

function lastMs(lastAt: string | null): number | null {
  if (!lastAt) return null
  const t = Date.parse(lastAt)
  return Number.isFinite(t) ? t : null
}

/**
 * When the run AFTER `last` is owed.
 *
 * One rule for all three schedules, which is what makes the missed-window case fall out instead of
 * needing a branch of its own: `daily` is the anchor hour on the NEXT local day, `weekly` the
 * anchor hour a week on, and `custom` a plain interval — an "every 6 hours" cadence has no time of
 * day to anchor to, and forcing one on it would turn it into something else.
 *
 * A machine that was off through its hour comes back with the run already OWED, runs it once on
 * start, and is then due again on the next anchored day — not immediately, and not a day late.
 */
export function nextRunMs(input: ScheduleInput, last: number): number | null {
  const every = intervalMs(input.schedule, input.customHours)
  if (every === null) return null
  if (input.schedule === 'custom') return last + every
  const tz = input.tzOffsetMinutes ?? 0
  return hourAnchorOnLocalDay(last, input.schedule === 'weekly' ? 7 : 1, normalizeHour(input.atHour), tz)
}

export function isDue(input: ScheduleInput): ScheduleVerdict {
  const every = intervalMs(input.schedule, input.customHours)
  if (every === null) return { due: false, reason: 'off' }
  if (!input.serverRunning) return { due: false, reason: 'no-server' }
  const last = lastMs(input.lastAt)
  if (last === null) return { due: true }
  const next = nextRunMs(input, last)
  if (next === null) return { due: false, reason: 'off' }
  return input.nowMs >= next ? { due: true } : { due: false, reason: 'not-yet' }
}

export function scheduleStatus(input: ScheduleInput): ScheduleStatus {
  const every = intervalMs(input.schedule, input.customHours)
  if (every === null) return { kind: 'off', nextAtMs: null }
  if (!input.serverRunning) return { kind: 'inactive-no-server', nextAtMs: null }
  const last = lastMs(input.lastAt)
  if (last === null) return { kind: 'next', nextAtMs: input.nowMs }
  const next = nextRunMs(input, last)
  // An owed run is reported as NOW, not as a time in the past: the schedule says when the next one
  // happens, and "it is already owed" is answered by the next tick, seconds away.
  return { kind: 'next', nextAtMs: next === null ? input.nowMs : Math.max(next, input.nowMs) }
}
