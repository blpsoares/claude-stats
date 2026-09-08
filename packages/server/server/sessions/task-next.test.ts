import { describe, expect, it } from 'bun:test'
import { boardProgress, claimState, DEFAULT_LEASE_MS, heldByOther, openBlockers, planNext } from './task-next'
import type { Task } from './task-model'

const NOW = Date.parse('2026-09-06T12:00:00.000Z')

const task = (over: Partial<Task> & { id: string }): Task => ({
  title: over.id, status: 'todo',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
})

const claim = (by: string, offsetMs: number) => ({
  by, at: new Date(NOW).toISOString(), expiresAt: new Date(NOW + offsetMs).toISOString(),
})

describe('claimState', () => {
  it('is free with no claim, held while the lease runs, expired after', () => {
    expect(claimState({}, NOW)).toBe('free')
    expect(claimState({ claim: claim('a', DEFAULT_LEASE_MS) }, NOW)).toBe('held')
    expect(claimState({ claim: claim('a', -1) }, NOW)).toBe('expired')
  })

  it('treats an UNPARSEABLE expiry as expired, never as forever', () => {
    // A claim nobody can date is a claim nobody can revoke — the permanent lock the lease exists
    // to avoid.
    expect(claimState({ claim: { by: 'a', at: '', expiresAt: 'soon' } }, NOW)).toBe('expired')
  })
})

describe('heldByOther', () => {
  it('is false for the holder itself — resuming your own work is not a conflict', () => {
    const t = { claim: claim('agent-1', DEFAULT_LEASE_MS) }
    expect(heldByOther(t, 'agent-1', NOW)).toBe(false)
    expect(heldByOther(t, 'agent-2', NOW)).toBe(true)
  })
})

describe('openBlockers', () => {
  const byId = new Map([
    ['open', task({ id: 'open' })],
    ['shipped', task({ id: 'shipped', status: 'done' })],
  ])

  it('counts only blockers that are still open', () => {
    expect(openBlockers(task({ id: 'x', blockedBy: ['open', 'shipped'] }), byId)).toEqual(['open'])
  })

  it('IGNORES an id naming no task rather than freezing the work', () => {
    expect(openBlockers(task({ id: 'x', blockedBy: ['ghost'] }), byId)).toEqual([])
  })
})

describe('planNext', () => {
  it('offers the free, unblocked, pickable tasks most urgent first', () => {
    const tasks = [
      task({ id: 'low', priority: 'low' }),
      task({ id: 'urgent', priority: 'urgent' }),
      task({ id: 'none' }),
    ]
    expect(planNext({ tasks, nowMs: NOW }).ready.map(r => r.task.id)).toEqual(['urgent', 'low', 'none'])
  })

  it('numbers the queue from 1, so "take the first" is unambiguous', () => {
    const plan = planNext({ tasks: [task({ id: 'a' })], nowMs: NOW })
    expect(plan.ready[0]!.position).toBe(1)
  })

  it('WITHHOLDS with a reason instead of returning a shorter list', () => {
    // An agent told "nothing" learns nothing; it has to be able to see why.
    const tasks = [
      task({ id: 'done', status: 'done' }),
      task({ id: 'blocked-status', status: 'blocked' }),
      task({ id: 'waiting', blockedBy: ['open'] }),
      task({ id: 'open' }),
      task({ id: 'taken', claim: claim('someone', DEFAULT_LEASE_MS) }),
    ]
    const plan = planNext({ tasks, nowMs: NOW, actor: 'me' })
    expect(plan.ready.map(r => r.task.id)).toEqual(['open'])
    const why = Object.fromEntries(plan.withheld.map(w => [w.task.id, w.why.reason]))
    expect(why).toEqual({
      done: 'closed', 'blocked-status': 'status', waiting: 'blocked', taken: 'claimed',
    })
  })

  it('returns an EXPIRED claim to the board', () => {
    const tasks = [task({ id: 'dropped', claim: claim('dead-agent', -1) })]
    expect(planNext({ tasks, nowMs: NOW, actor: 'me' }).ready.map(r => r.task.id)).toEqual(['dropped'])
  })

  it('offers an agent the task it already holds', () => {
    const tasks = [task({ id: 'mine', claim: claim('me', DEFAULT_LEASE_MS) })]
    expect(planNext({ tasks, nowMs: NOW, actor: 'me' }).ready.map(r => r.task.id)).toEqual(['mine'])
  })

  it('breaks ties by rank then by AGE, so nothing starves', () => {
    const tasks = [
      task({ id: 'new', createdAt: '2026-09-05T00:00:00.000Z' }),
      task({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(planNext({ tasks, nowMs: NOW }).ready.map(r => r.task.id)).toEqual(['old', 'new'])
  })

  it('honours a limit', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]
    expect(planNext({ tasks, nowMs: NOW, limit: 2 }).ready).toHaveLength(2)
  })
})

describe('boardProgress', () => {
  it('separates "all done" from "everything is in hands"', () => {
    const finished = boardProgress([task({ id: 'a', status: 'done' })], NOW)
    expect(finished.settled).toBe(true)
    expect(finished.ready).toBe(0)

    const inFlight = boardProgress([task({ id: 'a', claim: claim('agent', DEFAULT_LEASE_MS) })], NOW)
    // Nothing to hand out, but somebody is mid-task: NOT settled.
    expect(inFlight.ready).toBe(0)
    expect(inFlight.claimed).toBe(1)
    expect(inFlight.settled).toBe(false)
  })

  it('counts blocked work as open and not ready', () => {
    const p = boardProgress([task({ id: 'a' }), task({ id: 'b', blockedBy: ['a'] })], NOW)
    expect(p).toMatchObject({ total: 2, open: 2, blocked: 1, ready: 1, done: 0, settled: false })
  })
})
