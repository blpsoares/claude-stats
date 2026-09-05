import { test, expect } from 'bun:test'
import {
  GITHUB_NEAR_LIMIT_BYTES, GITHUB_RELEASE_LIMIT_BYTES, buildReleaseBody, githubFitVerdict,
  isBackupTag, parseReleaseBody, releaseTag, tagLabel, tooLargeUploadMessage, uploadVerdict,
} from './backup-github'
import type { BackupLayer } from './backup-plan'

const bytes = (over: Partial<Record<BackupLayer, number | null>> = {}): Record<BackupLayer, number | null> => ({
  metrics: 0, repos: null, archive: 0, raw: 0, ...over,
})

test('well under the cap fits, certainly — compression only shrinks further', () => {
  expect(githubFitVerdict(['metrics'], bytes({ metrics: 1_000_000 }))).toBe('fits')
})

test('at or over the cap is an honest "maybe-not", never a confident no', () => {
  expect(githubFitVerdict(['metrics', 'raw'], bytes({ metrics: 1_000, raw: GITHUB_RELEASE_LIMIT_BYTES }))).toBe('maybe-not')
  expect(githubFitVerdict(['raw'], bytes({ raw: GITHUB_RELEASE_LIMIT_BYTES - 1 }))).toBe('fits')
})

test('only the SELECTED layers are summed — an unticked heavy layer does not count against it', () => {
  expect(githubFitVerdict(['metrics'], bytes({ metrics: 100, raw: GITHUB_RELEASE_LIMIT_BYTES * 5 }))).toBe('fits')
})

test('an unmeasurable layer (repos, before a run) contributes nothing to the sum', () => {
  expect(githubFitVerdict(['metrics', 'repos'], bytes({ metrics: 100 }))).toBe('fits')
})

test('an empty layer selection trivially fits', () => {
  expect(githubFitVerdict([], bytes())).toBe('fits')
})

// --- uploadVerdict — the same reasoning, over a MEASURED archive, with a real refusal at the top ---

test('well under 1.7 GB is ok', () => {
  expect(uploadVerdict(1_000_000)).toBe('ok')
  expect(uploadVerdict(GITHUB_NEAR_LIMIT_BYTES - 1)).toBe('ok')
})

test('between 1.7 GB and 2 GB is near-limit — it still uploads', () => {
  expect(uploadVerdict(GITHUB_NEAR_LIMIT_BYTES)).toBe('near-limit')
  expect(uploadVerdict(GITHUB_RELEASE_LIMIT_BYTES - 1)).toBe('near-limit')
})

test('at or over 2 GB is too-large — it never uploads', () => {
  expect(uploadVerdict(GITHUB_RELEASE_LIMIT_BYTES)).toBe('too-large')
  expect(uploadVerdict(GITHUB_RELEASE_LIMIT_BYTES * 2)).toBe('too-large')
})

// --- tooLargeUploadMessage — everything the user asked this refusal to say ---

test('names the file, that it is self-sufficient, the media that works, the restore command and the alternatives', () => {
  const msg = tooLargeUploadMessage('/home/x/.agentistics/backups/agentistics-backup-host-2026.tar.zst', GITHUB_RELEASE_LIMIT_BYTES)
  expect(msg).toContain('/home/x/.agentistics/backups/agentistics-backup-host-2026.tar.zst')
  expect(msg).toContain('agentop restore /home/x/.agentistics/backups/agentistics-backup-host-2026.tar.zst')
  expect(msg.toLowerCase()).toContain('pendrive')
  expect(msg.toLowerCase()).toContain('self-sufficient')
  expect(msg).toContain('--harness')
  expect(msg).toContain('agentop backup')
})

// --- releaseTag / isBackupTag ---

test('releaseTag sanitizes the ISO stamp the same way the archive filename does', () => {
  expect(releaseTag('2026-09-05T04:07:03.123Z')).toBe('backup-2026-09-05T04-07-03-123Z')
  expect(releaseTag('2026-09-05T04:07:03Z')).toBe('backup-2026-09-05T04-07-03Z')
})

test('isBackupTag recognises exactly what releaseTag mints, and nothing a person would type', () => {
  expect(isBackupTag(releaseTag('2026-09-05T04:07:03.123Z'))).toBe(true)
  expect(isBackupTag(releaseTag('2026-09-05T04:07:03Z'))).toBe(true)
  expect(isBackupTag('v1.0.0')).toBe(false)
  expect(isBackupTag('backup-notes')).toBe(false)
  expect(isBackupTag('backup')).toBe(false)
  expect(isBackupTag('my-backup-2026-09-05T04-07-03Z')).toBe(false)
})

// --- buildReleaseBody — the manifest summary that has to travel with the upload ---

test('the body carries layers, harnesses, session count, byte size and the sha256', () => {
  const body = buildReleaseBody({
    layers: ['metrics', 'raw'],
    harnesses: ['claude', 'codex'],
    sessionCount: 42,
    archiveBytes: 123_456,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-05T04:07:03Z',
    hostname: 'my-laptop',
  })
  expect(body).toContain('metrics')
  expect(body).toContain('raw')
  expect(body).toContain('claude')
  expect(body).toContain('codex')
  expect(body).toContain('42')
  expect(body).toContain('123456')
  expect(body).toContain('a'.repeat(64))
  expect(body).toContain('2026-09-05T04:07:03Z')
  expect(body).toContain('my-laptop')
  expect(body).toContain('agentop restore')
})

// --- parseReleaseBody — wave G3 reads back exactly what buildReleaseBody wrote ---

test('parseReleaseBody round-trips every field buildReleaseBody wrote', () => {
  const input = {
    layers: ['metrics', 'raw'] as BackupLayer[],
    harnesses: ['claude', 'codex'] as const,
    sessionCount: 42,
    archiveBytes: 123_456,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-05T04:07:03Z',
    hostname: 'my-laptop',
  }
  const body = buildReleaseBody({ ...input, harnesses: [...input.harnesses] })
  const parsed = parseReleaseBody(body)
  expect(parsed).toEqual({ ...input, harnesses: [...input.harnesses] })
})

test('parseReleaseBody refuses a body with no recognisable summary', () => {
  expect(parseReleaseBody('# Just a release\n\nSome notes I typed by hand.')).toBeNull()
  expect(parseReleaseBody('')).toBeNull()
})

test('parseReleaseBody refuses a body missing one required field', () => {
  const body = buildReleaseBody({
    layers: ['metrics'], harnesses: ['claude'], sessionCount: 1, archiveBytes: 10,
    sha256: 'b'.repeat(64), createdAt: '2026-01-01T00:00:00Z', hostname: 'x',
  })
  const withoutSha = body.split('\n').filter(l => !l.startsWith('- sha256:')).join('\n')
  expect(parseReleaseBody(withoutSha)).toBeNull()
})

test('a machine LABEL rides in the tag, so releases of different machines are distinguishable', () => {
  // Two machines pointing at ONE repository is the case this exists for. The label had lived only
  // in the release BODY and in the asset's filename, and neither is read by the two things that
  // matter: the retention pass and the listing. See the retention test below for what that cost.
  const tag = releaseTag('2026-09-05T20-16-20-298Z', 'notebook')
  expect(tag.startsWith('backup-notebook-')).toBe(true)
  expect(isBackupTag(tag)).toBe(true)
  expect(tagLabel(tag)).toBe('notebook')
})

test('a tag from before labels existed is still ours, and reports no label', () => {
  // Refusing to recognise it would be worse than cosmetic: retention only ever touches tags it
  // recognises, so every release already in a user's repository would become permanently
  // un-prunable and accumulate until the repository filled up.
  const old = 'backup-2026-09-05T20-16-20-298Z'
  expect(isBackupTag(old)).toBe(true)
  expect(tagLabel(old)).toBe(null)
})

test('a label is folded to what a git ref may hold, and never collides with the timestamp', () => {
  expect(isBackupTag(releaseTag('2026-09-05T20-16-20-298Z', 'my laptop (work)'))).toBe(true)
  expect(tagLabel(releaseTag('2026-09-05T20-16-20-298Z', 'my laptop (work)'))).toBe('my-laptop-work')
  // A label that folds to nothing must not produce a tag that reads as an unlabelled one.
  expect(tagLabel(releaseTag('2026-09-05T20-16-20-298Z', '???'))).toBe(null)
})
