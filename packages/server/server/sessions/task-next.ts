/**
 * task-next.ts — the orchestration primitives. Pure: it takes a clock, it never reads one.
 *
 * A board driven by several agents has to answer three questions the board itself never asked:
 *
 *  1. **What can I pick up right now?** Not "what is open" — a task blocked by unfinished work, or
 *     one another agent is already inside, is not work available to me. `readyTasks` answers with
 *     the ones that are genuinely free, most urgent first.
 *  2. **Is this mine?** Two agents taking the same task and doing it twice is the failure mode of
 *     every shared queue. `claimTask` is an atomic take, and it takes a LEASE rather than a lock:
 *     an agent that dies holding a task must not remove it from the board forever, with nothing on
 *     screen saying why. `claimState` reads the expiry at the moment the question is asked.
 *  3. **Are we finished?** `boardProgress` is the convergence signal — how much is open, how much
 *     is blocked on something, how much is in hands right now, and whether anything at all is
 *     available to pick up. A coordinator that cannot tell "nothing to do because it is all done"
 *     from "nothing to do because everything is blocked" will re-dispatch forever.
 *
 * The thing this module deliberately does NOT do is decide anything for anyone. It reports what is
 * available and why the rest is not; nothing here starts, stops or approves a session.
 */

import { isClosed, PRIORITY_ORDER, type Task, type TaskStatus } from './task-model'

/** A claim lives 30 minutes unless refreshed — long enough for a turn, short enough that a dead
 *  agent's task is back on the board while the person is still at the desk. */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000

export type ClaimState = 'free' | 'held' | 'expired'

/** The statuses a task can be PICKED UP in. `blocked` is deliberately absent: it means somebody
 *  tried and cannot, and handing it to the next agent repeats that discovery. */
const PICKABLE: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress'] as const

export function claimState(task: Pick<Task, 'claim'>, nowMs: number): ClaimState {
  const c = task.claim
  if (!c) return 'free'
  const until = Date.parse(c.expiresAt)
  // An unparseable expiry is treated as EXPIRED, not as forever: a claim nobody can date is a claim
  // nobody can revoke, which is the permanent lock the lease exists to avoid.
  if (!Number.isFinite(until)) return 'expired'
  return until > nowMs ? 'held' : 'expired'
}

/** Held by someone else — the only state that withholds a task from another agent. */
export function heldByOther(task: Pick<Task, 'claim'>, actor: string, nowMs: number): boolean {
  return claimState(task, nowMs) === 'held' && task.claim?.by !== actor
}

export type NotReady =
  | { reason: 'closed' }
  | { reason: 'blocked'; by: string[] }
  | { reason: 'claimed'; by: string; until: string }
  | { reason: 'status'; status: TaskStatus }

export interface ReadyTask {
  task: Task
  /** Where it stands in the queue this call produced — 1 is the one to take. */
  position: number
}

export interface NextPlan {
  ready: ReadyTask[]
  /** Every task that is NOT ready, with the reason. An agent told "nothing" learns nothing. */
  withheld: Array<{ task: Task; why: NotReady }>
}

/**
 * The open blockers of a task, by id.
 *
 * A blocker that is already `done` or `abandoned` stops counting — the record of what held the work
 * up stays on the task, but it no longer holds it up. An id naming a task that does not exist is
 * IGNORED rather than treated as blocking: a dangling reference must not be able to freeze work
 * forever, and it is visible on the task's own screen.
 */
export function openBlockers(task: Task, byId: ReadonlyMap<string, Task>): string[] {
  return (task.blockedBy ?? []).filter(id => {
    const b = byId.get(id)
    return b !== undefined && !isClosed(b.status)
  })
}

export function planNext(o: {
  tasks: readonly Task[]
  nowMs: number
  /** Who is asking. A task this actor already holds is READY for them — resuming your own work is
   *  not a conflict, and refusing it would strand an agent behind its own claim. */
  actor?: string
  limit?: number
}): NextPlan {
  const byId = new Map(o.tasks.map(t => [t.id, t]))
  const ready: Task[] = []
  const withheld: NextPlan['withheld'] = []

  for (const task of o.tasks) {
    if (isClosed(task.status)) { withheld.push({ task, why: { reason: 'closed' } }); continue }
    if (!PICKABLE.includes(task.status)) {
      withheld.push({ task, why: { reason: 'status', status: task.status } })
      continue
    }
    const blockers = openBlockers(task, byId)
    if (blockers.length > 0) {
      withheld.push({ task, why: { reason: 'blocked', by: blockers } })
      continue
    }
    if (o.actor !== undefined ? heldByOther(task, o.actor, o.nowMs) : claimState(task, o.nowMs) === 'held') {
      withheld.push({
        task,
        why: { reason: 'claimed', by: task.claim?.by ?? '', until: task.claim?.expiresAt ?? '' },
      })
      continue
    }
    ready.push(task)
  }

  ready.sort(rankReady)
  const limited = o.limit !== undefined ? ready.slice(0, Math.max(0, o.limit)) : ready
  return {
    ready: limited.map((task, i) => ({ task, position: i + 1 })),
    withheld,
  }
}

/**
 * The queue order: urgency first, then the board's own hand-arranged order, then age.
 *
 * Age LAST and ascending — the oldest untouched task wins a tie, so nothing starves at the bottom
 * of a busy board. Deterministic to the id, like every other ordering here.
 */
function rankReady(a: Task, b: Task): number {
  const pa = PRIORITY_ORDER.indexOf(a.priority ?? 'none')
  const pb = PRIORITY_ORDER.indexOf(b.priority ?? 'none')
  if (pa !== pb) return pa - pb
  const ra = a.rank
  const rb = b.rank
  if (ra !== rb) {
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra < rb ? -1 : 1
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export interface BoardProgress {
  total: number
  done: number
  abandoned: number
  open: number
  /** Open, but waiting on another task. */
  blocked: number
  /** Open and in someone's hands right now. */
  claimed: number
  /** Open, free, and pickable — the number an orchestrator can act on. */
  ready: number
  /**
   * Nothing left to hand out AND nothing in flight. The convergence signal — and it is deliberately
   * two facts, because "no work available" while three agents are mid-task is not done.
   */
  settled: boolean
}

export function boardProgress(tasks: readonly Task[], nowMs: number): BoardProgress {
  const plan = planNext({ tasks, nowMs })
  const done = tasks.filter(t => t.status === 'done').length
  const abandoned = tasks.filter(t => t.status === 'abandoned').length
  const blocked = plan.withheld.filter(w => w.why.reason === 'blocked').length
  const claimed = plan.withheld.filter(w => w.why.reason === 'claimed').length
  const open = tasks.length - done - abandoned
  return {
    total: tasks.length,
    done,
    abandoned,
    open,
    blocked,
    claimed,
    ready: plan.ready.length,
    settled: plan.ready.length === 0 && claimed === 0,
  }
}
