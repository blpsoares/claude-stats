/**
 * github-seed.test.ts — a repository with no commits cannot hold a release, so we give it one.
 */
import { test, expect } from 'bun:test'
import { SEED_PATH, alreadyUploaded, isEmptyRepoError, seedRepository } from './github-seed'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('GitHub\'s "repository is empty" is recognised in the shapes it actually arrives in', () => {
  // Measured against the real API on 2026-09-06. Creating a release answers 422 with the sentence
  // nested inside `errors[]`, while reading contents answers 404 with it at the top level — the
  // same condition, two shapes, and neither carries a machine-readable code.
  expect(isEmptyRepoError('Validation Failed: Repository is empty.')).toBe(true)
  expect(isEmptyRepoError('This repository is empty.')).toBe(true)
  expect(isEmptyRepoError('Git Repository is empty.')).toBe(true)
  // Not this: a repository that exists and simply holds no BACKUPS is a different thing entirely,
  // and seeding it would be writing to somebody's repository for no reason.
  expect(isEmptyRepoError('Not Found')).toBe(false)
  expect(isEmptyRepoError('Bad credentials')).toBe(false)
})

test('seeding writes ONE file, through the Contents API, and says what it did', async () => {
  // The Contents API is the only way to create the first commit without a local clone: it creates
  // the default branch as a side effect of writing a file to it.
  let seen: { path: string; body: Record<string, unknown> } | null = null
  const r = await seedRepository('me', 'backups', 'tok', async (url, init) => {
    seen = { path: url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> }
    return json({ commit: { sha: 'abc' } }, 201)
  })
  expect(r.ok).toBe(true)
  expect(seen!.path).toContain(`/contents/${SEED_PATH}`)
  // Base64, because that is what the Contents API takes — and a README rather than an empty file,
  // so somebody opening the repository months later can tell what it is.
  const content = String(seen!.body.content)
  expect(atob(content)).toContain('agentistics')
})

test('a seed that fails is a REASON, never a silent carry-on', async () => {
  const r = await seedRepository('me', 'backups', 'tok', async () => json({ message: 'Bad credentials' }, 401))
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.reason).toContain('Bad credentials')
})

test('a repository that is NOT empty is never seeded — the file already being there is fine', async () => {
  // 422 "already exists" is what the Contents API answers for a path that is present. Racing
  // another machine seeding the same repository must not turn into a failed backup.
  const r = await seedRepository('me', 'backups', 'tok', async () =>
    json({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, 422))
  expect(r.ok).toBe(true)
})

test('alreadyUploaded — a backup already on GitHub is not sent twice', () => {
  // Asked for directly: "double verification, only send if it has not been sent". The check is by
  // TAG, which is minted from the backup's own timestamp and this machine's label, so it names
  // exactly one backup of exactly one machine. Re-uploading is not merely wasteful — the upload
  // deletes the local archive once confirmed, so a second run over an already-uploaded backup
  // would be re-sending ~90 MB to replace a release that is already correct.
  const tags = ['backup-braiaode2-2026-09-05T10-00-00Z', 'v1.0.0']
  expect(alreadyUploaded(tags, 'backup-braiaode2-2026-09-05T10-00-00Z')).toBe(true)
  expect(alreadyUploaded(tags, 'backup-braiaode2-2026-09-06T10-00-00Z')).toBe(false)
  // Another machine's backup of the same instant is NOT this one.
  expect(alreadyUploaded(tags, 'backup-desktop-2026-09-05T10-00-00Z')).toBe(false)
  expect(alreadyUploaded([], 'backup-x-2026-01-01T00-00-00Z')).toBe(false)
})
