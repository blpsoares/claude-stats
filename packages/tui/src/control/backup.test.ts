import { test, expect } from 'bun:test'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { controlStrings } from './i18n'
import {
  backupConfigRows,
  backupDetailLines,
  backupHints,
  harnessCells,
  harnessDetailLines,
  harnessLastLabel,
  harnessLastShort,
  harnessRows,
  nextBackupSchedule,
  formatElapsed,
} from './backup'
import type { ControlBackupConfig, ControlBackupHarness } from './types'

const s = controlStrings('en')

function harness(id: HarnessId, extra: Partial<ControlBackupHarness> = {}): ControlBackupHarness {
  return { id, enabled: true, sessions: 0, sizeLabel: '0 B', ...extra }
}

// -----------------------------------------------------------------------------
// harnessRows — order and coverage
// -----------------------------------------------------------------------------

test('harnessRows orders by HARNESS_ORDER, never by the order the host handed them', () => {
  const reversed = [...HARNESS_ORDER].reverse().map(id => harness(id))
  const rows = harnessRows(reversed, Date.now(), s)
  expect(rows.map(r => r.id)).toEqual(HARNESS_ORDER)
})

test('a harness the host never reported is simply absent, not a stub row', () => {
  const some = HARNESS_ORDER.slice(0, 1).map(id => harness(id))
  const rows = harnessRows(some, Date.now(), s)
  expect(rows.length).toBe(1)
  expect(rows[0]!.id).toBe(HARNESS_ORDER[0]!)
})

test('every harness reports its own sessions and size, independent of the others', () => {
  const rows = harnessRows(
    [harness('claude', { sessions: 552, sizeLabel: '3.4 MB' }), harness('codex', { sessions: 14, sizeLabel: '60 KB' })],
    Date.now(),
    s,
  )
  const claude = rows.find(r => r.id === 'claude')!
  const codex = rows.find(r => r.id === 'codex')!
  expect(claude.sessions).toBe('552')
  expect(claude.size).toBe('3.4 MB')
  expect(codex.sessions).toBe('14')
  expect(codex.size).toBe('60 KB')
})

// -----------------------------------------------------------------------------
// harnessLastLabel — the rule this tab exists for
// -----------------------------------------------------------------------------

test('a harness that has never been backed up says so', () => {
  expect(harnessLastLabel(harness('claude'), Date.now(), s)).toBe(s.backupNever)
})

test('a recorded backup whose file is gone says so, never a reassuring date', () => {
  expect(harnessLastLabel(harness('claude', { lastBackupGone: true }), Date.now(), s)).toBe(s.backupLastGone)
})

test('a real backup on disk reports a relative age', () => {
  const now = Date.now()
  const at = new Date(now - 2 * 3_600_000).toISOString()
  const label = harnessLastLabel(harness('claude', { lastBackupAt: at }), now, s)
  expect(label).toBe(s.backupAgo(formatElapsed(2 * 3_600_000)))
})

test('the list\'s short "gone" form is a single word, never the full sentence', () => {
  const short = harnessLastShort(harness('claude', { lastBackupGone: true }), Date.now(), s)
  expect(short).toBe(s.backupLastGoneShort)
  expect(short.length).toBeLessThan(s.backupLastGone.length)
})

test('harnessRows carries both the short list cell and the full detail sentence', () => {
  const rows = harnessRows([harness('claude', { lastBackupGone: true })], Date.now(), s)
  expect(rows[0]!.last).toBe(s.backupLastGoneShort)
  expect(rows[0]!.lastFull).toBe(s.backupLastGone)
})

test('harnessDetailLines shows the selected harness\'s own facts, full sentence included', () => {
  const rows = harnessRows([harness('claude', { sessions: 552, sizeLabel: '3.4 MB', lastBackupGone: true })], Date.now(), s)
  const lines = harnessDetailLines(rows[0], s)
  expect(lines.map(l => l.value)).toEqual(['552', '3.4 MB', s.backupLastGone])
})

test('harnessDetailLines answers nothing for an undefined selection', () => {
  expect(harnessDetailLines(undefined, s)).toEqual([])
})

test('formatElapsed is two units at most, like the cockpit\'s own uptime', () => {
  expect(formatElapsed(30_000)).toBe('<1m')
  expect(formatElapsed(90_000)).toBe('1m')
  expect(formatElapsed(2 * 3_600_000 + 14 * 60_000)).toBe('2h14m')
  expect(formatElapsed(3 * 86_400_000 + 5 * 3_600_000)).toBe('3d5h')
})

// -----------------------------------------------------------------------------
// harnessCells — the ladder, narrowest first
// -----------------------------------------------------------------------------

const WIDE_ROWS = [
  { label: 'antigravity', sessions: '34', size: '140 KB', last: '2h14m ago' },
  { label: 'claude', sessions: '552', size: '3.4 MB', last: 'never' },
]

test('at a generous width every cell is drawn', () => {
  const cells = harnessCells(WIDE_ROWS, 60)
  expect(cells.label).toBeGreaterThan(0)
  expect(cells.sessions).toBeGreaterThan(0)
  expect(cells.size).toBeGreaterThan(0)
  expect(cells.last).toBeGreaterThan(0)
})

test('the last-backup cell is the first to go under width pressure', () => {
  const wide = harnessCells(WIDE_ROWS, 60)
  // Narrow it until `last` drops, and confirm the others are still standing at that width.
  let width = 60
  while (width > 0 && harnessCells(WIDE_ROWS, width).last > 0) width--
  const atDrop = harnessCells(WIDE_ROWS, width)
  expect(atDrop.last).toBe(0)
  expect(atDrop.size).toBeGreaterThan(0)
  expect(atDrop.sessions).toBeGreaterThan(0)
  expect(width).toBeLessThan(60)
  expect(wide.last).toBeGreaterThan(0)
})

test('the name never gives way to zero while any width remains', () => {
  const cells = harnessCells(WIDE_ROWS, 6)
  expect(cells.label).toBeGreaterThan(0)
})

test('an empty row list or a non-positive width fits nothing', () => {
  expect(harnessCells([], 40)).toEqual({ label: 0, sessions: 0, size: 0, last: 0 })
  expect(harnessCells(WIDE_ROWS, 0)).toEqual({ label: 0, sessions: 0, size: 0, last: 0 })
})

// -----------------------------------------------------------------------------
// backupConfigRows / backupDetailLines
// -----------------------------------------------------------------------------

function config(extra: Partial<ControlBackupConfig> = {}): ControlBackupConfig {
  return {
    layers: ['metrics', 'repos'],
    destDir: '~/backups',
    schedule: 'daily',
    scheduleActive: true,
    keep: 7,
    retainedLabel: '35 MB',
    secretsCount: 5,
    ...extra,
  }
}

test('the config rows are exactly the six facts, in the mock\'s order, and only schedule acts', () => {
  const rows = backupConfigRows(config(), Date.now(), s)
  expect(rows.map(r => r.key)).toEqual(['layers', 'dest', 'schedule', 'keep', 'secrets', 'last'])
  expect(rows.filter(r => r.action).map(r => r.key)).toEqual(['schedule'])
})

test('an inactive schedule says so instead of a next time that will not arrive', () => {
  const rows = backupConfigRows(config({ scheduleActive: false }), Date.now(), s)
  const schedule = rows.find(r => r.key === 'schedule')!
  expect(schedule.value).toContain(s.backupScheduleWord.daily)
  expect(schedule.value).toContain(s.backupScheduleInactive)
})

test('an off schedule never carries the inactive caveat — it is off on purpose, not stalled', () => {
  const rows = backupConfigRows(config({ schedule: 'off', scheduleActive: false }), Date.now(), s)
  expect(rows.find(r => r.key === 'schedule')!.value).toBe(s.backupScheduleWord.off)
})

test('with no backup on disk yet, the last row says so plainly', () => {
  const rows = backupConfigRows(config(), Date.now(), s)
  expect(rows.find(r => r.key === 'last')!.value).toBe(s.backupNoneOnDisk)
})

test('a complete backup reports its age, size and "ok"', () => {
  const now = Date.now()
  const at = new Date(now - 6 * 3_600_000).toISOString()
  const rows = backupConfigRows(config({ last: { at, bytesLabel: '4.1 MB', skipped: 0 } }), now, s)
  const last = rows.find(r => r.key === 'last')!.value
  expect(last).toContain('4.1 MB')
  expect(last).toContain(s.backupLastOk)
})

test('a backup that skipped paths says how many, and one that predates tracking says unknown', () => {
  const now = Date.now()
  const at = new Date(now - 1000).toISOString()
  const skipped = backupConfigRows(config({ last: { at, bytesLabel: '1 KB', skipped: 3 } }), now, s)
    .find(r => r.key === 'last')!.value
  expect(skipped).toContain(s.backupLastSkipped(3))

  const unknown = backupConfigRows(config({ last: { at, bytesLabel: '1 KB' } }), now, s)
    .find(r => r.key === 'last')!.value
  expect(unknown).toContain(s.backupLastUnknown)
})

test('backupDetailLines mirrors the config rows, unabbreviated, as plain rows', () => {
  const lines = backupDetailLines(config(), Date.now(), s)
  expect(lines.length).toBe(6)
  expect(lines.every(l => l.kind === 'row' && l.tone === 'plain')).toBe(true)
  expect(lines[1]!.value).toBe('~/backups')
})

// -----------------------------------------------------------------------------
// nextBackupSchedule
// -----------------------------------------------------------------------------

test('the schedule cycles off -> daily -> weekly -> off', () => {
  expect(nextBackupSchedule('off')).toBe('daily')
  expect(nextBackupSchedule('daily')).toBe('weekly')
  expect(nextBackupSchedule('weekly')).toBe('off')
})

// -----------------------------------------------------------------------------
// backupHints — no hint for a key that does nothing
// -----------------------------------------------------------------------------

test('a running task claims the footer, and only its own three keys', () => {
  const hints = backupHints('harnesses', s, { task: true })
  expect(hints).toEqual([s.keyTaskClose, s.keyScroll, s.logFollow])
})

test('the harnesses pane offers the toggle; the config pane does not', () => {
  const harnesses = backupHints('harnesses', s, { task: false })
  const cfg = backupHints('config', s, { task: false })
  expect(harnesses).toContain(s.keyBackupToggle)
  expect(cfg).not.toContain(s.keyBackupToggle)
  expect(harnesses).toContain(s.keyBackupRun)
  expect(cfg).toContain(s.keyBackupRun)
})

test('quit leads every hint list — a user must always be able to find the way out', () => {
  expect(backupHints('harnesses', s, { task: false })[0]).toBe(s.keyQuit)
  expect(backupHints('config', s, { task: false })[0]).toBe(s.keyQuit)
})
