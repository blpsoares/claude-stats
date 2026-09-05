import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTaskStore } from './task-store'
import type { Task } from './task-model'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'open',
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
    expect(await s.read()).toEqual({ tasks: [], attempts: [] })
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
    expect(await s.patchTask('nope', { status: 'delivered' })).toBe(false)
  })

  it('patch stamps updatedAt so a later sync can order writes', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.patchTask('t-1', { status: 'delivered', updatedAt: '2026-09-05T11:00:00.000Z' })
    const [t] = (await s.read()).tasks
    expect(t!.status).toBe('delivered')
    expect(t!.updatedAt).toBe('2026-09-05T11:00:00.000Z')
  })

  it('reads an empty book from corrupt bytes instead of throwing', async () => {
    const { file, s } = await store()
    await writeFile(file, '{ this is not json', 'utf8')
    expect(await s.read()).toEqual({ tasks: [], attempts: [] })
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
