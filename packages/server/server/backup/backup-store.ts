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
 *
 * **A missing file is not one fact, it is two.** `pruneOldBackups` deletes a file ON PURPOSE, by
 * retention — that is the normal, expected outcome of a week of daily backups, and rendering it
 * the same red "gone" as a file that vanished for some OTHER reason (a tidied directory, a dead
 * external disk) cries wolf on every row past `keep`. So a prune is itself a recorded EVENT — a
 * `PruneRecord` line appended beside the backup records it is about — and `markPresence` reads
 * both to tell three states apart: `present` (the file is there), `pruned` (we deleted it, on
 * purpose, by retention — neutral, not an error), `missing` (recorded, not pruned, and not on
 * disk — the one that earns a warning colour).
 */
import { existsSync } from 'fs'
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

/** A prune deletes the FILE, on purpose, by retention — it is an event, not a correction of the
 *  backup record, so it is its own append-only line rather than a rewrite of one. `kind: 'prune'`
 *  is the discriminant; a plain `BackupRecord` line predates this field and has none, which reads
 *  as "not a prune" exactly like `skipped: undefined` reads as "not known" elsewhere in this file. */
export interface PruneRecord {
  kind: 'prune'
  /** ISO. */
  at: string
  path: string
}

type BackupLine = BackupRecord | PruneRecord

function isPruneRecord(x: BackupLine): x is PruneRecord {
  return (x as { kind?: string }).kind === 'prune'
}

export type BackupPresence = 'present' | 'pruned' | 'missing'

export interface BackupHistoryEntry extends BackupRecord {
  /** Three states, not two — see the module header. */
  presence: BackupPresence
  /**
   * Legacy convenience, true only for `presence === 'present'`. Every caller that only cares
   * whether a backup is actually RESTORABLE from — `lastBackup`, `lastPerHarness`, `toPrune`, the
   * retained-total sum — keeps reading this, unchanged: a pruned backup is still not a backup you
   * can restore from, exactly like a missing one.
   */
  present: boolean
}

/**
 * Newest first, each marked `present` / `pruned` / `missing`.
 *
 * `prunedPaths` is a SET, not a boolean flag on the record — a record on its own cannot know its
 * own future, so whether it was later pruned has to come from a separate read of the prune events.
 */
export function markPresence(
  records: BackupRecord[], prunedPaths: ReadonlySet<string>, exists: (path: string) => boolean,
): BackupHistoryEntry[] {
  return records
    .map(r => {
      const onDisk = exists(r.path)
      const presence: BackupPresence = onDisk ? 'present' : prunedPaths.has(r.path) ? 'pruned' : 'missing'
      return { ...r, presence, present: presence === 'present' }
    })
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

/** Every line of the store, parsed. A line that will not parse is SKIPPED, not thrown on: an
 *  append interrupted by a crash or a full disk leaves a torn last line, and one bad line must
 *  not cost the user every record before it. */
async function readLines(file: string): Promise<BackupLine[]> {
  const text = await readFile(file, 'utf-8').catch(() => '')
  const out: BackupLine[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as BackupLine)
    } catch {
      // torn or hand-edited line — the records around it are still good
    }
  }
  return out
}

/** Every recorded backup — prune events are a different line shape and are not among them. */
export async function readBackups(file = BACKUPS_FILE): Promise<BackupRecord[]> {
  return (await readLines(file)).filter((l): l is BackupRecord => !isPruneRecord(l))
}

/** The paths a prune event named — never a backup RECORD, only the fact that its file was
 *  deleted on purpose, by retention. */
export async function readPrunedPaths(file = BACKUPS_FILE): Promise<Set<string>> {
  const out = new Set<string>()
  for (const l of await readLines(file)) if (isPruneRecord(l)) out.add(l.path)
  return out
}

/** Append one record. Atomic by construction; see BACKUPS_FILE. */
export async function recordBackup(record: BackupRecord, file = BACKUPS_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(record) + '\n')
}

/** Append one prune event — deliberately never a rewrite of the backup record it is about; see
 *  the module header. */
export async function recordPrune(path: string, file = BACKUPS_FILE): Promise<void> {
  const rec: PruneRecord = { kind: 'prune', at: new Date().toISOString(), path }
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(rec) + '\n')
}

/**
 * The whole history, ready to render: every recorded backup, marked `present` / `pruned` /
 * `missing` against what is actually on disk and what was deliberately pruned. The one function
 * every caller that just wants "the history" should use, rather than re-composing
 * `readBackups`/`readPrunedPaths`/`markPresence` by hand at each of the (several) call sites.
 */
export async function loadBackupHistory(file = BACKUPS_FILE): Promise<BackupHistoryEntry[]> {
  const [records, pruned] = await Promise.all([readBackups(file), readPrunedPaths(file)])
  return markPresence(records, pruned, p => existsSync(p))
}
