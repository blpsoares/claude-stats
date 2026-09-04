import { test, expect } from 'bun:test'
import {
  lastBackup, lastPerHarness, markPresence, toPrune, type BackupRecord,
} from './backup-store'

const rec = (over: Partial<BackupRecord> & { at: string; path: string }): BackupRecord => ({
  layers: ['metrics'], harnesses: ['claude'], bytesUncompressed: 1000, archiveBytes: 400,
  sha256: 'x'.repeat(64), durationMs: 100,
  ...over,
})

test('a record whose file is gone is marked absent, not dropped', () => {
  const out = markPresence(
    [rec({ at: '2026-09-01T00:00:00Z', path: '/b/one.tar.zst' })],
    p => p !== '/b/one.tar.zst',
  )
  expect(out).toHaveLength(1)
  expect(out[0]!.present).toBe(false)
})

// The rule the whole store exists for. A reassuring timestamp pointing at a file that does not
// exist is worse than no timestamp: it is the difference between knowing you are unprotected and
// believing you are covered.
test('the last backup ignores records whose file is gone', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/new.tar.zst' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/old.tar.zst' }),
  ], p => p === '/b/old.tar.zst')
  expect(lastBackup(entries)?.at).toBe('2026-09-01T00:00:00Z')
})

test('with nothing present there is no last backup — never a stale date', () => {
  const entries = markPresence([rec({ at: '2026-09-03T00:00:00Z', path: '/b/x' })], () => false)
  expect(lastBackup(entries)).toBeNull()
})

test('last-backup is per harness, and a harness never backed up has none', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/a', harnesses: ['claude', 'codex'] }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/b', harnesses: ['claude'] }),
  ], () => true)
  const per = lastPerHarness(entries)
  expect(per.claude).toBe('2026-09-03T00:00:00Z')
  expect(per.codex).toBe('2026-09-03T00:00:00Z')
  expect(per.gemini).toBeUndefined()
})

test('a harness only in a backup whose file is gone counts as never backed up', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/a', harnesses: ['copilot'] }),
  ], () => false)
  expect(lastPerHarness(entries).copilot).toBeUndefined()
})

test('pruning keeps the newest N present records and returns the rest', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/1' }),
    rec({ at: '2026-09-02T00:00:00Z', path: '/b/2' }),
  ], () => true)
  expect(toPrune(entries, 2).map(r => r.path)).toEqual(['/b/1'])
})

test('pruning never proposes deleting a file that is already gone', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/1' }),
  ], p => p === '/b/3')
  expect(toPrune(entries, 1)).toEqual([])
})

test('keep 0 or below prunes nothing — an accidental zero must not wipe the history', () => {
  const entries = markPresence([rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' })], () => true)
  expect(toPrune(entries, 0)).toEqual([])
  expect(toPrune(entries, -1)).toEqual([])
})
