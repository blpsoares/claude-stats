/**
 * task-sort.ts — how a board is ORDERED. Pure, and shared by every surface that draws a task.
 *
 * The table's column headers and the kanban's order picker are two front doors onto this one
 * function, deliberately: a board that ranks its cards one way in the grid and another in the
 * columns is two boards, and the reader has to hold both.
 *
 * Three rules the sort obeys, each because the alternative is worse:
 *
 *  - **`null` is not zero, and it sorts LAST in both directions.** A task nobody could price is not
 *    the cheapest task; putting it at the top of an ascending "cost" sort is the same confident-zero
 *    this product refuses everywhere else. Reversing the direction moves the measured rows and
 *    leaves the unmeasurable ones at the bottom, where they read as "no answer" rather than "least".
 *  - **Every sort is TOTAL.** Ties break on the manual rank, then on creation, then on id, so the
 *    order is the same on every render and on every machine. A board whose rows shuffle when you
 *    change nothing is a board people stop trusting to have shown them everything.
 *  - **`manual` is a real key, not the absence of one.** It reads `Task.rank` (see `task-rank.ts`);
 *    tasks nobody has dragged have no rank and follow the ranked ones, oldest first.
 */

/**
 * It lives in `@agentistics/core` and not beside the store because the BROWSER sorts too: the
 * table's headers and the kanban's picker are the two front doors onto it, and a second
 * implementation in `packages/web` is a second set of rules for the same question — which is how a
 * grid and a set of columns end up ranking the same cards differently.
 */

/** Most urgent first. The one place the order is stated; every sort and every picker reads it. */
export type TaskPriorityId = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export const PRIORITY_ORDER: readonly TaskPriorityId[] =
  ['urgent', 'high', 'medium', 'low', 'none'] as const

export type SortKey =
  | 'manual' | 'priority' | 'title' | 'status' | 'created' | 'updated' | 'due'
  | 'assignee' | 'cost' | 'tokens' | 'rounds' | 'sessions' | 'attempts' | 'comments'
  | 'subtasks' | 'harnesses'

export type SortDir = 'asc' | 'desc'

export interface SortSpec {
  key: SortKey
  dir: SortDir
}

/** What a row must carry to be sorted. Deliberately narrower than `TaskListRow`, so the browser's
 *  own row type satisfies it without importing the server's. */
export interface SortableRow {
  task: {
    id: string
    title: string
    status: string
    createdAt: string
    updatedAt: string
    priority?: TaskPriorityId | string
    assignee?: string
    dueDate?: string
    rank?: string
  }
  attempts?: number
  rollup?: {
    costUSD: number | null
    tokens: number | null
    rounds: number | null
    sessionsUsed: number
  }
  counts?: { comments: number; subtasks: number; subtasksDone: number; files: number }
  harnesses?: string[]
}

export const DEFAULT_SORT: SortSpec = { key: 'manual', dir: 'asc' }

const priorityIndex = (p: string | undefined): number => {
  const i = PRIORITY_ORDER.indexOf((p ?? 'none') as TaskPriorityId)
  // An unknown word ranks with "nobody has said" rather than at the top: a typo in a stored
  // priority must not promote a task above every triaged one.
  return i === -1 ? PRIORITY_ORDER.length - 1 : i
}

/**
 * The comparable value of a row on one key: a number, a string, or `null` for "no answer".
 *
 * `null` is the whole reason this is a separate function — it is checked once, in `compare`, rather
 * than by every key remembering to.
 */
function valueOf(row: SortableRow, key: SortKey): number | string | null {
  const t = row.task
  switch (key) {
    case 'manual': return t.rank ?? null
    case 'priority': return priorityIndex(t.priority)
    case 'title': return t.title.toLowerCase()
    case 'status': return t.status
    case 'created': return t.createdAt || null
    case 'updated': return t.updatedAt || null
    case 'due': return t.dueDate || null
    case 'assignee': return t.assignee?.toLowerCase() || null
    case 'cost': return row.rollup?.costUSD ?? null
    case 'tokens': return row.rollup?.tokens ?? null
    case 'rounds': return row.rollup?.rounds ?? null
    case 'sessions': return row.rollup?.sessionsUsed ?? null
    case 'attempts': return row.attempts ?? null
    case 'comments': return row.counts?.comments ?? null
    case 'subtasks': return row.counts?.subtasks ?? null
    case 'harnesses': return row.harnesses?.length ?? null
  }
}

/** The total, deterministic tiebreak. Manual rank, then creation, then id. */
function tiebreak(a: SortableRow, b: SortableRow): number {
  const ra = a.task.rank
  const rb = b.task.rank
  if (ra !== rb) {
    // A ranked card outranks an unranked one — dragging a card must move it above the ones nobody
    // has touched, not merely reorder it among its equals.
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra < rb ? -1 : 1
  }
  const ca = a.task.createdAt
  const cb = b.task.createdAt
  if (ca !== cb) return ca < cb ? -1 : 1
  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0
}

export function compareBy(spec: SortSpec, a: SortableRow, b: SortableRow): number {
  const va = valueOf(a, spec.key)
  const vb = valueOf(b, spec.key)
  // Unmeasurable rows sit at the bottom whichever way the arrow points — see the header.
  if (va === null && vb === null) return tiebreak(a, b)
  if (va === null) return 1
  if (vb === null) return -1
  let d = 0
  if (typeof va === 'number' && typeof vb === 'number') d = va - vb
  else d = String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0
  if (d === 0) return tiebreak(a, b)
  return spec.dir === 'asc' ? d : -d
}

export function sortRows<T extends SortableRow>(rows: readonly T[], spec: SortSpec): T[] {
  return [...rows].sort((a, b) => compareBy(spec, a, b))
}

/**
 * A header click: none → ascending → descending → back to the board's own order.
 *
 * Three states rather than two, because "I did not choose a sort" has to be reachable without
 * remembering what the default key was — and on this board the default IS a key (`manual`), which a
 * two-state toggle can only leave you stuck outside of.
 */
export function nextSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  return DEFAULT_SORT
}
