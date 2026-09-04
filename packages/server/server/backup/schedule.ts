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

export type ScheduleId = 'off' | 'daily' | 'weekly'

export const SCHEDULE_IDS: ScheduleId[] = ['off', 'daily', 'weekly']

const DAY_MS = 86_400_000

/** null = never fires. A Record so a new id cannot be added without giving it an interval. */
export const SCHEDULE_MS: Record<ScheduleId, number | null> = {
  off: null,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
}

export interface ScheduleInput {
  schedule: ScheduleId
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
  const every = SCHEDULE_MS[input.schedule]
  if (every === null) return { due: false, reason: 'off' }
  if (!input.serverRunning) return { due: false, reason: 'no-server' }
  const last = lastMs(input.lastAt)
  if (last === null) return { due: true }
  return input.nowMs - last >= every ? { due: true } : { due: false, reason: 'not-yet' }
}

export function scheduleStatus(input: ScheduleInput): ScheduleStatus {
  const every = SCHEDULE_MS[input.schedule]
  if (every === null) return { kind: 'off', nextAtMs: null }
  if (!input.serverRunning) return { kind: 'inactive-no-server', nextAtMs: null }
  const last = lastMs(input.lastAt)
  return { kind: 'next', nextAtMs: last === null ? input.nowMs : last + every }
}
