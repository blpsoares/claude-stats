/**
 * backup-routes.ts — the web dashboard's read of the backup engine: per-harness coverage, the
 * current configuration, and the backup history, plus triggering a run.
 *
 * This is the THIRD surface over the same engine `agentop backup` and the cockpit's `backup` tab
 * call (`cli-backup.ts`'s `readBackupPrefs`/`performBackup`, `backup-store.ts`, `backup-size.ts`,
 * `schedule.ts`). It decides nothing: every number here is read straight off the same functions
 * `cli-start.ts`'s `backupStatus`/`runBackup` call for the cockpit, so the two front doors can
 * never disagree about what a backup covers.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { readPreferences } from './preferences'
import { readBackupPrefs, performBackup } from './cli-backup'
import { omittedSecrets, planSources } from './backup/backup-plan'
import { walkSources } from './backup/backup'
import { formatBytes, retainedTotal } from './backup/backup-size'
import { markPresence, readBackups, lastBackup, lastPerHarness } from './backup/backup-store'
import { scheduleStatus } from './backup/schedule'
import { loadConsolidated } from './consolidate'

export interface BackupHarnessJson {
  id: HarnessId
  enabled: boolean
  sessions: number
  sizeLabel: string
  /** ISO — see `ControlBackupHarness.lastBackupAt` for why this is an instant. */
  lastBackupAt?: string
  /** A backup once covered this harness and that file is gone — see `backup-store.ts`'s
   *  `markPresence`. Never rendered as a reassuring date. */
  lastBackupGone?: boolean
}

export interface BackupHistoryJson {
  at: string
  path: string
  layers: string[]
  harnesses: HarnessId[]
  bytesLabel: string
  /** How many paths the walk skipped — `undefined` reads as "not known", never as zero. */
  skipped?: number
  /** Whether the archive file is still on disk — see `backup-store.ts`'s `markPresence`. */
  present: boolean
}

export interface BackupStatusJson {
  /** One row per `HARNESS_ORDER` member — never a literal list. */
  harnesses: BackupHarnessJson[]
  config: {
    layers: string[]
    destDir: string
    schedule: string
    /** False while the server is stopped — see `schedule.ts`'s `inactive-no-server`. The row
     *  must say so rather than a "next at…" that will not arrive. */
    scheduleActive: boolean
    keep: number
    /** What EVERY retained backup occupies together, already formatted. */
    retainedLabel: string
    secretsCount: number
    last?: { at: string; bytesLabel: string; skipped?: number }
  }
  /** Newest first. */
  history: BackupHistoryJson[]
}

/**
 * The whole tab's worth of facts, in one read — the same shape `cli-start.ts`'s `backupStatus`
 * builds for the cockpit, plus the history list the design's web surface also shows.
 */
export async function readBackupStatus(): Promise<BackupStatusJson> {
  const prefs = readBackupPrefs(await readPreferences())
  const [sizes, consolidated, entries] = await Promise.all([
    walkSources(HOME_DIR, planSources({ layers: ['metrics'], harnesses: HARNESS_ORDER }))
      .then(r => r.sizes)
      .catch(() => null),
    loadConsolidated().catch(() => new Map()),
    readBackups().then(rs => markPresence(rs, p => existsSync(p))).catch(() => []),
  ])

  const sessionCounts: Partial<Record<HarnessId, number>> = {}
  for (const sess of consolidated.values()) {
    const h = (sess.harness ?? 'claude') as HarnessId
    sessionCounts[h] = (sessionCounts[h] ?? 0) + 1
  }
  const byHarness = sizes?.metrics.byHarness ?? {}
  const perHarnessLast = lastPerHarness(entries)

  const harnesses: BackupHarnessJson[] = HARNESS_ORDER.map(id => {
    const at = perHarnessLast[id]
    // A recorded backup once covered this harness and its file is gone — checked only when there
    // is no PRESENT one, same rule `cli-start.ts` follows.
    const gone = !at && entries.some(e => e.harnesses.includes(id))
    return {
      id,
      enabled: prefs.harnesses.includes(id),
      sessions: sessionCounts[id] ?? 0,
      sizeLabel: formatBytes(byHarness[id] ?? 0),
      ...(at ? { lastBackupAt: at } : {}),
      ...(gone ? { lastBackupGone: true } : {}),
    }
  })

  const last = lastBackup(entries)
  const st = scheduleStatus({
    schedule: prefs.schedule,
    lastAt: last?.at ?? null,
    nowMs: Date.now(),
    serverRunning: existsSync(join(AGENTISTICS_DATA_DIR, 'events-producer.json')),
  })

  return {
    harnesses,
    config: {
      layers: prefs.layers,
      destDir: prefs.destDir,
      schedule: prefs.schedule,
      scheduleActive: st.kind === 'next',
      keep: prefs.keep,
      retainedLabel: formatBytes(retainedTotal(entries.filter(e => e.present))),
      secretsCount: omittedSecrets().length,
      ...(last
        ? { last: { at: last.at, bytesLabel: formatBytes(last.archiveBytes), skipped: last.skipped } }
        : {}),
    },
    history: entries.map(e => ({
      at: e.at,
      path: e.path,
      layers: e.layers,
      harnesses: e.harnesses,
      bytesLabel: formatBytes(e.archiveBytes),
      skipped: e.skipped,
      present: e.present,
    })),
  }
}

/**
 * Run a backup now, with the configured layers and harnesses — the web's "Run backup now" button.
 * Calls `performBackup`, the ONE implementation `agentop backup` and the cockpit's `b` key both
 * call; this route decides nothing about what a backup carries.
 *
 * Unlike the cockpit, the web has no streaming detail pane to draw progress into, so the log lines
 * are simply discarded — the caller learns the outcome, not the play-by-play, exactly like
 * `agentop backup` run without a terminal attached would.
 */
export async function runBackupNow(): Promise<
  { ok: true; bytesLabel: string; skipped?: number } | { ok: false; reason: string }
> {
  const prefs = readBackupPrefs(await readPreferences())
  const result = await performBackup(
    prefs,
    { layers: prefs.layers, harnesses: prefs.harnesses, destDir: prefs.destDir },
    () => {},
  )
  return result.ok
    ? { ok: true, bytesLabel: formatBytes(result.record.archiveBytes), skipped: result.record.skipped }
    : { ok: false, reason: result.reason }
}
