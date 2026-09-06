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
import { getCommitsInWindow } from '../git'
import { readPreferences, writePreferences } from '../preferences'
import {
  legacyTaskId, newCommentId, newFileId, newLinkId, newSubtaskId, newTaskId,
  type Task, type TaskStatus,
} from './task-model'
import { deleteTaskFile, deleteTaskFiles, readTaskFile, writeTaskFile } from './task-files'
import type { TaskDetail, TaskListRow } from './task-report'

export interface TaskListReply {
  tasks: TaskListRow[]
  /** The board as a whole — what the page shows FIRST, before any kanban. */
  overview: BoardOverview
}

export interface TaskDetailReply {
  task: TaskDetail
  /** Present only once the task has been delivered. */
  evidence?: DeliveryEvidence
}

export async function listTasks(): Promise<TaskListReply> {
  const w = await loadTaskWorld()
  return {
    tasks: buildTaskList({
      tasks: w.book.tasks,
      attempts: w.book.attempts,
      rows: w.rows,
      metas: w.metas,
      costOf: w.costOf,
      comments: w.book.comments,
      subtasks: w.book.subtasks,
      files: w.book.files,
    }),
    overview: buildBoardOverview({
      tasks: w.book.tasks, rows: w.rows, metas: w.metas, costOf: w.costOf,
    }),
  }
}

export async function showTask(ref: string): Promise<TaskDetailReply | null> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return null
  return {
    task: buildTaskDetail({
      task,
      attempts: w.book.attempts,
      rows: w.rows,
      metas: w.metas,
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
  patch: { title?: string; detail?: string },
): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  return await w.store.patchTask(task.id, {
    ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
    // An EMPTY description is a deliberate clearing, which is why it is not filtered out the way an
    // empty title is: a title is an identity, a description is a note.
    ...(patch.detail !== undefined ? { detail: patch.detail.trim() } : {}),
    updatedAt: new Date().toISOString(),
  })
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
    id: newSubtaskId(), taskId: task.id, title: t, done: false, createdAt: now, updatedAt: now,
  })
  return true
}

export async function setSubtaskDone(subtaskId: string, done: boolean): Promise<boolean> {
  const w = await loadTaskWorld()
  const found = w.book.subtasks.find(t => t.id === subtaskId)
  if (!found) return false
  await w.store.upsertSubtask({ ...found, done, updatedAt: new Date().toISOString() })
  return true
}

/** The bytes land FIRST. A failed write must leave no record claiming the file exists. */
export async function attachFile(
  ref: string,
  o: { name: string; bytes: Uint8Array; kind?: string; author?: string },
): Promise<boolean> {
  const name = o.name.trim()
  if (!name) return false
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const id = newFileId()
  let size: number
  try {
    size = await writeTaskFile(task.id, id, o.bytes)
  } catch {
    return false
  }
  await w.store.addFile({
    id, taskId: task.id, name, size,
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.author ? { author: o.author } : {}),
    createdAt: new Date().toISOString(),
  })
  return true
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
export async function attachSession(ref: string, sessionId: string): Promise<boolean> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return false
  const row = w.rows.find(r => r.id === sessionId)
  if (!row) return false

  const { patchSession } = await import('./registry')
  const ok = await patchSession(row.id, { taskId: task.id, task: task.title })
  if (!ok) return false

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
  return true
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
  return await patchSession(sessionId, { taskId: '', attemptId: '', task: '' })
}

export async function markTask(
  ref: string,
  to: TaskStatus,
): Promise<{ ok: boolean; evidence?: DeliveryEvidence; message?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return { ok: false, message: 'no_such_task' }

  const now = new Date().toISOString()
  // `done` is the ONE status that stamps a delivery. Every other move is a change of where the work
  // stands, and stamping one of those would close rounds-to-delivery on work that is not delivered.
  const done = to === 'done'
  await w.store.patchTask(task.id, {
    status: to,
    updatedAt: now,
    ...(done ? { deliveredAt: now } : {}),
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
