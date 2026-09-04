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
import { join } from 'path'
import { writeFile } from 'fs/promises'
import type { HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from '../config'
import { safeReadJson } from '../utils'
import type { BackupLayer } from './backup-plan'

export const BACKUPS_FILE = join(AGENTISTICS_DATA_DIR, 'backups.json')

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

/** When each harness was last covered by a backup that still exists. */
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

export async function readBackups(file = BACKUPS_FILE): Promise<BackupRecord[]> {
  return (await safeReadJson<BackupRecord[]>(file)) ?? []
}

export async function writeBackups(records: BackupRecord[], file = BACKUPS_FILE): Promise<void> {
  await writeFile(file, JSON.stringify(records, null, 2))
}

export async function recordBackup(record: BackupRecord, file = BACKUPS_FILE): Promise<void> {
  const all = await readBackups(file)
  all.push(record)
  await writeBackups(all, file)
}
