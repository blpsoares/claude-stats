/**
 * backup-notify.test.ts — the toasts a backup raises.
 *
 * A backup can take minutes (a repos layer probes hundreds of directories and uploads ~90 MB) and,
 * on a schedule, nobody pressed anything to start it. Without these, a machine that is busy backing
 * up looks identical to one that is idle, and a FAILED backup looks identical to one that never
 * ran — which is the worst of the three, because it is the one where the person believes they are
 * covered.
 */
import { test, expect } from 'bun:test'
import { backupNotification } from './backup-notify'

test('a started backup is INFO and names what it is carrying', () => {
  const n = backupNotification({ phase: 'started', layers: ['metrics', 'repos'], scheduled: false })
  expect(n.type).toBe('info')
  expect(n.code).toBe('backup.started')
  expect(n.meta?.layers).toBe('metrics + repos')
})

test('a finished backup is SUCCESS and carries the size, which is the fact worth seeing', () => {
  const n = backupNotification({
    phase: 'done', layers: ['metrics'], scheduled: true, bytesLabel: '91.4 MB', skipped: 0,
  })
  expect(n.type).toBe('success')
  expect(n.meta?.size).toBe('91.4 MB')
})

test('a run that SKIPPED paths says so — a clean run and a partial one are different facts', () => {
  const clean = backupNotification({ phase: 'done', layers: ['metrics'], scheduled: false, bytesLabel: '4 MB', skipped: 0 })
  const partial = backupNotification({ phase: 'done', layers: ['metrics'], scheduled: false, bytesLabel: '4 MB', skipped: 3 })
  expect(clean.code).toBe('backup.done')
  expect(partial.code).toBe('backup.done.skipped')
  expect(partial.meta?.skipped).toBe(3)
})

test('a failure is ERROR and carries the reason, never a bare "failed"', () => {
  const n = backupNotification({ phase: 'failed', layers: ['metrics'], scheduled: true, reason: 'no space left on device' })
  expect(n.type).toBe('error')
  expect(n.code).toBe('backup.failed')
  expect(n.meta?.reason).toBe('no space left on device')
})

test('a SCHEDULED run is marked as such', () => {
  // A toast the person did not ask for needs to say why it appeared, or it reads as the app doing
  // something on its own.
  expect(backupNotification({ phase: 'started', layers: ['metrics'], scheduled: true }).meta?.scheduled).toBe(true)
  expect(backupNotification({ phase: 'started', layers: ['metrics'], scheduled: false }).meta?.scheduled).toBe(false)
})

test('the upload half has its own codes — it is a separate thing that can fail alone', () => {
  // A backup that WROTE and failed to UPLOAD is not a failed backup: the archive is on disk and
  // restorable. Reporting it as `backup.failed` would tell the user they have nothing when they
  // have everything except the copy on GitHub.
  const up = backupNotification({ phase: 'uploaded', layers: ['metrics'], scheduled: false, tag: 'backup-notebook-2026-09-05T20-00-00Z' })
  expect(up.type).toBe('success')
  expect(up.code).toBe('backup.uploaded')
  expect(up.meta?.tag).toContain('backup-')

  const failed = backupNotification({ phase: 'upload-failed', layers: ['metrics'], scheduled: false, reason: '403' })
  expect(failed.type).toBe('warning')
  expect(failed.code).toBe('backup.upload_failed')
})

test('every notification carries a code — never a pre-localized string', () => {
  // `NOTIFICATION_TEXT` localizes at RENDER time so the toast follows the language toggle. A
  // `title`/`message` written here would be frozen in whatever language the server chose.
  const all = [
    backupNotification({ phase: 'started', layers: ['metrics'], scheduled: false }),
    backupNotification({ phase: 'done', layers: ['metrics'], scheduled: false, bytesLabel: '1 MB', skipped: 0 }),
    backupNotification({ phase: 'failed', layers: ['metrics'], scheduled: false, reason: 'x' }),
    backupNotification({ phase: 'uploaded', layers: ['metrics'], scheduled: false, tag: 't' }),
    backupNotification({ phase: 'upload-failed', layers: ['metrics'], scheduled: false, reason: 'x' }),
  ]
  for (const n of all) {
    expect(n.code).toBeTruthy()
    expect(n.title).toBeUndefined()
    expect(n.message).toBeUndefined()
  }
})
