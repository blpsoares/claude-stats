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
  groups: [{ name: 'metrics', files: 648, bytes: 3_700_000, sha256: 'a'.repeat(64) }],
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
