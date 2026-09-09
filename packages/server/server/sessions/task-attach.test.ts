import { describe, expect, it } from 'bun:test'
import { filedUnder, planAttach, reconcileAttachment } from './task-attach'

const SUBS = [
  { id: 's1', taskId: 't1' },
  { id: 's2', taskId: 't1' },
  { id: 's9', taskId: 't2' },
]
const TASKS = ['t1', 't2']

describe('planAttach', () => {
  it('REFUSES a delivery as a target — a delivery does not take sessions', () => {
    // The delivery is the container; the subtask is the work. Allowing both left "does this cost
    // include the subtasks" without an answer.
    expect(planAttach({ target: { kind: 'task', id: 't1' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: false, reason: 'needs_subtask' })
  })

  it('still refuses a delivery that does not exist, before anything else', () => {
    expect(planAttach({ target: { kind: 'task', id: 'gone' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: false, reason: 'no_such_task' })
  })

  it('files under a subtask, and takes the parent FROM the subtask', () => {
    // Never from the caller: that is what stops the two ids naming different deliveries.
    expect(planAttach({ target: { kind: 'subtask', id: 's9' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: true, taskId: 't2', subtaskId: 's9' })
  })

  it('never produces a row filed under BOTH a task and a subtask of another', () => {
    const plan = planAttach({ target: { kind: 'subtask', id: 's1' }, taskIds: TASKS, subtasks: SUBS })
    expect(plan).toEqual({ ok: true, taskId: 't1', subtaskId: 's1' })
    if (!plan.ok) return
    // The stored pair is the subtask and ITS task — the invariant, stated as an assertion.
    const sub = SUBS.find(s => s.id === plan.subtaskId)!
    expect(plan.taskId).toBe(sub.taskId)
  })

  it('unfiles', () => {
    expect(planAttach({ target: { kind: 'none' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: true, taskId: null, subtaskId: null })
  })

  it('refuses a subtask that names nothing, rather than guessing one', () => {
    expect(planAttach({ target: { kind: 'subtask', id: 'gone' }, taskIds: TASKS, subtasks: SUBS }))
      .toEqual({ ok: false, reason: 'no_such_subtask' })
  })
})

describe('filedUnder', () => {
  it('answers with ONE owner — the subtask when there is one', () => {
    expect(filedUnder({ taskId: 't1', subtaskId: 's1' })).toEqual({ kind: 'subtask', id: 's1' })
    expect(filedUnder({ taskId: 't1' })).toEqual({ kind: 'task', id: 't1' })
    expect(filedUnder({})).toEqual({ kind: 'none' })
  })
})

describe('reconcileAttachment', () => {
  it('falls back to the task when the subtask is gone', () => {
    // Deleted while a session pointed at it. The delivery is still true, so the row keeps it
    // rather than vanishing from both lists.
    expect(reconcileAttachment({ taskId: 't1', subtaskId: 'gone' }, SUBS))
      .toEqual({ taskId: 't1', subtaskId: null })
  })

  it('corrects a pair that names two different deliveries', () => {
    // Written by an older build, or by a move that half-failed: the SUBTASK decides.
    expect(reconcileAttachment({ taskId: 't1', subtaskId: 's9' }, SUBS))
      .toEqual({ taskId: 't2', subtaskId: 's9' })
  })

  it('leaves an ordinary task-only row alone', () => {
    expect(reconcileAttachment({ taskId: 't1' }, SUBS)).toEqual({ taskId: 't1', subtaskId: null })
    expect(reconcileAttachment({}, SUBS)).toEqual({ taskId: null, subtaskId: null })
  })
})
