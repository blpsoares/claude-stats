import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MIN_CUSTOM_HOURS, intervalMs, isDue, scheduleStatus, SCHEDULE_IDS } from './schedule'

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

test('with the server running the status names the next time', () => {
  const s = scheduleStatus({
    schedule: 'daily', lastAt: new Date(now - DAY / 2).toISOString(), nowMs: now, serverRunning: true,
  })
  expect(s.kind).toBe('next')
  expect(s.nextAtMs).toBe(now + DAY / 2)
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
