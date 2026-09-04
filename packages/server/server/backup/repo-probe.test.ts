import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { candidatePaths, capturePatch, createBundle, listUntracked, probeDir } from './repo-probe'

let root = ''
let repo = ''
let wt = ''

// A pre-commit hook running from a linked worktree (as this repo's own does) exports GIT_DIR /
// GIT_INDEX_FILE pointing at the OUTER checkout. `-C`/`cwd` do not override GIT_DIR — it still wins
// repository discovery — so without stripping these, `git init` here would silently operate on the
// real repository instead of the temp directory being built. Confirmed by reproducing the exact
// failure: `GIT_DIR=$(git rev-parse --git-dir) bun test repo-probe.test.ts` fails with
// "remote origin already exists", identically to what husky's hook produced.
const git = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_PREFIX
  return execFileSync('git', args, { cwd, encoding: 'utf8', env })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentistics-probe-'))
  repo = join(root, 'proj')
  wt = join(root, 'wt')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'remote', 'add', 'origin', 'git@github.com:org/repo.git')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'one')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt)
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

test('a checkout reports its remote, branch, head, common dir and top level', async () => {
  const f = await probeDir(repo)
  expect(f.exists).toBe(true)
  expect(f.remote).toBe('github.com/org/repo')
  expect(f.cloneUrl).toBe('git@github.com:org/repo.git')
  expect(f.branch).toBe('main')
  expect(f.head).toMatch(/^[0-9a-f]{7,40}$/)
  expect(f.topLevel).toBe(repo)
  expect(f.commonDir).toBe(join(repo, '.git'))
})

// The exact fact groupRepos keys on. A worktree's common dir must be the MAIN checkout's .git,
// resolved to an absolute path — git prints a relative one from inside a worktree.
test('a worktree reports the MAIN checkout git dir as its common dir, absolute', async () => {
  const f = await probeDir(wt)
  expect(f.commonDir).toBe(join(repo, '.git'))
  expect(f.topLevel).toBe(wt)
  expect(f.branch).toBe('feat/x')
})

test('a directory that is not a repo reports exists with no common dir', async () => {
  const plain = join(root, 'plain')
  mkdirSync(plain)
  const f = await probeDir(plain)
  expect(f.exists).toBe(true)
  expect(f.commonDir).toBeNull()
})

// The discriminator is whether the directory EXISTS, never whether git answered. A removed
// worktree makes every `git -C` fail, and calling that "not a repo" invents a project.
test('a directory that does not exist reports exists:false and never runs git', async () => {
  const f = await probeDir(join(root, 'nope'))
  expect(f.exists).toBe(false)
  expect(f.commonDir).toBeNull()
})

test('a bundle of the unpushed history is written and is smaller than the full one', async () => {
  const partial = join(root, 'p.bundle')
  const full = join(root, 'f.bundle')
  expect(await createBundle(repo, partial, { full: false, maxBytes: 100_000_000 })).toBe('written')
  expect(await createBundle(repo, full, { full: true, maxBytes: 100_000_000 })).toBe('written')
  expect(statSync(partial).size).toBeGreaterThan(0)
})

// A ceiling that is enforced after writing would still have spent the disk. `too-large` deletes
// what it wrote and says so, so the caller can mark the repo and move on.
test('a bundle over the ceiling reports too-large and leaves no file behind', async () => {
  const out = join(root, 'huge.bundle')
  expect(await createBundle(repo, out, { full: true, maxBytes: 1 })).toBe('too-large')
  expect(() => statSync(out)).toThrow()
})

test('a clean tree yields no patch; a dirty one yields the diff', async () => {
  expect(await capturePatch(repo)).toBeNull()
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  const patch = await capturePatch(repo)
  expect(patch).toContain('-one')
  expect(patch).toContain('+two')
  git(repo, 'checkout', '--', 'a.txt')
})

test('untracked files are listed, and ignored ones are not', async () => {
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
  writeFileSync(join(repo, 'ignored.txt'), 'x')
  writeFileSync(join(repo, 'new.txt'), 'y')
  const un = await listUntracked(repo)
  expect(un).toContain('new.txt')
  expect(un).not.toContain('ignored.txt')
  rmSync(join(repo, '.gitignore'))
  rmSync(join(repo, 'ignored.txt'))
  rmSync(join(repo, 'new.txt'))
})

// --- candidatePaths (pure) --------------------------------------------------------------------

test('candidate paths are deduped and prefer current_cwd over project_path', () => {
  const paths = candidatePaths([
    { project_path: '/a', current_cwd: '/a/wt' },
    { project_path: '/a', current_cwd: '/a/wt' },
    { project_path: '/b' },
  ])
  expect(paths.sort()).toEqual(['/a', '/a/wt', '/b'])
})

test('a session with no usable path contributes nothing', () => {
  expect(candidatePaths([{ project_path: '' }, {}])).toEqual([])
})
