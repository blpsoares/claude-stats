/**
 * task-web.ts — `/api/tasks`, the one door the web, the VS Code extension and the MCP come through.
 *
 * It holds NO arithmetic: `task-source.ts` reads and `task-report.ts` decides, exactly as the CLI
 * does. A surface that computed a rollup of its own would be a second answer to "what did this
 * delivery cost", and the two would drift.
 */

import { loadTaskWorld } from './task-source'
import { buildTaskDetail, buildTaskList, findTask, rowsOfTask } from './task-report'
import { planDeliveryEvidence, type DeliveryEvidence } from './task-evidence'
import { buildBoardOverview, type BoardOverview } from './task-overview'
import { scopeMetas, type TaskFilter } from './task-filter'
import { getCommitsInWindow } from '../git'
import { readPreferences, writePreferences } from '../preferences'
import {
  legacyTaskId, migratePriority, newCommentId, newEventId, newFileId, newLinkId, newSubtaskId,
  newTaskId, subtaskDone,
  type Task, type TaskEvent, type TaskStatus,
} from './task-model'
import { boardProgress, DEFAULT_LEASE_MS, planNext } from './task-next'
import { planAttach, sanitizeSubtaskBlockedBy } from './task-attach'
import { planMove } from './task-rank'
import { compareBy } from '@agentistics/core'
import { deleteTaskFile, deleteTaskFiles, readTaskFile, writeTaskFile } from './task-files'
import type { TaskDetail, TaskListRow } from './task-report'

export interface TaskListReply {
  tasks: TaskListRow[]
  /** The board as a whole — what the page shows FIRST, before any kanban. */
  overview: BoardOverview
  /**
   * How many sessions the page's filters kept out of these numbers.
   *
   * Reported rather than swallowed: a rollup that silently shrank is the same defect as a confident
   * zero — the figure is smaller and nothing on screen says why.
   */
  excludedByFilter: number
}

export interface TaskDetailReply {
  task: TaskDetail
  /** See `TaskListReply.excludedByFilter`. */
  excludedByFilter?: number
  /** Present only once the task has been delivered. */
  evidence?: DeliveryEvidence
}

export async function listTasks(filter?: TaskFilter): Promise<TaskListReply> {
  const w = await loadTaskWorld()
  const scoped = scopeMetas(w.metas, filter)
  return {
    tasks: buildTaskList({
      tasks: w.book.tasks,
      attempts: w.book.attempts,
      rows: w.rows,
      metas: scoped.metas,
      costOf: w.costOf,
      comments: w.book.comments,
      subtasks: w.book.subtasks,
      files: w.book.files,
    }),
    overview: buildBoardOverview({
      tasks: w.book.tasks, rows: w.rows, metas: scoped.metas, costOf: w.costOf,
    }),
    excludedByFilter: scoped.excluded,
  }
}

export async function showTask(
  ref: string,
  filter?: TaskFilter,
): Promise<TaskDetailReply | null> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return null
  const scoped = scopeMetas(w.metas, filter)
  return {
    excludedByFilter: scoped.excluded,
    task: buildTaskDetail({
      task,
      attempts: w.book.attempts,
      rows: w.rows,
      metas: scoped.metas,
      costOf: w.costOf,
      comments: w.book.comments.filter(c => c.taskId === task.id),
      subtasks: w.book.subtasks.filter(t => t.taskId === task.id),
      files: w.book.files.filter(f => f.taskId === task.id),
    }),
  }
}

/** Create a task. Title is required; a description is not — a task nobody described is a task. */
export async function createTask(o: { title: string; detail?: string }): Promise<Task | null> {
  const title = o.title.trim()
  if (!title) return null
  const w = await loadTaskWorld()
  // Same title = same work. Creating a second one silently would split a delivery's metrics in two
  // with nothing on screen saying why.
  const existing = w.book.tasks.find(t => t.title === title)
  if (existing) return existing
  // Creating a name again lifts its tombstone: the delete was about that record, not a ban on the
  // words.
  await w.store.clearTombstone(legacyTaskId(title))
  const now = new Date().toISOString()
  const task: Task = {
    id: newTaskId(),
    title,
    status: 'todo',
    createdAt: now,
    updatedAt: now,
    ...(o.detail?.trim() ? { detail: o.detail.trim() } : {}),
  }
  await w.store.upsertTask(task)
  return task
}

export async function editTask(
  ref: string,
  patch: {
    title?: string
    detail?: string
    priority?: string
    assignee?: string
    dueDate?: string
    startDate?: string
    labels?: string[]
    actor?: string
  },
): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const now = new Date().toISOString()
  // An UNKNOWN priority word is refused rather than coerced: `migratePriority` would read it as
  // `none`, which is a real answer ("nobody has said") and would silently overwrite a real one.
  const priority = patch.priority !== undefined ? migratePriority(patch.priority) : undefined
  const ok = await w.store.patchTask(task.id, {
    ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
    // An EMPTY description is a deliberate clearing, which is why it is not filtered out the way an
    // empty title is: a title is an identity, a description is a note. Same for every field below:
    // an empty string CLEARS, an absent key leaves the value alone.
    ...(patch.detail !== undefined ? { detail: patch.detail.trim() } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(patch.assignee !== undefined ? { assignee: patch.assignee.trim() } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate.trim() } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate.trim() } : {}),
    ...(patch.labels !== undefined
      ? { labels: patch.labels.map(l => l.trim()).filter(Boolean) }
      : {}),
    updatedAt: now,
  })
  if (!ok) return false
  const changes: TaskEvent[] = []
  const actor = patch.actor?.trim() || 'you'
  if (priority !== undefined && priority !== (task.priority ?? 'none')) {
    changes.push(event(task.id, actor, 'priority', { from: task.priority ?? 'none', to: priority }))
  }
  if (patch.assignee !== undefined && patch.assignee.trim() !== (task.assignee ?? '')) {
    changes.push(event(task.id, actor, 'assign', {
      from: task.assignee ?? '', to: patch.assignee.trim() || 'nobody',
    }))
  }
  await w.store.logEvents(changes)
  return true
}

/** One log line. The store caps the log; this only ever writes what happened. */
function event(
  taskId: string,
  actor: string,
  kind: string,
  o: { from?: string; to?: string; detail?: string } = {},
): TaskEvent {
  return {
    id: newEventId(), taskId, actor, kind, at: new Date().toISOString(),
    ...(o.from !== undefined ? { from: o.from } : {}),
    ...(o.to !== undefined ? { to: o.to } : {}),
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
  }
}

/**
 * TAKE a task — the multi-agent primitive.
 *
 * The decision is the store's, under the lock (see `TaskStore.claimTask`); this layer only resolves
 * the reference, defaults the lease, and records what happened. A refusal NAMES the holder and when
 * their lease runs out, because "somebody has it" without saying who leaves the caller with nothing
 * to do but retry blindly.
 */
export async function claimTask(o: {
  ref: string
  by: string
  leaseMs?: number
  sessionId?: string
  note?: string
  takeover?: boolean
}): Promise<{ ok: boolean; task?: Task; reason?: string; heldBy?: string; until?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(o.ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task' }
  const by = o.by.trim()
  if (!by) return { ok: false, reason: 'no_actor' }
  const res = await w.store.claimTask({
    id: task.id, by, nowMs: Date.now(),
    leaseMs: o.leaseMs && o.leaseMs > 0 ? o.leaseMs : DEFAULT_LEASE_MS,
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.note ? { note: o.note } : {}),
    ...(o.takeover ? { takeover: true } : {}),
  })
  if (!res.ok) {
    return {
      ok: false,
      reason: res.reason,
      ...(res.task?.claim ? { heldBy: res.task.claim.by, until: res.task.claim.expiresAt } : {}),
    }
  }
  await w.store.logEvents([event(task.id, by, 'claim', {
    to: res.task.claim?.expiresAt ?? '',
    ...(o.takeover ? { detail: 'takeover' } : {}),
  })])
  return { ok: true, task: res.task }
}

export async function releaseTask(o: { ref: string; by: string; force?: boolean }):
Promise<{ ok: boolean; reason?: string; heldBy?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(o.ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task' }
  const res = await w.store.releaseTask({
    id: task.id, by: o.by.trim(), ...(o.force ? { force: true } : {}),
  })
  if (!res.ok) {
    return { ok: false, reason: res.reason, ...(res.task?.claim ? { heldBy: res.task.claim.by } : {}) }
  }
  await w.store.logEvents([event(task.id, o.by.trim() || 'you', 'release')])
  return { ok: true }
}

/**
 * What an agent can pick up right now, and why the rest is withheld.
 *
 * The FILTER applies to the sessions a task's numbers are read from, not to which tasks exist, so
 * this deliberately takes none: "what can I work on" is not a question about a date range.
 */
export async function nextTasks(o: { actor?: string; limit?: number } = {}): Promise<{
  ready: Array<{ task: Task; position: number }>
  withheld: Array<{ id: string; title: string; why: string; detail?: string }>
  progress: ReturnType<typeof boardProgress>
}> {
  const w = await loadTaskWorld()
  const nowMs = Date.now()
  const plan = planNext({
    tasks: w.book.tasks, nowMs,
    ...(o.actor ? { actor: o.actor } : {}),
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
  })
  return {
    ready: plan.ready,
    withheld: plan.withheld.map(x => ({
      id: x.task.id,
      title: x.task.title,
      why: x.why.reason,
      ...(x.why.reason === 'blocked' ? { detail: x.why.by.join(', ') } : {}),
      ...(x.why.reason === 'claimed' ? { detail: `${x.why.by} until ${x.why.until}` } : {}),
      ...(x.why.reason === 'status' ? { detail: x.why.status } : {}),
    })),
    progress: boardProgress(w.book.tasks, nowMs),
  }
}

/** The activity log, newest FIRST here — a reader starts at what just happened. */
export async function taskActivity(o: { ref?: string; limit?: number } = {}): Promise<TaskEvent[]> {
  const w = await loadTaskWorld()
  const task = o.ref ? findTask(o.ref, w.book.tasks) : null
  if (o.ref && !task) return []
  const all = task ? w.book.events.filter(e => e.taskId === task.id) : w.book.events
  const newestFirst = [...all].reverse()
  return o.limit !== undefined ? newestFirst.slice(0, Math.max(0, o.limit)) : newestFirst
}

/**
 * Move a card by hand, within the column it is being dropped into.
 *
 * `index` is the position among the cards of that STATUS after the move, which is what a drag
 * actually knows. Moving between columns is a status change and is `markTask`'s job — done here it
 * would be two facts written by one call, and a failure halfway would leave the card in a column
 * its status does not name.
 */
export async function moveTask(o: { ref: string; index: number; actor?: string }):
Promise<{ ok: boolean; reason?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(o.ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task' }
  const column = w.book.tasks
    .filter(t => t.status === task.status)
    .sort((a, b) => compareBy({ key: 'manual', dir: 'asc' }, { task: a }, { task: b }))
  await w.store.setRanks(planMove(column, task.id, o.index))
  await w.store.logEvents([event(task.id, o.actor?.trim() || 'you', 'move', {
    detail: `${task.status}#${o.index + 1}`,
  })])
  return { ok: true }
}

export async function deleteTask(ref: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const ok = await w.store.removeTask(task.id)
  if (!ok) return false
  // The bytes go with the record. The SESSIONS do not — see `TaskStore.removeTask`.
  await deleteTaskFiles(task.id)
  // And the NAME leaves `preferences.finishedTasks`, which is the other place the migration reads
  // from: a tombstone alone would stop the re-mint while the cockpit went on listing it as finished.
  const prefs = await readPreferences().catch(() => null)
  const current = prefs?.finishedTasks ?? []
  if (current.includes(task.title)) {
    await writePreferences({ finishedTasks: current.filter(t => t !== task.title) }).catch(() => undefined)
  }
  return true
}

export async function addComment(ref: string, o: { author: string; body: string }): Promise<boolean> {
  const body = o.body.trim()
  if (!body) return false
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  await w.store.addComment({
    id: newCommentId(),
    taskId: task.id,
    author: o.author.trim() || 'unknown',
    body,
    createdAt: new Date().toISOString(),
  })
  return true
}

/** An empty body is a DELETE by another name, so it is refused rather than silently blanking a row. */
export async function editComment(commentId: string, body: string): Promise<boolean> {
  const text = body.trim()
  if (!text) return false
  const w = await loadTaskWorld()
  return await w.store.editComment(commentId, text)
}

export async function removeComment(commentId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  return await w.store.removeComment(commentId)
}

export async function addSubtask(ref: string, title: string): Promise<boolean> {
  const t = title.trim()
  if (!t) return false
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const now = new Date().toISOString()
  await w.store.upsertSubtask({
    id: newSubtaskId(), taskId: task.id, title: t,
    status: 'todo', done: false, createdAt: now, updatedAt: now,
  })
  return true
}

/**
 * Change any column of a subtask.
 *
 * `done` is never taken from the caller — it is derived from `status`, because two fields for one
 * fact drift and a row reading `done: false, status: 'done'` has no correct interpretation. A
 * caller that ticks the box sends `status: 'done'`; one that moves the status gets the tick free.
 */
export async function patchSubtask(subtaskId: string, patch: {
  title?: string
  status?: TaskStatus
  assignee?: string
  dueDate?: string
  startDate?: string
  sessionId?: string
  notes?: string
  /** Sanitized against this subtask's OWN siblings — see `sanitizeSubtaskBlockedBy`. */
  blockedBy?: string[]
}): Promise<boolean> {
  const w = await loadTaskWorld()
  const found = w.book.subtasks.find(t => t.id === subtaskId)
  if (!found) return false
  const status = patch.status ?? found.status
  await w.store.upsertSubtask({
    ...found,
    ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
    status,
    done: subtaskDone(status),
    // An empty string CLEARS the column — that is how a date or an assignee is removed, and it is
    // why these are not filtered out the way an empty title is.
    ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
    ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
    ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.blockedBy !== undefined ? {
      blockedBy: sanitizeSubtaskBlockedBy({
        subtaskId: found.id, taskId: found.taskId, ids: patch.blockedBy, siblings: w.book.subtasks,
      }),
    } : {}),
    updatedAt: new Date().toISOString(),
  })
  return true
}

export async function removeSubtask(subtaskId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const found = w.book.subtasks.find(t => t.id === subtaskId)
  if (!found) return false
  await w.store.removeSubtask(subtaskId)
  return true
}

/** The tick, expressed as what it means: a move to `done`, or back to `todo`. */
export async function setSubtaskDone(subtaskId: string, done: boolean): Promise<boolean> {
  return await patchSubtask(subtaskId, { status: done ? 'done' : 'todo' })
}

/** The bytes land FIRST. A failed write must leave no record claiming the file exists. */
/**
 * Returns the new file's ID, never a bare `true`.
 *
 * A COMMENT can carry an attachment, and it references it by id — so an upload that answered only
 * "it worked" left the caller having to guess which of the task's files it had just created, which
 * on two screenshots pasted in the same second is a guess that goes wrong.
 */
export async function attachFile(
  ref: string,
  o: { name: string; bytes: Uint8Array; kind?: string; author?: string },
): Promise<string | null> {
  const name = o.name.trim()
  if (!name) return null
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return null
  const id = newFileId()
  let size: number
  try {
    size = await writeTaskFile(task.id, id, o.bytes)
  } catch {
    return null
  }
  await w.store.addFile({
    id, taskId: task.id, name, size,
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.author ? { author: o.author } : {}),
    createdAt: new Date().toISOString(),
  })
  return id
}

export async function fetchFile(fileId: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const w = await loadTaskWorld()
  const rec = w.book.files.find(f => f.id === fileId)
  if (!rec) return null
  const bytes = await readTaskFile(rec.taskId, rec.id)
  // A record whose bytes are gone is a FACT, reported as a miss rather than an empty download that
  // looks like an empty file.
  return bytes ? { name: rec.name, bytes } : null
}

export async function removeFile(fileId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const rec = w.book.files.find(f => f.id === fileId)
  if (!rec) return false
  await deleteTaskFile(rec.taskId, rec.id)
  return await w.store.removeFile(fileId)
}

/**
 * Mark a task delivered or abandoned.
 *
 * `delivered` attaches the git evidence of the window; `abandoned` attaches NONE — commits under an
 * attempt that was given up on would read as a delivery, which is the one thing this record must
 * not say.
 *
 * The finished NAME is mirrored into `preferences.finishedTasks` so the cockpit's own `finishTask`,
 * which reads that list, never disagrees with the board about what is done.
 */
/**
 * Set which tasks block this one.
 *
 * Self-blocking is refused rather than sanitised away silently — asking for it is a mistake worth
 * hearing about. A blocker that does not exist is dropped: a dangling id would render as a blocker
 * nobody can find or clear.
 */
export async function setBlockedBy(ref: string, ids: readonly string[]): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const known = new Set(w.book.tasks.map(t => t.id))
  const clean = [...new Set(ids)].filter(id => id !== task.id && known.has(id))
  return await w.store.patchTask(task.id, { blockedBy: clean, updatedAt: new Date().toISOString() })
}

/** Attach a link. Refused unless it is http(s) — see `sanitizeLink`. */
export async function addLink(
  ref: string,
  o: { url: string; label?: string; kind?: string },
): Promise<boolean> {
  const url = o.url.trim()
  if (!/^https?:\/\//i.test(url)) return false
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const link = {
    id: newLinkId(), url,
    ...(o.label?.trim() ? { label: o.label.trim() } : {}),
    ...(o.kind?.trim() ? { kind: o.kind.trim() } : {}),
  }
  return await w.store.patchTask(task.id, {
    links: [...(task.links ?? []), link],
    updatedAt: new Date().toISOString(),
  })
}

export async function removeLink(ref: string, linkId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  return await w.store.patchTask(task.id, {
    links: (task.links ?? []).filter(l => l.id !== linkId),
    updatedAt: new Date().toISOString(),
  })
}

/**
 * File an existing session under a task.
 *
 * Writes BOTH `taskId` and the free-text `task`: the id is what every rollup joins on, and the name
 * is what the cockpit, `session ls` and the harness-facing surfaces already read. Writing only one
 * would make the same session look filed in one place and loose in another.
 *
 * The task INHERITS the session's repository when it has none of its own. That is the point of
 * linking a live session first: the work is already somewhere, and asking a person to retype where
 * is asking them for a fact the machine holds. It never OVERWRITES a repo the task already carries
 * — a task that spans two repos keeps the one it was given.
 */
/**
 * File a session under a delivery, or under one of its SUBTASKS.
 *
 * `subtaskId` makes it a subtask filing, and it is a MOVE either way: `planAttach` decides the
 * whole pair, so filing under a subtask replaces a direct filing and filing under the task clears
 * the subtask. A session is never under both — see `task-attach.ts`, which is the only place that
 * rule exists.
 */
/**
 * What `attachSession` answers, instead of a bare boolean.
 *
 * A client that ends up here because a subtask is BLOCKED needs to say so in words and name what
 * is still open — the whole point of "diz que a subtask ainda está bloqueada e pergunta se você já
 * finalizou". A caller that only wants the yes/no still gets it: `ok` is always there.
 */
export type AttachResult =
  | { ok: true }
  | {
    ok: false
    reason: 'no_such_task' | 'no_such_session' | 'no_such_subtask' | 'needs_subtask'
      | 'wrong_delivery' | 'blocked'
    /** Set only for `reason: 'blocked'` — the subtask ids still open. */
    blockedBy?: readonly string[]
  }

export async function attachSession(
  ref: string,
  sessionId: string,
  o: { subtaskId?: string } = {},
): Promise<AttachResult> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task' }
  const row = w.rows.find(r => r.id === sessionId)
  if (!row) return { ok: false, reason: 'no_such_session' }

  // A DELIVERY DOES NOT TAKE SESSIONS: without a subtask this refuses, and the surfaces offer
  // "create one and move it here" rather than filing at the wrong level.
  const plan = planAttach({
    target: o.subtaskId ? { kind: 'subtask', id: o.subtaskId } : { kind: 'task', id: task.id },
    taskIds: w.book.tasks.map(t => t.id),
    subtasks: w.book.subtasks.map(st => ({
      id: st.id, taskId: st.taskId, done: st.done, blockedBy: st.blockedBy,
    })),
  })
  if (!plan.ok) {
    return plan.reason === 'blocked'
      ? { ok: false, reason: 'blocked', blockedBy: plan.blockedBy }
      : { ok: false, reason: plan.reason }
  }
  // A subtask of ANOTHER delivery is refused rather than quietly re-parenting the session: the
  // caller named a task, and honouring a subtask outside it would file the work somewhere nobody
  // asked for.
  if (plan.taskId !== task.id) return { ok: false, reason: 'wrong_delivery' }

  const { patchSession } = await import('./registry')
  const ok = await patchSession(row.id, {
    taskId: task.id,
    task: task.title,
    // `null` CLEARS — a move from a subtask back to the delivery leaves nothing behind.
    subtaskId: plan.subtaskId,
  })
  if (!ok) return { ok: false, reason: 'no_such_session' }

  // The record first, then LIVE git. Every row written before `ManagedSession.repo` existed carries
  // nothing, which is most of the fleet on a machine that has been running a while — and reading
  // `row.repo` alone made "link a session to inherit its repo" inherit nothing at all. `repoFacts`
  // is the same resolver the fleet uses: it prefers live git, falls back to the record, and says
  // `missing` for a directory that is gone rather than inventing a name from the path.
  if (!task.repo) {
    const { repoFacts } = await import('./repo-facts')
    const facts = await repoFacts(row.cwd, row.repo).catch(() => null)
    const repo = facts?.repo
    if (repo) await w.store.patchTask(task.id, { repo, updatedAt: new Date().toISOString() })
  }
  await w.store.logEvents([event(task.id, row.label || sessionId, 'session', {
    to: sessionId, detail: row.harness,
  })])
  return { ok: true }
}

/**
 * Unfile a session.
 *
 * The row keeps existing and keeps its history — only the attribution goes. `patchSession` writes
 * fields rather than clearing them, so the empty strings here are what "no longer filed" looks like
 * on this record; `rowsOfTask` matches on a non-empty id or name, so an empty one belongs to no task.
 */
export async function detachSession(sessionId: string): Promise<boolean> {
  const { patchSession } = await import('./registry')
  // The SUBTASK goes with it. Unfiling a session that left a `subtaskId` behind would leave it
  // drawn under a subtask of a delivery it is no longer part of.
  return await patchSession(sessionId, {
    taskId: '', attemptId: '', task: '', subtaskId: null,
  })
}

export async function markTask(
  ref: string,
  to: TaskStatus,
  actor?: string,
  o: {
    /** Why, in the blocker's own words. Required by `blocked` unless a blocking TASK is named. */
    reason?: string
    /** Blocking task ids to set as part of the same move — the other way to answer "why". */
    blockedBy?: readonly string[]
  } = {},
): Promise<{ ok: boolean; evidence?: DeliveryEvidence; message?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return { ok: false, message: 'no_such_task' }

  const now = new Date().toISOString()
  const reason = o.reason?.trim() ?? ''

  /*
   * `blocked` must SAY what it is waiting on.
   *
   * It is the one status that names a problem somebody has to go and solve, and a board of blocked
   * cards that do not say why is a board nobody can unblock: the fact lives only in the head of
   * whoever moved it, who by then has moved on. `task_next` already reports these as withheld —
   * without a reason that report is "you cannot have this" with no way forward.
   *
   * The check is HERE and not in the browser, so it binds the MCP and the CLI too. An assistant
   * that cannot say why it is blocked has not finished thinking about being blocked.
   */
  if (to === 'blocked') {
    const blockers = o.blockedBy ?? task.blockedBy ?? []
    if (!reason && blockers.length === 0) {
      return { ok: false, message: 'blocked_needs_reason' }
    }
    if (o.blockedBy) {
      await w.store.patchTask(task.id, {
        blockedBy: [...new Set(o.blockedBy.filter(id => id !== task.id))],
        updatedAt: now,
      })
    }
  }
  // `done` is the ONE status that stamps a delivery. Every other move is a change of where the work
  // stands, and stamping one of those would close rounds-to-delivery on work that is not delivered.
  const done = to === 'done'
  await w.store.patchTask(task.id, {
    status: to,
    updatedAt: now,
    ...(done ? { deliveredAt: now } : {}),
    // The reason belongs to THIS block. Leaving `blocked` clears it: a sentence that outlived its
    // block reads as current, which is worse than none.
    ...(to === 'blocked' ? { blockedReason: reason } : { blockedReason: '' }),
  })
  // Attempts only ever settle when the TASK settles. An in-progress task leaves them running.
  if (done || to === 'abandoned') {
    for (const a of w.book.attempts.filter(a => a.taskId === task.id && a.status === 'running')) {
      await w.store.patchAttempt(a.id, {
        status: done ? 'delivered' : 'abandoned',
        updatedAt: now,
        ...(done ? { deliveredAt: now } : {}),
      })
    }
  }

  // The status change is the log's most important line: on a board several agents drive, "who
  // moved this to blocked, and when" is not rhetorical.
  await w.store.logEvents([event(task.id, actor?.trim() || 'you', 'status', {
    from: task.status, to,
    // The log carries the reason with the move, so "why was this blocked on Tuesday" survives the
    // task being unblocked and the field being cleared.
    ...(to === 'blocked' && reason ? { detail: reason } : {}),
  })])

  const prefs = await readPreferences().catch(() => null)
  const current = prefs?.finishedTasks ?? []
  const next = done
    ? [...new Set([...current, task.title])]
    : current.filter(t => t !== task.title)
  if (next.length !== current.length) {
    await writePreferences({ finishedTasks: next }).catch(() => undefined)
  }

  if (!done) return { ok: true }

  const mine = rowsOfTask(task, w.rows)
  const dirs = [...new Set(mine.map(r => r.cwd).filter(Boolean))]
  const bySha = new Map<string, { sha: string; message: string; atMs: number }>()
  for (const dir of dirs) {
    // Deduped by sha: two sessions of one task routinely share a checkout, and the same commit read
    // twice would double every count in the evidence block.
    for (const c of await getCommitsInWindow(dir, task.createdAt, now)) {
      if (!bySha.has(c.sha)) bySha.set(c.sha, c)
    }
  }
  return {
    ok: true,
    evidence: planDeliveryEvidence({
      startedMs: Date.parse(task.createdAt) || 0,
      deliveredMs: Date.parse(now),
      commits: [...bySha.values()],
    }),
  }
}
