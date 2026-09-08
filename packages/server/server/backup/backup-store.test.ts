import { test, expect } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  lastBackup, lastBackupRun, lastPerHarness, loadBackupHistory, markPresence, readBackups,
  readPrunedPaths, recordBackup, recordPrune, toPrune, type BackupRecord,
} from './backup-store'

const rec = (over: Partial<BackupRecord> & { at: string; path: string }): BackupRecord => ({
  layers: ['metrics'], harnesses: ['claude'], bytesUncompressed: 1000, archiveBytes: 400,
  sha256: 'x'.repeat(64), durationMs: 100,
  ...over,
})

const NONE = new Set<string>()

test('a record whose file is gone, and never pruned, is marked missing — not dropped', () => {
  const out = markPresence(
    [rec({ at: '2026-09-01T00:00:00Z', path: '/b/one.tar.zst' })],
    NONE,
    p => p !== '/b/one.tar.zst',
  )
  expect(out).toHaveLength(1)
  expect(out[0]!.presence).toBe('missing')
  expect(out[0]!.present).toBe(false)
})

// The rule the whole store exists for. A reassuring timestamp pointing at a file that does not
// exist is worse than no timestamp: it is the difference between knowing you are unprotected and
// believing you are covered.
test('the last backup ignores records whose file is gone', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/new.tar.zst' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/old.tar.zst' }),
  ], NONE, p => p === '/b/old.tar.zst')
  expect(lastBackup(entries)?.at).toBe('2026-09-01T00:00:00Z')
})

test('with nothing present there is no last backup — never a stale date', () => {
  const entries = markPresence([rec({ at: '2026-09-03T00:00:00Z', path: '/b/x' })], NONE, () => false)
  expect(lastBackup(entries)).toBeNull()
})

test('last-backup is per harness, and a harness never backed up has none', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/a', harnesses: ['claude', 'codex'] }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/b', harnesses: ['claude'] }),
  ], NONE, () => true)
  const per = lastPerHarness(entries)
  expect(per.claude).toBe('2026-09-03T00:00:00Z')
  expect(per.codex).toBe('2026-09-03T00:00:00Z')
  expect(per.gemini).toBeUndefined()
})

test('a harness only in a backup whose file is gone counts as never backed up', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/a', harnesses: ['copilot'] }),
  ], NONE, () => false)
  expect(lastPerHarness(entries).copilot).toBeUndefined()
})

// The store is append-only and read back in file order, which is not necessarily sorted — a
// function that depended on its caller having sorted would go wrong the day one did not.
test('last-per-harness keeps the maximum, whatever order it is given', () => {
  const unsorted = [
    { ...rec({ at: '2026-09-01T00:00:00Z', path: '/b/1' }), presence: 'present' as const, present: true },
    { ...rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' }), presence: 'present' as const, present: true },
    { ...rec({ at: '2026-09-02T00:00:00Z', path: '/b/2' }), presence: 'present' as const, present: true },
  ]
  expect(lastPerHarness(unsorted).claude).toBe('2026-09-03T00:00:00Z')
})

test('pruning keeps the newest N present records and returns the rest', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/1' }),
    rec({ at: '2026-09-02T00:00:00Z', path: '/b/2' }),
  ], NONE, () => true)
  expect(toPrune(entries, 2).map(r => r.path)).toEqual(['/b/1'])
})

test('pruning never proposes deleting a file that is already gone', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' }),
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/1' }),
  ], NONE, p => p === '/b/3')
  expect(toPrune(entries, 1)).toEqual([])
})

test('keep 0 or below prunes nothing — an accidental zero must not wipe the history', () => {
  const entries = markPresence([rec({ at: '2026-09-03T00:00:00Z', path: '/b/3' })], NONE, () => true)
  expect(toPrune(entries, 0)).toEqual([])
  expect(toPrune(entries, -1)).toEqual([])
})

// -----------------------------------------------------------------------------
// three-state presence — the fix for "a giant list that looks like it's full of errors"
// -----------------------------------------------------------------------------

test('a file we deleted ON PURPOSE, by retention, reads pruned — neutral, not a warning', () => {
  const entries = markPresence(
    [rec({ at: '2026-09-01T00:00:00Z', path: '/b/old.tar.zst' })],
    new Set(['/b/old.tar.zst']),
    () => false,
  )
  expect(entries[0]!.presence).toBe('pruned')
  // Still not restorable — the legacy boolean keeps meaning exactly that.
  expect(entries[0]!.present).toBe(false)
})

test('a file gone for any OTHER reason reads missing, and only that one earns the warning', () => {
  const entries = markPresence(
    [rec({ at: '2026-09-01T00:00:00Z', path: '/b/vanished.tar.zst' })],
    new Set(['/b/some-other-file.tar.zst']),
    () => false,
  )
  expect(entries[0]!.presence).toBe('missing')
})

test('present wins over pruned when the same path is somehow on disk again', () => {
  const entries = markPresence(
    [rec({ at: '2026-09-01T00:00:00Z', path: '/b/x.tar.zst' })],
    new Set(['/b/x.tar.zst']),
    () => true,
  )
  expect(entries[0]!.presence).toBe('present')
})

test('pruned and missing both count as absent for lastBackup/lastPerHarness/toPrune', () => {
  const entries = markPresence([
    rec({ at: '2026-09-03T00:00:00Z', path: '/b/pruned', harnesses: ['claude'] }),
    rec({ at: '2026-09-02T00:00:00Z', path: '/b/missing', harnesses: ['claude'] }),
  ], new Set(['/b/pruned']), () => false)
  expect(lastBackup(entries)).toBeNull()
  expect(lastPerHarness(entries).claude).toBeUndefined()
  expect(toPrune(entries, 0)).toEqual([])
})

// -----------------------------------------------------------------------------
// the on-disk round trip — recordBackup / recordPrune / readBackups / readPrunedPaths /
// loadBackupHistory, all against a temp file so the suite never touches the real store.
// -----------------------------------------------------------------------------

function tempStore(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agentistics-backup-store-'))
  const file = join(dir, 'backups.jsonl')
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a prune event is its own line, never a rewrite of the backup record', async () => {
  const { file, cleanup } = tempStore()
  try {
    await recordBackup(rec({ at: '2026-09-01T00:00:00Z', path: '/b/a.tar.zst' }), file)
    await recordPrune('/b/a.tar.zst', file)

    const records = await readBackups(file)
    expect(records).toHaveLength(1)
    expect(records[0]!.path).toBe('/b/a.tar.zst')

    const pruned = await readPrunedPaths(file)
    expect(pruned.has('/b/a.tar.zst')).toBe(true)
  } finally {
    cleanup()
  }
})

test('loadBackupHistory composes the read + presence check end to end', async () => {
  const { file, cleanup } = tempStore()
  try {
    await recordBackup(rec({ at: '2026-09-01T00:00:00Z', path: '/b/pruned.tar.zst' }), file)
    await recordBackup(rec({ at: '2026-09-02T00:00:00Z', path: '/b/never-existed.tar.zst' }), file)
    await recordPrune('/b/pruned.tar.zst', file)

    const entries = await loadBackupHistory(file)
    expect(entries.find(e => e.path === '/b/pruned.tar.zst')!.presence).toBe('pruned')
    expect(entries.find(e => e.path === '/b/never-existed.tar.zst')!.presence).toBe('missing')
  } finally {
    cleanup()
  }
})

test('a torn or hand-edited line is skipped on both reads, never thrown on', async () => {
  const { file, cleanup } = tempStore()
  try {
    await recordBackup(rec({ at: '2026-09-01T00:00:00Z', path: '/b/good.tar.zst' }), file)
    const fs = await import('fs/promises')
    await fs.appendFile(file, '{not json\n')
    await recordPrune('/b/good.tar.zst', file)

    expect(await readBackups(file)).toHaveLength(1)
    expect((await readPrunedPaths(file)).has('/b/good.tar.zst')).toBe(true)
  } finally {
    cleanup()
  }
})

// --- when one last RAN, which is a different question -----------------------
//
// THE BUG THIS EXISTS FOR, measured on a real machine: a `daily` schedule fired every fifteen
// minutes for hours. With `deleteLocalAfterUpload` on, every scheduled run uploaded its archive
// and deleted the local copy, so no run it performed was ever `present`; the newest surviving file
// stayed a day old, "more than 24 h ago" was permanently true, and every tick started another
// 112 MB backup. The schedule was asking the restore question.

test('the last RUN counts a backup whose file was uploaded and deleted', () => {
  const entries = markPresence([
    rec({ at: '2026-09-07T19:11:36Z', path: '/b/uploaded.tar.zst' }),
    rec({ at: '2026-09-06T16:12:22Z', path: '/b/still-here.tar.zst' }),
  ], NONE, p => p === '/b/still-here.tar.zst')
  // What can I restore from? The one still on disk.
  expect(lastBackup(entries)?.at).toBe('2026-09-06T16:12:22Z')
  // When did one last run? The one that ran.
  expect(lastBackupRun(entries)?.at).toBe('2026-09-07T19:11:36Z')
})

test('the last run is order-independent — it does not depend on the caller having sorted', () => {
  const entries = markPresence([
    rec({ at: '2026-09-01T00:00:00Z', path: '/b/a.tar.zst' }),
    rec({ at: '2026-09-09T00:00:00Z', path: '/b/c.tar.zst' }),
    rec({ at: '2026-09-05T00:00:00Z', path: '/b/b.tar.zst' }),
  ], NONE, () => false)
  expect(lastBackupRun(entries)?.at).toBe('2026-09-09T00:00:00Z')
})

test('with no records at all there is no last run', () => {
  expect(lastBackupRun([])).toBeNull()
})

// ---------------------------------------------------------------------------------
// The same question, reached from the other side: `lastBackupRun` was arrived at twice,
// independently, from the same measured failure. These cases are kept beside the ones
// above because they pin things those do not — a PRUNED record specifically, ordering
// independence, and the grep guard that fails the build if a schedule is ever fed the
// restorable-from timestamp again. That guard is what stops the four call sites drifting
// back apart.
/**
 * `lastBackupRun` — WHEN ONE LAST RAN, which is not the question `lastBackup` answers.
 *
 * Measured on a real machine: with `deleteLocalAfterUpload` the archive goes to GitHub and the
 * local copy is deleted seconds later (17:20:13 written, 17:20:20 pruned), so every record reads
 * absent, `lastBackup` answers null on every check, and a schedule set to DAILY fired on every one
 * — nine runs in an afternoon, spaced at the daemon's fifteen-minute polling interval.
 */
test('lastBackupRun counts a PRUNED run: retention deleting the file does not un-run the backup', () => {
  const entries = markPresence(
    [rec({ at: '2026-09-07T17:20:13.507Z', path: '/b/new.tar.zst' })],
    new Set(['/b/new.tar.zst']),
    () => false,
  )
  expect(entries[0]!.presence).toBe('pruned')
  expect(lastBackup(entries)).toBe(null)
  expect(lastBackupRun(entries)?.at).toBe('2026-09-07T17:20:13.507Z')
})

test('lastBackupRun counts a MISSING run too — it happened, whatever became of the file', () => {
  const entries = markPresence(
    [rec({ at: '2026-09-07T10:00:00.000Z', path: '/gone.tar.zst' })], new Set(), () => false,
  )
  expect(entries[0]!.presence).toBe('missing')
  expect(lastBackupRun(entries)?.at).toBe('2026-09-07T10:00:00.000Z')
})

test('lastBackupRun takes the NEWEST regardless of presence, and of the order it is handed', () => {
  // The newest is the pruned one; an older record must not win just by still being restorable.
  const entries = markPresence(
    [
      rec({ at: '2026-09-05T00:00:00.000Z', path: '/old.tar.zst' }),
      rec({ at: '2026-09-07T00:00:00.000Z', path: '/new.tar.zst' }),
    ],
    new Set(['/new.tar.zst']),
    p => p === '/old.tar.zst',
  )
  expect(lastBackup(entries)?.path).toBe('/old.tar.zst')
  expect(lastBackupRun(entries)?.path).toBe('/new.tar.zst')
  // Order-independent, for the reason `lastPerHarness` gives.
  expect(lastBackupRun([...entries].reverse())?.path).toBe('/new.tar.zst')
})

test('lastBackupRun is null only when nothing was ever recorded', () => {
  expect(lastBackupRun([])).toBe(null)
})

/**
 * THE GUARD. Feeding a schedule the restorable-backup timestamp is the bug above, and it was in
 * four places at once — the daemon plus the three surfaces that print "next run". Greps the
 * server's own source, the same shape `backup-coverage.lint.test.ts` and `tokens.lint.test.ts` use.
 */
test('no schedule is fed the restorable-backup timestamp', () => {
  const src = join(import.meta.dir, '..')
  let out = ''
  try {
    out = execFileSync('grep', ['-rn', '-B3', 'lastAt:', src, '--include=*.ts'], { encoding: 'utf-8' })
  } catch {
    // grep exits non-zero when nothing matched; an empty result is a legitimate answer here.
    out = ''
  }
  const offenders = out.split('\n').filter(l => l.includes('lastBackup(') && !l.includes('.test.ts'))
  expect(offenders).toEqual([])
})
