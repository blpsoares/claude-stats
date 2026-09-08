/**
 * boardPrefs — what the board looked like when you left it.
 *
 * Opening a task is a NAVIGATION (`/tasks/:id`), so the list unmounts and every piece of arrangement
 * it held — which view, which columns, which groups, which of them were folded — is gone by the time
 * you press back. Re-deciding all of it on every return is the same defect as a filter that resets
 * itself: the arrangement is the user's, and a surface that forgets it teaches people not to arrange
 * anything.
 *
 * It lives in `localStorage` and NOT in `/api/preferences`, deliberately: this is a per-viewer,
 * per-browser convenience, and on a central `preferences.json` is shared by everyone signed in —
 * one person's folded groups would fold them for the whole team.
 *
 * Every read and write is guarded. A private window, cleared site data, or a browser set to block
 * storage makes the accessor itself THROW, and a board that will not render because it could not
 * remember which columns were shown is worse than one that opens on the defaults.
 */

import { COLUMN_ORDER, type BoardStatus, type ColumnId } from './board'
import { DEFAULT_SORT, type SortSpec } from '@agentistics/core'

const KEY = 'agentistics-task-board-v1'

export type BoardView = 'overview' | 'board' | 'table' | 'agents'

export interface BoardPrefs {
  view: BoardView
  /** How the rows are ordered — the table's headers and the kanban's picker write the same field. */
  sort: SortSpec
  /** The kanban's own arrangement: what the swimlanes are, and the per-column WIP limit. */
  lanes: LaneKey
  wip: Record<string, number>
  /** Which columns the table shows, in the order they were picked. */
  columns: ColumnId[] | null
  /** Which status groups the table renders at all. `null` = every one of them. */
  groups: BoardStatus[] | null
  /** Groups the user folded shut. */
  collapsed: BoardStatus[]
  /** Which sections of the task detail's right rail are OPEN, by their stable id. */
  rail: Record<string, boolean>
}

/** The metrics view is the default, because "what did it cost" is the question the board answers. */
export const DEFAULT_PREFS: BoardPrefs = {
  view: 'overview', sort: DEFAULT_SORT, lanes: 'none', wip: {},
  columns: null, groups: null, collapsed: [], rail: {},
}

/**
 * Is this rail section open?
 *
 * Read through a function rather than off the object, because a section the user has never touched
 * must fall back to the CALLER's default — "not stored" and "stored as shut" are different, and
 * treating them alike would open every section on a rail somebody deliberately folded.
 */
export function railOpen(id: string, fallback: boolean): boolean {
  const v = readBoardPrefs().rail[id]
  return typeof v === 'boolean' ? v : fallback
}

export function setRailOpen(id: string, open: boolean): void {
  writeBoardPrefs({ rail: { ...readBoardPrefs().rail, [id]: open } })
}

/** What the kanban's rows are grouped by. `none` is one lane holding everything. */
export type LaneKey = 'none' | 'repo' | 'assignee' | 'harness' | 'priority'

export const LANE_KEYS: readonly LaneKey[] = ['none', 'repo', 'assignee', 'harness', 'priority']

const isLane = (v: unknown): v is LaneKey => LANE_KEYS.includes(v as LaneKey)

/** A stored sort naming a key this build no longer has falls back rather than throwing. */
function readSort(v: unknown): SortSpec {
  if (!v || typeof v !== 'object') return DEFAULT_SORT
  const s = v as Record<string, unknown>
  const dir = s.dir === 'desc' ? 'desc' : 'asc'
  return typeof s.key === 'string' ? { key: s.key as SortSpec['key'], dir } : DEFAULT_SORT
}

const isView = (v: unknown): v is BoardView =>
  v === 'overview' || v === 'board' || v === 'table' || v === 'agents'

const statuses = (v: unknown): BoardStatus[] | null =>
  Array.isArray(v) ? v.filter((x): x is BoardStatus => COLUMN_ORDER.includes(x as BoardStatus)) : null

export function readBoardPrefs(): BoardPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PREFS
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      view: isView(p.view) ? p.view : DEFAULT_PREFS.view,
      sort: readSort(p.sort),
      lanes: isLane(p.lanes) ? p.lanes : 'none',
      // A WIP limit is a number per column; anything else in the stored object is dropped rather
      // than rendered as a limit nobody set.
      wip: p.wip && typeof p.wip === 'object'
        ? Object.fromEntries(Object.entries(p.wip as Record<string, unknown>)
          .filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n > 0)) as Record<string, number>
        : {},
      // A stored column id no longer in the table is dropped rather than rendering a blank cell;
      // an EMPTY stored list is a real choice ("show me only the names") and is kept.
      columns: Array.isArray(p.columns) ? (p.columns as ColumnId[]) : null,
      groups: statuses(p.groups),
      collapsed: statuses(p.collapsed) ?? [],
      rail: p.rail && typeof p.rail === 'object'
        ? Object.fromEntries(Object.entries(p.rail as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>
        : {},
    }
  } catch { return DEFAULT_PREFS }
}

export function writeBoardPrefs(patch: Partial<BoardPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readBoardPrefs(), ...patch }))
  } catch { /* storage unavailable — the arrangement lasts this visit and no longer */ }
}
