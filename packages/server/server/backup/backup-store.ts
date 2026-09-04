/**
 * backup-store.ts — the record of what has actually been backed up.
 *
 * The decisions are pure and take an `exists` predicate; only `readBackups` / `writeBackups` touch
 * the disk. That split is what lets the one rule this module exists for be tested without a
 * filesystem:
 *
 * **A recorded backup whose file is gone is not a backup.** The file lives on a pendrive, an
 * external disk, a directory someone tidied. `markPresence` marks it rather than dropping it (the
 * record is still the honest history), and `lastBackup` / `lastPerHarness` count only what is
 * present — so a machine whose only backup was deleted reads as never backed up, which is what it
 * is. A reassuring timestamp pointing at a file that does not exist is the difference between
 * knowing you are unprotected and believing you are covered.
 *
 * `toPrune` inherits it: it never proposes deleting a file that is already gone, and a `keep` of
 * zero or below prunes nothing — a config typo must not be a way to wipe every backup at once.
 */
import { dirname, join } from 'path'
import { appendFile, mkdir, readFile } from 'fs/promises'
import type { HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from '../config'
import type { BackupLayer } from './backup-plan'

/**
 * APPEND-ONLY, and `.jsonl` rather than `.json` because of it.
 *
 * The obvious shape — a JSON array, read-modify-written by `recordBackup` — is the registry race
 * `registry.ts` documents and this project has MEASURED: agentop runs as several processes (a
 * cockpit, the daemon, every one-shot command), and a record written by a short-lived one has been
 * observed erased by a longer-lived one. Here the loss is quiet and lands on exactly the question
 * this module exists to answer: the history would say you last backed up longer ago than you did.
 *
 * A lock would mitigate it. Appending removes it: one short line written with `O_APPEND` is atomic,
 * so two processes recording at once both survive with no coordination at all.
 *
 * Nothing rewrites the file, and that costs nothing, because the module already holds the rule that
 * makes rewriting unnecessary — a record whose file is gone is MARKED, not dropped. Pruning deletes
 * the FILES; the records stay, and `markPresence` reports them absent from then on. At roughly 200
 * bytes a record, a daily backup writes 73 KB a year.
 */
export const BACKUPS_FILE = join(AGENTISTICS_DATA_DIR, 'backups.jsonl')

export interface BackupRecord {
  /** ISO. */
  at: string
  path: string
  layers: BackupLayer[]
  harnesses: HarnessId[]
  /** What the sources weighed on disk. */
  bytesUncompressed: number
  /** The archive's REAL size, measured after writing. The only compressed figure in the system. */
  archiveBytes: number
  sha256: string
  durationMs: number
  /**
   * How many paths the walk skipped — a symlink it would not follow, or something it could not
   * read. A COUNT rather than the list, because the list is unbounded (a home directory can hold
   * thousands of symlinks) and this file is append-only history.
   *
   * It is here so `agentop backup status` can say a backup was incomplete. Absent on a record
   * written before the field existed, which reads as "not known", never as zero.
   */
  skipped?: number
}

export interface BackupHistoryEntry extends BackupRecord {
  present: boolean
}

/** Newest first, each marked with whether its file is still on disk. */
export function markPresence(
  records: BackupRecord[], exists: (path: string) => boolean,
): BackupHistoryEntry[] {
  return records
    .map(r => ({ ...r, present: exists(r.path) }))
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** The newest backup that is actually there, or null. */
export function lastBackup(entries: BackupHistoryEntry[]): BackupHistoryEntry | null {
  return entries.find(e => e.present) ?? null
}

/**
 * When each harness was last covered by a backup that still exists.
 *
 * Deliberately order-INDEPENDENT: it keeps the maximum rather than the first hit. `markPresence`
 * does sort, but a function whose answer depends on its caller having sorted is one that silently
 * becomes wrong the day some other caller does not.
 */
export function lastPerHarness(entries: BackupHistoryEntry[]): Partial<Record<HarnessId, string>> {
  const out: Partial<Record<HarnessId, string>> = {}
  for (const e of entries) {
    if (!e.present) continue
    for (const h of e.harnesses) {
      const seen = out[h]
      if (!seen || e.at > seen) out[h] = e.at
    }
  }
  return out
}

/** Records whose files should be deleted to honour `keep`. Never one that is already gone. */
export function toPrune(entries: BackupHistoryEntry[], keep: number): BackupHistoryEntry[] {
  if (keep <= 0) return []
  return entries.filter(e => e.present).slice(keep)
}

/**
 * Every recorded backup. A line that will not parse is SKIPPED, not thrown on: an append
 * interrupted by a crash or a full disk leaves a torn last line, and one bad line must not cost the
 * user every record before it.
 */
export async function readBackups(file = BACKUPS_FILE): Promise<BackupRecord[]> {
  const text = await readFile(file, 'utf-8').catch(() => '')
  const out: BackupRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as BackupRecord)
    } catch {
      // torn or hand-edited line — the records around it are still good
    }
  }
  return out
}

/** Append one record. Atomic by construction; see BACKUPS_FILE. */
export async function recordBackup(record: BackupRecord, file = BACKUPS_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(record) + '\n')
}
