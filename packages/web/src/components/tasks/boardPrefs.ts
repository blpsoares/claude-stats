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

import { COLUMN_ORDER, type BoardStatus } from './board'
import type { ColumnId } from './TaskTable'

const KEY = 'agentistics-task-board-v1'

export type BoardView = 'overview' | 'board' | 'table'

export interface BoardPrefs {
  view: BoardView
  /** Which columns the table shows, in the order they were picked. */
  columns: ColumnId[] | null
  /** Which status groups the table renders at all. `null` = every one of them. */
  groups: BoardStatus[] | null
  /** Groups the user folded shut. */
  collapsed: BoardStatus[]
}

/** The metrics view is the default, because "what did it cost" is the question the board answers. */
export const DEFAULT_PREFS: BoardPrefs = {
  view: 'overview', columns: null, groups: null, collapsed: [],
}

const isView = (v: unknown): v is BoardView =>
  v === 'overview' || v === 'board' || v === 'table'

const statuses = (v: unknown): BoardStatus[] | null =>
  Array.isArray(v) ? v.filter((x): x is BoardStatus => COLUMN_ORDER.includes(x as BoardStatus)) : null

export function readBoardPrefs(): BoardPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_PREFS
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      view: isView(p.view) ? p.view : DEFAULT_PREFS.view,
      // A stored column id no longer in the table is dropped rather than rendering a blank cell;
      // an EMPTY stored list is a real choice ("show me only the names") and is kept.
      columns: Array.isArray(p.columns) ? (p.columns as ColumnId[]) : null,
      groups: statuses(p.groups),
      collapsed: statuses(p.collapsed) ?? [],
    }
  } catch { return DEFAULT_PREFS }
}

export function writeBoardPrefs(patch: Partial<BoardPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readBoardPrefs(), ...patch }))
  } catch { /* storage unavailable — the arrangement lasts this visit and no longer */ }
}
