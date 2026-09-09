import { describe, expect, it } from 'bun:test'
import { filedUnder, planAttach, reconcileAttachment, sanitizeSubtaskBlockedBy } from './task-attach'

const SUBS = [
  { id: 's1', taskId: 't1', done: false },
  { id: 's2', taskId: 't1', done: false },
  { id: 's9', taskId: 't2', done: false },
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

  it("refuses a subtask still blocked by a sibling that is not done", () => {
    const blocked = [...SUBS, { id: 's3', taskId: 't1', done: false, blockedBy: ['s1'] }]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: blocked }))
      .toEqual({ ok: false, reason: 'blocked', blockedBy: ['s1'] })
  })

  it('files under a subtask once every one of its blockers is done', () => {
    const done = SUBS.map(s => (s.id === 's1' ? { ...s, done: true } : s))
    const withBlocker = [...done, { id: 's3', taskId: 't1', done: false, blockedBy: ['s1'] }]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: withBlocker }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: 's3' })
  })

  it('names every unmet blocker, in the order recorded, when there is more than one', () => {
    const withBlockers = [
      ...SUBS,
      { id: 's3', taskId: 't1', done: false, blockedBy: ['s2', 's1'] },
    ]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: withBlockers }))
      .toEqual({ ok: false, reason: 'blocked', blockedBy: ['s2', 's1'] })
  })

  it('a blocker naming a subtask that no longer exists is not a live block', () => {
    // The same reconciliation `filedUnder` already gives a session whose OWN subtask is gone —
    // a dangling reference stands in nobody's way forever.
    const withGoneBlocker = [...SUBS, { id: 's3', taskId: 't1', done: false, blockedBy: ['gone'] }]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: withGoneBlocker }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: 's3' })
  })

  it('a blocker outside this book of subtasks is not a live block either', () => {
    // `planAttach` is handed the DELIVERY's own subtasks in every measured caller; a blocker id
    // that does not resolve inside that set reads exactly like a deleted one.
    const scoped = [
      { id: 's1', taskId: 't1', done: false },
      { id: 's3', taskId: 't1', done: false, blockedBy: ['s9'] },
    ]
    expect(planAttach({ target: { kind: 'subtask', id: 's3' }, taskIds: TASKS, subtasks: scoped }))
      .toEqual({ ok: true, taskId: 't1', subtaskId: 's3' })
  })
})

describe('sanitizeSubtaskBlockedBy', () => {
  const SIBLINGS = [
    { id: 's1', taskId: 't1' },
    { id: 's2', taskId: 't1' },
    { id: 's3', taskId: 't1' },
    { id: 's9', taskId: 't2' },
  ]

  it('keeps a sibling of the same task', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['s1'], siblings: SIBLINGS }))
      .toEqual(['s1'])
  })

  it('drops a self-reference — a subtask cannot block itself', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['s3', 's1'], siblings: SIBLINGS }))
      .toEqual(['s1'])
  })

  it('drops a subtask of a DIFFERENT delivery', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['s9'], siblings: SIBLINGS }))
      .toEqual([])
  })

  it('drops an id naming nothing', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['ghost'], siblings: SIBLINGS }))
      .toEqual([])
  })

  it('dedupes', () => {
    expect(sanitizeSubtaskBlockedBy({ subtaskId: 's3', taskId: 't1', ids: ['s1', 's1', 's2'], siblings: SIBLINGS }))
      .toEqual(['s1', 's2'])
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
