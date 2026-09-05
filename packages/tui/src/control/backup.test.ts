import { test, expect } from 'bun:test'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { controlStrings } from './i18n'
import {
  BACKUP_LAYER_ORDER,
  GITHUB_RELEASE_LIMIT_BYTES,
  backupConfigRows,
  backupDetailLines,
  backupHints,
  githubFitLabel,
  githubFitVerdict,
  harnessCells,
  harnessDetailLines,
  harnessLastLabel,
  harnessLastShort,
  harnessRows,
  historyCells,
  historyRows,
  layerEditorCells,
  layerEditorRows,
  nextBackupSchedule,
  paginateHistory,
  scheduleReposNote,
  toggleBackupLayer,
  formatElapsed,
  githubRows,
  expandDetailText,
  type GithubRow,
  type GithubSection,
} from './backup'
import type { BackupLayer, ControlBackupConfig, ControlBackupHarness, ControlBackupHistoryEntry } from './types'

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
    layerBytes: { metrics: 3_400_000, repos: null, archive: 12_000_000, raw: 953_000_000 },
    ...extra,
  }
}

test('the config rows are the nine facts, in order, and layers/schedule/scheduleLayers/history act', () => {
  const rows = backupConfigRows(config(), Date.now(), s, 4)
  expect(rows.map(r => r.key)).toEqual(
    ['layers', 'dest', 'github', 'schedule', 'scheduleLayers', 'keep', 'secrets', 'last', 'history'],
  )
  expect(rows.filter(r => r.action).map(r => r.key)).toEqual(['layers', 'schedule', 'scheduleLayers', 'history'])
})

test('the history row states the count the host reported, never re-derived', () => {
  const rows = backupConfigRows(config(), Date.now(), s, 12)
  expect(rows.find(r => r.key === 'history')!.value).toBe(s.backupHistoryCount(12))
})

test('an inactive schedule says so instead of a next time that will not arrive', () => {
  const rows = backupConfigRows(config({ scheduleActive: false }), Date.now(), s, 0)
  const schedule = rows.find(r => r.key === 'schedule')!
  expect(schedule.value).toContain(s.backupScheduleWord.daily)
  expect(schedule.value).toContain(s.backupScheduleInactive)
})

test('an off schedule never carries the inactive caveat — it is off on purpose, not stalled', () => {
  const rows = backupConfigRows(config({ schedule: 'off', scheduleActive: false }), Date.now(), s, 0)
  expect(rows.find(r => r.key === 'schedule')!.value).toBe(s.backupScheduleWord.off)
})

test('with no backup on disk yet, the last row says so plainly', () => {
  const rows = backupConfigRows(config(), Date.now(), s, 0)
  expect(rows.find(r => r.key === 'last')!.value).toBe(s.backupNoneOnDisk)
})

test('a complete backup reports its age, size and "ok"', () => {
  const now = Date.now()
  const at = new Date(now - 6 * 3_600_000).toISOString()
  const rows = backupConfigRows(config({ last: { at, bytesLabel: '4.1 MB', skipped: 0 } }), now, s, 0)
  const last = rows.find(r => r.key === 'last')!.value
  expect(last).toContain('4.1 MB')
  expect(last).toContain(s.backupLastOk)
})

test('a backup that skipped paths says how many, and one that predates tracking says unknown', () => {
  const now = Date.now()
  const at = new Date(now - 1000).toISOString()
  const skipped = backupConfigRows(config({ last: { at, bytesLabel: '1 KB', skipped: 3 } }), now, s, 0)
    .find(r => r.key === 'last')!.value
  expect(skipped).toContain(s.backupLastSkipped(3))

  const unknown = backupConfigRows(config({ last: { at, bytesLabel: '1 KB' } }), now, s, 0)
    .find(r => r.key === 'last')!.value
  expect(unknown).toContain(s.backupLastUnknown)
})

test('backupDetailLines mirrors the config rows, unabbreviated, as plain rows', () => {
  const lines = backupDetailLines(config(), Date.now(), s, 4)
  // The eight config facts, minus the github summary the block below supersedes, then the block.
  const facts = lines.slice(0, 7)
  expect(facts.every(l => l.kind === 'row' && l.tone === 'plain')).toBe(true)
  expect(facts.map(l => l.label)).not.toContain(s.backupGithubLabel)
  expect(facts[1]!.value).toBe('~/backups')
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
// layerEditorRows — every row carries its own legend, so a checked box is never unexplained
// -----------------------------------------------------------------------------

test('every layer states what it actually saves, in the vocabulary CLAUDE.md pins', () => {
  const rows = layerEditorRows(['metrics', 'repos', 'archive', 'raw'], SIZES, s, 'full')
  for (const layer of BACKUP_LAYER_ORDER) {
    expect(rows.find(r => r.layer === layer)!.description).toBe(s.backupLayerDescription[layer])
  }
})

test('metrics ALWAYS carries the "cannot resume" caveat — the one fact its name does not carry', () => {
  const rows = layerEditorRows(['metrics'], SIZES, s, 'full')
  expect(rows.find(r => r.layer === 'metrics')!.caveat).toBe(s.backupMetricsNoResume)
})

test('archive carries no caveat in full mode — it is actually growing', () => {
  const rows = layerEditorRows(['metrics', 'archive'], SIZES, s, 'full')
  expect(rows.find(r => r.layer === 'archive')!.caveat).toBeNull()
})

test('archive names the machine\'s own mode when it is not full, so a frozen layer never looks live', () => {
  const consolidate = layerEditorRows(['metrics', 'archive'], SIZES, s, 'consolidate')
  expect(consolidate.find(r => r.layer === 'archive')!.caveat).toBe(s.backupArchiveFrozen('consolidate'))

  // Never chosen at all reads the same as anything other than full — never a confident "it's fine".
  const unset = layerEditorRows(['metrics', 'archive'], SIZES, s, undefined)
  expect(unset.find(r => r.layer === 'archive')!.caveat).toBe(s.backupArchiveFrozen(s.archiveUnset))
})

test('repos and raw carry no caveat, whatever the archive mode is', () => {
  const rows = layerEditorRows(['metrics', 'repos', 'raw'], SIZES, s, 'off')
  expect(rows.find(r => r.layer === 'repos')!.caveat).toBeNull()
  expect(rows.find(r => r.layer === 'raw')!.caveat).toBeNull()
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

// -----------------------------------------------------------------------------
// githubFitVerdict / githubFitLabel — NOT the upload feature, just the honest indicator
// -----------------------------------------------------------------------------

const BYTES = (over: Partial<Record<BackupLayer, number | null>> = {}): Record<BackupLayer, number | null> => ({
  metrics: 0, repos: null, archive: 0, raw: 0, ...over,
})

test('well under the cap fits, for certain — compression only shrinks further', () => {
  expect(githubFitVerdict(['metrics'], BYTES({ metrics: 1_000_000 }))).toBe('fits')
})

test('at or over the cap is an honest "maybe-not", never a confident no', () => {
  expect(githubFitVerdict(['raw'], BYTES({ raw: GITHUB_RELEASE_LIMIT_BYTES }))).toBe('maybe-not')
  expect(githubFitVerdict(['raw'], BYTES({ raw: GITHUB_RELEASE_LIMIT_BYTES - 1 }))).toBe('fits')
})

test('only the TICKED layers are summed — an unticked heavy layer never counts against it', () => {
  expect(githubFitVerdict(['metrics'], BYTES({ metrics: 100, raw: GITHUB_RELEASE_LIMIT_BYTES * 5 }))).toBe('fits')
})

test('an unmeasurable layer (repos, before a run) contributes nothing to the sum', () => {
  expect(githubFitVerdict(['metrics', 'repos'], BYTES({ metrics: 100 }))).toBe('fits')
})

test('the label names the right sentence for each verdict', () => {
  expect(githubFitLabel('fits', s)).toBe(s.backupGithubFits)
  expect(githubFitLabel('maybe-not', s)).toBe(s.backupGithubMayNotFit)
})

// -----------------------------------------------------------------------------
// historyRows / paginateHistory — the fix for "a giant list that looks full of errors"
// -----------------------------------------------------------------------------

function historyEntry(over: Partial<ControlBackupHistoryEntry> & { at: string }): ControlBackupHistoryEntry {
  return {
    layers: ['metrics'], harnesses: ['claude'], bytesLabel: '4.1 MB', presence: 'present',
    ...over,
  }
}

test('the three presence states are rendered as three different sentences, computed by the host', () => {
  const rows = historyRows([
    historyEntry({ at: '2026-09-01T00:00:00Z', presence: 'present' }),
    historyEntry({ at: '2026-09-02T00:00:00Z', presence: 'pruned' }),
    historyEntry({ at: '2026-09-03T00:00:00Z', presence: 'missing' }),
  ], s)
  expect(rows.map(r => r.status)).toEqual([s.backupHistoryPresent, s.backupHistoryPruned, s.backupHistoryMissing])
})

test('historyRows never reorders — the host already sorted newest first', () => {
  const rows = historyRows([
    historyEntry({ at: '2026-09-01T00:00:00Z' }),
    historyEntry({ at: '2026-09-03T00:00:00Z' }),
  ], s)
  expect(rows.map(r => r.at)).toEqual([new Date('2026-09-01T00:00:00Z').toLocaleString(), new Date('2026-09-03T00:00:00Z').toLocaleString()])
})

test('paginateHistory slices into pages of the given size, newest-first order preserved', () => {
  const rows = historyRows(
    Array.from({ length: 25 }, (_, i) => historyEntry({ at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` })),
    s,
  )
  const page0 = paginateHistory(rows, 0, 10)
  expect(page0.rows).toHaveLength(10)
  expect(page0.pages).toBe(3)
  expect(page0.page).toBe(0)

  const page2 = paginateHistory(rows, 2, 10)
  expect(page2.rows).toHaveLength(5)
  expect(page2.page).toBe(2)
})

test('a page number past the end is CLAMPED, never rendered blank', () => {
  const rows = historyRows([historyEntry({ at: '2026-09-01T00:00:00Z' })], s)
  const page = paginateHistory(rows, 99, 10)
  expect(page.page).toBe(0)
  expect(page.rows).toHaveLength(1)
})

test('a negative page number is clamped to the first page', () => {
  const rows = historyRows([historyEntry({ at: '2026-09-01T00:00:00Z' })], s)
  expect(paginateHistory(rows, -3, 10).page).toBe(0)
})

test('an empty history is one page, empty, never a division by zero', () => {
  const page = paginateHistory([], 0, 10)
  expect(page.pages).toBe(1)
  expect(page.rows).toEqual([])
})

// -----------------------------------------------------------------------------
// historyCells — the ladder, harnesses first to go
// -----------------------------------------------------------------------------

const HISTORY_ROWS = historyRows([
  historyEntry({ at: '2026-09-01T00:00:00Z', layers: ['metrics', 'repos', 'archive', 'raw'], harnesses: ['claude', 'codex'], bytesLabel: '953 MB', presence: 'missing' }),
], s)

test('at a generous width every cell is drawn', () => {
  const cells = historyCells(HISTORY_ROWS, 80)
  expect(cells.at).toBeGreaterThan(0)
  expect(cells.layers).toBeGreaterThan(0)
  expect(cells.size).toBeGreaterThan(0)
  expect(cells.harnesses).toBeGreaterThan(0)
  expect(cells.status).toBeGreaterThan(0)
})

test('harnesses is the first cell to give way under width pressure', () => {
  let width = 80
  while (width > 0 && historyCells(HISTORY_ROWS, width).harnesses > 0) width--
  const atDrop = historyCells(HISTORY_ROWS, width)
  expect(atDrop.harnesses).toBe(0)
  expect(atDrop.layers).toBeGreaterThan(0)
  expect(width).toBeLessThan(80)
})

test('the status word outlasts layers/size — it shrinks the date before it drops it', () => {
  let width = 80
  while (width > 0 && historyCells(HISTORY_ROWS, width).size > 0) width--
  const atDrop = historyCells(HISTORY_ROWS, width)
  expect(atDrop.size).toBe(0)
  expect(atDrop.status).toBeGreaterThan(0)
})

test('the name never gives way to zero while any width remains', () => {
  const cells = historyCells(HISTORY_ROWS, 6)
  expect(cells.at).toBeGreaterThan(0)
})

test('an empty row list or a non-positive width fits nothing', () => {
  expect(historyCells([], 40)).toEqual({ at: 0, layers: 0, size: 0, harnesses: 0, status: 0 })
  expect(historyCells(HISTORY_ROWS, 0)).toEqual({ at: 0, layers: 0, size: 0, harnesses: 0, status: 0 })
})

// -----------------------------------------------------------------------------
// githubRows — the versioning block, and the one thing it may never carry
// -----------------------------------------------------------------------------

const CONFIGURED: GithubSection & { configured: true } = {
  configured: true,
  url: 'https://github.com/you/agentistics-backups',
  repo: 'you/agentistics-backups',
  label: 'notebook',
  keepRemote: 5,
  deleteLocalAfterUpload: true,
  auth: 'token',
}

const rowText = (rows: GithubRow[]) =>
  rows.map(r => `${r.label} ${r.value} ${r.note ?? ''}`).join('\n')

test('an unconfigured machine still gets a row — a block that renders nothing reads as broken', () => {
  const rows = githubRows({ configured: false }, s)
  expect(rows).toHaveLength(1)
  expect(rowText(rows)).toContain('agentop backup github setup <url>')
})

test('a host that never reported the section at all is treated as unconfigured, not as blank', () => {
  expect(githubRows(undefined, s)).toEqual(githubRows({ configured: false }, s))
})

test('a configured machine names its repository and what this machine is called', () => {
  const rows = githubRows(CONFIGURED, s)
  const text = rowText(rows)
  expect(text).toContain('you/agentistics-backups')
  expect(text).toContain('notebook')
})

test('the machine-name row carries the sentence that one repository holds several machines', () => {
  const row = githubRows(CONFIGURED, s).find(r => r.key === 'machine')!
  expect(row.value).toBe('notebook')
  expect(row.note).toBe(s.backupGithubMachineNote)
})

test('keepRemote 0 says every release is kept, never a bare "0"', () => {
  const kept = (n: number) => githubRows({ ...CONFIGURED, keepRemote: n }, s).find(r => r.key === 'keep')!.value
  expect(kept(0)).toBe(s.backupGithubKeepValue(0))
  expect(kept(0)).not.toBe('0')
  expect(kept(5)).toBe(s.backupGithubKeepValue(5))
})

test('whether the local archive survives a confirmed upload is stated, both ways', () => {
  const local = (on: boolean) =>
    githubRows({ ...CONFIGURED, deleteLocalAfterUpload: on }, s).find(r => r.key === 'local')!.value
  expect(local(true)).toBe(s.backupGithubLocalDeleted)
  expect(local(false)).toBe(s.backupGithubLocalKept)
  expect(local(true)).not.toBe(local(false))
})

// The rows are read off a `GithubSection`, which has no token field and must never grow one. This
// asserts over the JOINED text rather than field by field, the same discipline
// `backup-routes.test.ts` runs server-side: a field added later that happened to carry the
// credential would sail through a key-by-key check.
test('nothing token-shaped ever reaches a row, in either language', () => {
  for (const lang of ['en', 'pt'] as const) {
    const strings = controlStrings(lang)
    const text = [
      rowText(githubRows({ configured: false }, strings)),
      rowText(githubRows(CONFIGURED, strings)),
      rowText(githubRows({ ...CONFIGURED, keepRemote: 0, deleteLocalAfterUpload: false }, strings)),
    ].join('\n')
    expect(text).not.toMatch(/ghp_|gho_|ghs_|ghu_|ghr_|github_pat_/)
    expect(text).not.toMatch(/token|senha|password|secret|segredo/i)
  }
})

test('a token smuggled onto the section object is not drawn — the rows read named fields only', () => {
  const smuggled = { ...CONFIGURED, token: 'ghp_0123456789abcdef' } as unknown as GithubSection
  expect(rowText(githubRows(smuggled, s))).not.toContain('ghp_')
})

// -----------------------------------------------------------------------------
// the block on screen — the config row's summary and the detail pane's section
// -----------------------------------------------------------------------------

test('the config pane carries a github row, configured or not', () => {
  const off = backupConfigRows(config(), Date.now(), s, 0, { configured: false })
  const on = backupConfigRows(config(), Date.now(), s, 0, CONFIGURED)
  expect(off.find(r => r.key === 'github')!.value).toBe(s.backupGithubOff)
  expect(on.find(r => r.key === 'github')!.value).toContain('you/agentistics-backups')
})

test('the github config row is read-only — it offers no verb the cockpit cannot perform', () => {
  const row = backupConfigRows(config(), Date.now(), s, 0, CONFIGURED).find(r => r.key === 'github')!
  expect(row.action).toBeUndefined()
})

test('the detail pane states the block once — a section, never the summary row repeated', () => {
  const lines = backupDetailLines(config(), Date.now(), s, 0, CONFIGURED)
  expect(lines.filter(l => l.kind === 'section' && l.label === s.backupGithubLabel)).toHaveLength(1)
  expect(lines.filter(l => l.kind === 'row' && l.label === s.backupGithubLabel)).toHaveLength(0)
  const values = lines.map(l => l.value).join('\n')
  expect(values).toContain('you/agentistics-backups')
  expect(values).toContain('notebook')
})

test('the detail pane draws the block even when the host reported no section', () => {
  const lines = backupDetailLines(config(), Date.now(), s, 0)
  expect(lines.some(l => l.kind === 'section' && l.label === s.backupGithubLabel)).toBe(true)
  expect(lines.map(l => l.value).join('\n')).toContain('agentop backup github setup <url>')
})

test('the block is the LAST thing on the detail pane, so a short pane gives it up first', () => {
  const lines = backupDetailLines(config(), Date.now(), s, 0, CONFIGURED)
  const start = lines.findIndex(l => l.kind === 'section' && l.label === s.backupGithubLabel)
  const configLines = backupDetailLines(config(), Date.now(), s, 0, CONFIGURED)
    .slice(0, start)
    .filter(l => l.kind === 'row')
  expect(configLines.length).toBeGreaterThan(0)
  expect(start).toBeGreaterThan(0)
  // Nothing about the backup itself lives below the block.
  expect(lines.slice(start).some(l => l.kind === 'row' && l.label === s.backupDestLabel)).toBe(false)
})

// -----------------------------------------------------------------------------
// expandDetailText — prose is wrapped BEFORE the pane's budget is spent
// -----------------------------------------------------------------------------

test('a note too long for the pane becomes several lines rather than a truncated one', () => {
  const lines = backupDetailLines(config(), Date.now(), s, 0, CONFIGURED)
  const expanded = expandDetailText(lines, 40)
  const note = expanded.filter(l => l.kind === 'text')
  expect(note.length).toBeGreaterThan(1)
  expect(note.every(l => l.value.length <= 40)).toBe(true)
  expect(note.map(l => l.value).join(' ')).toBe(s.backupGithubMachineNote)
})

test('rows, sections and blanks are left exactly as they were', () => {
  const lines = backupDetailLines(config(), Date.now(), s, 0, CONFIGURED)
  const structural = (ls: readonly typeof lines[number][]) => ls.filter(l => l.kind !== 'text')
  expect(structural(expandDetailText(lines, 40))).toEqual(structural(lines))
})

test('a non-positive width expands nothing — there is no line to wrap to', () => {
  const lines = backupDetailLines(config(), Date.now(), s, 0, CONFIGURED)
  expect(expandDetailText(lines, 0)).toEqual(lines)
})

test('a note that cannot be shown whole is not shown at all — never cut off mid-clause', () => {
  const lines = backupDetailLines(config(), Date.now(), s, 0, CONFIGURED)
  const wanted = expandDetailText(lines, 40)
  const noteRows = wanted.filter(l => l.kind === 'text').length
  expect(noteRows).toBeGreaterThan(1)

  // One row short of the whole note: the sentence goes, the facts above it stay.
  const tight = expandDetailText(lines, 40, wanted.length - 1)
  expect(tight.some(l => l.kind === 'text')).toBe(false)
  expect(tight.filter(l => l.kind === 'row')).toEqual(lines.filter(l => l.kind === 'row'))

  // Given exactly the rows it wants, the whole sentence survives.
  expect(expandDetailText(lines, 40, wanted.length)).toEqual(wanted)
})
