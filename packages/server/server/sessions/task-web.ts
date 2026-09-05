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
import { getCommitsInWindow } from '../git'
import { readPreferences, writePreferences } from '../preferences'
import type { TaskDetail, TaskListRow } from './task-report'

export interface TaskListReply {
  tasks: TaskListRow[]
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
    }),
  }
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
export async function markTask(
  ref: string,
  to: 'delivered' | 'abandoned',
): Promise<{ ok: boolean; evidence?: DeliveryEvidence; message?: string }> {
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) return { ok: false, message: 'no_such_task' }

  const now = new Date().toISOString()
  await w.store.patchTask(task.id, {
    status: to,
    updatedAt: now,
    ...(to === 'delivered' ? { deliveredAt: now } : {}),
  })
  for (const a of w.book.attempts.filter(a => a.taskId === task.id && a.status === 'running')) {
    await w.store.patchAttempt(a.id, {
      status: to,
      updatedAt: now,
      ...(to === 'delivered' ? { deliveredAt: now } : {}),
    })
  }

  const prefs = await readPreferences().catch(() => null)
  const current = prefs?.finishedTasks ?? []
  const next = to === 'delivered'
    ? [...new Set([...current, task.title])]
    : current.filter(t => t !== task.title)
  if (next.length !== current.length) {
    await writePreferences({ finishedTasks: next }).catch(() => undefined)
  }

  if (to === 'abandoned') return { ok: true }

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
