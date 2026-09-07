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
import { isBackupTag, labelSlug, releaseMadeAt, tagLabel } from './backup-github'

interface GithubReleaseListItem {
  id: number
  tag_name: string
  created_at: string
  published_at?: string | null
  body?: string
}

/** One release as the pure selection sees it: what it is called, when, and which machine it is
 *  attributable to (`null` = nothing said so). */
export interface PrunableRelease {
  tag: string
  /** When it was PUBLISHED — see `releaseMadeAt`. Sorting by GitHub's `created_at` here could
   *  delete the NEWEST backups: it is the tag's commit date, identical on every release. */
  publishedAt: string
  /** The `- host: NAME` line of the release body, for a tag minted before labels existed. */
  host: string | null
}

export interface PrunePlan {
  keep: string[]
  remove: string[]
  /** Backup releases belonging to OTHER machines. Never candidates — reported so the caller can
   *  say so rather than leave their presence looking like a retention that did not run. */
  otherMachines: string[]
  /** Backup releases no machine can be established for. Never deleted. */
  unattributable: string[]
}

/**
 * Which releases this machine may delete.
 *
 * PURE, and the rule it encodes is the one that keeps two machines sharing one repository from
 * destroying each other. Retention used to weigh EVERY machine's releases against a single
 * `keepRemote`, so a laptop backing up daily filled the window and deleted the desktop's only
 * backup — silently, and by the machine that had nothing to do with it.
 *
 * A release is a candidate only when it is provably THIS machine's: the label in its tag, or —
 * for a tag minted before labels existed — the `host` its body records. Anything else is kept.
 * Keeping a release too long costs storage; deleting one that was somebody's only copy costs the
 * backup, which is the whole point of the feature.
 */
export function selectForPruning(
  releases: PrunableRelease[], keepRemote: number, label: string,
): PrunePlan {
  const mine = labelSlug(label)
  const plan: PrunePlan = { keep: [], remove: [], otherMachines: [], unattributable: [] }

  const candidates: PrunableRelease[] = []
  for (const r of releases) {
    if (!isBackupTag(r.tag)) continue
    const owner = tagLabel(r.tag) ?? labelSlug(r.host ?? undefined)
    if (owner === null) { plan.unattributable.push(r.tag); continue }
    if (owner !== mine) { plan.otherMachines.push(owner); continue }
    candidates.push(r)
  }
  plan.otherMachines = [...new Set(plan.otherMachines)].sort()

  // `keepRemote <= 0` means "keep everything" — a config typo must not be a way to wipe a
  // repository, the same rule `backup-store.ts`'s `toPrune` applies to a local `keep` of zero.
  // Checked AFTER the walk so the caller still learns what is there.
  if (keepRemote <= 0) {
    plan.keep = candidates.map(r => r.tag)
    return plan
  }

  candidates.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  plan.keep = candidates.slice(0, keepRemote).map(r => r.tag)
  plan.remove = candidates.slice(keepRemote).map(r => r.tag)
  return plan
}

/** The `- host: NAME` line `buildReleaseBody` writes, for attributing a tag minted before labels
 *  existed. Deliberately narrow: anything else yields null, and null is never deleted. */
function hostOf(body: string | undefined): string | null {
  return /^- host: (.+)$/m.exec(body ?? '')?.[1]?.trim() || null
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
  fetchImpl: FetchLike | undefined, log: (line: string) => void, label = '',
): Promise<PruneRemoteResult> {
  if (keepRemote <= 0) return { deleted: [], kept: [], errors: [] }

  const listed = await gh<GithubReleaseListItem[]>(
    `/repos/${owner}/${repo}/releases?per_page=100`, token, {}, fetchImpl,
  )
  if (!listed.ok) {
    log(`github backup: could not list releases for retention: ${listed.message}`)
    return { deleted: [], kept: [], errors: [listed.message] }
  }

  const plan = selectForPruning(
    listed.data.map(r => ({ tag: r.tag_name, publishedAt: releaseMadeAt(r), host: hostOf(r.body) })),
    keepRemote, label,
  )
  // Said, never silently skipped: a user who can see other machines' releases on the page needs to
  // know retention left them alone on purpose rather than failing to run.
  if (plan.otherMachines.length) {
    log(`github backup: retention left ${plan.otherMachines.join(', ')} alone — another machine's backups are never this machine's to delete`)
  }
  for (const tag of plan.unattributable) {
    log(`github backup: ${tag} names no machine — kept, because it may be another machine's only copy`)
  }

  const byTag = new Map(listed.data.map(r => [r.tag_name, r]))
  const toKeep = plan.keep.map(t => byTag.get(t)!).filter(Boolean)
  const toDelete = plan.remove.map(t => byTag.get(t)!).filter(Boolean)

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
