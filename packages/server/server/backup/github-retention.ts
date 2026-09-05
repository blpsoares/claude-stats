/**
 * github-retention.ts — keep the newest `keepRemote` backup releases on GitHub, delete the rest.
 *
 * Runs only after a confirmed upload (see `github-upload.ts`'s `syncBackupToGithub`), and only
 * ever touches a release whose tag `isBackupTag` recognises — the EXACT shape `releaseTag` mints.
 * A release the user created by hand, whatever they named it, is never a candidate: this module
 * does not even see it as a "backup" release to weigh against `keepRemote`, because it is filtered
 * out before the newest-N split happens, not merely spared by luck.
 *
 * Deleting a release via the API removes its assets with it — GitHub does not leave an orphaned
 * asset behind — so one DELETE per release covers "asset and release" together; there is no
 * separate asset-delete call to make.
 */
import { gh, type FetchLike } from './github-api'
import { isBackupTag } from './backup-github'

interface GithubReleaseListItem {
  id: number
  tag_name: string
  created_at: string
}

export interface PruneRemoteResult {
  deleted: { tag: string; id: number }[]
  kept: string[]
  errors: string[]
}

/** `keepRemote <= 0` means "keep everything" and is a no-op — a config typo must not be a way to
 *  wipe every release on GitHub at once, the same rule `backup-store.ts`'s `toPrune` applies to a
 *  local `keep` of zero. */
export async function pruneRemoteReleases(
  owner: string, repo: string, token: string, keepRemote: number,
  fetchImpl: FetchLike | undefined, log: (line: string) => void,
): Promise<PruneRemoteResult> {
  if (keepRemote <= 0) return { deleted: [], kept: [], errors: [] }

  const listed = await gh<GithubReleaseListItem[]>(
    `/repos/${owner}/${repo}/releases?per_page=100`, token, {}, fetchImpl,
  )
  if (!listed.ok) {
    log(`github backup: could not list releases for retention: ${listed.message}`)
    return { deleted: [], kept: [], errors: [listed.message] }
  }

  const backups = listed.data
    .filter(r => isBackupTag(r.tag_name))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))

  const toKeep = backups.slice(0, keepRemote)
  const toDelete = backups.slice(keepRemote)

  const deleted: { tag: string; id: number }[] = []
  const errors: string[] = []
  for (const r of toDelete) {
    const res = await gh(
      `/repos/${owner}/${repo}/releases/${r.id}`, token, { method: 'DELETE' }, fetchImpl, 'none',
    )
    if (res.ok) {
      deleted.push({ tag: r.tag_name, id: r.id })
      log(`github backup: retention deleted ${r.tag_name}`)
    } else {
      errors.push(`${r.tag_name}: ${res.message}`)
      log(`github backup: retention could not delete ${r.tag_name}: ${res.message}`)
    }
  }

  return { deleted, kept: toKeep.map(r => r.tag_name), errors }
}
