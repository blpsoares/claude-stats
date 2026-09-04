import { test, expect } from 'bun:test'
import { emptySizes } from './backup-size'
import { MANIFEST_VERSION, decodeManifest, encodeManifest, type BackupManifest } from './manifest'

const sample = (): BackupManifest => ({
  version: MANIFEST_VERSION,
  createdAt: '2026-09-04T12:00:00.000Z',
  agentopVersion: '1.1.0',
  hostname: 'old-box',
  homeDir: '/home/mithrandir',
  platform: 'linux',
  layers: ['metrics', 'repos'],
  harnesses: ['claude', 'codex'],
  sizes: emptySizes(),
  groups: [{
    name: 'metrics',
    files: [{ rel: '.agentistics/tags.json', bytes: 2 }, { rel: '.claude/stats-cache.json', bytes: 3_699_998 }],
    bytes: 3_700_000,
    sha256: 'a'.repeat(64),
  }],
  repos: [],
  omittedSecrets: [{ path: '.claude/.credentials.json', restoreWith: 'claude login' }],
})

test('a manifest survives a round trip unchanged', () => {
  const m = sample()
  const back = decodeManifest(encodeManifest(m))
  expect(back.ok).toBe(true)
  if (back.ok) expect(back.manifest).toEqual(m)
})

test('unreadable text is refused with a reason, never thrown', () => {
  const r = decodeManifest('{not json')
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('unreadable')
})

// A backup written by a NEWER agentop may carry layers or repo fields this build cannot honour.
// Refusing is the honest answer; restoring the parts we recognise and silently dropping the rest
// would produce a machine that looks restored and is not.
test('a newer manifest version is refused, naming the version', () => {
  const raw = JSON.parse(encodeManifest(sample()))
  raw.version = MANIFEST_VERSION + 1
  const r = decodeManifest(JSON.stringify(raw))
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.reason).toBe('too-new')
    expect(r.found).toBe(MANIFEST_VERSION + 1)
  }
})

test('a manifest missing a required field is refused, not half-read', () => {
  const raw = JSON.parse(encodeManifest(sample()))
  delete raw.homeDir
  const r = decodeManifest(JSON.stringify(raw))
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe('incomplete')
})

// A key that is PRESENT but the wrong type is the half-read this function exists to refuse. Each
// of these passed the presence check and came back inside an `ok` manifest before `shapeOk`.
test('a required field present but the wrong type is refused, not cast', () => {
  for (const [key, bad] of [
    ['layers', 'not-an-array'],
    ['harnesses', 42],
    ['groups', { name: 'metrics' }],
    ['sizes', null],
    ['homeDir', { toString: 'nope' }],
    ['createdAt', 1_700_000_000],
  ] as [string, unknown][]) {
    const raw = JSON.parse(encodeManifest(sample())) as Record<string, unknown>
    raw[key] = bad
    const r = decodeManifest(JSON.stringify(raw))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('incomplete')
  }
})

test('an optional array that is present but not an array is refused', () => {
  const raw = JSON.parse(encodeManifest(sample())) as Record<string, unknown>
  raw.repos = 'nope'
  const r = decodeManifest(JSON.stringify(raw))
  expect(r.ok).toBe(false)
})

// Structure is validated, contents are NOT: a layer name or harness id this build does not know
// must still decode, because the VERSION gate is what guards meaning. Refusing on contents would
// stop an older build reading a manifest it is entitled to read.
test('an unknown layer name still decodes — the version gate guards meaning, not this', () => {
  const raw = JSON.parse(encodeManifest(sample())) as Record<string, unknown>
  raw.layers = ['metrics', 'something-new']
  expect(decodeManifest(JSON.stringify(raw)).ok).toBe(true)
})

test('an older manifest still reads — absent optional arrays become empty', () => {
  const raw = JSON.parse(encodeManifest(sample()))
  delete raw.repos
  delete raw.omittedSecrets
  const r = decodeManifest(JSON.stringify(raw))
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.manifest.repos).toEqual([])
    expect(r.manifest.omittedSecrets).toEqual([])
  }
})
