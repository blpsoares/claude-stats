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
import { PRIORITY_ORDER, type TaskPriorityId } from '@agentistics/core'
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

/**
 * How urgent, in the four words every board of this kind uses plus the honest fifth.
 *
 * `none` is not a synonym for "low" — it is "nobody has said", and it is what an absent field reads
 * as. Defaulting an unset priority to `medium` would fill a board with a judgement nobody made, and
 * "what has not been triaged" is a question a coordinator actually asks.
 */
export type TaskPriority = TaskPriorityId

/**
 * Most urgent first — re-exported from `@agentistics/core`, where the browser can read it too.
 * Two lists would be two orders, and the one on screen would be whichever surface drew last.
 */
export { PRIORITY_ORDER }

export function migratePriority(raw: unknown): TaskPriority {
  return typeof raw === 'string' && (PRIORITY_ORDER as readonly string[]).includes(raw)
    ? raw as TaskPriority
    : 'none'
}

/**
 * A LEASE on a task, not a lock.
 *
 * Two agents pulling the same task off a board and doing it twice is the failure this exists to
 * prevent, and the naive fix — a boolean "taken" — has a worse one behind it: an agent that dies
 * holding it takes the task out of circulation forever, with nothing on the board saying why.
 *
 * So a claim EXPIRES. `expiresAt` is set at claim time and is refreshed by whoever holds it; once
 * it passes, the task is available again and says it was. Nothing here deletes anything on its
 * own — expiry is read at the moment the question is asked, so a clock that jumps cannot silently
 * hand one task to two agents between polls.
 */
export interface TaskClaim {
  /** Free text — a session handle, an agent's label, a person. Same rule as `TaskComment.author`. */
  by: string
  at: string
  expiresAt: string
  /** The managed session holding it, when there is one — an exact link where the name is a guess. */
  sessionId?: string
  note?: string
}

/**
 * One thing that HAPPENED to a task, in the order it happened.
 *
 * A board driven by several agents is a board where "who moved this to blocked, and when" is not
 * rhetorical. The kinds are open (free text) for the same reason `TaskComment.author` is: an
 * assistant must be able to record something nobody anticipated without a schema change.
 */
export interface TaskEvent {
  id: string
  taskId: string
  at: string
  /** Who did it. Free text. */
  actor: string
  /** `status` | `claim` | `release` | `assign` | `priority` | `session` | `comment` | … */
  kind: string
  /** What it became, in one short phrase. Rendered verbatim; never a sentence built downstream. */
  detail?: string
  from?: string
  to?: string
}

export interface Task {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  /** Absent reads as `none` — see `TaskPriority`. */
  priority?: TaskPriority
  /** Free text: a person, an agent's label, a session handle. */
  assignee?: string
  /** `yyyy-MM-dd`, like `Subtask`. A date, not a timestamp — nobody schedules to the second. */
  dueDate?: string
  startDate?: string
  /** Free-text labels. Filtering and grouping only; they carry no rule. */
  labels?: string[]
  /**
   * Where the card sits when the board is ordered BY HAND (`task-rank.ts`).
   *
   * A string and not a number, so inserting between two neighbours is one write instead of
   * renumbering everything below — the LexoRank/fractional-indexing trick. Absent means "never
   * dragged": those sort after the ranked ones, by creation, so a board nobody has arranged still
   * reads in a sensible order.
   */
  rank?: string
  /** Who is on it RIGHT NOW, and until when. See `TaskClaim`. */
  claim?: TaskClaim
  /**
   * WHY this task is blocked, in the words of whoever blocked it.
   *
   * `blocked` is the one status that names a problem somebody has to go and solve, and a board full
   * of blocked cards that do not say what they are waiting on is a board nobody can unblock — the
   * fact has to be re-discovered by asking the person, who by then has moved on. So the status
   * cannot be SET without either this sentence or a blocking task (`blockedBy`); see `markTask`.
   *
   * Cleared when the task leaves `blocked`: a reason that outlived its block is a stale sentence
   * that reads as current, which is worse than none.
   */
  blockedReason?: string
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

/**
 * A subtask is a ROW, not a checkbox.
 *
 * It carries the same columns its parent does — status, dates, assignee, a linked session — because
 * the thing people actually break a task into is smaller pieces of the SAME kind of work, and a
 * checkbox cannot say "this half is blocked and that half shipped on Tuesday".
 *
 * What it deliberately does NOT carry is its own attempts or its own rollup. Cost, rounds and
 * tokens are measured per SESSION and roll up to the task; giving a subtask a second, smaller
 * rollup would either double-count the same sessions or invent a split nobody recorded. `done`
 * survives beside `status` because a tick is still the fastest way to close one, and it stays in
 * step with it: `done` is true exactly when `status` is `done`.
 */
export interface Subtask {
  id: string
  taskId: string
  title: string
  done: boolean
  status: TaskStatus
  createdAt: string
  updatedAt: string
  /** Free text, like `TaskComment.author` — a person, a session handle, an agent's label. */
  assignee?: string
  /** `yyyy-MM-dd`. A date the work is due, not a timestamp: nobody schedules to the second. */
  dueDate?: string
  startDate?: string
  /** One session filed under this specific piece. The task's own sessions stay on the task. */
  sessionId?: string
  notes?: string
  /**
   * Subtask ids, of the SAME task, that must be `done` before a session can be filed under this
   * one. See `task-attach.ts`'s `planAttach`, which is the only place this is actually enforced —
   * this field is the fact, not the rule.
   *
   * An id naming a subtask outside this task, or naming itself, is never written here — the
   * sanitize step lives beside the write (`patchSubtask`), the same place `Task.blockedBy`'s
   * cross-task version lives.
   */
  blockedBy?: string[]
}

/** `done` and `status` are one fact written twice; this keeps them from disagreeing. */
export function subtaskDone(status: TaskStatus): boolean {
  return status === 'done'
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
   * The activity log, newest LAST, for every task at once.
   *
   * One list rather than an array per task, because the question a coordinator asks is "what has
   * been happening", across the board — and because a per-task array makes the cap per task, so a
   * hundred tasks could hold a hundred caps' worth of history in a file read on every poll.
   */
  events: TaskEvent[]
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

export function newEventId(): string {
  return mint('e')
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
