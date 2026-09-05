/**
 * github-upload.ts — the confirmation ladder: release, upload, confirm, verify, and only then
 * delete the local copy.
 *
 * The user asked for "0 espaco pra falhas" and the local file is deleted on the strength of this
 * module's answer, so every rung either earns the next one or the whole thing stops with the local
 * file intact:
 *
 * 1. create the release (tag `backup-<ISO>`, never a draft, never a prerelease) with the manifest
 *    summary in the BODY — the one place the expected sha256 can live once this machine is gone.
 * 2. upload the archive to the release's own `upload_url`.
 * 3. RE-READ the release: the asset must be listed, `state === 'uploaded'`, and its `size` must
 *    match the archive's measured size exactly. This only trusts GitHub's own metadata.
 * 4. DOWNLOAD the asset back and hash it. Steps 1-3 prove GitHub recorded something; only this
 *    proves the bytes that arrived are the bytes that left — the cost (re-downloading what was
 *    just uploaded) is real and is why its elapsed time is reported rather than hidden.
 * 5. only now, and only if `deleteLocalAfterUpload`, delete the local file — and record the
 *    deletion with `recordPrune`, so the history shows a deliberate act rather than a loss.
 *
 * Any rung failing returns `{ ok: false }` with a sentence naming what happened, and the local file
 * is never touched past that point. Nothing here retries — a caller (the CLI, the daemon) decides
 * whether to try again on its own next run.
 */
import { createHash } from 'crypto'
import { hostname } from 'os'
import { readFile, unlink } from 'fs/promises'
import { basename } from 'path'
import { gh, type FetchLike } from './github-api'
import type { GithubBackupConfig } from './github-store'
import { readGithubConfig } from './github-store'
import { resolveGithubAuth } from './github-cli'
import type { BackupLayer } from './backup-plan'
import type { BackupRecord } from './backup-store'
import { recordPrune } from './backup-store'
import { readManifestOf } from './restore'
import { buildReleaseBody, releaseTag, tooLargeUploadMessage, uploadVerdict } from './backup-github'
import { pruneRemoteReleases } from './github-retention'

interface CreatedRelease {
  id: number
  html_url: string
  upload_url: string
}

interface UploadedAsset {
  id: number
  state: string
  size: number
}

interface ReleaseWithAssets {
  assets: UploadedAsset[]
}

export type GithubUploadOutcome =
  | { ok: true; htmlUrl: string; deletedLocal: boolean; verifyMs: number; tag: string }
  /** `localFileKept` is always `true` here — there is no failure path from this function that
   *  removes the local archive; it is named on the type so a caller cannot read a failure and
   *  wonder. */
  | { ok: false; reason: string; localFileKept: true }

export interface GithubUploadDeps {
  fetchImpl?: FetchLike
  onLine?: (line: string) => void
  /** Where `recordPrune` appends the deletion event. Defaults to the real `backups.jsonl`; tests
   *  pass a temp path, mirroring every other injection point in this package. */
  recordFile?: string
}

/** The upload URL GitHub hands back is a URI TEMPLATE (`…/assets{?name,label}`) — the `{...}`
 *  suffix is RFC 6570 syntax, not a literal part of the URL, and is replaced with the one query
 *  parameter this call actually needs. */
function assetUploadUrl(template: string, fileName: string): string {
  return `${template.replace(/\{[^}]*\}$/, '')}?name=${encodeURIComponent(fileName)}`
}

export async function uploadBackupToGithub(
  config: GithubBackupConfig, record: BackupRecord, deps: GithubUploadDeps = {},
): Promise<GithubUploadOutcome> {
  const log = deps.onLine ?? (() => {})
  const fetchImpl = deps.fetchImpl

  const fail = (reason: string): GithubUploadOutcome => {
    log(`github backup FAILED: ${reason}`)
    log(`github backup: the local file is kept: ${record.path}`)
    return { ok: false, reason, localFileKept: true }
  }

  const verdict = uploadVerdict(record.archiveBytes)
  if (verdict === 'too-large') return fail(tooLargeUploadMessage(record.path, record.archiveBytes))
  if (verdict === 'near-limit') {
    log('github backup: this archive is close to GitHub\'s 2 GB release-asset limit — '
      + 'the next one may not fit.')
  }

  // The manifest travels INSIDE the archive (see manifest.ts) — reading it back here, rather than
  // threading it through every caller, is what lets this function take just a `BackupRecord` and
  // still build a release body with the layers/harnesses/session count the plan requires.
  // The credential, resolved ONCE for this whole upload. On a `gh` config nothing is stored and
  // this is where `gh auth token` runs; on a `token` config it is the stored one. Resolved before
  // any request so a machine whose gh has been logged out fails with THAT sentence, rather than
  // with a 401 the user would read as a revoked PAT.
  const auth = await resolveGithubAuth(config)
  if (!auth.ok) return fail(auth.reason)
  const token = auth.token

  const decoded = await readManifestOf(record.path)
  if (!decoded.ok) {
    return fail(`could not read this backup's own manifest before uploading it (${decoded.reason})`)
  }
  const manifest = decoded.manifest
  const sessionCount = manifest.groups
    .flatMap(g => g.files)
    .filter(f => f.rel.startsWith('.agentistics/sessions/'))
    .length

  const tag = releaseTag(record.at, config.label ?? manifest.hostname)
  const body = buildReleaseBody({
    layers: manifest.layers,
    harnesses: manifest.harnesses,
    sessionCount,
    archiveBytes: record.archiveBytes,
    sha256: record.sha256,
    createdAt: manifest.createdAt,
    hostname: manifest.hostname,
  })

  log(`github backup: creating release ${tag}…`)
  const created = await gh<CreatedRelease>(
    `/repos/${config.owner}/${config.repo}/releases`, token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false }),
    },
    fetchImpl,
  )
  if (!created.ok) return fail(`could not create the release: ${created.message}`)

  const fileName = basename(record.path)
  let bytes: Buffer
  try {
    bytes = await readFile(record.path)
  } catch (e) {
    return fail(`could not read the archive to upload it: ${e instanceof Error ? e.message : String(e)}`)
  }

  log(`github backup: uploading ${fileName} (${bytes.length} bytes)…`)
  const uploaded = await gh<UploadedAsset>(
    assetUploadUrl(created.data.upload_url, fileName), token,
    // `Buffer` is not itself in the DOM `BodyInit` union `fetch` is typed against here — a plain
    // `Uint8Array` (which `Buffer` already is, at runtime) is.
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) },
    fetchImpl,
  )
  if (!uploaded.ok) return fail(`the upload failed: ${uploaded.message}`)

  log('github backup: re-reading the release to confirm the asset landed…')
  const reread = await gh<ReleaseWithAssets>(
    `/repos/${config.owner}/${config.repo}/releases/${created.data.id}`, token, {}, fetchImpl,
  )
  if (!reread.ok) return fail(`could not re-read the release to confirm the upload: ${reread.message}`)

  const asset = reread.data.assets.find(a => a.id === uploaded.data.id)
  if (!asset) return fail('the release does not list the asset that was just uploaded')
  if (asset.state !== 'uploaded') {
    return fail(`the asset is in state "${asset.state}", not "uploaded" — GitHub has not finished processing it`)
  }
  if (asset.size !== record.archiveBytes) {
    return fail(
      `the uploaded asset is ${asset.size} bytes but this backup is ${record.archiveBytes} bytes — `
      + 'size mismatch',
    )
  }

  log('github backup: downloading it back to verify the bytes (this re-downloads the whole file)…')
  const verifyStart = Date.now()
  const downloaded = await gh<ArrayBuffer>(
    `/repos/${config.owner}/${config.repo}/releases/assets/${asset.id}`, token,
    { headers: { Accept: 'application/octet-stream' } }, fetchImpl, 'arrayBuffer',
  )
  const verifyMs = Date.now() - verifyStart
  if (!downloaded.ok) return fail(`could not download the asset back to verify it: ${downloaded.message}`)

  const downloadedSha256 = createHash('sha256').update(Buffer.from(downloaded.data)).digest('hex')
  log(`github backup: downloaded and hashed in ${verifyMs}ms`)
  if (downloadedSha256 !== record.sha256) {
    return fail(
      `the downloaded bytes hash to ${downloadedSha256}, this backup is ${record.sha256} — `
      + 'the bytes that arrived are NOT the bytes that left',
    )
  }
  log('github backup: confirmed byte-for-byte.')

  let deletedLocal = false
  if (config.deleteLocalAfterUpload) {
    await unlink(record.path)
    await recordPrune(record.path, deps.recordFile)
    deletedLocal = true
    log(`github backup: deleted the local copy (confirmed on ${config.owner}/${config.repo}@${tag}): ${record.path}`)
  }

  return { ok: true, htmlUrl: created.data.html_url, deletedLocal, verifyMs, tag }
}

/**
 * The one entry point `agentop backup` and the scheduled run both call after a backup is written —
 * "not configured" is a silent no-op (most machines never set this up), a configured upload runs
 * the whole ladder above, and a confirmed upload is followed by remote retention. Composed here
 * rather than duplicated in `cli-backup.ts` and `daemon.ts`, which is the "one gesture, one
 * implementation" rule this package already applies to `performBackup` itself.
 */
export async function syncBackupToGithub(
  record: BackupRecord,
  opts: {
    fetchImpl?: FetchLike
    log?: (line: string) => void
    configFile?: string
    recordFile?: string
    /** Raised for the upload's own outcome — a SEPARATE thing from the backup's. A backup that was
     *  written and failed to upload is not a failed backup: the archive is on disk and restores. */
    onOutcome?: (n: {
      phase: 'uploaded' | 'upload-failed'
      layers: BackupLayer[]
      scheduled: boolean
      reason?: string
      tag?: string
    }) => void
    scheduled?: boolean
  } = {},
): Promise<void> {
  const log = opts.log ?? (() => {})
  const config = await readGithubConfig(opts.configFile)
  // Not configured is a silent no-op, and raises NO toast: most machines never set this up, and a
  // notification saying "this thing you did not enable did not happen" is noise on every run.
  if (!config) return

  const outcome = await uploadBackupToGithub(config, record, {
    fetchImpl: opts.fetchImpl, onLine: log, recordFile: opts.recordFile,
  })
  const scheduled = opts.scheduled ?? false
  if (!outcome.ok) {
    opts.onOutcome?.({
      phase: 'upload-failed', layers: record.layers, scheduled, reason: outcome.reason,
    })
    return
  }
  opts.onOutcome?.({
    phase: 'uploaded', layers: record.layers, scheduled, tag: outcome.tag,
  })

  if (config.keepRemote > 0) {
    // Resolved again rather than carried out of the upload: on a `gh` config the token is asked for
    // at the moment it is needed and never held, and retention is a separate moment. A `gh` that
    // stopped answering between the two leaves the backup UPLOADED and unpruned — the safe half to
    // fail on, and it is said rather than swallowed.
    const auth = await resolveGithubAuth(config)
    if (!auth.ok) {
      log(`github backup: retention skipped — ${auth.reason}`)
      return
    }
    await pruneRemoteReleases(
      config.owner, config.repo, auth.token, config.keepRemote, opts.fetchImpl, log,
      // Same fallback the upload uses. On a config written before labels existed this is exactly
      // what those releases' bodies already record (`- host:` is `os.hostname()`), so the machine
      // still attributes — and therefore may still prune — its own history.
      config.label ?? hostname(),
    )
  }
}
