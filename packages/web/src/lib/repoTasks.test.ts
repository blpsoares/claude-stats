import { describe, expect, it } from 'bun:test'
import { repoTaskTotals, tasksOfRepo } from './repoTasks'
import type { TaskListRow } from './tasks'

const row = (over: Partial<TaskListRow> & { id?: string } = {}): TaskListRow => ({
  task: {
    id: over.id ?? 't1', title: 'a delivery', status: 'in_progress',
    createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
    ...(over.task ?? {}),
  },
  attempts: 1,
  rollup: {
    sessionsUsed: 1, sessionsLinked: 1, provenance: { assigned: 1, observed: 0, none: 0 },
    rounds: 4, activeMinutes: 10, tokens: 1000, costUSD: 2,
    costMeasuredSessions: 0, costEstimatedSessions: 1, credits: null, mixedCurrency: false,
    ...(over.rollup ?? {}),
  },
  counts: { comments: 0, subtasks: 0, subtasksDone: 0, files: 0, ...(over.counts ?? {}) },
  harnesses: over.harnesses ?? ['claude'],
  repos: over.repos ?? ['github.com/org/a'],
})

describe('tasksOfRepo', () => {
  it('keeps a task that touched this repository, whichever others it also touched', () => {
    const rows = [
      row({ id: 't1', repos: ['github.com/org/a'] }),
      row({ id: 't2', repos: ['github.com/org/b', 'github.com/org/a'] }),
      row({ id: 't3', repos: ['github.com/org/b'] }),
    ]
    expect(tasksOfRepo(rows, 'github.com/org/a').map(r => r.task.id)).toEqual(['t1', 't2'])
  })

  it('treats `` as the "no linked repository" bucket, not as "every repository"', () => {
    const rows = [row({ id: 't1', repos: [''] }), row({ id: 't2', repos: ['github.com/org/a'] })]
    expect(tasksOfRepo(rows, '').map(r => r.task.id)).toEqual(['t1'])
  })

  it('drops a task whose sessions were all scoped out — it names no repository at all', () => {
    expect(tasksOfRepo([row({ repos: [] })], 'github.com/org/a')).toEqual([])
  })
})

describe('repoTaskTotals', () => {
  it('counts in flight, delivered and abandoned apart', () => {
    const t = repoTaskTotals([
      row({ id: 't1', task: { status: 'in_progress' } as never }),
      row({ id: 't2', task: { status: 'done' } as never }),
      row({ id: 't3', task: { status: 'abandoned' } as never }),
      row({ id: 't4', task: { status: 'blocked' } as never }),
    ])
    expect(t.tasks).toBe(4)
    // Counted as LINKED sessions: what this repository could actually see.
    expect(t.sessions).toBe(4)
    expect(t.inFlight).toBe(2)
    expect(t.delivered).toBe(1)
    expect(t.abandoned).toBe(1)
  })

  it('reports a total nobody could measure as null, never as zero', () => {
    // Every task on a harness that reports no cost: the repository has not delivered for free.
    const t = repoTaskTotals([
      row({ id: 't1', rollup: { costUSD: null, tokens: null } as never }),
      row({ id: 't2', rollup: { costUSD: null, tokens: null } as never }),
    ])
    expect(t.costUSD).toBeNull()
    expect(t.tokens).toBeNull()
  })

  it('sums what was reported and ignores what was not', () => {
    const t = repoTaskTotals([
      row({ id: 't1', rollup: { costUSD: 2, tokens: 1000 } as never }),
      row({ id: 't2', rollup: { costUSD: null, tokens: 500 } as never }),
    ])
    expect(t.costUSD).toBe(2)
    expect(t.tokens).toBe(1500)
  })

  it('counts only the sessions the repository could see', () => {
    // A task spanning two repositories files rows on both sides; only the ones whose conversation
    // resolved here contributed anything, and only those may be counted here.
    const t = repoTaskTotals([
      row({ id: 't1', rollup: { sessionsUsed: 4, sessionsLinked: 1 } as never }),
    ])
    expect(t.sessions).toBe(1)
  })

  it('counts the tasks that also spent credits, and never adds them to the dollars', () => {
    const t = repoTaskTotals([
      row({ id: 't1', rollup: { costUSD: 2, credits: { nanoAiu: 5, premiumRequests: 1 }, mixedCurrency: true } as never }),
      row({ id: 't2' }),
    ])
    expect(t.creditTasks).toBe(1)
    expect(t.costUSD).toBe(4)
  })
})
