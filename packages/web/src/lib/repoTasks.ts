/**
 * repoTasks.ts — PURE. Which deliveries touched a repository, and what they add up to there.
 *
 * A task belongs to a repository through its SESSIONS' `git_remote` — never through a field
 * somebody typed — which is the rule the repository dimension already follows everywhere else
 * (`normalizeGitRemote` is the only key). The server does that half: `buildTaskList` reports the
 * distinct remotes of each task's sessions, read off the metas it was given, which on this page are
 * already scoped to this repository and to the page's date/harness filters.
 *
 * So the membership test here is a lookup and not a derivation. What this module owns is the
 * arithmetic of the tiles above the list, and the one rule that arithmetic must not break: a total
 * nobody could measure is `null`, never `0`. A repository whose tasks all ran on a harness that
 * reports no cost has not delivered for free.
 */

import type { TaskListRow } from './tasks'

/**
 * The rows of one repository.
 *
 * `remote` is the normalized remote, and `''` is the "no linked repository" bucket the repositories
 * page already shows — a real value here, exactly as it is in the server's `sessionInScope`. On an
 * unlinked folder page the caller passes `''` and the rows arrived scoped by project, so the empty
 * bucket means "a session in this folder that named no repository".
 */
export function tasksOfRepo(rows: readonly TaskListRow[], remote: string): TaskListRow[] {
  return rows.filter(r => r.repos.includes(remote))
}

export interface RepoTaskTotals {
  tasks: number
  /** Neither delivered nor abandoned — the work still going on in this repository. */
  inFlight: number
  delivered: number
  abandoned: number
  /**
   * The sessions this repository can actually account for — `sessionsLinked`, never `sessionsUsed`.
   *
   * A row with no conversation link contributes no numbers anywhere and named no repository, so
   * counting it here would attribute a session to a repository nothing observed in it. On a task
   * spanning two repositories that difference is the whole point: it must not report all of its
   * sessions on each side.
   */
  sessions: number
  /** Null when not one of these tasks could be priced. Never a reassuring `0`. */
  costUSD: number | null
  tokens: number | null
  /**
   * How many of these tasks also spent Copilot credits. Credits are not dollars and are never
   * summed into `costUSD`; the count exists so the tile can SAY the total is short.
   */
  creditTasks: number
}

/** The sum of what was reported, or `null` when nothing was. Mirrors the server's `sumOrNull`. */
function sumOrNull(values: readonly (number | null)[]): number | null {
  const real = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return real.length === 0 ? null : real.reduce((a, b) => a + b, 0)
}

/**
 * The tiles over the list.
 *
 * Every figure summed here was already decided by `task-rollup.ts` on the server and is scoped to
 * this repository by the same filter that scoped the rows — a task spanning two repositories
 * therefore contributes only what it spent in THIS one. Each task appears once, so nothing is
 * double counted.
 */
export function repoTaskTotals(rows: readonly TaskListRow[]): RepoTaskTotals {
  return {
    tasks: rows.length,
    inFlight: rows.filter(r => r.task.status !== 'done' && r.task.status !== 'abandoned').length,
    delivered: rows.filter(r => r.task.status === 'done').length,
    abandoned: rows.filter(r => r.task.status === 'abandoned').length,
    sessions: rows.reduce((a, r) => a + r.rollup.sessionsLinked, 0),
    costUSD: sumOrNull(rows.map(r => r.rollup.costUSD)),
    tokens: sumOrNull(rows.map(r => r.rollup.tokens)),
    creditTasks: rows.filter(r => r.rollup.credits !== null).length,
  }
}
