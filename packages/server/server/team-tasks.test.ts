/**
 * The date boundary and the second redaction — the two things about this collection that cannot
 * be checked by reading the code that writes it.
 */
import { describe, expect, it } from 'bun:test'
import type { SharedTask } from '@agentistics/core'
import { REDACTION } from '@agentistics/core'
import { fromTeamTaskDoc, teamTaskDocId, toTeamTaskDoc } from './team-tasks'

const shared = (over: Partial<SharedTask> = {}): SharedTask => ({
  task: {
    id: 't1', title: 'ship it', status: 'done',
    createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
    deliveredAt: '2026-09-05T18:00:00.000Z', dueDate: '2026-09-10',
  },
  comments: [{ id: 'c1', author: 'scion', body: 'done', createdAt: '2026-09-02T10:00:00.000Z' }],
  subtasks: [{
    id: 's1', title: 'half', done: true, status: 'done',
    createdAt: '2026-09-01T11:00:00.000Z', updatedAt: '2026-09-04T11:00:00.000Z',
  }],
  files: [{ id: 'f1', name: 'plan.md', size: 12, createdAt: '2026-09-01T12:00:00.000Z' }],
  sessionIds: ['conv-1'],
  sessionsWithheld: 2,
  ...over,
})

describe('toTeamTaskDoc', () => {
  it('stores every timestamp as a BSON Date, including the ones inside the board', () => {
    const doc = toTeamTaskDoc(shared(), 'acme', 'm1', 'laptop')
    expect(doc.createdAt).toBeInstanceOf(Date)
    expect(doc.updatedAt).toBeInstanceOf(Date)
    expect(doc.deliveredAt).toBeInstanceOf(Date)
    expect(doc.comments[0]!.createdAt).toBeInstanceOf(Date)
    expect(doc.subtasks[0]!.updatedAt).toBeInstanceOf(Date)
    expect(doc.files[0]!.createdAt).toBeInstanceOf(Date)
  })

  it('leaves a scheduled DAY as a string — `yyyy-MM-dd` is not an instant', () => {
    const doc = toTeamTaskDoc(shared(), 'acme', 'm1', 'laptop')
    expect(doc.dueDate).toBe('2026-09-10')
  })

  it('redacts again on the central — a mixed-version fleet leaks from the old machine', () => {
    const doc = toTeamTaskDoc(shared({
      task: { ...shared().task, title: 'deploy ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      comments: [{ id: 'c1', author: 'scion', body: 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', createdAt: '2026-09-02T10:00:00.000Z' }],
    }), 'acme', 'm1', 'laptop')
    expect(doc.title).toContain(REDACTION)
    expect(doc.comments[0]!.body).toContain(REDACTION)
  })

  it('keeps the shortfall, so the central can say the delivery is measured short', () => {
    const doc = toTeamTaskDoc(shared(), 'acme', 'm1', 'laptop')
    expect(doc.sessionIds).toEqual(['conv-1'])
    expect(doc.sessionsWithheld).toBe(2)
  })

  it('keys the document by the machine, so a rename never duplicates it', () => {
    expect(teamTaskDocId('acme', 'm1', 't1')).toBe('acme:m1:t1')
  })
})

describe('fromTeamTaskDoc', () => {
  it('round-trips to the wire shape', () => {
    const doc = toTeamTaskDoc(shared(), 'acme', 'm1', 'laptop')
    const back = fromTeamTaskDoc(doc)
    expect(back.task.createdAt).toBe('2026-09-01T10:00:00.000Z')
    expect(back.task.deliveredAt).toBe('2026-09-05T18:00:00.000Z')
    expect(back.comments[0]!.createdAt).toBe('2026-09-02T10:00:00.000Z')
    expect(back.sessionsWithheld).toBe(2)
    expect(back).not.toHaveProperty('org')
    expect(back.task).not.toHaveProperty('memberId')
  })

  it('reads a document an older build left as strings', () => {
    // Mixed-version fleets are the reason `fromBsonDate` accepts both shapes; rendering one as
    // "Invalid Date" is a regression the type checker cannot catch.
    const legacy = {
      _id: 'acme:m1:t1', org: 'acme', memberId: 'm1', user: 'laptop',
      id: 't1', title: 'ship it', status: 'done',
      createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
      comments: [{ id: 'c1', author: 'scion', body: 'done', createdAt: '2026-09-02T10:00:00.000Z' }],
      subtasks: [], files: [], sessionIds: [], sessionsWithheld: 0,
    }
    const back = fromTeamTaskDoc(legacy as never)
    expect(back.task.createdAt).toBe('2026-09-01T10:00:00.000Z')
    expect(back.comments[0]!.createdAt).toBe('2026-09-02T10:00:00.000Z')
  })

  it('survives a document with no board arrays at all', () => {
    const back = fromTeamTaskDoc({
      _id: 'x', org: 'acme', memberId: 'm1', user: 'laptop',
      id: 't1', title: 't', status: 'todo',
      createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
    } as never)
    expect(back.comments).toEqual([])
    expect(back.sessionsWithheld).toBe(0)
  })
})
