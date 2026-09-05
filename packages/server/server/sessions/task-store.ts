/**
 * task-store.ts — the task book on disk, and the only file in this feature that touches it.
 *
 * Shape and durability rules come from `tags-local-store.ts` and `registry.ts`, unchanged because
 * they were learned from real losses: temp-file-then-rename, so a crash cannot leave a truncated
 * file a reader would parse-fail on; corrupt bytes quarantined rather than overwritten, so a parse
 * failure degrades to "no tasks" instead of erasing them; a no-op mutation writing nothing.
 *
 * Mutations additionally run under `withFileLock`. The in-process promise chain is only half the
 * problem, because agentop runs as several processes: the server, the cockpit, and every one-shot
 * command. See `file-lock.ts`.
 *
 * A CONTENDED write is retried once. `withFileLock`'s wait is bounded and it runs the callback
 * ANYWAY when the wait expires, reporting `contended` — the right trade for a session that has
 * already been spawned, where a lost label beats a live session with no record, and the wrong one
 * here: nothing has been started, and a task silently lost has no running process to be adopted
 * back from. The retry re-runs the whole read-modify-write, which is idempotent, so the second pass
 * merges with whatever the other process wrote in between.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from './file-lock'
import type { Attempt, AttemptStatus, Task, TaskBook, TaskStatus } from './task-model'

export interface TaskPatch {
  title?: string
  detail?: string
  status?: TaskStatus
  deliveredAt?: string
  repo?: string
  updatedAt?: string
}

export interface AttemptPatch {
  label?: string
  status?: AttemptStatus
  deliveredAt?: string
  updatedAt?: string
}

export interface TaskStore {
  read(): Promise<TaskBook>
  upsertTask(task: Task): Promise<void>
  upsertAttempt(attempt: Attempt): Promise<void>
  /** False when no record carries that id — never a silent success. */
  patchTask(id: string, patch: TaskPatch): Promise<boolean>
  patchAttempt(id: string, patch: AttemptPatch): Promise<boolean>
}

/** Keep only records shaped enough to be used safely downstream. */
function sanitizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || !t.id) return null
  if (typeof t.title !== 'string' || !t.title) return null
  const status = t.status
  return {
    id: t.id,
    title: t.title,
    status: status === 'delivered' || status === 'abandoned' ? status : 'open',
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString(),
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date(0).toISOString(),
    ...(typeof t.detail === 'string' ? { detail: t.detail } : {}),
    ...(typeof t.deliveredAt === 'string' ? { deliveredAt: t.deliveredAt } : {}),
    ...(typeof t.repo === 'string' ? { repo: t.repo } : {}),
  }
}

/**
 * An attempt is kept only when it names a TASK and a HARNESS.
 *
 * Without `taskId` it belongs to nothing and no reader that walks tasks would ever see it again;
 * without a harness it is not a configuration of anything. Both are load-bearing in the way
 * `sanitize`'s three fields are in `registry.ts` — the rest is trusted once these check out.
 */
function sanitizeAttempt(raw: unknown): Attempt | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (typeof a.id !== 'string' || !a.id) return null
  if (typeof a.taskId !== 'string' || !a.taskId) return null
  const cfg = (a.config ?? {}) as Record<string, unknown>
  if (typeof cfg.harness !== 'string' || !cfg.harness) return null
  const status = a.status
  return {
    id: a.id,
    taskId: a.taskId,
    label: typeof a.label === 'string' ? a.label : a.id,
    config: {
      harness: cfg.harness as Attempt['config']['harness'],
      ...(typeof cfg.model === 'string' ? { model: cfg.model } : {}),
      ...(typeof cfg.effort === 'string' ? { effort: cfg.effort } : {}),
      ...(typeof cfg.method === 'string' ? { method: cfg.method } : {}),
    },
    status: status === 'delivered' || status === 'abandoned' ? status : 'running',
    startedAt: typeof a.startedAt === 'string' ? a.startedAt : new Date(0).toISOString(),
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : new Date(0).toISOString(),
    ...(typeof a.deliveredAt === 'string' ? { deliveredAt: a.deliveredAt } : {}),
  }
}

export function createTaskStore(file: string): TaskStore {
  // One in-process writer. Each mutation appends to this chain, so read-modify-write sequences run
  // strictly one after another even when several land at once.
  let queue: Promise<unknown> = Promise.resolve()
  // Set when a read failed to parse. The bad bytes are still on disk at that point; they are moved
  // aside (not overwritten) by the next write, so the empty book a corrupt file produces can never
  // become permanent data loss.
  let corrupt = false

  async function read(): Promise<TaskBook> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      corrupt = false
      return { tasks: [], attempts: [] }
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      corrupt = false
      const tasks = Array.isArray(raw.tasks) ? raw.tasks : []
      const attempts = Array.isArray(raw.attempts) ? raw.attempts : []
      return {
        tasks: tasks.map(sanitizeTask).filter((t): t is Task => t !== null),
        attempts: attempts.map(sanitizeAttempt).filter((a): a is Attempt => a !== null),
      }
    } catch {
      corrupt = true
      return { tasks: [], attempts: [] }
    }
  }

  async function write(book: TaskBook): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    if (corrupt) {
      await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
      corrupt = false
    }
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(book, null, 2), 'utf8')
    await rename(tmp, file)
  }

  /** One mutation, under the cross-process lock, re-run once when the lock was contended. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      let contended = false
      const first = await withFileLock(file, async held => {
        contended = held.contended
        return fn()
      })
      if (!contended) return first
      return await withFileLock(file, () => fn())
    }
    const next = queue.then(run)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    read,
    upsertTask(task) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, tasks: [...book.tasks.filter(t => t.id !== task.id), task] })
      })
    },
    upsertAttempt(attempt) {
      return enqueue(async () => {
        const book = await read()
        await write({
          ...book,
          attempts: [...book.attempts.filter(a => a.id !== attempt.id), attempt],
        })
      })
    },
    patchTask(id, patch) {
      return enqueue(async () => {
        const book = await read()
        const target = book.tasks.find(t => t.id === id)
        // Nothing to change: writing anyway would touch the file, and pointlessly clear a pending
        // corrupt-quarantine, for a no-op.
        if (!target) return false
        const next = { ...target, ...patch }
        await write({ ...book, tasks: book.tasks.map(t => (t.id === id ? next : t)) })
        return true
      })
    },
    patchAttempt(id, patch) {
      return enqueue(async () => {
        const book = await read()
        const target = book.attempts.find(a => a.id === id)
        if (!target) return false
        const next = { ...target, ...patch }
        await write({ ...book, attempts: book.attempts.map(a => (a.id === id ? next : a)) })
        return true
      })
    },
  }
}
