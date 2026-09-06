import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTaskStore } from './task-store'
import type { Task } from './task-model'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'todo',
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
  ...over,
})

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-tasks-'))
  const file = join(dir, 'tasks.json')
  return { file, s: createTaskStore(file) }
}

describe('createTaskStore', () => {
  it('reads an empty book when the file does not exist', async () => {
    const { s } = await store()
    expect(await s.read()).toEqual({ tasks: [], attempts: [], comments: [], subtasks: [], files: [], tombstones: [], events: [] })
  })

  it('round-trips a task', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    expect((await s.read()).tasks.map(t => t.id)).toEqual(['t-1'])
  })

  it('upsert replaces by id rather than appending a second record', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1', { title: 'first' }))
    await s.upsertTask(task('t-1', { title: 'second' }))
    const book = await s.read()
    expect(book.tasks).toHaveLength(1)
    expect(book.tasks[0]!.title).toBe('second')
  })

  it('patch reports false for an id nobody carries, never a silent success', async () => {
    const { s } = await store()
    expect(await s.patchTask('nope', { status: 'done' })).toBe(false)
  })

  it('patch stamps updatedAt so a later sync can order writes', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.patchTask('t-1', { status: 'done', updatedAt: '2026-09-05T11:00:00.000Z' })
    const [t] = (await s.read()).tasks
    expect(t!.status).toBe('done')
    expect(t!.updatedAt).toBe('2026-09-05T11:00:00.000Z')
  })

  it('reads an empty book from corrupt bytes instead of throwing', async () => {
    const { file, s } = await store()
    await writeFile(file, '{ this is not json', 'utf8')
    expect(await s.read()).toEqual({ tasks: [], attempts: [], comments: [], subtasks: [], files: [], tombstones: [], events: [] })
  })

  it('moves corrupt bytes aside rather than overwriting them', async () => {
    const { file, s } = await store()
    await writeFile(file, '{ this is not json', 'utf8')
    await s.read()
    await s.upsertTask(task('t-1'))
    // The bad bytes still exist: a parse failure must never become permanent data loss.
    const names = await readdir(dirname(file))
    expect(names.some(n => n.includes('corrupt'))).toBe(true)
  })

  it('drops a malformed record and keeps the file usable', async () => {
    const { file, s } = await store()
    await writeFile(file, JSON.stringify({ tasks: [{ nope: 1 }, task('t-ok')], attempts: [] }), 'utf8')
    expect((await s.read()).tasks.map(t => t.id)).toEqual(['t-ok'])
  })

  it('keeps an attempt only when it names a task and a harness', async () => {
    // An attempt with no taskId belongs to nothing and would sit in the book forever, invisible to
    // every reader that walks tasks. An attempt with no harness cannot be a configuration of
    // anything.
    const { file, s } = await store()
    await writeFile(file, JSON.stringify({
      tasks: [],
      attempts: [
        { id: 'a-1', taskId: 't-1', label: 'opus', config: { harness: 'claude' }, status: 'running' },
        { id: 'a-2', label: 'orphan', config: { harness: 'claude' } },
        { id: 'a-3', taskId: 't-1', label: 'no harness', config: {} },
      ],
    }), 'utf8')
    expect((await s.read()).attempts.map(a => a.id)).toEqual(['a-1'])
  })

  it('serialises concurrent writes without losing one', async () => {
    const { s } = await store()
    await Promise.all([s.upsertTask(task('t-1')), s.upsertTask(task('t-2')), s.upsertTask(task('t-3'))])
    expect((await s.read()).tasks.map(t => t.id).sort()).toEqual(['t-1', 't-2', 't-3'])
  })
})

describe('the board around a task', () => {
  it('round-trips a comment, a subtask and a file record', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.addComment({
      id: 'c-1', taskId: 't-1', author: 'claude:3f5f', body: 'spec written',
      createdAt: '2026-09-05T10:00:00.000Z',
    })
    await s.upsertSubtask({
      id: 's-1', taskId: 't-1', title: 'write the spec', done: false, status: 'todo',
      createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
    })
    await s.addFile({
      id: 'f-1', taskId: 't-1', name: 'spec.md', size: 120, kind: 'spec',
      createdAt: '2026-09-05T10:00:00.000Z',
    })
    const book = await s.read()
    expect(book.comments.map(c => c.body)).toEqual(['spec written'])
    expect(book.subtasks.map(t => t.title)).toEqual(['write the spec'])
    expect(book.files.map(f => f.name)).toEqual(['spec.md'])
  })

  it('drops a comment with no body — it says nothing and would render as a blank row', async () => {
    const { file, s } = await store()
    await writeFile(file, JSON.stringify({
      tasks: [], attempts: [],
      comments: [{ id: 'c-1', taskId: 't-1', body: '' }, { id: 'c-2', taskId: 't-1', body: 'real' }],
    }), 'utf8')
    expect((await s.read()).comments.map(c => c.id)).toEqual(['c-2'])
  })

  it('a subtask toggles by upsert rather than growing a second row', async () => {
    const { s } = await store()
    const base = {
      id: 's-1', taskId: 't-1', title: 'x',
      createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
    }
    await s.upsertSubtask({ ...base, done: false, status: 'todo' })
    await s.upsertSubtask({ ...base, done: true, status: 'done', updatedAt: '2026-09-05T11:00:00.000Z' })
    const list = (await s.read()).subtasks
    expect(list).toHaveLength(1)
    expect(list[0]!.done).toBe(true)
  })

  it('removing a task takes its board with it and reports false for an unknown id', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.addComment({ id: 'c-1', taskId: 't-1', author: 'me', body: 'hi', createdAt: 'x' })
    expect(await s.removeTask('nope')).toBe(false)
    expect(await s.removeTask('t-1')).toBe(true)
    const book = await s.read()
    expect([book.tasks.length, book.comments.length]).toEqual([0, 0])
  })

  it('reads a book written before these collections existed', async () => {
    // Absent is not corrupt: an older file carries only tasks and attempts.
    const { file, s } = await store()
    await writeFile(file, JSON.stringify({ tasks: [task('t-1')], attempts: [] }), 'utf8')
    const book = await s.read()
    expect(book.tasks).toHaveLength(1)
    expect([book.comments, book.subtasks, book.files]).toEqual([[], [], []])
  })
})

describe('the legacy migration and a task that was marked done', () => {
  it('does not mint a duplicate for a title the book already carries', async () => {
    // The bug this pins: `markTask` mirrors a delivered title into `preferences.finishedTasks`, the
    // migration reads it back as a legacy name, and — checking only the DERIVED id — minted a second
    // task beside the real one. Two rows, one delivery, metrics split between them.
    const { s } = await store()
    await s.upsertTask({
      id: 't-real', title: 'ship it', status: 'done',
      createdAt: '2026-09-05T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
    })
    const { legacyTaskId, migrateLegacyTasks } = await import('./task-model')
    const book = await s.read()
    const knownIds = new Set(book.tasks.map(t => t.id))
    const knownTitles = new Set(book.tasks.map(t => t.title))
    const minted = migrateLegacyTasks({ names: [], finished: ['ship it'], now: 'x' })
      .filter(t => !knownIds.has(t.id) && !knownTitles.has(t.title))
    expect(minted).toEqual([])
    // And the derived id really is different from the real one — the check had to be on the title.
    expect(legacyTaskId('ship it')).not.toBe('t-real')
  })
})

describe('a deleted task stays deleted', () => {
  it('records a tombstone so the legacy migration cannot mint it again', async () => {
    // The reported bug: deleting the task the migration had created did nothing visible, because
    // `ensureLegacyTasks` runs on every read and re-created it from the same name.
    const { s } = await store()
    await s.upsertTask(task('legacy-abc'))
    await s.removeTask('legacy-abc')
    const book = await s.read()
    expect(book.tasks).toEqual([])
    expect(book.tombstones).toEqual(['legacy-abc'])
  })

  it('creating the name again lifts the tombstone — it was a delete, not a ban', async () => {
    const { s } = await store()
    await s.upsertTask(task('legacy-abc'))
    await s.removeTask('legacy-abc')
    await s.clearTombstone('legacy-abc')
    expect((await s.read()).tombstones).toEqual([])
  })

  it('clearing a tombstone that is not there writes nothing', async () => {
    const { s } = await store()
    await s.clearTombstone('nope')
    expect((await s.read()).tombstones).toEqual([])
  })
})

describe('a subtask is a row, not a checkbox', () => {
  it('reads a pre-status subtask by its tick — `done` IS its status', async () => {
    // Without this, every completed subtask on an existing board would silently un-tick.
    const { file, s } = await store()
    await writeFile(file, JSON.stringify({
      tasks: [], attempts: [],
      subtasks: [
        { id: 's-1', taskId: 't-1', title: 'shipped', done: true },
        { id: 's-2', taskId: 't-1', title: 'not yet', done: false },
      ],
    }), 'utf8')
    const list = (await s.read()).subtasks
    expect(list.map(t => [t.id, t.status, t.done]))
      .toEqual([['s-1', 'done', true], ['s-2', 'todo', false]])
  })

  it('derives `done` from `status` rather than trusting a file that disagrees', async () => {
    // Two fields for one fact drift. A row saying done:false + status:'done' has no correct
    // reading, so the status wins and the tick follows it.
    const { file, s } = await store()
    await writeFile(file, JSON.stringify({
      tasks: [], attempts: [],
      subtasks: [{ id: 's-1', taskId: 't-1', title: 'x', done: false, status: 'done' }],
    }), 'utf8')
    expect((await s.read()).subtasks[0]!.done).toBe(true)
  })

  it('round-trips the columns a subtask inherits from its parent', async () => {
    const { s } = await store()
    await s.upsertSubtask({
      id: 's-1', taskId: 't-1', title: 'the half that is blocked',
      status: 'blocked', done: false,
      assignee: 'claude:3f5f', dueDate: '2026-09-12', startDate: '2026-09-06',
      sessionId: 'sess-1', notes: 'waiting on the API',
      createdAt: 'a', updatedAt: 'b',
    })
    const t = (await s.read()).subtasks[0]!
    expect([t.status, t.assignee, t.dueDate, t.sessionId, t.notes])
      .toEqual(['blocked', 'claude:3f5f', '2026-09-12', 'sess-1', 'waiting on the API'])
  })

  it('removes one and reports false for an id nobody carries', async () => {
    const { s } = await store()
    await s.upsertSubtask({
      id: 's-1', taskId: 't-1', title: 'x', status: 'todo', done: false,
      createdAt: 'a', updatedAt: 'b',
    })
    expect(await s.removeSubtask('nope')).toBe(false)
    expect(await s.removeSubtask('s-1')).toBe(true)
    expect((await s.read()).subtasks).toEqual([])
  })
})

describe('claimTask / releaseTask — the lease', () => {
  const NOW = Date.parse('2026-09-06T12:00:00.000Z')
  const LEASE = 60_000

  it('gives the task to the FIRST asker and refuses the second, naming the holder', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    const first = await s.claimTask({ id: 't-1', by: 'agent-a', nowMs: NOW, leaseMs: LEASE })
    expect(first.ok).toBe(true)
    const second = await s.claimTask({ id: 't-1', by: 'agent-b', nowMs: NOW, leaseMs: LEASE })
    expect(second).toMatchObject({ ok: false, reason: 'held' })
    expect(second.task?.claim?.by).toBe('agent-a')
  })

  it('decides under the lock: two simultaneous claims cannot both succeed', async () => {
    // The reason this lives in the store rather than as a read-then-patch in the caller.
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    const [a, b] = await Promise.all([
      s.claimTask({ id: 't-1', by: 'agent-a', nowMs: NOW, leaseMs: LEASE }),
      s.claimTask({ id: 't-1', by: 'agent-b', nowMs: NOW, leaseMs: LEASE }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })

  it('hands an EXPIRED claim to the next asker — a dead agent does not hold a task forever', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.claimTask({ id: 't-1', by: 'agent-a', nowMs: NOW, leaseMs: LEASE })
    const later = await s.claimTask({ id: 't-1', by: 'agent-b', nowMs: NOW + LEASE + 1, leaseMs: LEASE })
    expect(later.ok).toBe(true)
    expect((await s.read()).tasks[0]!.claim?.by).toBe('agent-b')
  })

  it('lets the HOLDER re-claim, which is how a lease is refreshed', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.claimTask({ id: 't-1', by: 'agent-a', nowMs: NOW, leaseMs: LEASE })
    const again = await s.claimTask({ id: 't-1', by: 'agent-a', nowMs: NOW + 1000, leaseMs: LEASE })
    expect(again.ok).toBe(true)
    expect(Date.parse(again.task!.claim!.expiresAt)).toBe(NOW + 1000 + LEASE)
  })

  it('takes over only when asked to explicitly', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.claimTask({ id: 't-1', by: 'agent-a', nowMs: NOW, leaseMs: LEASE })
    const forced = await s.claimTask({
      id: 't-1', by: 'a-person', nowMs: NOW, leaseMs: LEASE, takeover: true,
    })
    expect(forced.ok).toBe(true)
  })

  it('refuses a release by someone who is not the holder', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.claimTask({ id: 't-1', by: 'agent-a', nowMs: NOW, leaseMs: LEASE })
    expect(await s.releaseTask({ id: 't-1', by: 'agent-b' })).toMatchObject({ ok: false, reason: 'other' })
    expect(await s.releaseTask({ id: 't-1', by: 'agent-b', force: true })).toMatchObject({ ok: true })
    expect((await s.read()).tasks[0]!.claim).toBeUndefined()
  })

  it('reports a missing task rather than pretending', async () => {
    const { s } = await store()
    expect(await s.claimTask({ id: 'ghost', by: 'a', nowMs: NOW, leaseMs: LEASE }))
      .toMatchObject({ ok: false, reason: 'missing' })
    expect(await s.releaseTask({ id: 'ghost', by: 'a' })).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('drops a claim with no expiry on read — a permanent lock is what the lease prevents', async () => {
    const { file, s } = await store()
    await writeFile(file, JSON.stringify({
      tasks: [{ ...task('t-1'), claim: { by: 'ghost', at: 'x' } }],
    }), 'utf8')
    expect((await s.read()).tasks[0]!.claim).toBeUndefined()
  })
})

describe('setRanks and the activity log', () => {
  it('writes several ranks in one pass and leaves the rest alone', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.upsertTask(task('t-2'))
    await s.setRanks([{ id: 't-1', rank: 'b' }])
    const book = await s.read()
    expect(book.tasks.find(t => t.id === 't-1')!.rank).toBe('b')
    expect(book.tasks.find(t => t.id === 't-2')!.rank).toBeUndefined()
  })

  it('keeps the log newest-last and CAPS it', async () => {
    const { s } = await store()
    const many = Array.from({ length: 2100 }, (_, i) => ({
      id: `e-${i}`, taskId: 't-1', at: '2026-09-06T00:00:00.000Z', actor: 'me', kind: 'status',
    }))
    await s.logEvents(many)
    const events = (await s.read()).events
    expect(events).toHaveLength(2000)
    // The oldest went, not the newest: the question the log answers is about the recent end.
    expect(events.at(-1)!.id).toBe('e-2099')
  })

  it('takes the log down with the task it belongs to', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.logEvents([{ id: 'e-1', taskId: 't-1', at: 'now', actor: 'me', kind: 'status' }])
    await s.removeTask('t-1')
    expect((await s.read()).events).toEqual([])
  })
})
