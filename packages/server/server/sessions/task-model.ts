/**
 * task-model.ts — what a Task and an Attempt ARE. Pure: no clock, no filesystem.
 *
 * Three levels, and the middle one is not optional. A Task is the work ("landing page for a
 * pizzeria"); an Attempt is one CONFIGURATION of that work ("opus, prompt only"); the sessions hang
 * off the attempt. Without the middle level, running one task under four configurations produces
 * one task holding a dozen unattributed sessions and nothing is comparable, which is the whole
 * point of the feature.
 *
 * See docs/superpowers/specs/2026-09-05-task-measurement-design.md.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { HarnessId } from '@agentistics/core'

/**
 * Where the work stands. A board needs more than open/closed, and each of these answers a question
 * the others cannot:
 *
 *  `backlog`     — recorded, not yet queued.
 *  `todo`        — queued, nothing started.
 *  `in_progress` — something is running or a session has touched it.
 *  `blocked`     — it CANNOT proceed. Distinct from `todo` on purpose: "nobody picked it up" and
 *                  "somebody tried and cannot" are different facts, and only the second is a
 *                  problem to go and solve.
 *  `in_review`   — the work exists and is being judged. The rounds are not finished.
 *  `done`        — DELIVERED. This is the state that closes rounds-to-delivery and stamps
 *                  `deliveredAt`; there is exactly one, so the metric cannot be ambiguous.
 *  `abandoned`   — given up on. First-class, because an abandoned attempt is the most informative
 *                  row in a comparison and treating it as still-open inflates every average.
 */
export type TaskStatus =
  | 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'abandoned'

export const TASK_STATUSES: readonly TaskStatus[] =
  ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned'] as const

/**
 * The two words this board used before it had seven.
 *
 * Read-migration only, and deliberately not a rename in the file: an `open` written by an older
 * build must keep meaning what it meant, and `delivered` IS `done` — the metric that closes on it
 * may not shift because the vocabulary grew.
 */
export function migrateStatus(raw: unknown): TaskStatus | null {
  if (typeof raw !== 'string') return null
  if (raw === 'open') return 'todo'
  if (raw === 'delivered') return 'done'
  return (TASK_STATUSES as readonly string[]).includes(raw) ? raw as TaskStatus : null
}

/** The statuses that mean the work is finished, either way. */
export function isClosed(s: TaskStatus): boolean {
  return s === 'done' || s === 'abandoned'
}

/**
 * `abandoned` is first-class on purpose. An attempt that was given up on is the most informative
 * row in a comparison; treating it as merely "still open" quietly inflates every average.
 */
export type AttemptStatus = 'running' | 'delivered' | 'abandoned'

/**
 * How a session's conversation link was established — carried into every rollup.
 *
 * `assigned` the CLI was handed the id (`SpawnSpec.assignId`; claude and copilot only).
 * `observed`  claimed once at first sighting (`task-attribution.ts`).
 * `none`      no link: the session contributes rounds and time, and no cost or tokens.
 */
export type LinkProvenance = 'assigned' | 'observed' | 'none'

export interface AttemptConfig {
  harness: HarnessId
  model?: string
  effort?: string
  /** Free text: "sdd", "prompt only", "opus spec then sonnet". The method is not a closed set. */
  method?: string
}

export interface Task {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  /** `normalizeGitRemote` key, when the work belongs to one repository. */
  repo?: string
  /**
   * Tasks that must finish before this one can proceed — Jira's "is blocked by".
   *
   * Ids, never titles: a title is renameable and a dependency that silently detaches on a rename is
   * worse than no dependency. A task never blocks ITSELF (refused on write), and a blocker that is
   * already `done` or `abandoned` stops counting rather than being removed — the record of what
   * held the work up is part of the delivery's story.
   */
  blockedBy?: string[]
  /**
   * Links out — a pull request, an issue, a doc.
   *
   * `kind` is free text with two conventional values (`pr`, `issue`) the UI renders an icon for;
   * anything else is a plain link. Not an enum, for the same reason `TaskComment.author` is not one:
   * an assistant must be able to attach a kind of link nobody anticipated without a schema change.
   */
  links?: TaskLink[]
}

export interface TaskLink {
  id: string
  url: string
  label?: string
  kind?: string
}

export interface Attempt {
  id: string
  taskId: string
  label: string
  config: AttemptConfig
  status: AttemptStatus
  startedAt: string
  updatedAt: string
  deliveredAt?: string
}

/**
 * A comment on a task — the channel a person and an assistant share.
 *
 * `author` is free text on purpose: it is a person's name, or a session handle, or an agent's
 * label. A closed enum here would mean an assistant could not say who it was without a schema
 * change, and the whole point is that anything working on the task can leave a trace.
 */
export interface TaskComment {
  id: string
  taskId: string
  author: string
  body: string
  createdAt: string
}

/** A subtask: a checkbox, not a second Task. It has no attempts, no sessions and no cost. */
export interface Subtask {
  id: string
  taskId: string
  title: string
  done: boolean
  createdAt: string
  updatedAt: string
}

/**
 * A file belonging to the task — a spec, a plan, a screenshot an assistant produced.
 *
 * The BYTES live on disk under the data dir; this record is the index. Kept apart so the book
 * stays a small JSON that is cheap to read on every poll, and so a file that fails to write leaves
 * no phantom row claiming it exists.
 */
export interface TaskFile {
  id: string
  taskId: string
  name: string
  /** Bytes on disk. Recorded so a listing need not stat every file. */
  size: number
  /** Free text: "spec", "plan", "screenshot", "log". Not an enum — see `TaskComment.author`. */
  kind?: string
  author?: string
  createdAt: string
}

export interface TaskBook {
  tasks: Task[]
  attempts: Attempt[]
  comments: TaskComment[]
  subtasks: Subtask[]
  files: TaskFile[]
  /**
   * Task ids the user DELETED, so the legacy migration does not mint them again.
   *
   * Without this a deleted task comes straight back: `ensureLegacyTasks` runs on every read and
   * re-creates a task for every name in `preferences.finishedTasks` and every `ManagedSession.task`
   * string. The delete worked, the next read undid it, and the button read as broken. Reported.
   *
   * It is a tombstone and not a permanent ban: creating a task with that title again clears it.
   */
  tombstones: string[]
}

function shortHex(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 10)
}

function mint(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function newTaskId(): string {
  return mint('t')
}

export function newAttemptId(): string {
  return mint('a')
}

export function newCommentId(): string {
  return mint('c')
}

export function newSubtaskId(): string {
  return mint('s')
}

export function newFileId(): string {
  return mint('f')
}

export function newLinkId(): string {
  return mint('l')
}

/**
 * The id a legacy free-text task name resolves to.
 *
 * DERIVED from the name rather than minted, which is what makes the migration idempotent: every
 * existing `ManagedSession.task` string already points at its Task without the row being rewritten,
 * and running the migration twice cannot produce two Tasks for one name.
 *
 * The name is hashed VERBATIM. Folding case or trimming would merge two names the user deliberately
 * typed apart, and a board that silently merges two pieces of work is worse than one carrying a
 * near-duplicate.
 */
export function legacyTaskId(name: string): string {
  return `legacy-${shortHex(name)}`
}

/**
 * Every legacy task name, as Tasks.
 *
 * `finished` names are carried even when no session still references them:
 * `preferences.finishedTasks` outlives the sessions it was about, and a delivery that happened is
 * not erased by its rows being cleaned up.
 */
export function migrateLegacyTasks(o: {
  names: readonly string[]
  finished: readonly string[]
  now: string
}): Task[] {
  const finished = new Set(o.finished)
  const seen = new Set<string>()
  const out: Task[] = []
  for (const title of [...o.names, ...o.finished]) {
    if (!title || seen.has(title)) continue
    seen.add(title)
    const delivered = finished.has(title)
    out.push({
      id: legacyTaskId(title),
      title,
      status: delivered ? 'done' : 'todo',
      createdAt: o.now,
      updatedAt: o.now,
      ...(delivered ? { deliveredAt: o.now } : {}),
    })
  }
  return out
}
