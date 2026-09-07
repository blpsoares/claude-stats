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
import { readPreferences } from '../preferences'
import { performBackup, readBackupPrefs } from '../cli-backup'
import { lastBackupRun, loadBackupHistory } from './backup-store'
import { isDue } from './schedule'

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
      // `lastBackupRun`, NOT `lastBackup`: the schedule asks when one last RAN, and a run whose
      // archive was uploaded and then deleted locally still ran. Reading the restorable-from one
      // here made a daily schedule fire every fifteen minutes — see backup-store.ts.
      const last = lastBackupRun(entries)
      // serverRunning is true by construction: this code only runs inside the daemon.
      const verdict = isDue({
        schedule: prefs.schedule, customHours: prefs.customHours,
        atHour: prefs.atHour, tzOffsetMinutes: new Date().getTimezoneOffset(),
        lastAt: last?.at ?? null, nowMs: Date.now(), serverRunning: true,
      })
      if (!verdict.due) return

      // The scheduled run carries no repository manifest — building one shells out to git across
      // every known directory and writes bundles, which is load nobody asked for unattended. So it
      // must not RECORD a repos layer either: a manifest that claims one produces a restore saying
      // "0 repositories to clone" on a machine whose owner believed they were covered.
      const layers = prefs.scheduleLayers.filter(l => l !== 'repos')
      log(`[backup] scheduled run: layers ${layers.join(', ')} (repos are built by \`agentop backup\`, not on a schedule)`)
      // THE SAME `performBackup` a manual `agentop backup` runs — write, prune, then the GitHub
      // confirmation ladder — rather than a second copy of that sequence. It used to be one here,
      // and a copy of a gesture is a second place for the two to drift: the notifications added to
      // `performBackup` reached a person pressing a button and NOT the unattended run, which is the
      // one nobody is watching and the only one where a silent failure goes unnoticed for weeks.
      //
      // Passing `layers` WITHOUT `repos` is what keeps the daemon's own rule intact:
      // `performBackup` builds a manifest only when the layers ask for one, so filtering the layer
      // out is the whole of "no unattended git shelling", stated once.
      const r = await performBackup(
        prefs,
        { layers, harnesses: prefs.harnesses, destDir: prefs.destDir },
        l => log(`[backup] ${l}`),
        true,
      )
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
