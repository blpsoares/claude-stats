/**
 * task-filter.ts — PURE. Which of a task's sessions the dashboard's filters let through.
 *
 * The board is not a separate world: the date range, the harness chips, the project and repository
 * pickers at the top of the page scope it exactly as they scope every other surface. That is what
 * makes "what did this task cost me LAST WEEK" and "what did CLAUDE cost me on this task"
 * answerable at all.
 *
 * It scopes SESSIONS, never tasks. A task whose sessions all fall outside the window still appears
 * — with `N/A` and a count of what was left out — because removing the row would answer a question
 * nobody asked ("which tasks existed last week") with one that looks like the answer to the one
 * they did ask ("what did my tasks cost last week").
 *
 * The day rule is `start_time.slice(0, 10)`, the UTC one — the same rule `tagSessionDay` and
 * `billing.ts` use. Two day rules exist in this repo and mixing them drifts a session across a
 * boundary at UTC-3; a board that disagreed with the tag beside it about which day a session landed
 * on would be a third answer.
 */

import type { SessionMeta } from '@agentistics/core'

export interface TaskFilter {
  /** Inclusive `yyyy-MM-dd`. Absent means unbounded on that side. */
  from?: string
  to?: string
  /** Empty or absent means "every one" — never "none". */
  harnesses?: readonly string[]
  projects?: readonly string[]
  repos?: readonly string[]
}

/** True when nothing is being narrowed — the caller can then skip the walk entirely. */
export function filterIsEmpty(f: TaskFilter | undefined): boolean {
  if (!f) return true
  return !f.from && !f.to
    && (f.harnesses?.length ?? 0) === 0
    && (f.projects?.length ?? 0) === 0
    && (f.repos?.length ?? 0) === 0
}

/** The UTC day a session is filed under. `''` when it recorded no usable start. */
export function sessionDay(m: SessionMeta): string {
  return typeof m.start_time === 'string' ? m.start_time.slice(0, 10) : ''
}

export function sessionInScope(m: SessionMeta, f: TaskFilter | undefined): boolean {
  if (filterIsEmpty(f)) return true
  const filter = f!

  if (filter.from || filter.to) {
    const day = sessionDay(m)
    // A session with no usable start time cannot be placed in a window. It is EXCLUDED rather than
    // let through, because a filtered view that quietly keeps unplaceable rows reports a figure
    // wider than the window it names.
    if (!day) return false
    if (filter.from && day < filter.from) return false
    if (filter.to && day > filter.to) return false
  }

  if (filter.harnesses?.length && !filter.harnesses.includes(m.harness ?? 'claude')) return false

  if (filter.projects?.length) {
    const p = m.current_cwd || m.project_path || ''
    if (!filter.projects.includes(p)) return false
  }

  if (filter.repos?.length) {
    // `''` is the "no linked repository" bucket the repositories page already uses, so a filter
    // naming it must still match a session that has no remote.
    if (!filter.repos.includes(m.git_remote ?? '')) return false
  }

  return true
}

/**
 * The metas a task may count, and how many it lost to the filter.
 *
 * The count is returned rather than discarded so the surface can SAY the numbers are scoped. A
 * rollup that silently shrank is the same defect as a confident zero: the figure is smaller and
 * nothing on screen explains why.
 */
export function scopeMetas(
  metas: ReadonlyMap<string, SessionMeta>,
  f: TaskFilter | undefined,
): { metas: ReadonlyMap<string, SessionMeta>; excluded: number } {
  if (filterIsEmpty(f)) return { metas, excluded: 0 }
  const out = new Map<string, SessionMeta>()
  let excluded = 0
  for (const [id, m] of metas) {
    if (sessionInScope(m, f)) out.set(id, m)
    else excluded++
  }
  return { metas: out, excluded }
}
