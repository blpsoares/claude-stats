/**
 * github-restore.ts — the case wave G3 exists for: numa maquina recem-formatada you have the
 * repository URL and nothing else.
 *
 * There is no local `backups.jsonl` here, no stored config, no expected hash on this disk — every
 * fact this module needs comes from the far side: the release LISTING (which tag, which asset) and
 * the release BODY (`backup-github.ts`'s `buildReleaseBody`/`parseReleaseBody` pair), which is the
 * only place the sha256 survives once the machine that made it is gone.
 *
 * The three steps are deliberately separate functions so each can be proven on its own:
 *
 * 1. `listGithubReleases` + `pickBackupRelease` — find WHICH release, never an arbitrary
 *    hand-made one (the same `isBackupTag` guard `github-retention.ts` uses).
 * 2. `pickBackupAsset` — find WHICH asset in that release actually holds the archive.
 * 3. `downloadBackupAsset` — pull the bytes down and hash them against the release body's sha256
 *    BEFORE anything is handed to `restoreMetrics`. A mismatch is a refusal that KEEPS the file
 *    (so it can be inspected) and never claims the bytes are good.
 *
 * `downloadBackupRelease` composes all three into the one call the CLI drives, with an injectable
 * `confirmDownload` — showing what would be downloaded and asking is a CLI concern, but the
 * decision of whether to proceed has to happen INSIDE this function, before the download, so a
 * test can assert a decline never reaches the network.
 *
 * **Phase two must not re-download.** `agentop restore <url>` (phase one) already leaves the
 * archive sitting in `destDir`; `agentop restore <url> --repos` (phase two) is a SEPARATE CLI
 * invocation with no memory of that, and re-fetching a 600 MB asset it already has on disk is pure
 * waste. `findReusableArchive` checks for exactly that file — same name, same `destDir` — and
 * hashes it against the release body's own sha256 before trusting it: a file that is THERE but
 * does not match is never reused, only ignored and overwritten by the real download. This is the
 * cheap fix, not a cache — it reuses only what a previous run of this same function already wrote.
 */
import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { gh, type FetchLike } from './github-api'
import { isBackupTag, labelSlug, parseReleaseBody, releaseMadeAt, tagLabel, type ReleaseSummary } from './backup-github'

export interface GithubReleaseAsset {
  id: number
  name: string
  size: number
}

export interface GithubReleaseInfo {
  id: number
  tagName: string
  /** When the release was PUBLISHED — never GitHub's `created_at`. See `releaseMadeAt`. */
  publishedAt: string
  /** Raw markdown — `parseReleaseBody` is what turns this into something a caller can act on. */
  body: string
  assets: GithubReleaseAsset[]
}

interface RawGithubRelease {
  id: number
  tag_name: string
  created_at: string
  published_at: string | null
  body: string | null
  assets: { id: number; name: string; size: number }[]
}

export type ListReleasesResult =
  | { ok: true; releases: GithubReleaseInfo[] }
  | { ok: false; message: string }

/** Every release on the repository — not filtered to `backup-` tags here, so `--list` can show a
 *  hand-made release too and say plainly which ones agentop would ever pick from. */
export async function listGithubReleases(
  owner: string, repo: string, token: string, fetchImpl?: FetchLike,
): Promise<ListReleasesResult> {
  const res = await gh<RawGithubRelease[]>(`/repos/${owner}/${repo}/releases?per_page=100`, token, {}, fetchImpl)
  if (!res.ok) return { ok: false, message: res.message }
  const releases = res.data.map(r => ({
    id: r.id,
    tagName: r.tag_name,
    publishedAt: releaseMadeAt(r),
    body: r.body ?? '',
    assets: r.assets.map(a => ({ id: a.id, name: a.name, size: a.size })),
  }))
  return { ok: true, releases }
}

export type PickReleaseResult =
  | { ok: true; release: GithubReleaseInfo }
  | { ok: false; reason: string }

/**
 * Which release to restore from. With an explicit `tag`, that EXACT release — the user named it,
 * so it is looked up regardless of shape, and its absence is refused BY NAME rather than falling
 * back to a guess. Without one, the NEWEST release whose tag `isBackupTag` recognises — never an
 * arbitrary release the user created by hand, even if it happens to look plausible.
 */
export function pickBackupRelease(releases: GithubReleaseInfo[], tag?: string): PickReleaseResult {
  if (tag) {
    const found = releases.find(r => r.tagName === tag)
    return found
      ? { ok: true, release: found }
      : { ok: false, reason: `no release tagged "${tag}" was found on this repository` }
  }
  const backups = [...releases]
    .filter(r => isBackupTag(r.tagName))
    // By PUBLICATION. `created_at` is the tag's commit date and is identical on every release of a
    // backup repository, so sorting by it made "the newest" whatever order GitHub returned — and
    // this is the function that picks what a bare `restore` overwrites your machine with.
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  const newest = backups[0]
  return newest
    ? { ok: true, release: newest }
    : {
        ok: false,
        reason: 'no release with a `backup-` tag was found on this repository — nothing here looks '
          + 'like an agentop backup. If one was made by hand, restore from it by naming its tag with '
          + '--release.',
      }
}

export type PickAssetResult =
  | { ok: true; asset: GithubReleaseAsset }
  | { ok: false; reason: string }

/**
 * Which asset in the release actually holds the archive. Matched by SIZE against the summary's
 * `archiveBytes` — the one figure the release body and the real upload both carry — rather than by
 * name, since a name is whatever `basename(record.path)` happened to be and this module has no
 * other way to recognise it. Zero, or more than one, matching asset is a refusal naming why, never
 * a guess at which one to download.
 */
export function pickBackupAsset(release: GithubReleaseInfo, summary: ReleaseSummary): PickAssetResult {
  if (!release.assets.length) {
    return { ok: false, reason: `release ${release.tagName} has no assets to download` }
  }
  const matches = release.assets.filter(a => a.size === summary.archiveBytes)
  if (matches.length === 1) return { ok: true, asset: matches[0]! }
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `no asset in release ${release.tagName} matches the ${summary.archiveBytes}-byte size `
        + 'recorded in its own body',
    }
  }
  return {
    ok: false,
    reason: `${matches.length} assets in release ${release.tagName} match the expected size — `
      + 'ambiguous, refusing to guess which one to restore from',
  }
}

export type DownloadAssetResult =
  | { ok: true; path: string; sha256: string }
  /** `path` is populated even on failure once the bytes have hit disk — a mismatch or a truncated
   *  download is kept for inspection, never deleted out from under the person who just wiped their
   *  machine. It stays undefined only when nothing was ever written (e.g. the request itself failed). */
  | { ok: false; reason: string; path?: string }

/**
 * Download one release asset to `destDir` and hash it. The comparison against `expectedSha256`
 * happens HERE, before anything downstream ever sees the file — this is the one line the whole
 * feature is judged on, and it is deliberately a single, easy-to-spot comparison rather than
 * folded into a larger conditional.
 */
export async function downloadBackupAsset(
  owner: string, repo: string, token: string, asset: GithubReleaseAsset, expectedSha256: string,
  destDir: string, fetchImpl?: FetchLike, onLine?: (line: string) => void,
): Promise<DownloadAssetResult> {
  const log = onLine ?? (() => {})
  log(`downloading ${asset.name} (${asset.size} bytes)…`)

  const res = await gh<ArrayBuffer>(
    `/repos/${owner}/${repo}/releases/assets/${asset.id}`, token,
    { headers: { Accept: 'application/octet-stream' } }, fetchImpl, 'arrayBuffer',
  )
  if (!res.ok) return { ok: false, reason: `could not download the asset: ${res.message}` }

  const bytes = Buffer.from(res.data)
  await mkdir(destDir, { recursive: true })
  const path = join(destDir, asset.name)
  await writeFile(path, bytes)

  const sha256 = createHash('sha256').update(bytes).digest('hex')

  // The one comparison this whole wave exists to make. A corrupt or truncated download must never
  // reach `restoreMetrics` — see restore.test.ts's deliberate-break check on this exact line.
  if (sha256 !== expectedSha256) {
    log(`hash mismatch: downloaded bytes hash to ${sha256}, the release body says ${expectedSha256}`)
    return {
      ok: false,
      path,
      reason: `the downloaded bytes hash to ${sha256}, but the release body says ${expectedSha256} — `
        + `the bytes that arrived are NOT the bytes that were uploaded. The file is kept at ${path} `
        + 'so it can be inspected; it was NOT restored from.',
    }
  }
  log(`verified: sha256 matches (${sha256})`)
  return { ok: true, path, sha256 }
}

/**
 * Wave G4's fix for phase two: before downloading anything, look for a file already sitting at
 * `destDir/<fileName>` — the exact path `downloadBackupAsset` would write to — and hash it. Used
 * only when it matches `expectedSha256` exactly; a file that is there but does NOT match is never
 * trusted, is never reused, and is left in place to be overwritten by the real download below.
 * Any error reading it (missing, unreadable, a directory) is treated the same as "nothing to
 * reuse" — this function never throws and never blocks the download path.
 */
async function findReusableArchive(
  destDir: string, fileName: string, expectedSha256: string, onLine?: (line: string) => void,
): Promise<string | null> {
  const log = onLine ?? (() => {})
  const path = join(destDir, fileName)

  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    return null
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== expectedSha256) {
    log(`a local file already exists at ${path} but its sha256 does not match this release — `
      + 'ignoring it and downloading again')
    return null
  }
  log(`found an already-downloaded file matching this release's sha256 at ${path} — reusing it `
    + 'instead of downloading it again')
  return path
}

export interface GithubRestoreDeps {
  fetchImpl?: FetchLike
  onLine?: (line: string) => void
  /** Where the archive is written. Defaults to `~/.agentistics/backups/` — the same directory a
   *  local `agentop backup` writes into. */
  destDir?: string
  /**
   * Called once the release is picked, its body is decoded, and no already-downloaded local file
   * was found to reuse — BEFORE any bytes are downloaded, this is the "downloading gigabytes is a
   * decision" gate. Returning `false` cancels with nothing ever fetched. Defaults to always-yes so
   * a non-interactive caller (a test, a script driving `--yes`-shaped automation) never hangs; the
   * CLI passes a real confirmation prompt. Never called when a local file is reused instead — there
   * is nothing to confirm when nothing is about to be downloaded.
   */
  confirmDownload?: (summary: ReleaseSummary, release: GithubReleaseInfo) => boolean | Promise<boolean>
}

export type GithubRestoreOutcome =
  | { status: 'downloaded'; archivePath: string; release: GithubReleaseInfo; summary: ReleaseSummary }
  | { status: 'cancelled' }
  | { status: 'error'; reason: string; archivePath?: string }

/**
 * List, pick, confirm, download, verify — everything up to (and never including) handing the
 * archive to `restoreMetrics`. That hand-off is `cli-backup.ts`'s job: once this returns
 * `'downloaded'`, the resulting file is an ordinary local archive and the EXISTING restore code
 * takes over unchanged, exactly as it does for a path typed directly on the command line.
 */
export async function downloadBackupRelease(
  owner: string, repo: string, token: string, tag: string | undefined, deps: GithubRestoreDeps = {},
): Promise<GithubRestoreOutcome> {
  const log = deps.onLine ?? (() => {})
  const destDir = deps.destDir ?? join(AGENTISTICS_DATA_DIR, 'backups')

  log(`listing releases on ${owner}/${repo}…`)
  const listed = await listGithubReleases(owner, repo, token, deps.fetchImpl)
  if (!listed.ok) return { status: 'error', reason: `could not list releases: ${listed.message}` }

  const picked = pickBackupRelease(listed.releases, tag)
  if (!picked.ok) return { status: 'error', reason: picked.reason }
  const release = picked.release

  const summary = parseReleaseBody(release.body)
  if (!summary) {
    return {
      status: 'error',
      reason: `release ${release.tagName} does not carry a recognisable agentop backup summary in `
        + 'its body — it may have been created by hand, or by an incompatible version',
    }
  }

  const assetPicked = pickBackupAsset(release, summary)
  if (!assetPicked.ok) return { status: 'error', reason: assetPicked.reason }

  // Phase two (`agentop restore <url> --repos`) is a separate invocation from phase one and has no
  // memory of the archive phase one already downloaded — without this check it would fetch the
  // whole thing again. A file that is there but does not match the release's own sha256 is never
  // trusted here; it falls straight through to the ordinary download below, which overwrites it.
  const reused = await findReusableArchive(destDir, assetPicked.asset.name, summary.sha256, log)
  if (reused) return { status: 'downloaded', archivePath: reused, release, summary }

  if (deps.confirmDownload) {
    const proceed = await deps.confirmDownload(summary, release)
    if (!proceed) return { status: 'cancelled' }
  }

  const downloaded = await downloadBackupAsset(
    owner, repo, token, assetPicked.asset, summary.sha256, destDir, deps.fetchImpl, log,
  )
  if (!downloaded.ok) return { status: 'error', reason: downloaded.reason, archivePath: downloaded.path }

  return { status: 'downloaded', archivePath: downloaded.path, release, summary }
}

/** For `agentop restore github --list <url>` — every backup release on the repository, newest
 *  first, decoded where possible. Never downloads anything. */
export interface ListedBackupRelease {
  tagName: string
  /** When it was PUBLISHED — see `releaseMadeAt`. */
  publishedAt: string
  summary: ReleaseSummary | null
}

export async function listBackupReleases(
  owner: string, repo: string, token: string, fetchImpl?: FetchLike,
): Promise<{ ok: true; releases: ListedBackupRelease[] } | { ok: false; message: string }> {
  const listed = await listGithubReleases(owner, repo, token, fetchImpl)
  if (!listed.ok) return { ok: false, message: listed.message }
  const releases = listed.releases
    .filter(r => isBackupTag(r.tagName))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map(r => ({ tagName: r.tagName, publishedAt: r.publishedAt, summary: parseReleaseBody(r.body) }))
  return { ok: true, releases }
}

/** Backup releases of ONE machine, newest first. `machine` is `null` only when nothing —
 *  neither the tag nor the body — says which machine made them. */
export interface MachineReleases {
  machine: string | null
  releases: ListedBackupRelease[]
}

/**
 * Which machine a release belongs to. The TAG is authoritative because it is what retention and
 * the GitHub releases page read; the body's `- host:` covers a tag minted before labels existed,
 * so those releases join their own machine rather than a bucket named "unknown".
 */
function machineOf(r: ListedBackupRelease): string | null {
  return tagLabel(r.tagName) ?? labelSlug(r.summary?.hostname) ?? null
}

/**
 * Group a repository's backup releases by machine, machines ordered by their most recent backup
 * and each machine's releases newest first.
 *
 * Several machines backing up to one repository is the case this exists for: a flat chronological
 * list interleaves them, and telling one from another means opening each release. The
 * unattributable group is LAST and kept — a release nobody can place is still a release somebody
 * may need.
 */
export function groupReleasesByMachine(releases: ListedBackupRelease[]): MachineReleases[] {
  const byMachine = new Map<string | null, ListedBackupRelease[]>()
  for (const r of releases) {
    const m = machineOf(r)
    const list = byMachine.get(m)
    if (list) list.push(r)
    else byMachine.set(m, [r])
  }
  const groups = [...byMachine.entries()].map(([machine, list]) => ({
    machine,
    releases: [...list].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
  }))
  return groups.sort((a, b) => {
    // The unattributable group is last whatever its dates: it is the one a person cannot act on
    // with confidence.
    if ((a.machine === null) !== (b.machine === null)) return a.machine === null ? 1 : -1
    return (b.releases[0]?.publishedAt ?? '').localeCompare(a.releases[0]?.publishedAt ?? '')
  })
}

/**
 * The newest release of ONE named machine, or `null`.
 *
 * Null and never a fallback to some other machine's newest: restoring the wrong computer onto this
 * one, without saying so, is the failure this whole feature exists to prevent.
 */
export function newestForMachine(
  releases: ListedBackupRelease[], machine: string,
): ListedBackupRelease | null {
  const want = labelSlug(machine)
  const group = groupReleasesByMachine(releases).find(g => g.machine === want)
  return group?.releases[0] ?? null
}
