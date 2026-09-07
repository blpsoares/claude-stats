import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  MIN_CUSTOM_HOURS, DEFAULT_HOUR, intervalMs, isDue, scheduleStatus, SCHEDULE_IDS,
  normalizeHour, hourAnchorOnLocalDay, nextRunMs,
} from './schedule'

const DAY = 86_400_000
const now = Date.parse('2026-09-04T12:00:00.000Z')

test('a schedule that is off is never due', () => {
  expect(isDue({ schedule: 'off', lastAt: null, nowMs: now, serverRunning: true }).due).toBe(false)
})

test('a daily schedule with no previous run is due immediately', () => {
  const v = isDue({ schedule: 'daily', lastAt: null, nowMs: now, serverRunning: true })
  expect(v.due).toBe(true)
})

test('a daily schedule is not due before the interval elapses', () => {
  const v = isDue({
    schedule: 'daily', lastAt: new Date(now - DAY / 2).toISOString(), nowMs: now, serverRunning: true,
  })
  expect(v.due).toBe(false)
  if (!v.due) expect(v.reason).toBe('not-yet')
})

test('a daily schedule is due once the interval has elapsed', () => {
  const v = isDue({
    schedule: 'daily', lastAt: new Date(now - DAY - 1).toISOString(), nowMs: now, serverRunning: true,
  })
  expect(v.due).toBe(true)
})

test('weekly is seven days, not seven of anything else', () => {
  const base = { schedule: 'weekly' as const, nowMs: now, serverRunning: true }
  expect(isDue({ ...base, lastAt: new Date(now - 6 * DAY).toISOString() }).due).toBe(false)
  expect(isDue({ ...base, lastAt: new Date(now - 8 * DAY).toISOString() }).due).toBe(true)
})

test('an unparseable lastAt is treated as never run, not as now', () => {
  expect(isDue({ schedule: 'daily', lastAt: 'garbage', nowMs: now, serverRunning: true }).due).toBe(true)
})

// The rule the spec commits the UI to. Nothing here runs without the daemon, so a "next at 03:00"
// on a machine whose server is stopped is a promise the product cannot keep. Same N/A-versus-a-
// confident-0 discipline HARNESS_CAPABILITIES applies to metrics.
test('with the server stopped nothing is due and the status is `inactive`, with no next time', () => {
  const input = { schedule: 'daily' as const, lastAt: null, nowMs: now, serverRunning: false }
  expect(isDue(input).due).toBe(false)
  const s = scheduleStatus(input)
  expect(s.kind).toBe('inactive-no-server')
  expect(s.nextAtMs).toBeNull()
})

// A daily run is now ANCHORED to an hour, so the next time is that hour on the next day rather
// than one interval after whenever the last one happened to fire.
test('with the server running the status names the next anchored time', () => {
  const s = scheduleStatus({
    schedule: 'daily', atHour: 10, tzOffsetMinutes: 0,
    lastAt: new Date(now - DAY / 2).toISOString(), nowMs: now, serverRunning: true,
  })
  expect(s.kind).toBe('next')
  // last = 2026-09-04T00:00Z, so the next daily run is 2026-09-05T10:00Z.
  expect(s.nextAtMs).toBe(Date.parse('2026-09-05T10:00:00.000Z'))
})

test('an off schedule reports off, not a missing next time', () => {
  expect(scheduleStatus({ schedule: 'off', lastAt: null, nowMs: now, serverRunning: true }).kind).toBe('off')
})

// `packages/tui` may not import from `packages/server` (server -> tui is the only allowed
// direction), so `BackupScheduleId` is redeclared there. This is what stops the two drifting: a
// value added here and not there would compile fine and simply never be offered by the cockpit —
// the same guard `central-runtime.test.ts` runs for `CentralRuntimeId`.
test('the control center\'s BackupScheduleId union matches SCHEDULE_IDS, member for member', () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', '..', 'tui', 'src', 'control', 'types.ts'), 'utf8')
  const decl = source.match(/export type BackupScheduleId = ([^\n]+)/)?.[1]
  expect(decl).toBeDefined()
  const members = [...decl!.matchAll(/'([a-z-]+)'/g)].map(m => m[1]!)
  expect(members.sort()).toEqual([...SCHEDULE_IDS].sort())
})

describe('custom — an interval the user picks', () => {
  const base = { lastAt: null as string | null, nowMs: 1_000_000, serverRunning: true }

  test('custom uses customHours, and off/daily/weekly ignore it', () => {
    // In HOURS, which is the one unit that serves both ends of what people ask for: "every 6
    // hours" and "every 3 days" are the same field. Days alone cannot express the first; minutes
    // would invite a value that runs a 112 MB backup every five minutes.
    expect(intervalMs('custom', 6)).toBe(6 * 3_600_000)
    expect(intervalMs('custom', 72)).toBe(72 * 3_600_000)
    expect(intervalMs('daily', 6)).toBe(86_400_000)
    expect(intervalMs('off', 6)).toBe(null)
  })

  test('a custom interval below the floor is CLAMPED, never honoured', () => {
    // A backup here is 112 MB and its upload re-downloads the whole file to verify it. An hourly
    // one is already a lot; anything under that is a machine spending its day backing itself up.
    expect(intervalMs('custom', 0)).toBe(MIN_CUSTOM_HOURS * 3_600_000)
    expect(intervalMs('custom', -5)).toBe(MIN_CUSTOM_HOURS * 3_600_000)
    expect(intervalMs('custom', 0.25)).toBe(MIN_CUSTOM_HOURS * 3_600_000)
  })

  test('a missing or unusable customHours falls back to daily, never to "never"', () => {
    // A schedule the user switched ON must not silently become one that never fires. Falling back
    // to daily keeps the promise; falling back to `null` breaks it in the direction where nobody
    // notices until they need the backup.
    expect(intervalMs('custom', undefined)).toBe(86_400_000)
    expect(intervalMs('custom', Number.NaN)).toBe(86_400_000)
  })

  test('isDue and scheduleStatus both honour it', () => {
    const six = { ...base, schedule: 'custom' as const, customHours: 6 }
    expect(isDue({ ...six, lastAt: new Date(six.nowMs - 5 * 3_600_000).toISOString() }).due).toBe(false)
    expect(isDue({ ...six, lastAt: new Date(six.nowMs - 7 * 3_600_000).toISOString() }).due).toBe(true)
    const st = scheduleStatus({ ...six, lastAt: new Date(six.nowMs).toISOString() })
    expect(st.kind).toBe('next')
    if (st.kind !== 'next') return
    expect(st.nextAtMs).toBe(six.nowMs + 6 * 3_600_000)
  })

  test('custom is in SCHEDULE_IDS, so every surface offering the list offers it', () => {
    expect(SCHEDULE_IDS).toContain('custom')
  })
})

// --- the hour of the day ----------------------------------------------------

test('an hour outside the clock is clamped, never refused — a field is an intent', () => {
  expect(normalizeHour(undefined)).toBe(DEFAULT_HOUR)
  expect(normalizeHour(NaN)).toBe(DEFAULT_HOUR)
  expect(normalizeHour(-3)).toBe(0)
  expect(normalizeHour(99)).toBe(23)
  expect(normalizeHour(10.7)).toBe(10)
})

test('the anchor lands on the local clock, not on UTC', () => {
  // UTC-3: 10:00 local is 13:00Z.
  const at = hourAnchorOnLocalDay(Date.parse('2026-09-04T12:00:00Z'), 1, 10, 180)
  expect(new Date(at).toISOString()).toBe('2026-09-05T13:00:00.000Z')
})

// THE BUG THIS EXISTS FOR: "daily" fired every 15 minutes. It must fire once.
test('a daily run already taken today is not due again today', () => {
  const base = { schedule: 'daily' as const, atHour: 10, tzOffsetMinutes: 0, serverRunning: true }
  // Ran at 09:00, and it is now 11:00 — the anchor hour has passed, but the day already has a run.
  const v = isDue({ ...base, lastAt: '2026-09-04T09:00:00.000Z', nowMs: Date.parse('2026-09-04T11:00:00Z') })
  expect(v.due).toBe(false)
  if (v.due) return
  expect(v.reason).toBe('not-yet')
})

test('a daily run is due at the anchor hour the next day, and not before', () => {
  const base = { schedule: 'daily' as const, atHour: 10, tzOffsetMinutes: 0, serverRunning: true, lastAt: '2026-09-04T09:00:00.000Z' }
  expect(isDue({ ...base, nowMs: Date.parse('2026-09-05T09:59:00Z') }).due).toBe(false)
  expect(isDue({ ...base, nowMs: Date.parse('2026-09-05T10:00:00Z') }).due).toBe(true)
})

// The machine that was off through its hour: it comes back OWED, runs once, then waits.
test('a missed window is owed on start, and the run after it is the next anchor', () => {
  const base = { schedule: 'daily' as const, atHour: 10, tzOffsetMinutes: 0, serverRunning: true }
  const bootedLate = Date.parse('2026-09-06T14:00:00Z')
  expect(isDue({ ...base, lastAt: '2026-09-04T10:00:00.000Z', nowMs: bootedLate }).due).toBe(true)
  // Having run at 14:00, the next one is 10:00 the following day — not immediately, not a day late.
  const after = nextRunMs({ ...base, lastAt: null, nowMs: bootedLate }, bootedLate)
  expect(new Date(after!).toISOString()).toBe('2026-09-07T10:00:00.000Z')
})

test('a weekly run is anchored a week on, at the same hour', () => {
  const after = nextRunMs(
    { schedule: 'weekly', atHour: 8, tzOffsetMinutes: 0, lastAt: null, nowMs: now, serverRunning: true },
    Date.parse('2026-09-04T09:00:00Z'),
  )
  expect(new Date(after!).toISOString()).toBe('2026-09-11T08:00:00.000Z')
})

// An interval cadence has no time of day, and forcing one on it would turn it into something else.
test('a custom interval keeps interval semantics, unanchored', () => {
  const last = Date.parse('2026-09-04T09:13:00Z')
  const after = nextRunMs(
    { schedule: 'custom', customHours: 6, atHour: 10, tzOffsetMinutes: 0, lastAt: null, nowMs: now, serverRunning: true },
    last,
  )
  expect(after).toBe(last + 6 * 3_600_000)
})

test('an owed run is reported as now, never as a time already past', () => {
  const s = scheduleStatus({
    schedule: 'daily', atHour: 10, tzOffsetMinutes: 0,
    lastAt: '2026-09-01T10:00:00.000Z', nowMs: now, serverRunning: true,
  })
  expect(s.kind).toBe('next')
  if (s.kind !== 'next') return
  expect(s.nextAtMs).toBe(now)
})
