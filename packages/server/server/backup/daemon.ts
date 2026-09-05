/**
 * daemon.ts — the scheduled backup, riding along with the daemon that is already running.
 *
 * Same reasoning as `events/daemon.ts`, and the same discipline: it NEVER takes the daemon down
 * with it. A backup that throws reports the reason once and the watcher carries on doing what it
 * was already doing. The scheduled backup is an addition to that process, never a condition of it.
 *
 * The check is cheap (a preference read and a date comparison), so it runs on a plain interval
 * rather than trying to be clever about when to wake up.
 */
import { hostname } from 'os'
import { HOME_DIR } from '../config'
import { readPreferences } from '../preferences'
import { CURRENT_VERSION } from '../version'
import { pruneOldBackups, readBackupPrefs } from '../cli-backup'
import { lastBackup, loadBackupHistory } from './backup-store'
import { isDue } from './schedule'
import { runBackup } from './backup'

const CHECK_MS = 15 * 60_000

export interface ScheduledBackup { stop(): void }

/** Set `AGENTISTICS_BACKUP=0` to keep the daemon from ever running one. */
const enabled = (): boolean => process.env.AGENTISTICS_BACKUP !== '0'

export function startScheduledBackup(log: (line: string) => void = console.log): ScheduledBackup | null {
  if (!enabled()) { log('[backup] disabled (AGENTISTICS_BACKUP=0)'); return null }

  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const prefs = readBackupPrefs(await readPreferences())
      const entries = await loadBackupHistory()
      const last = lastBackup(entries)
      // serverRunning is true by construction: this code only runs inside the daemon.
      const verdict = isDue({
        schedule: prefs.schedule, lastAt: last?.at ?? null, nowMs: Date.now(), serverRunning: true,
      })
      if (!verdict.due) return

      // The scheduled run carries no repository manifest — building one shells out to git across
      // every known directory and writes bundles, which is load nobody asked for unattended. So it
      // must not RECORD a repos layer either: a manifest that claims one produces a restore saying
      // "0 repositories to clone" on a machine whose owner believed they were covered.
      const layers = prefs.scheduleLayers.filter(l => l !== 'repos')
      log(`[backup] scheduled run: layers ${layers.join(', ')} (repos are built by \`agentop backup\`, not on a schedule)`)
      const r = await runBackup({
        homeDir: HOME_DIR,
        destDir: prefs.destDir,
        layers,
        harnesses: prefs.harnesses,
        repos: [],   // the repo manifest is a manual concern: it shells out to git 282 times
        agentopVersion: CURRENT_VERSION,
        hostname: hostname(),
        onLine: l => log(`[backup] ${l}`),
      })
      log(r.ok ? `[backup] wrote ${r.record.path}` : `[backup] failed: ${r.reason}`)
      if (r.ok) await pruneOldBackups(prefs.keep, l => log(`[backup] ${l}`))
    } catch (e) {
      log(`[backup] not run: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, CHECK_MS)
  return { stop: () => clearInterval(timer) }
}
