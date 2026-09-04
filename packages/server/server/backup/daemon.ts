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
import { hostname, tmpdir } from 'os'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { HOME_DIR } from '../config'
import { readPreferences } from '../preferences'
import { CURRENT_VERSION } from '../version'
import { readBackupPrefs } from '../cli-backup'
import { markPresence, readBackups, lastBackup } from './backup-store'
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
      const entries = markPresence(await readBackups(), p => existsSync(p))
      const last = lastBackup(entries)
      // serverRunning is true by construction: this code only runs inside the daemon.
      const verdict = isDue({
        schedule: prefs.schedule, lastAt: last?.at ?? null, nowMs: Date.now(), serverRunning: true,
      })
      if (!verdict.due) return

      log(`[backup] scheduled run: layers ${prefs.scheduleLayers.join(', ')}`)
      const r = await runBackup({
        homeDir: HOME_DIR,
        destDir: prefs.destDir,
        layers: prefs.scheduleLayers,
        harnesses: prefs.harnesses,
        repos: [],   // the repo manifest is a manual concern: it shells out to git 282 times
        agentopVersion: CURRENT_VERSION,
        hostname: hostname(),
        onLine: l => log(`[backup] ${l}`),
      })
      log(r.ok ? `[backup] wrote ${r.record.path}` : `[backup] failed: ${r.reason}`)
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
