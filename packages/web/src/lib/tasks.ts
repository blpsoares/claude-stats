/**
 * tasks.ts — the browser's reader for `/api/tasks`.
 *
 * It holds NO arithmetic. Every figure on the screen was computed by `task-rollup.ts` on the
 * server and travels already decided, because a second implementation of "what did this delivery
 * cost" is a second answer, and the two would drift. The only thing this file decides is how to
 * ask and what to do when the answer does not come.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Filters, TaskPriorityId } from '@agentistics/core'
import { getDateRangeFilter } from '../hooks/useData'

export type LinkProvenance = 'assigned' | 'observed' | 'none'
export type TaskStatus =
  | 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'abandoned'
export type AttemptStatus = 'running' | 'delivered' | 'abandoned'

export interface AttemptRollup {
  sessionsUsed: number
  sessionsLinked: number
  provenance: Record<LinkProvenance, number>
  rounds: number | null
  activeMinutes: number | null
  tokens: number | null
  costUSD: number | null
  costMeasuredSessions: number
  costEstimatedSessions: number
  credits: { nanoAiu: number; premiumRequests: number } | null
  mixedCurrency: boolean
}

export interface TaskRecord {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  repo?: string
  /** Task ids that must finish first. */
  blockedBy?: string[]
  links?: TaskLink[]
  /** Absent reads as `none` — "nobody has said", which is not the same as `low`. */
  priority?: TaskPriorityId
  assignee?: string
  dueDate?: string
  startDate?: string
  labels?: string[]
  /** Manual order, a fractional-index string. Absent = never dragged. */
  rank?: string
  /** Who is on it right now, and until when — a LEASE, so it expires on its own. */
  claim?: TaskClaim
  /** Why it is blocked. `blocked` cannot be recorded without this or a blocking task. */
  blockedReason?: string
}

export interface TaskClaim {
  by: string
  at: string
  expiresAt: string
  sessionId?: string
  note?: string
}

/** One thing that happened to a task. `kind`: status | claim | release | priority | assign | … */
export interface TaskEvent {
  id: string
  taskId: string
  at: string
  actor: string
  kind: string
  detail?: string
  from?: string
  to?: string
}

export interface TaskLink { id: string; url: string; label?: string; kind?: string }

export interface AttemptView {
  id: string | null
  label: string
  config?: { harness: string; model?: string; effort?: string; method?: string }
  status: AttemptStatus | 'unattributed'
  rollup: AttemptRollup
}

export interface BoardOverview {
  statusCounts: Record<string, number>
  tasks: number
  inFlight: number
  delivered: number
  abandoned: number
  totalCostUSD: number | null
  avgCostPerTask: number | null
  avgCostPerDelivered: number | null
  /** How many tasks carry no cost at all — the averages above name their own gap. */
  tasksWithoutCost: number
  avgRoundsPerTask: number | null
  avgSessionsPerTask: number | null
  avgDeliveryMs: number | null
  totalSessions: number
  totalTokens: number | null
  topModels: Bucket[]
  topHarnesses: Bucket[]
}

export interface TaskListRow {
  task: TaskRecord
  attempts: number
  rollup: AttemptRollup
  counts: { comments: number; subtasks: number; subtasksDone: number; files: number }
  harnesses: string[]
  /**
   * The repositories this task's sessions touched — normalized remotes, `''` for the "no linked
   * repository" bucket. Decided on the server from the sessions themselves (see `reposOfRows`), so
   * the Repositories page and the board can never disagree about which deliveries belong where.
   */
  repos: string[]
}

export interface Bucket { key: string; sessions: number; tokens: number | null }

export interface TaskStats {
  models: Bucket[]
  harnesses: Bucket[]
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  agentRuns: number | null
  filesModified: number | null
  linesAdded: number | null
  linesRemoved: number | null
  commits: number | null
  toolErrors: number | null
  /** Null while the task is open — "still running" and "took N hours" are different sentences. */
  deliveryMs: number | null
  firstSessionAt: string | null
  lastSessionAt: string | null
}

export interface TaskSessionRow {
  id: string
  harness: string
  cwd: string
  attemptId: string | null
  /** The subtask it is filed under, or null for the delivery itself — never both. */
  subtaskId: string | null
  createdAt: string
  endedAt?: string
  label?: string
  conversationId?: string
  tokens: number | null
  costUSD: number | null
  rounds: number | null
}

export interface TaskComment {
  id: string; taskId: string; author: string; body: string; createdAt: string
}
export interface Subtask {
  id: string
  taskId: string
  title: string
  done: boolean
  status: TaskStatus
  createdAt: string
  updatedAt: string
  assignee?: string
  dueDate?: string
  startDate?: string
  sessionId?: string
  notes?: string
}
export interface TaskFile {
  id: string; taskId: string; name: string; size: number
  kind?: string; author?: string; createdAt: string
}

export interface TaskDetail {
  task: TaskRecord
  attempts: AttemptView[]
  rollup: AttemptRollup
  stats: TaskStats
  sessions: TaskSessionRow[]
  comments: TaskComment[]
  subtasks: Subtask[]
  files: TaskFile[]
}

/**
 * Three states, and an empty list is only ever ONE of them.
 *
 * `refused` is what a central (or a profile with no host power) answers — the board is a local
 * store and there is nothing there to show. Rendering that as "no tasks yet" would invite someone
 * to look for work that was never going to appear. Same rule the fleet already follows.
 */
export type TasksError = 'down' | 'refused' | null

/**
 * The page's filters, as `/api/tasks` takes them.
 *
 * Built from the SAME `Filters` the rest of the dashboard edits and resolved through the SAME
 * `getDateRangeFilter`, so "last 7 days" means one thing across the product. The day is the UTC one
 * (`toISOString().slice(0,10)`), matching `tagSessionDay` and the server's `sessionDay`.
 *
 * `all` with no custom dates sends no window at all rather than a window starting at the epoch —
 * an unbounded range is the absence of a filter, and saying so lets the server skip the walk.
 */
export function taskQuery(filters: Filters | undefined): string {
  if (!filters) return ''
  const p = new URLSearchParams()
  const unbounded = filters.dateRange === 'all' && !filters.customStart && !filters.customEnd
  if (!unbounded) {
    const { start, end } = getDateRangeFilter(filters.dateRange, filters.customStart, filters.customEnd)
    if (start.getTime() > 0) p.set('from', start.toISOString().slice(0, 10))
    p.set('to', end.toISOString().slice(0, 10))
  }
  if (filters.harnesses?.length) p.set('harnesses', filters.harnesses.join(','))
  else if (filters.harness) p.set('harnesses', filters.harness)
  if (filters.projects?.length) p.set('projects', filters.projects.join(','))
  // `repos: ['']` deliberately targets the "no linked repository" bucket, so presence matters more
  // than emptiness here.
  if (filters.repos !== undefined && filters.repos.length > 0) p.set('repos', filters.repos.join(','))
  const q = p.toString()
  return q ? `?${q}` : ''
}

export function useTaskList(filters?: Filters) {
  const [rows, setRows] = useState<TaskListRow[] | null>(null)
  const [overview, setOverview] = useState<BoardOverview | null>(null)
  /** Sessions the page's filters kept out of these numbers — stated, never swallowed. */
  const [excluded, setExcluded] = useState(0)
  const [error, setError] = useState<TasksError>(null)

  const q = useMemo(() => taskQuery(filters), [filters])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks${q}`)
      if (res.status === 403 || res.status === 404) { setError('refused'); setRows([]); return }
      if (!res.ok) { setError('down'); setRows([]); return }
      const body = await res.json() as {
        tasks: TaskListRow[]; overview: BoardOverview; excludedByFilter?: number
      }
      setError(null)
      setRows(body.tasks ?? [])
      setOverview(body.overview ?? null)
      setExcluded(body.excludedByFilter ?? 0)
    } catch {
      setError('down')
      setRows([])
    }
  }, [q])

  useEffect(() => { void load() }, [load])
  return { rows, overview, excluded, error, reload: load }
}

export function useTaskDetail(ref: string | undefined, filters?: Filters) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<TasksError | 'missing'>(null)

  const load = useCallback(async () => {
    if (!ref) return
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}${taskQuery(filters)}`)
      if (res.status === 404) { setError('missing'); setDetail(null); return }
      if (res.status === 403) { setError('refused'); setDetail(null); return }
      if (!res.ok) { setError('down'); setDetail(null); return }
      const body = await res.json() as { task: TaskDetail }
      setError(null)
      setDetail(body.task)
    } catch {
      setError('down')
      setDetail(null)
    }
  }, [ref, JSON.stringify(filters ?? null)])

  useEffect(() => { void load() }, [load])
  return { detail, error, reload: load }
}

export async function markTask(
  ref: string,
  status: TaskStatus,
  o: { reason?: string; blockedBy?: string[]; actor?: string } = {},
): Promise<boolean> {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        ...(o.reason ? { reason: o.reason } : {}),
        ...(o.blockedBy ? { blockedBy: o.blockedBy } : {}),
        ...(o.actor ? { actor: o.actor } : {}),
      }),
    })
    // A 422 is the server refusing a `blocked` with nothing to say — the caller opens the dialog
    // rather than reporting a failure, so the rule reads as a question and not as a bug.
    return res.ok
  } catch {
    return false
  }
}

async function post(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function createTask(title: string, detail?: string): Promise<TaskRecord | null> {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, detail }),
    })
    if (!res.ok) return null
    return (await res.json() as { task: TaskRecord }).task
  } catch {
    return null
  }
}

export interface TaskFieldPatch {
  title?: string
  detail?: string
  priority?: TaskPriorityId
  assignee?: string
  dueDate?: string
  startDate?: string
  labels?: string[]
  /** Who is making the change — it goes into the activity log. */
  actor?: string
}

/** An absent field is left alone; an EMPTY STRING clears it. Same rule as the server's. */
export const editTask = (ref: string, patch: TaskFieldPatch) =>
  post(`/api/tasks/${encodeURIComponent(ref)}`, patch)

export const addComment = (ref: string, author: string, body: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/comments`, { author, body })

export const addSubtask = (ref: string, title: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, { title })

export const setSubtaskDone = (ref: string, id: string, done: boolean) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, { id, done })

export async function deleteTask(ref: string): Promise<boolean> {
  try {
    return (await fetch(`/api/tasks/${encodeURIComponent(ref)}`, { method: 'DELETE' })).ok
  } catch { return false }
}

/** The new file's ID, or `null` — a comment references its attachment by id, never by name. */
export async function uploadFile(ref: string, file: File, author?: string): Promise<string | null> {
  const form = new FormData()
  form.append('file', file)
  if (author) form.append('author', author)
  try {
    const r = await fetch(`/api/tasks/${encodeURIComponent(ref)}/files`, { method: 'POST', body: form })
    if (!r.ok) return null
    const body = await r.json() as { id?: unknown }
    return typeof body.id === 'string' ? body.id : null
  } catch { return null }
}

export async function deleteFile(fileId: string): Promise<boolean> {
  try {
    return (await fetch(`/api/task-files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })).ok
  } catch { return false }
}

export const fileUrl = (fileId: string) => `/api/task-files/${encodeURIComponent(fileId)}`

/** Hours and days, from ms. Null in, null out — an open task has no duration. */
export function fmtDuration(ms: number | null): string | null {
  if (ms === null) return null
  const h = ms / 3_600_000
  if (h < 1) return `${Math.round(ms / 60_000)} min`
  if (h < 48) return `${h.toFixed(1)} h`
  return `${(h / 24).toFixed(1)} d`
}

export const setBlockedBy = (ref: string, blockedBy: string[]) =>
  post(`/api/tasks/${encodeURIComponent(ref)}`, { blockedBy })

export const addLink = (ref: string, url: string, label?: string, kind?: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/links`, { url, label, kind })

export const removeLink = (ref: string, remove: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/links`, { remove })

/**
 * File a session under a delivery, or under one of its subtasks.
 *
 * Passing `subtaskId` MOVES it there; passing none moves it back to the delivery itself. A session
 * is filed under one or the other and never both — the rule lives in the server's `task-attach.ts`,
 * and this client only ever states a target.
 */
export const attachSession = (ref: string, sessionId: string, subtaskId?: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/sessions`,
    subtaskId ? { sessionId, subtaskId } : { sessionId })

export const detachSession = (ref: string, detach: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/sessions`, { detach })

export const editComment = (ref: string, id: string, body: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/comments`, { id, body })

export const removeComment = (ref: string, id: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/comments`, { id, remove: true })

export const patchSubtask = (
  ref: string,
  id: string,
  patch: Partial<Pick<Subtask, 'title' | 'status' | 'assignee' | 'dueDate' | 'startDate' | 'sessionId' | 'notes'>>,
) => post(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, { id, ...patch })

export const removeSubtask = (ref: string, id: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/subtasks`, { id, remove: true })

/**
 * TAKE a task, or give it back.
 *
 * A LEASE, not a lock: it expires on its own, so a browser tab closed mid-task does not hold work
 * forever. A refusal comes back `ok: false` naming the holder — rendered as a sentence, never as a
 * silent no-op.
 */
export async function claimTask(ref: string, o: {
  by: string
  release?: boolean
  sessionId?: string
  takeover?: boolean
  force?: boolean
  leaseMs?: number
}): Promise<{ ok: boolean; reason?: string; heldBy?: string; until?: string }> {
  try {
    const r = await fetch(`/api/tasks/${encodeURIComponent(ref)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(o),
    })
    return await r.json() as { ok: boolean; reason?: string; heldBy?: string; until?: string }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

/** Drop a card at `index` within the column it is being dropped into. Status is `markTask`'s job. */
export const moveTask = (ref: string, index: number, actor?: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/move`, { index, ...(actor ? { actor } : {}) })

/** The activity log, newest first. No `ref` = the whole board. */
export function useTaskActivity(ref?: string, limit = 60) {
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    const q = new URLSearchParams()
    if (ref) q.set('task', ref)
    q.set('limit', String(limit))
    try {
      const r = await fetch(`/api/tasks/activity?${q}`)
      const body = await r.json() as { events?: TaskEvent[] }
      setEvents(body.events ?? [])
    } catch {
      // An unreachable server keeps the last log rather than reporting an empty one — the same
      // rule the fleet poller follows. "Nothing happened" and "nobody answered" are different.
    } finally {
      setLoading(false)
    }
  }, [ref, limit])
  useEffect(() => { void reload() }, [reload])
  return { events, loading, reload }
}

export interface NextReply {
  ready: Array<{ task: TaskRecord; position: number }>
  withheld: Array<{ id: string; title: string; why: string; detail?: string }>
  progress: {
    total: number
    done: number
    abandoned: number
    open: number
    blocked: number
    claimed: number
    ready: number
    settled: boolean
  }
}

/** What can be picked up right now, why the rest cannot, and whether the board is settled. */
export function useNextTasks(actor?: string, intervalMs = 15000) {
  const [next, setNext] = useState<NextReply | null>(null)
  const reload = useCallback(async () => {
    const q = new URLSearchParams()
    if (actor) q.set('actor', actor)
    try {
      const r = await fetch(`/api/tasks/next?${q}`)
      setNext(await r.json() as NextReply)
    } catch { /* keep the last answer — see `useTaskActivity` */ }
  }, [actor])
  useEffect(() => {
    void reload()
    const t = setInterval(() => void reload(), intervalMs)
    return () => clearInterval(t)
  }, [reload, intervalMs])
  return { next, reload }
}
