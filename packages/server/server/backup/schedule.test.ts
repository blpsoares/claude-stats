import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isDue, scheduleStatus, SCHEDULE_IDS } from './schedule'

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
