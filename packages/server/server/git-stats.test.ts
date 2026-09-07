/** Regression: repository stats must not turn into a git storm.
 *
 *  `getProjectGitStats` once walked `git log --numstat` — a diff per commit — with no bound, no
 *  memo, and a timeout below the real cost of a large repo. Because a timed-out walk returns the
 *  same `undefined` as "not a git repo", every timeout fell through to the workspace fallback,
 *  which re-walked the SAME repository once per subdirectory. Measured on a real machine: ~9
 *  concurrent `git log` processes at 100-300MB each, permanently, none able to finish.
 *
 *  These tests pin the three properties that make that impossible: a repo never triggers the
 *  subdirectory scan, distinct repository roots are counted once each, and a walked repo is
 *  remembered rather than re-walked. */
import { test, expect, beforeEach } from 'bun:test'
import { exec } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectGitStats, clearGitStatsCache, gitStatsWalkCount } from './git'

const execAsync = promisify(exec)

/** Run git with every inherited `GIT_*` variable stripped.
 *
 *  Under the full suite these tests share a process with others that set `GIT_DIR` / `GIT_INDEX_FILE`,
 *  and an inherited one points this fixture's git at somebody else's repository — `git worktree add`
 *  fails with "index file open failed". Isolated here rather than depending on suite ordering. */
function run(command: string, opts: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return execAsync(command, { ...opts, env })
}

/** A repo with one commit per file, plus any extra subdirectories requested. */
async function makeRepo(dir: string, files: string[], subdirs: string[] = []): Promise<void> {
  await mkdir(dir, { recursive: true })
  await run('git init -q .', { cwd: dir })
  await run('git config user.email t@t.t && git config user.name t', { cwd: dir })
  for (const f of files) {
    await writeFile(join(dir, f), `${f}\n`)
    await run(`git add -A && git commit -q -m "add ${f}"`, { cwd: dir })
  }
  for (const s of subdirs) {
    await mkdir(join(dir, s), { recursive: true })
    await writeFile(join(dir, s, 'file.txt'), 'x\n')
    await run(`git add -A && git commit -q -m "add ${s}"`, { cwd: dir })
  }
}

/** A linked worktree of `repo` at `dir`, checked out on the same commit. */
async function addWorktree(repo: string, dir: string, branch: string): Promise<void> {
  await run(`git worktree add -q -b ${branch} "${dir}" HEAD`, { cwd: repo })
}

beforeEach(async () => {
  // Point the persistent store at a throwaway file: these tests must never read or write the
  // user's real repository statistics.
  process.env.AGENTISTICS_GIT_STATS_CACHE_FILE = join(await mkdtemp(join(tmpdir(), 'gitdb-')), 'git-stats.db')
  clearGitStatsCache()
})

test('a repository is walked once, not once per subdirectory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  const repo = join(root, 'repo')
  // Three subdirectories, all of which `git -C <sub>` resolves to this same repo.
  await makeRepo(repo, ['a.txt', 'b.txt'], ['scripts', 'templates', 'docs'])

  const stats = await getProjectGitStats(repo)
  // 2 file commits + 3 subdirectory commits. The bug reported this repo's history once per
  // subdirectory, so the count came back multiplied.
  expect(stats?.commits).toBe(5)
})

test('an empty window on a repo reports nothing — it does not fall through to the subdirs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  const repo = join(root, 'repo')
  await makeRepo(repo, ['a.txt', 'b.txt'], ['scripts', 'templates', 'docs'])

  // A window with no commits in it. This is the exact shape a timed-out walk also had: the repo
  // answers "nothing", and the old code read that as "not a repository" and scanned the
  // subdirectories — each of which is this same repo, walked again with the window DROPPED. So an
  // empty window produced the single most expensive result possible, five commits deep, three
  // times over. It must produce nothing.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  expect(await getProjectGitStats(repo, tomorrow)).toBeUndefined()
})

test('a workspace of separate repos aggregates each root exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  await makeRepo(join(root, 'one'), ['a.txt'])
  await makeRepo(join(root, 'two'), ['a.txt', 'b.txt'])
  // A subdirectory of a repo already counted must not be counted a second time.
  await mkdir(join(root, 'two', 'nested'), { recursive: true })
  await writeFile(join(root, 'two', 'nested', 'f.txt'), 'x\n')

  const stats = await getProjectGitStats(root)
  expect(stats?.commits).toBe(3)
})

test('a non-repository directory with no repos inside reports nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  await mkdir(join(root, 'plain'), { recursive: true })
  await writeFile(join(root, 'plain', 'f.txt'), 'x\n')

  expect(await getProjectGitStats(root)).toBeUndefined()
})

test('a repository is walked once and then served from the memo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  const repo = join(root, 'repo')
  await makeRepo(repo, ['a.txt'])

  expect((await getProjectGitStats(repo))?.commits).toBe(1)
  expect(gitStatsWalkCount()).toBe(1)

  // Reading it again spends nothing. This is the property that keeps the 30s data-cache rebuild
  // from re-running git every 30s, forever, which is what the storm actually was.
  await getProjectGitStats(repo)
  await getProjectGitStats(repo)
  expect(gitStatsWalkCount()).toBe(1)
})

test('a new commit is picked up without waiting out the TTL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  const repo = join(root, 'repo')
  await makeRepo(repo, ['a.txt'])
  expect((await getProjectGitStats(repo))?.commits).toBe(1)

  await writeFile(join(repo, 'b.txt'), 'b\n')
  await run('git add -A && git commit -q -m "add b.txt"', { cwd: repo })

  // The memo is keyed on the HEAD commit, so committing invalidates it by construction — a 10
  // minute TTL never hides work you just did.
  expect((await getProjectGitStats(repo))?.commits).toBe(2)
})

test('worktrees parked on one commit share a single walk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  const repo = join(root, 'repo')
  await makeRepo(repo, ['a.txt', 'b.txt'])
  // A linked worktree has its OWN toplevel, so deduplicating by repository root did not catch
  // these — and this machine had 34 of them against one repository.
  await addWorktree(repo, join(root, 'wt-one'), 'one')
  await addWorktree(repo, join(root, 'wt-two'), 'two')

  const fromRepo = await getProjectGitStats(repo)
  const fromOne = await getProjectGitStats(join(root, 'wt-one'))
  const fromTwo = await getProjectGitStats(join(root, 'wt-two'))

  expect(fromOne).toEqual(fromRepo!)
  expect(fromTwo).toEqual(fromRepo!)
  expect(gitStatsWalkCount()).toBe(1)
})

test('a restart does not re-walk what a previous run already knew', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  const repo = join(root, 'repo')
  await makeRepo(repo, ['a.txt', 'b.txt'])

  const first = await getProjectGitStats(repo)
  expect(gitStatsWalkCount()).toBe(1)

  // `clearGitStatsCache` drops everything a process holds in memory — which is exactly what dying
  // and starting again does. The disk store is keyed on the COMMIT, so it is still valid, and on
  // this machine the server restarts constantly: an upgrade, a crash, a dev server someone left
  // running. Each of those used to pay the full 18s walk again for numbers already computed.
  clearGitStatsCache()

  expect(await getProjectGitStats(repo)).toEqual(first!)
  expect(gitStatsWalkCount()).toBe(0)
})

test('two instances running side by side walk a repository once between them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  const repo = join(root, 'repo')
  await makeRepo(repo, ['a.txt'])

  // Same store, two processes' worth of memory. Four servers were once found running at once on
  // one laptop, each walking every repository independently.
  await getProjectGitStats(repo)
  expect(gitStatsWalkCount()).toBe(1)
  clearGitStatsCache()
  await getProjectGitStats(repo)

  expect(gitStatsWalkCount()).toBe(0)
})

test('concurrent callers for one repo share a single in-flight walk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitstats-'))
  const repo = join(root, 'repo')
  await makeRepo(repo, ['a.txt', 'b.txt'])

  // Eight callers is the width of the caller-side limiter that used to mean eight walks.
  const all = await Promise.all(Array.from({ length: 8 }, () => getProjectGitStats(repo)))
  for (const s of all) expect(s?.commits).toBe(2)
  // Eight callers, one walk: the later ones joined the in-flight promise.
  expect(gitStatsWalkCount()).toBe(1)
})
