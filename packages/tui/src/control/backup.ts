/**
 * backup.ts — PURE arithmetic for the `backup` tab: the row budget, the cell fit, the harness
 * rows, and the facts the detail pane draws.
 *
 * The tab owns no decisions — every number here already came from the host, which calls the same
 * engine `agentop backup` does (`cli-backup.ts`, `backup-store.ts`, `backup-size.ts`,
 * `schedule.ts`). This module only lays out what the host already decided, exactly as `sessions.ts`
 * and `chrome.ts`'s cockpit helpers do for their own screens.
 */

import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { SERVICE_MARKER, type DetailLine } from './chrome.ts'
import type { ControlStrings } from './i18n'
import type { BackupLayer, BackupScheduleId, ControlBackupConfig, ControlBackupHarness } from './types'

/** `● ` / `○ ` — whether the harness rides the next backup, ahead of its name. */
const MARK_WIDTH = 2

/** Below this a harness name is a stub — the same floor `serviceCells` holds a service label to. */
const LABEL_FLOOR = 8

/**
 * Two units at most, like `chrome.ts`'s `formatUptime` — "2h14m", never a stopwatch.
 *
 * Deliberately a separate function rather than an import: `chrome.ts` sits beside the cockpit's
 * OWN components, `formatUptime`'s two-unit shape is the vocabulary this tab borrows and not an
 * implementation this tab depends on, and the two are allowed to diverge — a backup's age is read
 * in hours and days, a service's uptime in seconds and minutes too.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '<1m'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h${min % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

/**
 * One harness's `last` cell, in FULL — a complete sentence, for the detail pane's wide column.
 *
 * The rule this exists for: an unticked harness must read as unprotected, and a recorded backup
 * whose file is gone says so rather than a reassuring date. `lastBackupAt` and `lastBackupGone`
 * are mutually exclusive facts the HOST already resolved (`backup-store.ts`'s `markPresence`) —
 * this only picks the sentence and, for a real date, the relative age against `now`.
 */
export function harnessLastLabel(h: ControlBackupHarness, now: number, s: ControlStrings): string {
  if (h.lastBackupAt) {
    const ms = now - Date.parse(h.lastBackupAt)
    if (Number.isFinite(ms) && ms >= 0) return s.backupAgo(formatElapsed(ms))
  }
  if (h.lastBackupGone) return s.backupLastGone
  return s.backupNever
}

/**
 * The SAME fact, SHORT — for the harnesses list, which is the narrow column of the band.
 *
 * The full "none (no recorded backup whose file is still on disk)" sentence is a paragraph next
 * to "2h ago", and sizing the list's `last` COLUMN to its widest row (the ordinary rule every
 * other cell here follows) would let that one sentence force the column — and therefore the
 * whole band's width — wide enough to starve the config pane beside it, or force `harnessCells`
 * to drop the column for every row just because one of them has something long to say. The full
 * sentence still exists: it is what the detail pane shows for the SELECTED harness (see
 * `harnessDetailLines`), the same relationship the Services detail pane has with its compact row.
 */
export function harnessLastShort(h: ControlBackupHarness, now: number, s: ControlStrings): string {
  if (h.lastBackupAt) {
    const ms = now - Date.parse(h.lastBackupAt)
    if (Number.isFinite(ms) && ms >= 0) return s.backupAgo(formatElapsed(ms))
  }
  if (h.lastBackupGone) return s.backupLastGoneShort
  return s.backupNever
}

/** One drawable row of the harnesses pane, cells already composed as text. `last` is the SHORT
 *  form (see `harnessLastShort`); `lastFull` is the sentence the detail pane draws when this row
 *  is selected. */
export interface HarnessRow {
  id: HarnessId
  enabled: boolean
  label: string
  sessions: string
  size: string
  last: string
  lastFull: string
}

/**
 * The harness rows, in `HARNESS_ORDER` — never in whatever order the host happened to report
 * them, and never a literal array. A host that reported a harness twice, or left one out, still
 * yields one row per `HARNESS_ORDER` member the host actually covered.
 */
export function harnessRows(harnesses: ControlBackupHarness[], now: number, s: ControlStrings): HarnessRow[] {
  const byId = new Map(harnesses.map(h => [h.id, h]))
  return HARNESS_ORDER.filter(id => byId.has(id)).map(id => {
    const h = byId.get(id)!
    return {
      id,
      enabled: h.enabled,
      label: id,
      sessions: String(h.sessions),
      size: h.sizeLabel,
      last: harnessLastShort(h, now, s),
      lastFull: harnessLastLabel(h, now, s),
    }
  })
}

/** Cell widths inside a harness row; `0` means the cell is not drawn. The mark is fixed and never
 *  dropped — an unmarked, unnamed row answers nothing at all. */
export interface HarnessCells {
  label: number
  sessions: number
  size: number
  last: number
}

function harnessRowCost(c: HarnessCells): number {
  return c.label
    + (c.sessions > 0 ? c.sessions + 1 : 0)
    + (c.size > 0 ? c.size + 1 : 0)
    + (c.last > 0 ? c.last + 1 : 0)
}

/**
 * Fits the harnesses row: name, sessions, size, last-backup — a ladder of whole allocations, the
 * same shape `serviceCells` uses.
 *
 * THE ORDER OF GIVING WAY: `last` goes first — it is the fact this tab exists to surface, but a
 * truncated date is worse than an absent one, and the harnesses pane is the narrow column of the
 * band — then `size`, then `sessions`. The mark and the name never give way.
 */
export function harnessCells(
  rows: { label: string; sessions: string; size: string; last: string }[],
  width: number,
): HarnessCells {
  const avail = width - SERVICE_MARKER - MARK_WIDTH
  if (rows.length === 0 || avail <= 0) return { label: 0, sessions: 0, size: 0, last: 0 }

  const widest = (pick: (r: (typeof rows)[number]) => string) =>
    rows.reduce((n, r) => Math.max(n, pick(r).length), 0)

  const label = widest(r => r.label)
  const sessions = widest(r => r.sessions)
  const size = widest(r => r.size)
  const last = widest(r => r.last)
  const floor = Math.min(label, LABEL_FLOOR)

  const ladder: HarnessCells[] = [
    { label, sessions, size, last },
    { label: floor, sessions, size, last },
    { label, sessions, size, last: 0 },
    { label: floor, sessions, size, last: 0 },
    { label, sessions, size: 0, last: 0 },
    { label: floor, sessions, size: 0, last: 0 },
    { label, sessions: 0, size: 0, last: 0 },
    { label: Math.max(1, avail), sessions: 0, size: 0, last: 0 },
  ]

  const picked = ladder.find(c => harnessRowCost(c) <= avail) ?? ladder[ladder.length - 1]!
  const spare = avail - harnessRowCost(picked)
  if (spare <= 0) return picked
  // Whatever the rung did not spend goes to the name, the only cell with a use for one more column.
  return { ...picked, label: Math.min(label, picked.label + spare) }
}

/** One row of the config pane. `action` is present only on `schedule` — the one row `enter`/`s`
 *  changes; the rest are read-only facts here (layers, keep and destination are set outside the
 *  cockpit today, same as the web and CLI surfaces this design leaves for a later phase). */
export interface BackupConfigRow {
  key: string
  label: string
  value: string
  action?: string
}

/** Deliberately untranslated — the CLI's own vocabulary, the same convention as `native`/`docker`. */
function layersLabel(layers: BackupLayer[]): string {
  return layers.length > 0 ? layers.join(' + ') : '—'
}

function scheduleLabel(config: ControlBackupConfig, s: ControlStrings): string {
  const word = s.backupScheduleWord[config.schedule]
  return config.schedule === 'off' || config.scheduleActive ? word : `${word} ${s.backupScheduleInactive}`
}

/** The config pane's rows — layers, destination, schedule, keep (with the retained total),
 *  secrets excluded, last backup. Exactly the facts CLAUDE.md's mock names, in that order. */
export function backupConfigRows(config: ControlBackupConfig, now: number, s: ControlStrings): BackupConfigRow[] {
  return [
    { key: 'layers', label: s.backupLayersLabel, value: layersLabel(config.layers) },
    { key: 'dest', label: s.backupDestLabel, value: config.destDir },
    {
      key: 'schedule', label: s.backupScheduleLabel, value: scheduleLabel(config, s),
      action: s.actBackupSchedule,
    },
    { key: 'keep', label: s.backupKeepLabel, value: s.backupKeepValue(config.keep, config.retainedLabel) },
    { key: 'secrets', label: s.backupSecretsLabel, value: s.backupSecretsValue(config.secretsCount) },
    { key: 'last', label: s.backupLastLabel, value: lastSummary(config, now, s) },
  ]
}

/** The outcome word for a completed backup — mirrors `agentop backup status`'s own three
 *  sentences: unknown (predates skip tracking), a clean run, or a warning naming the count. */
function lastOutcome(skipped: number | undefined, s: ControlStrings): string {
  if (skipped === undefined) return s.backupLastUnknown
  return skipped > 0 ? s.backupLastSkipped(skipped) : s.backupLastOk
}

function lastSummary(config: ControlBackupConfig, now: number, s: ControlStrings): string {
  if (!config.last) return s.backupNoneOnDisk
  const ms = now - Date.parse(config.last.at)
  const age = Number.isFinite(ms) && ms >= 0 ? s.backupAgo(formatElapsed(ms)) : config.last.at
  return `${age} · ${config.last.bytesLabel} · ${lastOutcome(config.last.skipped, s)}`
}

/**
 * The detail pane's facts — the SAME config, unabbreviated, exactly the relationship `chrome.ts`'s
 * `detailContent` gives a service's compact row and its own detail pane. Reuses `DetailLine` so
 * the pane goes through the cockpit's own `fitDetailLines`/`detailPlan` rather than a second set
 * of rules for one more list of facts.
 */
export function backupDetailLines(config: ControlBackupConfig, now: number, s: ControlStrings): DetailLine[] {
  const rows = backupConfigRows(config, now, s)
  return rows.map(r => ({ kind: 'row' as const, label: r.label, value: r.value, tone: 'plain' as const }))
}

/**
 * One SELECTED harness's own facts, in full — the wide column's half of the relationship the
 * harnesses list has with the detail pane, mirroring what `detailContent` does for a selected
 * service. This is where `lastFull`'s complete sentence actually gets read, having been kept out
 * of the narrow list column that would have had to shrink for it.
 */
export function harnessDetailLines(row: HarnessRow | undefined, s: ControlStrings): DetailLine[] {
  if (!row) return []
  return [
    { kind: 'row', label: s.backupSessionsLabel, value: row.sessions, tone: 'plain' },
    { kind: 'row', label: s.backupSizeLabel, value: row.size, tone: 'plain' },
    { kind: 'row', label: s.backupLastLabel, value: row.lastFull, tone: 'plain' },
  ]
}

/**
 * The keys that work in the focused pane, most-important-first — the same shape `cockpitHints`
 * follows for the Services tab, and the same reason: a hint for a key that does nothing here is a
 * bug, not a cosmetic issue.
 */
export function backupHints(focus: 'harnesses' | 'config', s: ControlStrings, ctx: { task: boolean }): string[] {
  if (ctx.task) return [s.keyTaskClose, s.keyScroll, s.logFollow]
  const shared = [s.keyQuit, s.keyTabs, s.keyPane, s.keyMove]
  return focus === 'harnesses'
    ? [...shared, s.keyBackupToggle, s.keyBackupRun, s.keyBackupSchedule, s.keyRefresh]
    : [...shared, s.keyBackupRun, s.keyBackupSchedule, s.keyRefresh]
}

/** The order `s` cycles through — a closed three-value enum, so this is the one place that knows
 *  what comes after what rather than every caller re-deriving it from `SCHEDULE_IDS` by hand. */
const SCHEDULE_CYCLE: BackupScheduleId[] = ['off', 'daily', 'weekly']

export function nextBackupSchedule(current: BackupScheduleId): BackupScheduleId {
  const i = SCHEDULE_CYCLE.indexOf(current)
  return SCHEDULE_CYCLE[(i + 1) % SCHEDULE_CYCLE.length]!
}
