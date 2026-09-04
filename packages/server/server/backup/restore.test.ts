import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runBackup } from './backup'
import { readManifestOf, restoreMetrics, restoreRepos, verifyArchive } from './restore'
import { createBundle } from './repo-probe'
import type { BackupManifest } from './manifest'
import type { RepoEntry } from './repo-manifest'

let oldHome = ''
let newHome = ''
let dest = ''
let archive = ''

beforeAll(async () => {
  oldHome = mkdtempSync(join(tmpdir(), 'agentistics-old-'))
  newHome = mkdtempSync(join(tmpdir(), 'agentistics-new-'))
  dest = mkdtempSync(join(tmpdir(), 'agentistics-arch-'))
  mkdirSync(join(oldHome, '.agentistics/sessions/claude'), { recursive: true })
  mkdirSync(join(oldHome, '.claude'), { recursive: true })
  writeFileSync(
    join(oldHome, '.agentistics/sessions/claude/a.json'),
    JSON.stringify({ session_id: 'a', project_path: `${oldHome}/proj` }),
  )
  writeFileSync(join(oldHome, '.claude/stats-cache.json'), '{"totalCostUSD":42}')
  const r = await runBackup({
    homeDir: oldHome, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'old',
  })
  if (!r.ok) throw new Error(r.reason)
  archive = r.record.path
})

afterAll(() => {
  for (const d of [oldHome, newHome, dest]) rmSync(d, { recursive: true, force: true })
})

test('the manifest is readable straight out of the archive', async () => {
  const m = await readManifestOf(archive)
  expect(m.ok).toBe(true)
  if (m.ok) expect(m.manifest.homeDir).toBe(oldHome)
})

test('a truncated archive is refused before anything is written', async () => {
  const broken = join(dest, 'broken.tar.zst')
  const bytes = readFileSync(archive)
  writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length / 2)))
  const m = await readManifestOf(archive)
  expect(m.ok).toBe(true)
  if (!m.ok) return
  const v = await verifyArchive(broken, m.manifest)
  expect(v.ok).toBe(false)
})

test('an intact archive verifies', async () => {
  const m = await readManifestOf(archive)
  expect(m.ok).toBe(true)
  if (!m.ok) return
  const v = await verifyArchive(archive, m.manifest)
  expect(v.ok).toBe(true)
})

test('metrics land in the new home and the old $HOME prefix is rewritten', async () => {
  const r = await restoreMetrics({ archive, homeDir: newHome })
  expect(r.ok).toBe(true)
  const restored = join(newHome, '.agentistics/sessions/claude/a.json')
  expect(existsSync(restored)).toBe(true)
  const doc = JSON.parse(readFileSync(restored, 'utf8')) as { project_path: string }
  expect(doc.project_path).toBe(`${newHome}/proj`)
})

// Claude owns that file. Ours goes where applyArchivedStats already reads it with per-field max.
test('stats-cache.json never lands on top of Claude own copy', async () => {
  mkdirSync(join(newHome, '.claude'), { recursive: true })
  writeFileSync(join(newHome, '.claude/stats-cache.json'), '{"totalCostUSD":1}')
  await restoreMetrics({ archive, homeDir: newHome })
  expect(readFileSync(join(newHome, '.claude/stats-cache.json'), 'utf8')).toBe('{"totalCostUSD":1}')
  expect(existsSync(join(newHome, '.agentistics/archive/stats-cache/stats-cache.json'))).toBe(true)
})

test('a newer local file survives the restore, and is reported as skipped', async () => {
  const target = join(newHome, '.agentistics/sessions/claude/a.json')
  writeFileSync(target, '{"session_id":"a","local":true}')
  const future = new Date(Date.now() + 60_000)
  utimesSync(target, future, future)

  const r = await restoreMetrics({ archive, homeDir: newHome })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.skipped).toBeGreaterThan(0)
  expect(JSON.parse(readFileSync(target, 'utf8')).local).toBe(true)
})

test('a restore leaves no staging directory behind', async () => {
  await restoreMetrics({ archive, homeDir: newHome })
  expect(existsSync(join(newHome, '.agentistics/restore-staging'))).toBe(false)
})

// The defect this test exists for: the manifest digest covered only the $HOME walk while the
// staging walk covered the repos assets too, so a backup taken with the DEFAULT layers reported
// itself corrupt on restore. Both halves had tests; this is the seam.
test('an archive carrying repos assets restores — the digest covers the same set both sides', async () => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'agentistics-a-'))
  const target = mkdtempSync(join(tmpdir(), 'agentistics-rt-'))
  try {
    mkdirSync(join(assetRoot, 'repos'), { recursive: true })
    writeFileSync(join(assetRoot, 'repos/example.bundle'), 'BUNDLE BYTES')
    writeFileSync(join(assetRoot, 'repos/example__main.patch'), 'PATCH BYTES')

    const made = await runBackup({
      homeDir: oldHome, destDir: dest, layers: ['metrics', 'repos'], harnesses: ['claude'],
      repos: [], assetRoot, agentopVersion: 'test', hostname: 'old',
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    const r = await restoreMetrics({ archive: made.record.path, homeDir: target })
    expect(r.ok).toBe(true)
    expect(existsSync(join(target, '.agentistics/sessions/claude/a.json'))).toBe(true)
    // …and the assets are NOT merged into $HOME: they belong to the archive, not to the home.
    expect(existsSync(join(target, 'repos'))).toBe(false)
  } finally {
    rmSync(assetRoot, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

// --- the repo phase -----------------------------------------------------------------------------
//
// It is the resumable half of the feature and was reaching production verified only by reading it.
// These run real git against a real repository, because what is under test is the interaction.

// `cwd` is NOT enough, and this is not theoretical — it happened twice on this branch. Git fires a
// pre-commit hook with GIT_DIR / GIT_INDEX_FILE / GIT_PREFIX exported, and neither `cwd` nor `-C`
// overrides an inherited GIT_DIR. Run under husky from a linked worktree, `makeOrigin`'s `git init`
// and `git config user.email` below executed against the REAL SHARED repository: they rewrote this
// fleet's git identity and committed a fixture file onto the branch. `repo-probe.test.ts` carries
// the same guard for the same reason; GIT_COMMON_DIR is here too because it redirects
// --git-common-dir on its own (measured).
const git = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[k]
  return execFileSync('git', args, { cwd, encoding: 'utf8', env })
}

/** A real repository to clone FROM. */
function makeOrigin(at: string): string {
  mkdirSync(at, { recursive: true })
  git(at, 'init', '-q', '-b', 'main')
  git(at, 'config', 'user.email', 't@t')
  git(at, 'config', 'user.name', 't')
  writeFileSync(join(at, 'a.txt'), 'one\n')
  git(at, 'add', 'a.txt')
  git(at, 'commit', '-q', '-m', 'one')
  return at
}

const entry = (over: Partial<RepoEntry> & { key: string; cloneUrl: string; mainPath: string }): RepoEntry => ({
  mainBranch: 'main', worktrees: [], bundle: null, dirty: [], note: null, ...over,
})

async function manifestWith(repos: RepoEntry[]): Promise<BackupManifest> {
  const m = await readManifestOf(archive)
  if (!m.ok) throw new Error('fixture archive has no readable manifest')
  return { ...m.manifest, repos }
}

test('a repo is cloned, and a second run does not attempt it again', async () => {
  const origin = makeOrigin(join(dest, 'origin-ok'))
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t1-'))
  try {
    const manifest = await manifestWith([entry({ key: 'ok', cloneUrl: origin, mainPath: '~/proj' })])

    const first = await restoreRepos({ manifest, homeDir: target, archive })
    expect(first.attempted).toBe(1)
    expect(first.succeeded).toBe(1)
    expect(first.failures).toEqual([])
    expect(readFileSync(join(target, 'proj/a.txt'), 'utf8')).toBe('one\n')

    // `done` is terminal — this is what makes re-running safe rather than destructive.
    const second = await restoreRepos({ manifest, homeDir: target, archive })
    expect(second.attempted).toBe(0)
    expect(second.succeeded).toBe(0)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// A restore of 89 repositories WILL partially fail. Re-running until it converges is the whole
// design, and that only works if `failed` is retried while `done` is not.
test('a failure is recorded by name and retried on the next run', async () => {
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t2-'))
  try {
    const manifest = await manifestWith([
      entry({ key: 'bad', cloneUrl: join(dest, 'no-such-repo-anywhere'), mainPath: '~/gone' }),
    ])

    const first = await restoreRepos({ manifest, homeDir: target, archive })
    expect(first.attempted).toBe(1)
    expect(first.succeeded).toBe(0)
    expect(first.failures).toHaveLength(1)
    expect(first.failures[0]!.key).toBe('bad')
    expect(first.failures[0]!.reason.length).toBeGreaterThan(0)

    const second = await restoreRepos({ manifest, homeDir: target, archive })
    expect(second.attempted).toBe(1)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// The resume bookkeeping belongs to the machine being restored INTO. Anchored to the operator's own
// $HOME, two different restore targets sharing a repository key overwrite each other's progress.
test('the resume state is written under the home being restored into', async () => {
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t3-'))
  try {
    const manifest = await manifestWith([
      entry({ key: 'bad', cloneUrl: join(dest, 'nope'), mainPath: '~/gone' }),
    ])
    await restoreRepos({ manifest, homeDir: target, archive })
    expect(existsSync(join(target, '.agentistics/restore-state.json'))).toBe(true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a destination that already exists is skipped with a reason, never cloned over', async () => {
  const origin = makeOrigin(join(dest, 'origin-occupied'))
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t4-'))
  try {
    mkdirSync(join(target, 'proj'), { recursive: true })
    writeFileSync(join(target, 'proj/MINE.txt'), 'do not touch')

    const manifest = await manifestWith([entry({ key: 'occ', cloneUrl: origin, mainPath: '~/proj' })])
    const r = await restoreRepos({ manifest, homeDir: target, archive })

    expect(r.attempted).toBe(0)
    expect(r.skipped).toEqual([{ key: 'occ', reason: 'destination-exists' }])
    expect(readFileSync(join(target, 'proj/MINE.txt'), 'utf8')).toBe('do not touch')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('the repo phase leaves no staging directory behind', async () => {
  const target = mkdtempSync(join(tmpdir(), 'agentistics-t5-'))
  try {
    const manifest = await manifestWith([
      entry({ key: 'bad', cloneUrl: join(dest, 'nope'), mainPath: '~/gone' }),
    ])
    await restoreRepos({ manifest, homeDir: target, archive })
    expect(existsSync(join(target, '.agentistics/restore-staging'))).toBe(false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// C4 reproduced and pinned: `git fetch <bundle> refs/heads/*:refs/heads/*` after a plain clone is
// REFUSED when the branch is checked out — which is exactly the case a bundle exists for.
test('a repository ahead of its remote comes back WITH its unpushed commit', async () => {
  const origin = makeOrigin(join(dest, 'origin-ahead'))
  const clone = join(dest, 'ahead-work')
  const target = mkdtempSync(join(tmpdir(), 'agentistics-ahead-'))
  try {
    git(dest, 'clone', '-q', origin, clone)
    git(clone, 'config', 'user.email', 't@t')
    git(clone, 'config', 'user.name', 't')
    writeFileSync(join(clone, 'b.txt'), 'unpushed\n')
    git(clone, 'add', 'b.txt')
    git(clone, 'commit', '-q', '-m', 'unpushed work')

    const bundleDir = mkdtempSync(join(tmpdir(), 'agentistics-b-'))
    mkdirSync(join(bundleDir, 'repos'), { recursive: true })
    const res = await createBundle(clone, join(bundleDir, 'repos/ahead.bundle'), {
      full: false, maxBytes: 100_000_000,
    })
    expect(res).toBe('written')

    const made = await runBackup({
      homeDir: oldHome, destDir: dest, layers: ['metrics', 'repos'], harnesses: ['claude'],
      assetRoot: bundleDir, agentopVersion: 'test', hostname: 'old',
      repos: [entry({ key: 'ahead', cloneUrl: origin, mainPath: '~/back', bundle: 'repos/ahead.bundle' })],
    })
    expect(made.ok).toBe(true)
    if (!made.ok) return

    const m = await readManifestOf(made.record.path)
    expect(m.ok).toBe(true)
    if (!m.ok) return

    const r = await restoreRepos({ manifest: m.manifest, homeDir: target, archive: made.record.path })
    expect(r.failures).toEqual([])
    expect(r.succeeded).toBe(1)
    // The whole promise of the repos layer, in one assertion.
    expect(readFileSync(join(target, 'back/b.txt'), 'utf8')).toBe('unpushed\n')

    rmSync(bundleDir, { recursive: true, force: true })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
