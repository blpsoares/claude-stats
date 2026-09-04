import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runBackup } from './backup'
import { readManifestOf, restoreMetrics, verifyArchive } from './restore'

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
