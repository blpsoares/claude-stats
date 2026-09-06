import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { archiverFor, runBackup, walkSources } from './backup'
import { decodeManifest, MANIFEST_NAME } from './manifest'

let home = ''
let dest = ''
// `recordBackup` defaults to the real `~/.agentistics/backups.jsonl` — every `runBackup` call below
// passes this instead, so running the suite never appends to the operator's own backup history.
let records = ''

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agentistics-home-'))
  dest = mkdtempSync(join(tmpdir(), 'agentistics-dest-'))
  records = join(mkdtempSync(join(tmpdir(), 'agentistics-records-')), 'backups.jsonl')
  mkdirSync(join(home, '.agentistics/sessions/claude'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.agentistics/sessions/claude/a.json'), '{"session_id":"a","project_path":"/x"}')
  writeFileSync(join(home, '.agentistics/tags.json'), '[]')
  writeFileSync(join(home, '.agentistics/cache.db'), 'X'.repeat(5000))          // regenerable
  writeFileSync(join(home, '.claude/stats-cache.json'), '{}')
  writeFileSync(join(home, '.claude/.credentials.json'), '{"secret":"nope"}')   // secret
  writeFileSync(join(home, '.agentistics/preferences.json'), JSON.stringify({
    lang: 'en',
    team: { token: 'SUPER-SECRET-TOKEN', connections: [{ token: 'SUPER-SECRET-TOKEN' }] },
  }))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
  rmSync(dirname(records), { recursive: true, force: true })
})

test('the walk sizes real files and attributes them to a layer and a harness', async () => {
  const { files, sizes } = await walkSources(home, [
    { rel: '.agentistics/sessions/claude', layer: 'metrics', harness: 'claude' },
  ])
  expect(files.map(f => f.rel)).toEqual(['.agentistics/sessions/claude/a.json'])
  expect(sizes.metrics.byHarness.claude).toBeGreaterThan(0)
  expect(sizes.metrics.files).toBe(1)
})

test('the walk drops excluded files and never counts them toward a size', async () => {
  const { files, sizes } = await walkSources(home, [
    { rel: '.agentistics', layer: 'metrics', harness: null },
  ])
  const rels = files.map(f => f.rel)
  expect(rels).toContain('.agentistics/tags.json')
  expect(rels).not.toContain('.agentistics/cache.db')
  expect(sizes.metrics.bytes).toBeLessThan(5000)
})

test('a missing source is not an error — it contributes nothing and is not reported', async () => {
  const { files, skipped } = await walkSources(home, [{ rel: '.codex', layer: 'raw', harness: 'codex' }])
  expect(files).toEqual([])
  expect(skipped).toEqual([])
})

// C2 (I1): an unreadable source ROOT used to read exactly like an absent one — only the errno tells
// them apart. Without the check a permission error on `~/.claude` produced an empty claude layer
// inside a backup that still reported complete success.
//
// If the test runner is root, a mode-000 directory is still readable and this can never fail —
// which is the same silently-cannot-fail shape this branch keeps finding, so it is skipped rather
// than left to pass for the wrong reason.
test('a source root that exists but cannot be read is reported, not read as "not installed"', async () => {
  if (process.getuid?.() === 0) return
  const locked = join(home, '.locked')
  mkdirSync(locked, { recursive: true })
  writeFileSync(join(locked, 'x.json'), '{}')
  chmodSync(locked, 0o000)
  try {
    const { files, skipped } = await walkSources(home, [{ rel: '.locked', layer: 'raw', harness: 'claude' }])
    expect(files).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.reason).toBe('unreadable')
  } finally {
    chmodSync(locked, 0o700)
    rmSync(locked, { recursive: true, force: true })
  }
})

// `stat` dereferences and `lstat` does not, and the difference is a hang. A link to one of its own
// ancestors is an ordinary dotfiles-manager artifact, and following it recurses forever in a tool
// whose whole job is walking someone's home directory.
test('a symlink is not followed, and is reported rather than dropped', async () => {
  const dir = join(home, '.agentistics/sessions/claude')
  symlinkSync(home, join(dir, 'loop'))
  try {
    const { files, skipped } = await walkSources(home, [
      { rel: '.agentistics/sessions/claude', layer: 'metrics', harness: 'claude' },
    ])
    expect(files.map(f => f.rel)).toEqual(['.agentistics/sessions/claude/a.json'])
    expect(skipped).toEqual([{ rel: '.agentistics/sessions/claude/loop', reason: 'symlink' }])
  } finally {
    rmSync(join(dir, 'loop'), { force: true })
  }
})

// THE test of this feature, and it must be written so it can fail.
//
// The first version asked for `layers: ['metrics']`, which reaches `.claude` through exactly ONE
// entry — the single file `.claude/stats-cache.json`. The walk therefore never visited
// `.claude/.credentials.json` at all, so `excludeFor` was never asked about it and the assertion
// passed for the same reason it would pass if the file did not exist. It would have stayed green
// with the entire secrets table deleted.
//
// `raw` is what puts the `.claude` DIRECTORY in the source list, which is the only arrangement
// under which the credential is a candidate and its exclusion is a real event.
test('a backup writes an archive, records a real size, and no credential is inside', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics', 'raw'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box', recordFile: records,
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(existsSync(r.record.path)).toBe(true)
  expect(r.record.archiveBytes).toBeGreaterThan(0)
  expect(r.record.sha256).toMatch(/^[0-9a-f]{64}$/)

  const listing = execFileSync('tar', ['-tf', r.record.path], { encoding: 'utf8' })
  expect(listing).toContain('.agentistics/sessions/claude/a.json')
  expect(listing).toContain(MANIFEST_NAME)
  // Proof the walk actually entered the directory holding the credential — without this the two
  // assertions below are about a file that was never a candidate.
  expect(listing).toContain('.claude/stats-cache.json')
  // The rule that matters most in this whole plan.
  expect(listing).not.toContain('.credentials.json')
  expect(listing).not.toContain('cache.db')
})

// A backup whose source tree contains a symlink returns skipped on the result with that entry,
// and the recorded skipped count matches. Proving the defect is fixed: onLine defaults to a no-op,
// so a caller that does not wire it would get an {ok: true} that looks identical whether the walk
// skipped a symlink or skipped nothing at all.
test('a backup with a symlink in sources returns skipped and records the count', async () => {
  const dir = join(home, '.agentistics/sessions/claude')
  symlinkSync(home, join(dir, 'loop'))
  try {
    const r = await runBackup({
      homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
      repos: [], agentopVersion: 'test', hostname: 'box', recordFile: records,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // The result carries skipped, not only logged it.
    expect(r.skipped).toEqual([{ rel: '.agentistics/sessions/claude/loop', reason: 'symlink' }])
    // The record captures the count.
    expect(r.record.skipped).toBe(1)
  } finally {
    rmSync(join(dir, 'loop'), { force: true })
  }
})

// The repos layer's whole promise. Before this was wired the bundle path in the manifest named a
// file that existed only on the machine being replaced.
test('the repos assets travel inside the archive, under their archive-relative names', async () => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'agentistics-assets-'))
  mkdirSync(join(assetRoot, 'repos'), { recursive: true })
  writeFileSync(join(assetRoot, 'repos/example.bundle'), 'BUNDLE')
  writeFileSync(join(assetRoot, 'repos/example__main.patch'), 'PATCH')

  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics', 'repos'], harnesses: ['claude'],
    repos: [], assetRoot, agentopVersion: 'test', hostname: 'box', recordFile: records,
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const listing = execFileSync('tar', ['-tf', r.record.path], { encoding: 'utf8' })
  expect(listing).toContain('repos/example.bundle')
  expect(listing).toContain('repos/example__main.patch')
  rmSync(assetRoot, { recursive: true, force: true })
})

// B1 (C2): preferences.json is not walked from $HOME — it never enters `EXCLUDE_RULES`, since
// dropping the file entirely would lose custom layouts, the billing timeline and the sharing
// rules the design promises to restore. Instead `runBackup` stages a REDACTED copy of it itself
// (`stageRedactedFiles`, backup.ts) and takes that path from the staging root instead of `$HOME`.
//
// D1: this used to be a CALLER's job — `cli-backup.ts` built the staged copy and passed it in as
// `stagedRels` — which meant a caller could produce an incomplete backup by omitting the argument.
// `daemon.ts` did exactly that, and every scheduled run silently dropped the billing timeline while
// reporting success. This test deliberately mentions no caller: it calls `runBackup` with no
// `assetRoot` and no staging argument and asserts the redacted file is in the archive anyway.
test('runBackup always carries the redacted preferences, with no caller cooperation', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box', recordFile: records,   // no assetRoot, no staged anything
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return

  const text = execFileSync('tar', ['-xOf', r.record.path, '.agentistics/preferences.json'], { encoding: 'utf8' })
  expect(text).toContain('"lang"')
  expect(text).not.toContain('SUPER-SECRET-TOKEN')
})

test('an absent assetRoot is not an error — a metrics-only backup has no assets', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box', recordFile: records,
  })
  expect(r.ok).toBe(true)
})

test('the manifest inside the archive round-trips and records the old $HOME', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box', recordFile: records,
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const text = execFileSync('tar', ['-xOf', r.record.path, MANIFEST_NAME], { encoding: 'utf8' })
  const m = decodeManifest(text)
  expect(m.ok).toBe(true)
  if (m.ok) {
    expect(m.manifest.homeDir).toBe(home)
    expect(m.manifest.harnesses).toEqual(['claude'])
    expect(m.manifest.omittedSecrets.length).toBeGreaterThan(0)
  }
})

test('an archiver is resolved, and it names the extension it will actually produce', () => {
  const a = archiverFor()
  expect(['zstd', 'gzip', 'none']).toContain(a.kind)
  if (a.kind !== 'none') expect(a.extension.startsWith('.tar.')).toBe(true)
})

test('the repos layer COUNTS its bundles and patches', () => {
  // The assets are produced during the backup and live nowhere in $HOME, so the walk cannot see
  // them — they enter the tar through `assetRoot`. They were also never MEASURED, and on a real
  // machine that read `before compression: 2.4 MB` beside `archive: 80.7 MB`: 80 MB of bundles
  // uncounted. Every size surface is fed from `sizes` — the CLI's line, the manifest, the TUI's
  // per-layer figures and the "will this fit in a GitHub release" verdict — so an unmeasured layer
  // makes all of them wrong in the same direction, and the last one decides whether a backup is
  // uploaded or the user is told to carry it on a pendrive.
  const assetRoot = mkdtempSync(join(tmpdir(), 'agentistics-assets-'))
  mkdirSync(join(assetRoot, 'repos'), { recursive: true })
  writeFileSync(join(assetRoot, 'repos/a.bundle'), 'x'.repeat(5000))
  writeFileSync(join(assetRoot, 'repos/b__main.patch'), 'y'.repeat(300))
  const records = join(mkdtempSync(join(tmpdir(), 'agentistics-rec-')), 'backups.jsonl')

  return runBackup({
    homeDir: home, destDir: dest, layers: ['metrics', 'repos'], harnesses: [],
    repos: [], assetRoot, agentopVersion: 'test', hostname: 'box', recordFile: records,
  }).then(async res => {
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const m = decodeManifest(await Bun.file(join(dest, MANIFEST_NAME)).text().catch(() => ''))
    const sizes = res.sizes ?? (m.ok ? m.manifest.sizes : null)
    expect(sizes).not.toBe(null)
    expect(sizes!.repos.bytes).toBe(5300)
    expect(sizes!.repos.files).toBe(2)
  })
})
