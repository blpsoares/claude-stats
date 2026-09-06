/**
 * github-seed.ts — a repository with no commits cannot hold a release.
 *
 * Measured against the real API on 2026-09-06: a freshly created GitHub repository, with the
 * "add a README" box left unticked, refuses `POST /releases` with
 * `422 Validation Failed — Repository is empty.` That is exactly the repository a person creates
 * when they follow the instruction "create a private repository", so the FIRST backup of every new
 * setup failed, and the toast said only "upload failed".
 *
 * Rather than telling the user to go and make a commit, the upload makes one: a README, through
 * the Contents API, which is the only way to create the first commit without a local clone — it
 * creates the default branch as a side effect of writing a file to it.
 *
 * It is a README rather than an empty file on purpose. This repository is going to sit in somebody's
 * account holding nothing but release assets; opening it months later and finding one file that
 * says what it is for is the difference between a backup store and a mystery.
 */
import { gh, type FetchLike } from './github-api'

export const SEED_PATH = 'README.md'

const SEED_TEXT = [
  '# agentistics backups',
  '',
  'This repository holds versioned backups of one or more machines running',
  '[agentistics](https://github.com/blpsoares/agentistics).',
  '',
  'Each backup is a **release**, and the archive is its asset. The release tag names the machine',
  'that made it (`backup-<machine>-<timestamp>`), so several machines can share this repository',
  'without their histories being mistaken for one another.',
  '',
  'Restore one with:',
  '',
  '```',
  'agentop restore <this repository URL>',
  '```',
  '',
  'Nothing here is meant to be edited by hand.',
  '',
].join('\n')

/**
 * Does this message mean "the repository has no commits yet"?
 *
 * GitHub says it in more than one shape and gives no machine-readable code: creating a release
 * answers 422 with the sentence nested inside `errors[]`, reading contents answers 404 with it at
 * the top level. Both were measured. The match is deliberately NARROW — a repository that merely
 * holds no backups is a different thing, and seeding it would be writing to somebody's repository
 * for no reason.
 */
export function isEmptyRepoError(message: string): boolean {
  return /repository is empty/i.test(message)
}

/**
 * Give the repository its first commit. Idempotent in the way that matters: a path that already
 * exists answers 422 (`"sha" wasn't supplied`), which means somebody — another machine sharing
 * this repository, or a previous run — got there first, and that is a SUCCESS for our purposes.
 */
export async function seedRepository(
  owner: string, repo: string, token: string, fetchImpl?: FetchLike,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await gh<{ commit?: { sha?: string } }>(
    `/repos/${owner}/${repo}/contents/${SEED_PATH}`, token,
    {
      method: 'PUT',
      body: JSON.stringify({
        message: 'chore: initialise the agentistics backup store',
        content: btoa(SEED_TEXT),
      }),
    },
    fetchImpl,
  )
  if (res.ok) return { ok: true }
  // Already there. Racing another machine seeding the same repository must not become a failed
  // backup — the goal was "this repository has a commit", and it does.
  if (/sha.{0,3} wasn.{0,3}t supplied|already exists/i.test(res.message)) return { ok: true }
  return { ok: false, reason: res.message }
}

/**
 * Is this exact backup already on GitHub?
 *
 * By TAG, which `releaseTag` mints from the backup's own timestamp and this machine's label — so it
 * names one backup of one machine and nothing else. Asked for directly, and worth more than the
 * round trip it saves: the upload DELETES the local archive once the copy is confirmed, so a
 * second run over an already-uploaded backup would re-send ~90 MB to replace a release that is
 * already correct, and would do it while the local file it is replacing has already been removed.
 */
export function alreadyUploaded(existingTags: string[], tag: string): boolean {
  return existingTags.includes(tag)
}
