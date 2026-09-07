/**
 * backup-notify.ts — PURE: the toast a backup raises, as a `broadcastNotification` payload.
 *
 * A backup can take minutes — the repos layer probes hundreds of directories and the archive is
 * ~90 MB on the machine this was written for — and on a schedule nobody pressed anything to start
 * it. Without a toast, a machine that is busy backing up looks exactly like one that is idle, and
 * a FAILED backup looks exactly like one that never ran. That last pair is the dangerous one: it
 * is the case where the person believes they are covered.
 *
 * Pure, and separate from the code that performs the backup, for the usual reason — what is said
 * is a decision worth testing on its own, and `broadcastNotification` reaches a socket.
 */
import type { BackupLayer } from './backup-plan'

export interface BackupNotifyInput {
  phase: 'started' | 'done' | 'failed' | 'uploaded' | 'upload-failed'
  layers: BackupLayer[]
  /** True when the daemon started it rather than a person. */
  scheduled: boolean
  bytesLabel?: string
  skipped?: number
  reason?: string
  /** The release tag, for the upload phases. */
  tag?: string
}

export interface BackupNotification {
  type: 'error' | 'warning' | 'info' | 'success'
  code: string
  meta: Record<string, unknown>
  /** Never set. Declared so the "no pre-localized text" test can assert its absence. */
  title?: undefined
  message?: undefined
}

/**
 * What to say, and how loudly.
 *
 * Rules that are decisions rather than formatting:
 * - **A run that skipped paths gets its own code.** A clean run and a partial one are different
 *   facts, and one sentence covering both would let a backup quietly stop carrying something.
 * - **The upload is its own pair of codes, and its failure is a WARNING, not an error.** A backup
 *   that was written and failed to upload is not a failed backup: the archive is on disk and
 *   restores. Calling it `backup.failed` would tell someone they have nothing when they have
 *   everything except the copy on GitHub.
 * - **`scheduled` travels.** A toast nobody asked for has to say why it appeared, or it reads as
 *   the application doing something on its own.
 * - **Only a `code`, never a `title`/`message`.** `NOTIFICATION_TEXT` localizes at render time so
 *   the toast follows the language toggle; text written here would be frozen in whatever language
 *   the server happened to choose.
 */
export function backupNotification(input: BackupNotifyInput): BackupNotification {
  const meta: Record<string, unknown> = {
    layers: input.layers.join(' + '),
    scheduled: input.scheduled,
  }
  if (input.bytesLabel !== undefined) meta.size = input.bytesLabel
  if (input.reason !== undefined) meta.reason = input.reason
  if (input.tag !== undefined) meta.tag = input.tag

  switch (input.phase) {
    case 'started':
      return { type: 'info', code: 'backup.started', meta }
    case 'done': {
      const skipped = input.skipped ?? 0
      if (skipped > 0) {
        meta.skipped = skipped
        return { type: 'success', code: 'backup.done.skipped', meta }
      }
      return { type: 'success', code: 'backup.done', meta }
    }
    case 'failed':
      return { type: 'error', code: 'backup.failed', meta }
    case 'uploaded':
      return { type: 'success', code: 'backup.uploaded', meta }
    case 'upload-failed':
      return { type: 'warning', code: 'backup.upload_failed', meta }
  }
}
