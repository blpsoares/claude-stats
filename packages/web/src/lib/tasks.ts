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
export type TaskStatus = 'open' | 'delivered' | 'abandoned'
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
}

export interface AttemptView {
  id: string | null
  label: string
  config?: { harness: string; model?: string; effort?: string; method?: string }
  status: AttemptStatus | 'unattributed'
  rollup: AttemptRollup
}

export interface TaskListRow {
  task: TaskRecord
  attempts: number
  rollup: AttemptRollup
}

export interface TaskDetail {
  task: TaskRecord
  attempts: AttemptView[]
  rollup: AttemptRollup
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
  const [error, setError] = useState<TasksError>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks')
      if (res.status === 403 || res.status === 404) { setError('refused'); setRows([]); return }
      if (!res.ok) { setError('down'); setRows([]); return }
      const body = await res.json() as { tasks: TaskListRow[] }
      setError(null)
      setRows(body.tasks ?? [])
    } catch {
      setError('down')
      setRows([])
    }
  }, [])

  useEffect(() => { void load() }, [load])
  return { rows, error, reload: load }
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

export async function markTask(ref: string, status: 'delivered' | 'abandoned'): Promise<boolean> {
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
