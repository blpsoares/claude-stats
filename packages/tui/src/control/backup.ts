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
import type {
  ArchiveMode, BackupLayer, BackupPresence, BackupScheduleId, ControlBackupConfig,
  ControlBackupHarness, ControlBackupHistoryEntry,
} from './types'

/** `● ` / `○ ` — whether the harness rides the next backup, ahead of its name. */
const MARK_WIDTH = 2

/** Below this a harness name is a stub — the same floor `serviceCells` holds a service label to. */
const LABEL_FLOOR = 8

/**
 * Redeclared from `server/backup/backup-plan.ts`'s `BACKUP_LAYERS` — `packages/tui` may not import
 * from `packages/server`. Order matters here as much as membership: every layer row (the manual
 * editor and the schedule editor alike) is drawn in this order, metrics first because it is the one
 * that is never optional. Cross-checked in `backup-plan.test.ts`, the same discipline that test
 * already runs for the `BackupLayer` union itself.
 */
export const BACKUP_LAYER_ORDER: BackupLayer[] = ['metrics', 'repos', 'archive', 'raw']

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

/** One row of the config pane. `action` is present on `layers`, `schedule` and `scheduleLayers` —
 *  the three rows `enter` does something to (the two layer rows open the layers editor in the
 *  detail pane, `schedule` cycles inline); `dest`, `keep`, `secrets` and `last` stay read-only
 *  facts, set outside the cockpit today, same as the web and CLI surfaces this design leaves for a
 *  later phase). */
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

/** The config pane's rows — layers, destination, schedule, the schedule's own layers, keep (with
 *  the retained total), secrets excluded, last backup, and the history — exactly the facts
 *  CLAUDE.md's mock names, in that order, with the schedule's own layers row added right under
 *  the schedule itself. `enter` on `history` opens the paginated viewer, the same relationship
 *  `layers`/`scheduleLayers` have with the layers editor. */
export function backupConfigRows(
  config: ControlBackupConfig, now: number, s: ControlStrings, historyCount: number,
): BackupConfigRow[] {
  return [
    { key: 'layers', label: s.backupLayersLabel, value: layersLabel(config.layers), action: s.actBackupEditLayers },
    { key: 'dest', label: s.backupDestLabel, value: config.destDir },
    {
      key: 'schedule', label: s.backupScheduleLabel, value: scheduleLabel(config, s),
      action: s.actBackupSchedule,
    },
    {
      key: 'scheduleLayers', label: s.backupScheduleLayersLabel, value: layersLabel(config.scheduleLayers),
      action: s.actBackupEditScheduleLayers,
    },
    { key: 'keep', label: s.backupKeepLabel, value: s.backupKeepValue(config.keep, config.retainedLabel) },
    { key: 'secrets', label: s.backupSecretsLabel, value: s.backupSecretsValue(config.secretsCount) },
    { key: 'last', label: s.backupLastLabel, value: lastSummary(config, now, s) },
    { key: 'history', label: s.paneHistory, value: s.backupHistoryCount(historyCount), action: s.actBackupViewHistory },
  ]
}

/**
 * The layers editor's own rows — one per `BACKUP_LAYER_ORDER` member, whether the given draft has
 * it checked, and its measured size (already formatted by the host, or `backupLayerSizeUnknown`
 * when the host reported `null` — the `repos` layer, unmeasurable ahead of a run).
 *
 * `metrics` is always reported checked and `fixed`, whatever the draft says — it cannot be removed
 * (`backup-plan.ts`'s `withMetrics` enforces this server-side too), and the editor renders its row
 * non-interactive rather than merely disabled, saying why via `backupLayerAlwaysOn`.
 */
export interface LayerEditorRow {
  layer: BackupLayer
  label: string
  checked: boolean
  sizeLabel: string
  fixed: boolean
  /** What this layer actually saves — the truth about the code, not marketing. Shown under its
   *  row so a person ticking boxes knows what they are asking for, in the same words the web's
   *  format picker uses (see `backupLayerDescription`). */
  description: string
  /**
   * A caveat specific to THIS row, or null when there is none:
   *  - `metrics` always carries one — alone, it cannot resume a session.
   *  - `archive` carries one only when the machine's history-preservation mode is not `full` — a
   *    frozen layer must not look like it is still growing.
   *  - `repos`/`raw` never do.
   */
  caveat: string | null
}

/** `archive` only grows while `archiveMode === 'full'`. Anything else — `undefined` (never
 *  chosen), `'consolidate'`, `'off'` — means the layer is frozen, and the caveat says so by
 *  naming the mode in the CLI's own untranslated vocabulary, same convention as `native`/`docker`. */
function layerCaveat(layer: BackupLayer, archiveMode: ArchiveMode | undefined, s: ControlStrings): string | null {
  if (layer === 'metrics') return s.backupMetricsNoResume
  if (layer === 'archive' && archiveMode !== 'full') return s.backupArchiveFrozen(archiveMode ?? s.archiveUnset)
  return null
}

export function layerEditorRows(
  draft: BackupLayer[], sizes: Record<BackupLayer, string | null>, s: ControlStrings,
  archiveMode?: ArchiveMode,
): LayerEditorRow[] {
  return BACKUP_LAYER_ORDER.map(layer => ({
    layer,
    label: s.backupLayerName[layer],
    checked: layer === 'metrics' || draft.includes(layer),
    sizeLabel: sizes[layer] ?? s.backupLayerSizeUnknown,
    fixed: layer === 'metrics',
    description: s.backupLayerDescription[layer],
    caveat: layerCaveat(layer, archiveMode, s),
  }))
}

/** `space` on a layers-editor row: flips membership, except `metrics`, which the editor never even
 *  lets the cursor land a toggle on — this is the belt to that braces. Order is not the editor's
 *  concern; every writer (`ControlHost.setBackupLayers`/`setBackupScheduleLayers`, and the CLI's
 *  and web's own writers) normalizes it on the way to disk. */
export function toggleBackupLayer(draft: BackupLayer[], layer: BackupLayer): BackupLayer[] {
  if (layer === 'metrics') return draft
  return draft.includes(layer) ? draft.filter(l => l !== layer) : [...draft, layer]
}

/** The one caveat the SCHEDULE layers editor carries and the manual one never does: checking
 *  `repos` there does not make a scheduled run build a repository manifest — `schedule.ts` and
 *  `daemon.ts` filter it out regardless of what is stored. Null when the draft does not have it
 *  checked, so a caller can render the sentence only when it is actually relevant. */
export function scheduleReposNote(draft: BackupLayer[], s: ControlStrings): string | null {
  return draft.includes('repos') ? s.backupScheduleReposNote : null
}

/** `❯ ● ` / `  ● ` — the cursor and check mark ahead of a layer editor row's label. */
const LAYER_MARK_WIDTH = 4

/** Cell widths inside a layers-editor row — the same ladder shape `harnessCells` uses, just for two
 *  columns instead of four. `size` is the first to go, because at the width this editor is drawn
 *  (the full-width detail pane, or a stacked narrow one) the checkbox and the layer's NAME are what
 *  make the row actionable; its measured size is the reason to look, not the reason to act. */
export interface LayerRowCells {
  label: number
  size: number
}

export function layerEditorCells(labels: string[], sizeLabels: string[], width: number): LayerRowCells {
  const avail = width - LAYER_MARK_WIDTH
  if (labels.length === 0 || avail <= 0) return { label: 0, size: 0 }

  const label = labels.reduce((n, l) => Math.max(n, l.length), 0)
  const size = sizeLabels.reduce((n, l) => Math.max(n, l.length), 0)
  const floor = Math.min(label, LABEL_FLOOR)
  const cost = (l: number, sz: number) => l + (sz > 0 ? sz + 2 : 0)

  const ladder: LayerRowCells[] = [
    { label, size },
    { label: floor, size },
    { label, size: 0 },
    { label: floor, size: 0 },
    { label: Math.max(1, avail), size: 0 },
  ]
  return ladder.find(c => cost(c.label, c.size) <= avail) ?? ladder[ladder.length - 1]!
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
export function backupDetailLines(
  config: ControlBackupConfig, now: number, s: ControlStrings, historyCount: number,
): DetailLine[] {
  const rows = backupConfigRows(config, now, s, historyCount)
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
 *
 * `ctx.editing` is checked before `ctx.task` would ever be true — the layers editor and the output
 * pane are mutually exclusive (see `Backup.tsx`'s `capturing`), but stating the same order here
 * keeps this function total over every combination a future caller might pass.
 */
export function backupHints(
  focus: 'harnesses' | 'config', s: ControlStrings,
  ctx: { task: boolean; editing?: boolean; history?: boolean },
): string[] {
  if (ctx.editing) return [s.keyLayerToggle, s.keyLayerSave, s.keyLayerCancel]
  if (ctx.history) return [s.keyHistoryPage, s.keyHistoryClose]
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

// -----------------------------------------------------------------------------
// GitHub-fit — NOT the "push to GitHub Releases" feature (that does not exist yet). This is the
// honest indicator that belongs beside the format picker: a Release asset is capped at 2 GiB PER
// FILE, and reasoning about it is possible today from the layer sizes already measured.
// -----------------------------------------------------------------------------

/** GitHub's own cap on one Release asset. Binary units, matching every other size in this
 *  product (`backup-size.ts`'s `formatBytes`). Mirrored server-side in `backup-github.ts` — kept
 *  in sync by `backup-plan.test.ts`'s cross-check, the same discipline `BACKUP_LAYER_ORDER` gets. */
export const GITHUB_RELEASE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

export type GithubFitVerdict = 'fits' | 'maybe-not'

/**
 * Whether `layers` would fit a single Release asset, reasoned ONLY from the measured
 * UNCOMPRESSED total — compression can only shrink further, so under the cap is a certain fit and
 * at or over it is an honest "might not," never a guessed compressed figure (that number does not
 * exist until an archive is actually written; see `backup-size.ts`'s header). A layer with no
 * measured size yet (`repos`, before a run has built a manifest) contributes nothing to the sum.
 *
 * Computed LOCALLY, live, as `draft` changes in the layers editor — no round trip, so the
 * sentence updates the instant a box is ticked, which is the whole point of showing it here.
 */
export function githubFitVerdict(
  layers: BackupLayer[], layerBytes: Record<BackupLayer, number | null>,
): GithubFitVerdict {
  const total = layers.reduce((n, l) => n + (layerBytes[l] ?? 0), 0)
  return total < GITHUB_RELEASE_LIMIT_BYTES ? 'fits' : 'maybe-not'
}

export function githubFitLabel(verdict: GithubFitVerdict, s: ControlStrings): string {
  return verdict === 'fits' ? s.backupGithubFits : s.backupGithubMayNotFit
}

// -----------------------------------------------------------------------------
// history — paginated, and "gone" is two different facts (pruned by retention vs. really missing)
// -----------------------------------------------------------------------------

/** One row of the history viewer, cells already composed as text. */
export interface HistoryRow {
  at: string
  layers: string
  size: string
  harnesses: string
  presence: BackupPresence
  status: string
}

function presenceLabel(p: BackupPresence, s: ControlStrings): string {
  if (p === 'present') return s.backupHistoryPresent
  if (p === 'pruned') return s.backupHistoryPruned
  return s.backupHistoryMissing
}

/** `entries` is already newest-first (the host's `loadBackupHistory` sorts it) — this only
 *  formats, never reorders, so a caller that DID sort differently is not silently corrected. */
export function historyRows(entries: ControlBackupHistoryEntry[], s: ControlStrings): HistoryRow[] {
  return entries.map(e => ({
    at: new Date(e.at).toLocaleString(),
    layers: e.layers.join(' + '),
    size: e.bytesLabel,
    harnesses: String(e.harnesses.length),
    presence: e.presence,
    status: presenceLabel(e.presence, s),
  }))
}

export interface HistoryPage {
  rows: HistoryRow[]
  /** Zero-based, already clamped into range. */
  page: number
  pages: number
}

/**
 * Slices `rows` into `pageSize`-row pages. `page` is CLAMPED rather than trusted — the same rule
 * `tablePaging.ts` documents for the web's restriction tables: a page left pointing past the end
 * after the history shrinks (a prune, a machine with fewer runs than before) corrects itself
 * instead of rendering nothing.
 */
export function paginateHistory(rows: HistoryRow[], page: number, pageSize: number): HistoryPage {
  const size = Math.max(1, pageSize)
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const clamped = Math.min(Math.max(0, page), pages - 1)
  const start = clamped * size
  return { rows: rows.slice(start, start + size), page: clamped, pages }
}

/** Cell widths for one history row — the same ladder shape `harnessCells`/`layerEditorCells`
 *  use. Under pressure `harnesses` goes first (it is one digit and the least actionable fact
 *  here), then `layers`, then `size`; the date and the status word never give way — the status
 *  word is the one fact this whole fix exists to make trustworthy. */
export interface HistoryCells {
  at: number
  layers: number
  size: number
  harnesses: number
  status: number
}

const HISTORY_GAP = 1

function historyRowCost(c: HistoryCells): number {
  return c.at
    + (c.layers > 0 ? c.layers + HISTORY_GAP : 0)
    + (c.size > 0 ? c.size + HISTORY_GAP : 0)
    + (c.harnesses > 0 ? c.harnesses + HISTORY_GAP : 0)
    + (c.status > 0 ? c.status + HISTORY_GAP : 0)
}

export function historyCells(rows: HistoryRow[], width: number): HistoryCells {
  if (rows.length === 0 || width <= 0) return { at: 0, layers: 0, size: 0, harnesses: 0, status: 0 }

  const widest = (pick: (r: HistoryRow) => string) => rows.reduce((n, r) => Math.max(n, pick(r).length), 0)
  const at = widest(r => r.at)
  const layers = widest(r => r.layers)
  const size = widest(r => r.size)
  const harnesses = widest(r => r.harnesses)
  const status = widest(r => r.status)
  const atFloor = Math.min(at, LABEL_FLOOR)

  const ladder: HistoryCells[] = [
    { at, layers, size, harnesses, status },
    { at, layers, size, harnesses: 0, status },
    { at, layers: 0, size, harnesses: 0, status },
    { at, layers: 0, size: 0, harnesses: 0, status },
    // The status word is what this whole fix exists to make trustworthy, so it is the last thing
    // to go — `at` shrinks to a floor before it does.
    { at: atFloor, layers: 0, size: 0, harnesses: 0, status },
    { at: Math.max(1, width), layers: 0, size: 0, harnesses: 0, status: 0 },
  ]
  return ladder.find(c => historyRowCost(c) <= width) ?? ladder[ladder.length - 1]!
}
