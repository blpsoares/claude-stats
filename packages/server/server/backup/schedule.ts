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

export function isDue(input: ScheduleInput): ScheduleVerdict {
  const every = intervalMs(input.schedule, input.customHours)
  if (every === null) return { due: false, reason: 'off' }
  if (!input.serverRunning) return { due: false, reason: 'no-server' }
  const last = lastMs(input.lastAt)
  if (last === null) return { due: true }
  return input.nowMs - last >= every ? { due: true } : { due: false, reason: 'not-yet' }
}

export function scheduleStatus(input: ScheduleInput): ScheduleStatus {
  const every = intervalMs(input.schedule, input.customHours)
  if (every === null) return { kind: 'off', nextAtMs: null }
  if (!input.serverRunning) return { kind: 'inactive-no-server', nextAtMs: null }
  const last = lastMs(input.lastAt)
  return { kind: 'next', nextAtMs: last === null ? input.nowMs : last + every }
}
