import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readShells, shellsPath, writeShells, type ShellRecord } from './shell-store'

const rec = (id: string): ShellRecord => ({
  id, sessionId: 's1', cwd: '/home/u/proj', createdMs: 1, lastViewedMs: 2,
})

const tmp = () => mkdtemp(join(tmpdir(), 'agentistics-shells-'))

test('IT IS NOT THE SESSION REGISTRY — a different file, so a different writer', () => {
  // The whole isolation argument rests on this. `host.sessions()` walks every row in
  // managed-sessions.json and captures its pane — ~200 ms, every 5 s, in four processes — and a
  // shell in there would join that loop AND become a fleet row besides.
  expect(shellsPath('/x')).toBe('/x/shells.json')
  expect(shellsPath('/x')).not.toContain('managed-sessions')
})

test('a missing store is an empty list, never a throw', async () => {
  const dir = await tmp()
  expect(await readShells(dir)).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test('what is written is what is read, in order', async () => {
  const dir = await tmp()
  await writeShells([rec('a'), rec('b')], dir)
  expect((await readShells(dir)).map(r => r.id)).toEqual(['a', 'b'])
  await rm(dir, { recursive: true, force: true })
})

test('an unreadable store is an empty list, never a throw', async () => {
  // A truncated write or a hand edit must cost the person a new shell, never the dashboard.
  const dir = await tmp()
  await writeFile(join(dir, 'shells.json'), '{ not json')
  expect(await readShells(dir)).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test('a store that is not an array is an empty list', async () => {
  const dir = await tmp()
  await writeFile(join(dir, 'shells.json'), '{"id":"a"}')
  expect(await readShells(dir)).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test('a row missing a field it cannot do without is DROPPED, not kept half-built', async () => {
  // A record with no cwd names no directory, and the ceiling counts rows: a half-read one would be
  // counted against the cap while being useless to every verb.
  const dir = await tmp()
  await writeFile(join(dir, 'shells.json'), JSON.stringify([rec('a'), { id: 'b' }]))
  expect((await readShells(dir)).map(r => r.id)).toEqual(['a'])
  await rm(dir, { recursive: true, force: true })
})

test('a row whose timestamps are not numbers is dropped too', async () => {
  const dir = await tmp()
  await writeFile(join(dir, 'shells.json'), JSON.stringify([
    { id: 'a', sessionId: 's', cwd: '/w', createdMs: 'yesterday', lastViewedMs: 2 },
  ]))
  expect(await readShells(dir)).toEqual([])
  await rm(dir, { recursive: true, force: true })
})
