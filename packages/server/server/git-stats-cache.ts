import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import { GIT_STATS_CACHE_FILE } from './config'
import type { ProjectGitStats } from '@agentistics/core'

/**
 * Repository statistics that survive a restart.
 *
 * `git log --numstat` computes a diff per commit — 18.5s and 478MB of RSS on a 363-commit repo
 * with a 287MB pack. The in-process memo makes one build cheap, but it dies with the process, and
 * on a real machine the server restarts constantly: an upgrade, a crash, a `dev:api` a developer
 * left running, a second instance nobody noticed. Every one of those paid the full price again
 * for numbers that had already been computed.
 *
 * The key is what makes this safe to persist forever: a walk is a pure function of (starting
 * commit, window), and a commit is immutable. A row keyed on a commit SHA can never go stale —
 * it is not a guess about the current state, it is a fact about a commit. New commits get new
 * SHAs and therefore new rows; `gc` drops what stopped being read.
 *
 * Shared through one SQLite file in WAL mode, so instances that DO run side by side compute each
 * repository once between them rather than once each.
 */
export interface GitStatsCache {
  /** Stats recorded for this (commit, window), or null. `null` is also a cached ANSWER when the
   *  stored value is the empty one — see `set`. */
  get(key: string): { value: ProjectGitStats | undefined } | null
  /** Record the result, INCLUDING `undefined` ("this commit has nothing in this window"), which
   *  is exactly the answer the old code kept re-deriving at full price. */
  set(key: string, value: ProjectGitStats | undefined): void
  /** Drop rows not read since `cutoffMs`. */
  gc(cutoffMs: number): number
  rowCount(): number
  close(): void
}

/** The cache that is not there — every method a safe nothing. */
export const NOOP_GIT_STATS_CACHE: GitStatsCache = {
  get: () => null,
  set: () => {},
  gc: () => 0,
  rowCount: () => 0,
  close: () => {},
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS git_stats (
  slot  TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  used  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS git_stats_used ON git_stats(used);
`

/**
 * Open the store, creating it if needed.
 *
 * EVERY failure path returns `NOOP_GIT_STATS_CACHE` rather than throwing, for the same reason
 * `openParseCache` does: an unwritable home, a read-only container, a corrupt database and a
 * non-Bun runtime are all ordinary here, and none may stop a build. The cost of degrading is
 * exactly the time this was meant to save — never a wrong number, because every row is
 * recomputable from the commit it names.
 */
export async function openGitStatsCache(
  file: string = GIT_STATS_CACHE_FILE,
  now: () => number = Date.now,
): Promise<GitStatsCache> {
  let db: any
  let selectStmt: any
  let upsertStmt: any
  let touchStmt: any
  let countStmt: any
  let gcStmt: any
  try {
    await mkdir(dirname(file), { recursive: true })
    // Dynamic import so a non-Bun runtime degrades instead of crashing at import time.
    const { Database } = await import('bun:sqlite')
    db = new Database(file, { create: true })
    // WAL: several agentop processes read and write this one file, and a reader must not block
    // behind a writer holding the whole database.
    db.exec('PRAGMA journal_mode = WAL')
    // NORMAL is the right durability for derived state: a row lost to a power cut is one walk.
    db.exec('PRAGMA synchronous = NORMAL')
    // A write must never wedge a build because another instance holds the lock.
    db.exec('PRAGMA busy_timeout = 2000')
    db.exec(SCHEMA)

    // Compiled inside the guard: a pre-existing `git_stats` table with different columns throws
    // HERE (CREATE TABLE IF NOT EXISTS matches on name only), which is the degrade we promise.
    selectStmt = db.query('SELECT value FROM git_stats WHERE slot = ?')
    upsertStmt = db.query(
      'INSERT INTO git_stats (slot, value, used) VALUES (?, ?, ?) ' +
      'ON CONFLICT(slot) DO UPDATE SET value = excluded.value, used = excluded.used'
    )
    touchStmt = db.query('UPDATE git_stats SET used = ? WHERE slot = ?')
    countStmt = db.query('SELECT COUNT(*) AS n FROM git_stats')
    gcStmt = db.query('DELETE FROM git_stats WHERE used < ?')
  } catch {
    try { db?.close() } catch { /* already gone */ }
    return NOOP_GIT_STATS_CACHE
  }

  const store: GitStatsCache = {
    get(key) {
      try {
        const row = selectStmt.get(key) as { value: string } | null
        if (!row) return null
        // A blob written by an older build may no longer parse or hold the shape expected.
        // Both are a miss — recompute, never crash.
        const parsed = JSON.parse(row.value) as { v: ProjectGitStats | null }
        touchStmt.run(now(), key)
        return { value: parsed.v ?? undefined }
      } catch {
        return null
      }
    },
    set(key, value) {
      // A write that fails costs one recomputation, never the build.
      try { upsertStmt.run(key, JSON.stringify({ v: value ?? null }), now()) } catch { /* ignore */ }
    },
    gc(cutoffMs) {
      try {
        const before = store.rowCount()
        gcStmt.run(cutoffMs)
        return before - store.rowCount()
      } catch {
        return 0
      }
    },
    rowCount() {
      try { return (countStmt.get() as { n: number } | null)?.n ?? 0 } catch { return 0 }
    },
    close() {
      try { db.close() } catch { /* already gone */ }
    },
  }
  return store
}
