import { test, expect } from 'bun:test'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { controlStrings } from './i18n'
import {
  BACKUP_LAYER_ORDER,
  backupConfigRows,
  backupDetailLines,
  backupHints,
  harnessCells,
  harnessDetailLines,
  harnessLastLabel,
  harnessLastShort,
  harnessRows,
  layerEditorCells,
  layerEditorRows,
  nextBackupSchedule,
  scheduleReposNote,
  toggleBackupLayer,
  formatElapsed,
} from './backup'
import type { BackupLayer, ControlBackupConfig, ControlBackupHarness } from './types'

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
    scheduleLayers: ['metrics', 'repos'],
    destDir: '~/backups',
    schedule: 'daily',
    scheduleActive: true,
    keep: 7,
    retainedLabel: '35 MB',
    secretsCount: 5,
    layerSizes: { metrics: '3.4 MB', repos: null, archive: '12 MB', raw: '953 MB' },
    ...extra,
  }
}

test('the config rows are the seven facts, in order, and layers/schedule/scheduleLayers act', () => {
  const rows = backupConfigRows(config(), Date.now(), s)
  expect(rows.map(r => r.key)).toEqual(['layers', 'dest', 'schedule', 'scheduleLayers', 'keep', 'secrets', 'last'])
  expect(rows.filter(r => r.action).map(r => r.key)).toEqual(['layers', 'schedule', 'scheduleLayers'])
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
  expect(lines.length).toBe(7)
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

test('the layers editor claims the footer with its own three keys, ahead of a task even', () => {
  const hints = backupHints('config', s, { task: false, editing: true })
  expect(hints).toEqual([s.keyLayerToggle, s.keyLayerSave, s.keyLayerCancel])
  expect(backupHints('config', s, { task: true, editing: true })).toEqual(hints)
})

// -----------------------------------------------------------------------------
// toggleBackupLayer — metrics never moves
// -----------------------------------------------------------------------------

test('toggling an absent layer adds it, toggling a present one removes it', () => {
  expect(toggleBackupLayer(['metrics'], 'repos')).toEqual(['metrics', 'repos'])
  expect(toggleBackupLayer(['metrics', 'repos'], 'repos')).toEqual(['metrics'])
})

test('metrics can never be toggled off, even if asked directly', () => {
  expect(toggleBackupLayer(['metrics'], 'metrics')).toEqual(['metrics'])
  expect(toggleBackupLayer([], 'metrics')).toEqual([])
})

// -----------------------------------------------------------------------------
// layerEditorRows — order, checked state, and the unmeasurable repos size
// -----------------------------------------------------------------------------

const SIZES: Record<BackupLayer, string | null> = { metrics: '3.4 MB', repos: null, archive: '12 MB', raw: '953 MB' }

test('layerEditorRows draws every layer in BACKUP_LAYER_ORDER, metrics leading and fixed', () => {
  const rows = layerEditorRows(['metrics'], SIZES, s)
  expect(rows.map(r => r.layer)).toEqual(BACKUP_LAYER_ORDER)
  expect(rows[0]!.layer).toBe('metrics')
  expect(rows[0]!.fixed).toBe(true)
  expect(rows[0]!.checked).toBe(true)
})

test('metrics reads checked even when the draft omits it — it is never actually optional', () => {
  const rows = layerEditorRows([], SIZES, s)
  expect(rows.find(r => r.layer === 'metrics')!.checked).toBe(true)
})

test('a layer in the draft reads checked, one absent from it does not, and neither is fixed', () => {
  const rows = layerEditorRows(['metrics', 'repos'], SIZES, s)
  expect(rows.find(r => r.layer === 'repos')!.checked).toBe(true)
  expect(rows.find(r => r.layer === 'archive')!.checked).toBe(false)
  expect(rows.find(r => r.layer === 'repos')!.fixed).toBe(false)
})

test('a measured layer shows its size; the unmeasurable repos layer shows the host\'s null as a sentence', () => {
  const rows = layerEditorRows(['metrics'], SIZES, s)
  expect(rows.find(r => r.layer === 'archive')!.sizeLabel).toBe('12 MB')
  expect(rows.find(r => r.layer === 'repos')!.sizeLabel).toBe(s.backupLayerSizeUnknown)
})

// -----------------------------------------------------------------------------
// scheduleReposNote — the one caveat the schedule editor carries and the manual one never does
// -----------------------------------------------------------------------------

test('checking repos in a draft surfaces the schedule caveat; leaving it unchecked says nothing', () => {
  expect(scheduleReposNote(['metrics', 'repos'], s)).toBe(s.backupScheduleReposNote)
  expect(scheduleReposNote(['metrics'], s)).toBeNull()
})

// -----------------------------------------------------------------------------
// layerEditorCells — size gives way before the label, and every row still fits
// -----------------------------------------------------------------------------

const EDITOR_LABELS = ['Metrics', 'Repositories', 'Mirrored transcripts', 'Conversations']
const EDITOR_SIZES = ['3.4 MB', 'known after running', '12 MB', '953 MB']

test('at a generous width both the label and the size are drawn', () => {
  const cells = layerEditorCells(EDITOR_LABELS, EDITOR_SIZES, 60)
  expect(cells.label).toBeGreaterThan(0)
  expect(cells.size).toBeGreaterThan(0)
})

test('the size cell is the first to go under width pressure, and the label never reaches zero', () => {
  let width = 60
  while (width > 0 && layerEditorCells(EDITOR_LABELS, EDITOR_SIZES, width).size > 0) width--
  const atDrop = layerEditorCells(EDITOR_LABELS, EDITOR_SIZES, width)
  expect(atDrop.size).toBe(0)
  expect(atDrop.label).toBeGreaterThan(0)
  expect(width).toBeLessThan(60)
})

test('an empty label list or a non-positive width fits nothing', () => {
  expect(layerEditorCells([], [], 40)).toEqual({ label: 0, size: 0 })
  expect(layerEditorCells(EDITOR_LABELS, EDITOR_SIZES, 0)).toEqual({ label: 0, size: 0 })
})

test('every picked cell combination stays within the available width, at every width tried', () => {
  for (let width = 0; width <= 60; width++) {
    const cells = layerEditorCells(EDITOR_LABELS, EDITOR_SIZES, width)
    const cost = cells.label + (cells.size > 0 ? cells.size + 2 : 0)
    expect(cost).toBeLessThanOrEqual(Math.max(0, width - 4))
  }
})
