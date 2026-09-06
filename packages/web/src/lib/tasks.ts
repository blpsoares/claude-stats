/**
 * tasks.ts — the browser's reader for `/api/tasks`.
 *
 * It holds NO arithmetic. Every figure on the screen was computed by `task-rollup.ts` on the
 * server and travels already decided, because a second implementation of "what did this delivery
 * cost" is a second answer, and the two would drift. The only thing this file decides is how to
 * ask and what to do when the answer does not come.
 */

import { useCallback, useEffect, useState } from 'react'

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
  id: string; taskId: string; title: string; done: boolean; createdAt: string; updatedAt: string
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

export function useTaskList() {
  const [rows, setRows] = useState<TaskListRow[] | null>(null)
  const [overview, setOverview] = useState<BoardOverview | null>(null)
  const [error, setError] = useState<TasksError>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks')
      if (res.status === 403 || res.status === 404) { setError('refused'); setRows([]); return }
      if (!res.ok) { setError('down'); setRows([]); return }
      const body = await res.json() as { tasks: TaskListRow[]; overview: BoardOverview }
      setError(null)
      setRows(body.tasks ?? [])
      setOverview(body.overview ?? null)
    } catch {
      setError('down')
      setRows([])
    }
  }, [])

  useEffect(() => { void load() }, [load])
  return { rows, overview, error, reload: load }
}

export function useTaskDetail(ref: string | undefined) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<TasksError | 'missing'>(null)

  const load = useCallback(async () => {
    if (!ref) return
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}`)
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
  }, [ref])

  useEffect(() => { void load() }, [load])
  return { detail, error, reload: load }
}

export async function markTask(ref: string, status: TaskStatus): Promise<boolean> {
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(ref)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
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

export const editTask = (ref: string, patch: { title?: string; detail?: string }) =>
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

export async function uploadFile(ref: string, file: File, author?: string): Promise<boolean> {
  const form = new FormData()
  form.append('file', file)
  if (author) form.append('author', author)
  try {
    return (await fetch(`/api/tasks/${encodeURIComponent(ref)}/files`, {
      method: 'POST', body: form,
    })).ok
  } catch { return false }
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

export const attachSession = (ref: string, sessionId: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/sessions`, { sessionId })

export const detachSession = (ref: string, detach: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/sessions`, { detach })

export const editComment = (ref: string, id: string, body: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/comments`, { id, body })

export const removeComment = (ref: string, id: string) =>
  post(`/api/tasks/${encodeURIComponent(ref)}/comments`, { id, remove: true })
