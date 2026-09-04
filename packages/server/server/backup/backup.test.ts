import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { archiverFor, runBackup, walkSources } from './backup'
import { decodeManifest, MANIFEST_NAME } from './manifest'

let home = ''
let dest = ''

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agentistics-home-'))
  dest = mkdtempSync(join(tmpdir(), 'agentistics-dest-'))
  mkdirSync(join(home, '.agentistics/sessions/claude'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.agentistics/sessions/claude/a.json'), '{"session_id":"a","project_path":"/x"}')
  writeFileSync(join(home, '.agentistics/tags.json'), '[]')
  writeFileSync(join(home, '.agentistics/cache.db'), 'X'.repeat(5000))          // regenerable
  writeFileSync(join(home, '.claude/stats-cache.json'), '{}')
  writeFileSync(join(home, '.claude/.credentials.json'), '{"secret":"nope"}')   // secret
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
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

test('a missing source is not an error — it contributes nothing', async () => {
  const { files } = await walkSources(home, [{ rel: '.codex', layer: 'raw', harness: 'codex' }])
  expect(files).toEqual([])
})

test('a backup writes an archive, records a real size, and no credential is inside', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box',
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(existsSync(r.record.path)).toBe(true)
  expect(r.record.archiveBytes).toBeGreaterThan(0)
  expect(r.record.sha256).toMatch(/^[0-9a-f]{64}$/)

  const listing = execFileSync('tar', ['-tf', r.record.path], { encoding: 'utf8' })
  expect(listing).toContain('.agentistics/sessions/claude/a.json')
  expect(listing).toContain(MANIFEST_NAME)
  // The rule that matters most in this whole plan.
  expect(listing).not.toContain('.credentials.json')
  expect(listing).not.toContain('cache.db')
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
    repos: [], assetRoot, agentopVersion: 'test', hostname: 'box',
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const listing = execFileSync('tar', ['-tf', r.record.path], { encoding: 'utf8' })
  expect(listing).toContain('repos/example.bundle')
  expect(listing).toContain('repos/example__main.patch')
  rmSync(assetRoot, { recursive: true, force: true })
})

test('an absent assetRoot is not an error — a metrics-only backup has no assets', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box',
  })
  expect(r.ok).toBe(true)
})

test('the manifest inside the archive round-trips and records the old $HOME', async () => {
  const r = await runBackup({
    homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
    repos: [], agentopVersion: 'test', hostname: 'box',
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
