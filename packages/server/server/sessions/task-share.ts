/**
 * task-share.ts — PURE. Which deliveries leave this machine, and what is left of them when they do.
 *
 * Two independent gates, and keeping them independent is the whole design:
 *
 *  1. **The TASK travels only if its owner said so** — `taskShared`, absent reading as NOT shared.
 *  2. **Its SESSIONS travel only if the connection's sharing rules already let them** —
 *     `sessionShared`, unchanged, decided by the caller and handed here as a set. Sharing a task
 *     may never widen what a repository rule withholds; it only ever adds the task's own record to
 *     what was already travelling.
 *
 * So a shared task whose work sits in a withheld repository ships its record and NONE of its
 * sessions — and `sessionsWithheld` says how many, because a delivery that arrives measured short
 * with nothing on screen explaining why is the same defect as a confident zero.
 *
 * The text is scrubbed by the CALLER through `redactSharedTask` at both boundaries; this module
 * decides membership and shape, never wording.
 */

import type {
  SharedSubtask, SharedTask, SharedTaskComment, SharedTaskFile, SharedTaskRecord,
} from '@agentistics/core'
import { taskShared, type Subtask, type Task, type TaskComment, type TaskFile } from './task-model'
import type { ManagedSession } from './types'

/** The task's own fields that travel — written out, never spread from the record. */
function shareRecord(t: Task): SharedTaskRecord {
  return {
    id: t.id,
    title: t.title,
    ...(t.detail !== undefined ? { detail: t.detail } : {}),
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.deliveredAt !== undefined ? { deliveredAt: t.deliveredAt } : {}),
    ...(t.priority !== undefined ? { priority: t.priority } : {}),
    ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
    ...(t.dueDate !== undefined ? { dueDate: t.dueDate } : {}),
    ...(t.startDate !== undefined ? { startDate: t.startDate } : {}),
    ...(t.labels !== undefined ? { labels: [...t.labels] } : {}),
    ...(t.blockedReason !== undefined ? { blockedReason: t.blockedReason } : {}),
    ...(t.repo !== undefined ? { repo: t.repo } : {}),
    ...(t.blockedBy !== undefined ? { blockedBy: [...t.blockedBy] } : {}),
  }
}

const shareComment = (c: TaskComment): SharedTaskComment =>
  ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })

const shareSubtask = (s: Subtask): SharedSubtask => ({
  id: s.id, title: s.title, done: s.done, status: s.status,
  createdAt: s.createdAt, updatedAt: s.updatedAt,
  ...(s.assignee !== undefined ? { assignee: s.assignee } : {}),
  ...(s.dueDate !== undefined ? { dueDate: s.dueDate } : {}),
  ...(s.startDate !== undefined ? { startDate: s.startDate } : {}),
  ...(s.notes !== undefined ? { notes: s.notes } : {}),
})

/** Identity and size. The BYTES stay on this machine — see `SharedTask`. */
const shareFile = (f: TaskFile): SharedTaskFile => ({
  id: f.id, name: f.name, size: f.size, createdAt: f.createdAt,
  ...(f.kind !== undefined ? { kind: f.kind } : {}),
  ...(f.author !== undefined ? { author: f.author } : {}),
})

export interface ShareInputs {
  tasks: readonly Task[]
  rows: readonly ManagedSession[]
  comments: readonly TaskComment[]
  subtasks: readonly Subtask[]
  files: readonly TaskFile[]
  /** Conversation ids this connection SHARES, from `sessionShared` — decided by the caller. */
  sharedIds: ReadonlySet<string>
  /**
   * Conversation ids this machine's store KNOWS.
   *
   * The two sets answer different questions, and `sessionsWithheld` needs both: a session the
   * store has never heard of was not withheld from anybody, it was never measured at all, and
   * counting it as withheld would report a shortfall this connection did not cause.
   */
  knownIds: ReadonlySet<string>
  /**
   * Which rows belong to a task — `rowsOfTask` from `task-report.ts`, passed in rather than
   * imported so this module stays free of the report's resolution.
   */
  rowsOf: (task: Task, rows: readonly ManagedSession[]) => ManagedSession[]
}

export function toSharedTask(task: Task, o: ShareInputs): SharedTask {
  const mine = o.rowsOf(task, o.rows)
  const sessionIds: string[] = []
  let withheld = 0
  for (const r of mine) {
    const id = r.conversationId
    if (!id) continue
    if (o.sharedIds.has(id)) {
      if (!sessionIds.includes(id)) sessionIds.push(id)
    } else if (o.knownIds.has(id)) {
      withheld++
    }
  }
  return {
    task: shareRecord(task),
    comments: o.comments.filter(c => c.taskId === task.id).map(shareComment),
    subtasks: o.subtasks.filter(s => s.taskId === task.id).map(shareSubtask),
    files: o.files.filter(f => f.taskId === task.id).map(shareFile),
    sessionIds,
    sessionsWithheld: withheld,
  }
}

/**
 * The deliveries that travel, in the book's own order.
 *
 * A task that is not shared is ABSENT — not present and empty. "This machine shares no task" and
 * "this task exists and is empty" are different facts, and only the machine's own operator may
 * turn the first into the second.
 */
export function selectSharedTasks(o: ShareInputs): SharedTask[] {
  return o.tasks.filter(taskShared).map(t => toSharedTask(t, o))
}
