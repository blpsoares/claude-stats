import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listExistingArtifacts, resolveArtifactPath } from './artifact-list'

test('a relative path resolves against the session directory', () => {
  // A shell write after a `cd` is recorded relative; without this it is listed and then refused,
  // because the read guard wants a path inside the session's own directory.
  expect(resolveArtifactPath('packages/web/x.ts', '/repo')).toBe('/repo/packages/web/x.ts')
})

test('an absolute path is left alone', () => {
  expect(resolveArtifactPath('/tmp/a.log', '/repo')).toBe('/tmp/a.log')
})

test('a tilde is REFUSED rather than expanded — it is the shell\'s home, not this process\'s', () => {
  expect(resolveArtifactPath('~/bin/agentop', '/repo')).toBeNull()
  expect(resolveArtifactPath('   ', '/repo')).toBeNull()
})

test('only files that exist, have content, and sit inside the session directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artlist-'))
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'real.ts'), 'export const a = 1\n')
  await writeFile(join(dir, 'sub', 'deep.md'), '# doc\n')
  await writeFile(join(dir, 'empty.txt'), '')

  const out = await listExistingArtifacts(
    ['real.ts', 'sub/deep.md', 'empty.txt', 'gone.ts'],
    dir,
  )
  expect(out.map(o => o.raw)).toEqual(['real.ts', 'sub/deep.md'])
  expect(out.every(o => o.scope === 'project')).toBe(true)
  // An empty file opens onto nothing, which reads as the panel being broken rather than as the
  // file being empty; a deleted one has nothing to open; one outside the directory would be
  // refused by the read guard anyway.
  expect(out.every(o => o.bytes > 0)).toBe(true)
})

test('the transcript order survives, and one file is listed once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artlist2-'))
  await writeFile(join(dir, 'a.ts'), 'a')
  await writeFile(join(dir, 'b.ts'), 'b')
  const out = await listExistingArtifacts(['b.ts', 'a.ts', 'b.ts'], dir)
  expect(out.map(o => o.raw)).toEqual(['b.ts', 'a.ts'])
})

/**
 * OUTSIDE THE FOLDER IS NOT THE SAME AS OUT OF REACH, and this is the change the rule was asked
 * for. Writing a memory in this product IS writing to `~/.claude/projects/<project>/memory/`, and
 * the panel listed those while the reader refused them — two halves of one screen disagreeing.
 * Gate 1 still stands: the path is here only because the session wrote it.
 */
test('a file outside the session folder IS listed when nothing redirected it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artscope-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'artmem-'))
  const memory = join(elsewhere, 'MEMORY.md')
  await writeFile(memory, '# memory\n')
  expect((await listExistingArtifacts([memory], dir)).map(o => o.raw)).toEqual([memory])
})

/**
 * THE HOLE THAT MUST STAY CLOSED, and the reason the widening is a comparison rather than a second
 * root. Adding the system temp directory as one was tried and reverted precisely because it let a
 * link inside a session's own folder reach anything else under `/tmp` — and every probe session
 * here sits there. The new rule does not reopen it: the link's NAME and its REAL path disagree, and
 * the real one is not inside the folder, so it is dropped.
 */
test('a link inside the folder pointing OUT of it is still dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artscope2-'))
  const outside = await mkdtemp(join(tmpdir(), 'artout-'))
  const secret = join(outside, 'secret.txt')
  await writeFile(secret, 'no')
  const link = join(dir, 'looks-local.txt')
  await symlink(secret, link)
  // Named inside the session's folder, really somewhere else entirely.
  expect(await listExistingArtifacts(['looks-local.txt'], dir)).toEqual([])
})

/**
 * A link that stays INSIDE the folder is ordinary and must keep working — this is the second half
 * of the union, and without it a machine whose project sits behind a symlink lists nothing.
 */
test('a link that resolves back inside the folder is kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artscope3-'))
  await writeFile(join(dir, 'real.md'), '# x\n')
  await symlink(join(dir, 'real.md'), join(dir, 'alias.md'))
  expect((await listExistingArtifacts(['alias.md'], dir)).map(o => o.raw)).toEqual(['alias.md'])
})
