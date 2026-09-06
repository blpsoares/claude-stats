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
import { migrateStatus } from './task-model'
import type {
  Attempt, AttemptStatus, Subtask, Task, TaskBook, TaskComment, TaskFile, TaskLink, TaskStatus,
} from './task-model'

export interface TaskPatch {
  title?: string
  detail?: string
  status?: TaskStatus
  deliveredAt?: string
  repo?: string
  updatedAt?: string
  blockedBy?: string[]
  links?: TaskLink[]
}

export interface AttemptPatch {
  label?: string
  status?: AttemptStatus
  deliveredAt?: string
  updatedAt?: string
}

const EMPTY_BOOK = (): TaskBook =>
  ({ tasks: [], attempts: [], comments: [], subtasks: [], files: [], tombstones: [] })

export interface TaskStore {
  read(): Promise<TaskBook>
  upsertTask(task: Task): Promise<void>
  upsertAttempt(attempt: Attempt): Promise<void>
  /** False when no record carries that id — never a silent success. */
  patchTask(id: string, patch: TaskPatch): Promise<boolean>
  patchAttempt(id: string, patch: AttemptPatch): Promise<boolean>
  addComment(c: TaskComment): Promise<void>
  upsertSubtask(t: Subtask): Promise<void>
  addFile(f: TaskFile): Promise<void>
  /** Removes the RECORD. The bytes on disk are the caller's to unlink — see `task-files.ts`. */
  removeFile(id: string): Promise<boolean>
  /**
   * Delete a task and everything hanging off it.
   *
   * Sessions are NOT touched: a row's `taskId` becomes a dangling reference, which reads as
   * "no attempt named" rather than vanishing. Deleting a board entry must never delete work.
   */
  removeTask(id: string): Promise<boolean>
  /** Forget a tombstone, so a name the user deleted can be created again. */
  clearTombstone(id: string): Promise<void>
}

/**
 * A link with no usable URL is dropped.
 *
 * Only http(s): a `javascript:` URL rendered into an anchor is a script somebody else wrote running
 * on this page, and the board takes text from assistants.
 */
function sanitizeLink(raw: unknown): TaskLink | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  const id = typeof l.id === 'string' && l.id ? l.id : null
  const url = typeof l.url === 'string' ? l.url.trim() : ''
  if (!id || !/^https?:\/\//i.test(url)) return null
  return {
    id, url,
    ...(typeof l.label === 'string' && l.label ? { label: l.label } : {}),
    ...(typeof l.kind === 'string' && l.kind ? { kind: l.kind } : {}),
  }
}

/** Keep only records shaped enough to be used safely downstream. */
function sanitizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || !t.id) return null
  if (typeof t.title !== 'string' || !t.title) return null
  return {
    id: t.id,
    title: t.title,
    // An unknown word is not a status. `todo` is the safe read: it claims the least.
    status: migrateStatus(t.status) ?? 'todo',
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString(),
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date(0).toISOString(),
    ...(typeof t.detail === 'string' ? { detail: t.detail } : {}),
    ...(typeof t.deliveredAt === 'string' ? { deliveredAt: t.deliveredAt } : {}),
    ...(typeof t.repo === 'string' ? { repo: t.repo } : {}),
    ...(Array.isArray(t.links)
      ? {
        links: t.links.map(sanitizeLink).filter((l): l is TaskLink => l !== null),
      }
      : {}),
    ...(Array.isArray(t.blockedBy)
      ? { blockedBy: t.blockedBy.filter((v): v is string => typeof v === 'string' && v !== t.id) }
      : {}),
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** A comment with no body says nothing; one with no task belongs to nothing. Both are dropped. */
function sanitizeComment(raw: unknown): TaskComment | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const id = str(c.id); const taskId = str(c.taskId); const body = str(c.body)
  if (!id || !taskId || !body) return null
  return {
    id, taskId, body,
    author: str(c.author) ?? 'unknown',
    createdAt: str(c.createdAt) ?? new Date(0).toISOString(),
  }
}

function sanitizeSubtask(raw: unknown): Subtask | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const id = str(t.id); const taskId = str(t.taskId); const title = str(t.title)
  if (!id || !taskId || !title) return null
  return {
    id, taskId, title,
    done: t.done === true,
    createdAt: str(t.createdAt) ?? new Date(0).toISOString(),
    updatedAt: str(t.updatedAt) ?? new Date(0).toISOString(),
  }
}

function sanitizeFile(raw: unknown): TaskFile | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  const id = str(f.id); const taskId = str(f.taskId); const name = str(f.name)
  if (!id || !taskId || !name) return null
  return {
    id, taskId, name,
    // A size that is not a finite number would render as NaN beside a real one; 0 is honest here
    // because the bytes are on disk either way and the listing is an index, not the measurement.
    size: typeof f.size === 'number' && Number.isFinite(f.size) ? f.size : 0,
    ...(str(f.kind) ? { kind: str(f.kind)! } : {}),
    ...(str(f.author) ? { author: str(f.author)! } : {}),
    createdAt: str(f.createdAt) ?? new Date(0).toISOString(),
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
      return EMPTY_BOOK()
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      corrupt = false
      const arr = (v: unknown) => (Array.isArray(v) ? v : [])
      return {
        tasks: arr(raw.tasks).map(sanitizeTask).filter((t): t is Task => t !== null),
        attempts: arr(raw.attempts).map(sanitizeAttempt).filter((a): a is Attempt => a !== null),
        // Absent on a book written before these existed, which is why every read goes through
        // `arr` rather than trusting the field to be there.
        comments: arr(raw.comments).map(sanitizeComment).filter((c): c is TaskComment => c !== null),
        subtasks: arr(raw.subtasks).map(sanitizeSubtask).filter((t): t is Subtask => t !== null),
        files: arr(raw.files).map(sanitizeFile).filter((f): f is TaskFile => f !== null),
        tombstones: arr(raw.tombstones).filter((v): v is string => typeof v === 'string'),
      }
    } catch {
      corrupt = true
      return EMPTY_BOOK()
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
    addComment(c) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, comments: [...book.comments, c] })
      })
    },
    upsertSubtask(t) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, subtasks: [...book.subtasks.filter(x => x.id !== t.id), t] })
      })
    },
    addFile(f) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, files: [...book.files, f] })
      })
    },
    removeFile(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.files.some(f => f.id === id)) return false
        await write({ ...book, files: book.files.filter(f => f.id !== id) })
        return true
      })
    },
    removeTask(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.tasks.some(t => t.id === id)) return false
        await write({
          tasks: book.tasks.filter(t => t.id !== id),
          attempts: book.attempts.filter(a => a.taskId !== id),
          comments: book.comments.filter(c => c.taskId !== id),
          subtasks: book.subtasks.filter(t => t.taskId !== id),
          files: book.files.filter(f => f.taskId !== id),
          // Remembered as DELETED, or the legacy migration mints it again on the next read.
          tombstones: [...new Set([...book.tombstones, id])],
        })
        return true
      })
    },
    clearTombstone(id) {
      return enqueue(async () => {
        const book = await read()
        if (!book.tombstones.includes(id)) return
        await write({ ...book, tombstones: book.tombstones.filter(t => t !== id) })
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
