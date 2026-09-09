/**
 * task-overview.ts — PURE. The board as a whole: what is in flight, what shipped, and what a
 * delivery costs on average.
 *
 * This is the FIRST thing the page shows, before any kanban. The board's own shape ("which column
 * is full") is a tracking question and comes second; the question people open this for is "what is
 * my work costing me".
 *
 * The averages are the part that can lie, so each one states its DENOMINATOR:
 *  - a task nobody could price is excluded from the cost average and COUNTED, or the average is of
 *    a set the reader cannot see;
 *  - delivery time averages over DELIVERED tasks only — an open task has no duration (`task-stats`),
 *    and treating "so far" as a duration drags every average down as the board grows.
 */

import type { SessionMeta } from '@agentistics/core'
import { sessionTokens } from '@agentistics/core'
import { TASK_STATUSES, isClosed, type Task, type TaskStatus } from './task-model'
import type { Bucket } from './task-stats'
import type { ManagedSession } from './types'
import { distinctConversations, rowsOfTask } from './task-report'

export interface BoardOverview {
  /** Every status, always present — a column at zero is a fact, not an absence. */
  statusCounts: Record<TaskStatus, number>
  tasks: number
  inFlight: number
  delivered: number
  abandoned: number

  /** Sum over every task that could be priced at all. */
  totalCostUSD: number | null
  /** Mean over the tasks that HAVE a cost. Null when none does. */
  avgCostPerTask: number | null
  /** Mean over DELIVERED tasks that have a cost — the figure people actually want. */
  avgCostPerDelivered: number | null
  /** How many tasks carry no cost at all, so the averages above name their own gap. */
  tasksWithoutCost: number

  avgRoundsPerTask: number | null
  avgSessionsPerTask: number | null
  /** Mean wall time of DELIVERED tasks, ms. Null when nothing has been delivered. */
  avgDeliveryMs: number | null

  totalSessions: number
  totalTokens: number | null

  /** Ranked across every task's sessions. Only what was reported. */
  topModels: Bucket[]
  topHarnesses: Bucket[]
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}

function rank(m: Map<string, { sessions: number; tokens: number | null }>): Bucket[] {
  return [...m.entries()]
    .map(([key, v]) => ({ key, sessions: v.sessions, tokens: v.tokens }))
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.sessions - a.sessions)
}

export function buildBoardOverview(o: {
  tasks: readonly Task[]
  rows: readonly ManagedSession[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
}): BoardOverview {
  const statusCounts = Object.fromEntries(
    TASK_STATUSES.map(s => [s, 0]),
  ) as Record<TaskStatus, number>

  const models = new Map<string, { sessions: number; tokens: number | null }>()
  const harnesses = new Map<string, { sessions: number; tokens: number | null }>()

  const costs: number[] = []
  const deliveredCosts: number[] = []
  const roundsPer: number[] = []
  const sessionsPer: number[] = []
  const deliveryMs: number[] = []
  let tasksWithoutCost = 0
  let totalSessions = 0
  let totalTokens: number | null = null

  for (const task of o.tasks) {
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1

    // ONE CONVERSATION, COUNTED ONCE — the same rule `rollupSessionsFor` keeps, and it has to be
    // kept HERE TOO because this walk accumulates its own totals rather than going through it.
    // Six rows of one reopened conversation put its tokens and its cost into the headline six
    // times: measured on a live board, the overview read 13.110.140.051 tokens where the
    // deliveries under it summed to 2.493.697.631.
    const mine = distinctConversations(rowsOfTask(task, o.rows))
    totalSessions += mine.length
    sessionsPer.push(mine.length)

    let taskCost: number | null = null
    let taskRounds: number | null = null

    for (const r of mine) {
      const meta = r.conversationId ? o.metas.get(r.conversationId) : undefined
      if (!meta) continue

      taskCost = (taskCost ?? 0) + o.costOf(meta)
      if (typeof meta.user_message_count === 'number') {
        taskRounds = (taskRounds ?? 0) + meta.user_message_count
      }

      const reported = meta.input_tokens !== undefined || meta.output_tokens !== undefined
        || meta.cache_read_input_tokens !== undefined || meta.cache_creation_input_tokens !== undefined
      const b = reported ? sessionTokens(meta) : null
      const total = b === null ? null : b.input + b.output + b.cacheRead + b.cacheWrite
      if (total !== null) totalTokens = (totalTokens ?? 0) + total

      const bump = (m: typeof models, key: string) => {
        const cur = m.get(key) ?? { sessions: 0, tokens: null }
        m.set(key, {
          sessions: cur.sessions + 1,
          // Absent stays absent: a bucket where nothing reported tokens is not a bucket of zero.
          tokens: total === null ? cur.tokens : (cur.tokens ?? 0) + total,
        })
      }
      // A session with no model contributes no model row — an `unknown` bar is a measurement of our
      // ignorance dressed as a finding about the work.
      if (meta.model) bump(models, meta.model)
      bump(harnesses, meta.harness ?? 'claude')
    }

    if (taskCost === null) tasksWithoutCost += 1
    else {
      costs.push(taskCost)
      if (task.status === 'done') deliveredCosts.push(taskCost)
    }
    if (taskRounds !== null) roundsPer.push(taskRounds)

    if (task.status === 'done' && task.deliveredAt) {
      const ms = Date.parse(task.deliveredAt) - Date.parse(task.createdAt)
      if (Number.isFinite(ms) && ms >= 0) deliveryMs.push(ms)
    }
  }

  const inFlight = o.tasks.filter(t => !isClosed(t.status)).length

  return {
    statusCounts,
    tasks: o.tasks.length,
    inFlight,
    delivered: statusCounts.done ?? 0,
    abandoned: statusCounts.abandoned ?? 0,
    totalCostUSD: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    avgCostPerTask: mean(costs),
    avgCostPerDelivered: mean(deliveredCosts),
    tasksWithoutCost,
    avgRoundsPerTask: mean(roundsPer),
    avgSessionsPerTask: mean(sessionsPer),
    avgDeliveryMs: mean(deliveryMs),
    totalSessions,
    totalTokens,
    topModels: rank(models),
    topHarnesses: rank(harnesses),
  }
}
