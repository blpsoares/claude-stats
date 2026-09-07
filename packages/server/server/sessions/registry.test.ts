import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRegistry, newSessionId, retireFallenSessions } from './registry'

let dir = ''
let file = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-registry-'))
  file = join(dir, 'managed-sessions.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const session = (id: string) => ({
  id, harness: 'claude' as const, cwd: '/tmp', createdAt: '2026-08-12T10:00:00.000Z',
})

describe('createSessionRegistry', () => {
  it('starts empty and never throws on a missing file', async () => {
    expect(await createSessionRegistry(file).read()).toEqual([])
  })

  it('starts empty and never throws on a corrupt file', async () => {
    await writeFile(file, '{ this is not json', 'utf-8')
    expect(await createSessionRegistry(file).read()).toEqual([])
  })

  it('round-trips an added session', async () => {
    const r = createSessionRegistry(file)
    await r.add(session('a1'))
    expect(await r.read()).toEqual([session('a1')])
  })

  it('replaces rather than duplicates when the same id is added twice', async () => {
    const r = createSessionRegistry(file)
    await r.add(session('a1'))
    await r.add({ ...session('a1'), cwd: '/srv' })
    const list = await r.read()
    expect(list).toHaveLength(1)
    expect(list[0]!.cwd).toBe('/srv')
  })

  it('patches a label and a note without touching the rest', async () => {
    const r = createSessionRegistry(file)
    await r.add(session('a1'))
    expect(await r.patch('a1', { label: 'refactor auth', note: 'split the god object' })).toBe(true)
    const [s] = await r.read()
    expect(s!.label).toBe('refactor auth')
    expect(s!.note).toBe('split the god object')
    expect(s!.harness).toBe('claude')
  })

  it('reports a patch of an unknown id rather than silently succeeding', async () => {
    expect(await createSessionRegistry(file).patch('nope', { label: 'x' })).toBe(false)
  })

  it('removes a session', async () => {
    const r = createSessionRegistry(file)
    await r.add(session('a1'))
    await r.remove('a1')
    expect(await r.read()).toEqual([])
  })

  it('does not rewrite the file when removing an id that was never there', async () => {
    const r = createSessionRegistry(file)
    await r.add(session('a1'))
    const before = await readFile(file, 'utf-8')
    await r.remove('nope')
    expect(await readFile(file, 'utf-8')).toBe(before)
    expect(await r.read()).toEqual([session('a1')])
  })

  it('drops a malformed entry rather than throwing or surfacing it', async () => {
    // A hand-edited file can hold anything. `resolveSessionRef` calls `s.id.startsWith(...)` on
    // every candidate, so an entry missing `id` must never reach a caller.
    await writeFile(file, JSON.stringify([
      { foo: 1 },
      { id: 'a1', harness: 'claude', cwd: '/tmp' }, // missing createdAt — still a valid entry
      { id: 'a2', cwd: '/tmp' }, // missing harness
      { id: 'a3', harness: 'claude' }, // missing cwd
      session('a4'),
    ]), 'utf-8')
    const list = await createSessionRegistry(file).read()
    expect(list.map(s => s.id).sort()).toEqual(['a1', 'a4'])
  })

  it('quarantines corrupt bytes instead of overwriting them on the next write', async () => {
    await writeFile(file, '{ not json', 'utf-8')
    const r = createSessionRegistry(file)
    expect(await r.read()).toEqual([]) // degrades to empty rather than throwing
    await r.add(session('a1'))
    // The bad bytes were moved aside, not erased, and the new file holds only the fresh write.
    const dirEntries = await readdir(dir)
    expect(dirEntries.some(f => f.startsWith('managed-sessions.json.corrupt-'))).toBe(true)
    expect(await r.read()).toEqual([session('a1')])
  })

  it('serializes concurrent adds so a read-modify-write race cannot drop one', async () => {
    const r = createSessionRegistry(file)
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`)
    await Promise.all(ids.map(id => r.add(session(id))))
    const list = await r.read()
    expect(list.map(s => s.id).sort()).toEqual([...ids].sort())
  })
})

describe('newSessionId', () => {
  it('mints ids that are unique and safe as a tmux session name', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()))
    expect(ids.size).toBe(200)
    // tmux treats `.` and `:` as target separators, so the id must contain neither.
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{10}$/)
  })
})

describe('the heartbeat', () => {
  it('stamps every id given with ONE timestamp, in one write', async () => {
    // One shared timestamp is what makes `crash-group.ts` exact rather than fuzzy: sessions that
    // later fall together do not merely have nearby `lastSeenMs`, they have the same one.
    const reg = createSessionRegistry(file)
    await reg.add(session('a'))
    await reg.add(session('b'))
    expect(await reg.touch(['a', 'b'], 1_786_700_000_000)).toBe(2)
    const rows = await reg.read()
    expect(rows.map(r => r.lastSeenMs)).toEqual([1_786_700_000_000, 1_786_700_000_000])
  })

  it('leaves alone the ids it was not given', async () => {
    const reg = createSessionRegistry(file)
    await reg.add(session('a'))
    await reg.add(session('b'))
    await reg.touch(['a'], 42)
    const rows = await reg.read()
    expect(rows.find(r => r.id === 'a')?.lastSeenMs).toBe(42)
    expect(rows.find(r => r.id === 'b')?.lastSeenMs).toBeUndefined()
  })

  it('does not write at all when no id matches', async () => {
    // A heartbeat runs every minute forever. Touching the file to change nothing would be a write a
    // minute for the life of the process, on a fleet this registry does not hold.
    const reg = createSessionRegistry(file)
    await reg.add(session('a'))
    const before = await readFile(file, 'utf-8')
    expect(await reg.touch(['nope'], 42)).toBe(0)
    expect(await readFile(file, 'utf-8')).toBe(before)
  })

  it('survives an empty registry', async () => {
    expect(await createSessionRegistry(file).touch(['a'], 42)).toBe(0)
  })
})

describe('what survives a round trip', () => {
  it('keeps conversationId, which the sanitiser used to drop', async () => {
    // It was written by `resumeSession` and then read back as absent, so the exact conversation a
    // reopened session drives was recorded and never used — and the next reopen fell back to the
    // harness+directory guess that cannot tell two sessions of one repository apart.
    const reg = createSessionRegistry(file)
    await reg.add(session('a'))
    await reg.patch('a', { conversationId: 'conv-1' })
    expect((await reg.read())[0]!.conversationId).toBe('conv-1')
  })

  it('refuses a lastSeenMs that is not a finite number', async () => {
    // Hand-editable file. A NaN reaching `crash-group.ts` would put an always-false comparison in
    // charge of which sessions get reopened.
    await writeFile(file, JSON.stringify([
      { ...session('a'), lastSeenMs: 'yesterday' },
      { ...session('b'), lastSeenMs: 7 },
    ]), 'utf-8')
    const rows = await createSessionRegistry(file).read()
    expect(rows[0]!.lastSeenMs).toBeUndefined()
    expect(rows[1]!.lastSeenMs).toBe(7)
  })

  it('keeps the repository recorded at spawn, which is all a removed worktree leaves behind', async () => {
    const reg = createSessionRegistry(file)
    await reg.add({
      ...session('a'),
      repo: { repo: 'blpsoares/agentistics', root: 'agentistics', worktree: true },
    })
    expect((await reg.read())[0]!.repo)
      .toEqual({ repo: 'blpsoares/agentistics', root: 'agentistics', worktree: true })
  })

  it('keeps the main checkout PATH too, which is what the cascade measures branches from', async () => {
    // Recorded at spawn for the same reason `root` is: it is the one moment the directory is
    // provably there. Dropping it here would leave a removed worktree keeping its project and
    // losing its place inside it.
    const reg = createSessionRegistry(file)
    const repo = {
      repo: 'blpsoares/agentistics',
      root: 'agentistics',
      rootPath: '/home/d/agentistics',
      worktree: true,
    }
    await reg.add({ ...session('a'), repo })
    expect((await reg.read())[0]!.repo).toEqual(repo)
  })

  it('drops a recorded repo that is not SHAPED like one, keeping the session', async () => {
    // The one nested object in this file, so it is the one place "the load-bearing fields checked
    // out, trust the rest" does not hold. A hand-edited string would reach `resolveRepoFacts` with
    // no `repo` on it and the row would behave as though nothing had been recorded — the failure
    // this field exists to prevent, arriving silently.
    await writeFile(file, JSON.stringify([
      { ...session('a'), repo: 'agentistics' },
      { ...session('b'), repo: { root: 'agentistics', worktree: true } },
      { ...session('c'), repo: { repo: 'x/y', worktree: 'yes' } },
    ]), 'utf-8')
    const rows = await createSessionRegistry(file).read()
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(rows[0]!.repo).toBeUndefined()
    // No `repo` key means nothing every reader can key on — kept out rather than half-kept.
    expect(rows[1]!.repo).toBeUndefined()
    // `worktree` is a claim about the directory, so anything that is not literally true is false.
    expect(rows[2]!.repo).toEqual({ repo: 'x/y', worktree: false })
  })
})

describe('retireFallenSessions', () => {
  it('retires old fallen sessions in the same directory or conversation, leaving live backend sessions alone', async () => {
    const reg = createSessionRegistry(file)
    await reg.add({ id: 's1', harness: 'claude', cwd: '/tmp/proj', conversationId: 'c1', createdAt: '2026-08-12T10:00:00.000Z' })
    await reg.add({ id: 's2', harness: 'claude', cwd: '/tmp/other', conversationId: 'c2', createdAt: '2026-08-12T10:00:00.000Z' })
    await reg.add({ id: 's3', harness: 'claude', cwd: '/tmp/proj', conversationId: 'c3', createdAt: '2026-08-12T10:00:00.000Z' })

    // s3 is active in backend; s1 and s2 are not.
    const backendIds = new Set(['s3'])

    // Calling retireFallenSessions when spawning new session s4 in /tmp/proj
    const retired = await retireFallenSessions({
      newSessionId: 's4',
      conversationId: 'c1',
      cwd: '/tmp/proj',
      harness: 'claude',
      backendIds,
    }, reg)

    expect(retired).toBe(1) // s1 was retired
    const current = await reg.read()
    expect(current.find(s => s.id === 's1')?.endedAt).toBeDefined()
    expect(current.find(s => s.id === 's2')?.endedAt).toBeUndefined()
    expect(current.find(s => s.id === 's3')?.endedAt).toBeUndefined()
  })
})

// The write's temp path is unique per writer — see `registry.ts`.
//
// THE RACE ITSELF IS NOT UNIT-TESTED, and saying so is more useful than a test that passes either
// way. It needs both writers on the UNLOCKED path (`file-lock.ts` lets a blocked acquirer proceed
// after WAIT_MS), and holding the lock to force that makes every write pay 5 s, so a run long
// enough to show the loss takes minutes. An in-process test WITHOUT holding the lock passes with
// the old shared path too: the lock does its job, and the test discriminates nothing.
//
// It was measured instead, with two real processes doing 60 adds each against one file while the
// lock was held from outside — the records that survived, of 120:
//
//     shared `<file>.tmp`   68 · 120 · 62
//     unique per writer    119 · 120 · 118
//
// With one path they overwrite each other INSIDE the temp file: A writes its list, B replaces the
// bytes with its own, A renames and publishes B's — a third of the registry gone in one step,
// which is what "the sessions stopped by themselves" looks like from outside. What IS asserted
// here is the property that makes it impossible: nothing shared is left behind to collide on.
describe('the registry write', () => {
  let dir = ''
  let file = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentistics-reg-tmp-'))
    file = join(dir, 'managed-sessions.json')
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const session = (id: string) => ({
    id, harness: 'claude' as const, cwd: '/x', createdAt: new Date().toISOString(),
    label: `s-${id}`, lastSeenMs: Date.now(),
  })

  it('leaves no scratch file behind for another writer to collide on', async () => {
    const reg = createSessionRegistry(file)
    await reg.add(session('one') as never)
    await reg.add(session('two') as never)
    const left = await readdir(dir)
    expect(left.filter(f => f.includes('.tmp'))).toEqual([])
    expect(left).toContain('managed-sessions.json')
  })

  it('publishes a complete list, never a partial one', async () => {
    const reg = createSessionRegistry(file)
    await Promise.all(Array.from({ length: 12 }, (_, i) => reg.add(session(`id${i}`) as never)))
    const list = JSON.parse(await readFile(file, 'utf-8')) as unknown[]
    expect(list.length).toBe(12)
  })
})
