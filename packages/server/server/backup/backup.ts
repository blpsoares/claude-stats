/**
 * backup.ts — IO. Walk the sources, measure them, hand tar an explicit file list, record what
 * happened.
 *
 * ## tar receives a LIST, never an exclude pattern
 *
 * The exclusion rules live in `backup-plan.ts` and are tested there, including the grep that no
 * credential can pass. Handing tar `--exclude` globs would create a SECOND expression of those
 * rules, in a different language, with different escaping — and the one that runs would be the
 * untested one. So the walk applies `excludeFor` per file and tar is given the survivors through
 * `-T`. A file that is not in the list cannot be in the archive.
 *
 * ## The only compressed number in the system is measured here
 *
 * `archiveBytes` is `statSync` on the finished file. Nothing predicts it (see `backup-size.ts`).
 */
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { createReadStream, existsSync, statSync } from 'fs'
import { lstat, mkdir, readdir, stat, writeFile, unlink } from 'fs/promises'
import { join, relative } from 'path'
import type { HarnessId } from '@agentistics/core'
import { excludeFor, omittedSecrets, planSources, type BackupLayer, type SourceEntry } from './backup-plan'
import { addBytes, emptySizes, plannedTotal, type BackupSizes } from './backup-size'
import { encodeManifest, MANIFEST_NAME, type BackupManifest } from './manifest'
import { recordBackup, type BackupRecord } from './backup-store'
import type { RepoEntry } from './repo-manifest'

const run = promisify(execFile)

export interface WalkedFile {
  rel: string
  bytes: number
  layer: BackupLayer
  harness: HarnessId | null
}

/** A path the walk could not read, or deliberately did not follow. Reported, never silent. */
export interface WalkSkip {
  rel: string
  reason: 'symlink' | 'unreadable'
  detail?: string
}

/**
 * Walk every source, applying the exclusion rules per file.
 *
 * A MISSING source contributes nothing and is not an error — a machine that never installed codex
 * is not a fault. Two other cases are NOT the same thing and are recorded:
 *
 * **Symlinks are not followed.** `stat` dereferences; `lstat` does not, and the difference matters
 * twice. A link pointing at one of its own ancestors — an ordinary dotfiles-manager artifact —
 * sends this recursion around forever, in a tool whose entire job is walking an arbitrary person's
 * home directory. And a link pointing OUTSIDE `$HOME` would copy its target's bytes into the
 * archive under an innocent `$HOME`-relative name, which is the exclusion table's own problem
 * arriving through a side door.
 *
 * **A directory that cannot be read is recorded, not skipped in silence.** A permission error deep
 * inside an otherwise-fine tree would otherwise produce a smaller backup that reports complete
 * success — the same failure-wearing-good-news shape this feature has had to remove three times
 * already.
 */
export async function walkSources(
  homeDir: string, sources: SourceEntry[],
): Promise<{ files: WalkedFile[]; sizes: BackupSizes; skipped: WalkSkip[] }> {
  const sizes = emptySizes()
  const files: WalkedFile[] = []
  const skipped: WalkSkip[] = []

  const visit = async (abs: string, src: SourceEntry, isRoot: boolean): Promise<void> => {
    const rel = relative(homeDir, abs).split('\\').join('/')
    if (excludeFor(rel)) return

    let st
    try {
      st = await lstat(abs)
    } catch (e) {
      // A source ROOT that is absent is the ordinary "this harness is not installed" case. The same
      // failure on a path we reached by reading its parent's entry is a real read error.
      if (!isRoot) skipped.push({ rel, reason: 'unreadable', detail: errText(e) })
      return
    }

    if (st.isSymbolicLink()) { skipped.push({ rel, reason: 'symlink' }); return }

    if (st.isDirectory()) {
      let entries: string[]
      try {
        entries = await readdir(abs)
      } catch (e) {
        skipped.push({ rel, reason: 'unreadable', detail: errText(e) })
        return
      }
      for (const e of entries) await visit(join(abs, e), src, false)
      return
    }
    if (!st.isFile()) return
    files.push({ rel, bytes: st.size, layer: src.layer, harness: src.harness })
    addBytes(sizes, src.layer, src.harness, st.size)
  }

  for (const src of sources) await visit(join(homeDir, src.rel), src, true)
  return { files, sizes, skipped }
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200)
}

export type Archiver =
  | { kind: 'zstd'; extension: '.tar.zst'; flag: '--zstd' }
  | { kind: 'gzip'; extension: '.tar.gz'; flag: '-z' }
  | { kind: 'none'; extension: '.tar'; flag: null }

/** Which compression this machine can actually produce. Never guessed: a `.tar.zst` written by a
 *  tar that ignored `--zstd` is a file nothing can open. */
export function archiverFor(): Archiver {
  const probe = (args: string[]): boolean => {
    try {
      execFileSync('tar', args, { stdio: 'ignore' })
      return true
    } catch { return false }
  }
  if (probe(['--zstd', '--version'])) return { kind: 'zstd', extension: '.tar.zst', flag: '--zstd' }
  if (probe(['-z', '--version'])) return { kind: 'gzip', extension: '.tar.gz', flag: '-z' }
  return { kind: 'none', extension: '.tar', flag: null }
}

export interface BackupOptions {
  homeDir: string
  destDir: string
  layers: BackupLayer[]
  harnesses: HarnessId[]
  repos: RepoEntry[]
  agentopVersion: string
  hostname: string
  /**
   * Directory holding the repos layer's ASSETS — the bundles and patches, already laid out as
   * `<assetRoot>/repos/…` exactly as they must appear inside the archive.
   *
   * They cannot come from the $HOME walk: they are produced during the backup and live nowhere in
   * $HOME. Without this they never enter the tar, `RepoEntry.bundle` names a file that only exists
   * on the machine being replaced, and every unpushed branch the manifest promises is lost — which
   * is the single thing the repos layer exists to save.
   */
  assetRoot?: string
  /**
   * Archive-relative paths to take from `assetRoot` instead of from `$HOME`.
   *
   * For a file that must be TRANSFORMED before it travels — today, `preferences.json` with its
   * tokens redacted. They are archive content like any walked file: digested, sized, counted, and
   * merged on restore. They differ only in where `tar` reads them from.
   */
  stagedRels?: string[]
  /** Called with each progress line. Defaults to a no-op so tests are silent. */
  onLine?: (line: string) => void
}

export type BackupResult =
  /**
   * `skipped` is on the RESULT, not only in the log.
   *
   * `onLine` defaults to a no-op, so a caller that does not wire it — the scheduled run, anything
   * headless, any future surface reading the result after the fact — would get an `ok: true` that
   * looks identical whether the walk skipped a permission-denied directory or skipped nothing.
   * That is the same "reports complete success over a real gap" this walk was changed to stop
   * doing, arriving one layer up.
   */
  | { ok: true; record: BackupRecord; sizes: BackupSizes; skipped: WalkSkip[] }
  | { ok: false; reason: string }

/** sha256 over the sorted `path:bytes` list. Deterministic, and independent of the archive. */
export function manifestDigest(files: WalkedFile[]): string {
  const lines = files.map(f => `${f.rel}:${f.bytes}`).sort().join('\n')
  return createHash('sha256').update(lines).digest('hex')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((res, rej) => {
    createReadStream(path).on('data', d => hash.update(d)).on('end', () => res()).on('error', rej)
  })
  return hash.digest('hex')
}

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const log = opts.onLine ?? (() => {})
  const started = Date.now()

  const archiver = archiverFor()
  if (archiver.kind === 'none') log('tar has no compression here — writing an uncompressed .tar')

  const sources = planSources({ layers: opts.layers, harnesses: opts.harnesses })
  log(`planning ${sources.length} sources`)
  const { files, sizes, skipped } = await walkSources(opts.homeDir, sources)
  log(`${files.length} files, ${plannedTotal(sizes, opts.layers)} bytes before compression`)

  // Named, never counted-and-forgotten: a backup that quietly left things out is a backup whose
  // completeness the user cannot reason about.
  for (const s of skipped) {
    log(s.reason === 'symlink'
      ? `skipped ${s.rel} — a symlink; its target is either already in the walk or deliberately outside it`
      : `skipped ${s.rel} — could not be read: ${s.detail ?? 'unknown'}`)
  }

  // Staged replacements join the walked files for every purpose except which root tar reads them
  // from. They must be in the digest — they are $HOME content and the restore merges them.
  const staged: WalkedFile[] = []
  for (const rel of opts.stagedRels ?? []) {
    const st = await stat(join(opts.assetRoot ?? '', rel)).catch(() => null)
    if (!st?.isFile()) continue
    staged.push({ rel, bytes: st.size, layer: 'metrics', harness: null })
    addBytes(sizes, 'metrics', null, st.size)
  }
  const archived = [...files, ...staged]

  await mkdir(opts.destDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archivePath = join(opts.destDir, `agentistics-backup-${opts.hostname}-${stamp}${archiver.extension}`)

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    agentopVersion: opts.agentopVersion,
    hostname: opts.hostname,
    homeDir: opts.homeDir,
    platform: process.platform,
    layers: opts.layers,
    harnesses: opts.harnesses,
    sizes,
    groups: [{
      name: 'files',
      files: archived.length,
      bytes: plannedTotal(sizes, opts.layers),
      // A digest of the FILE LIST, not of the archive: the manifest travels inside the archive, so
      // hashing the archive from here is circular. This catches an archive that was rebuilt or
      // edited — the case a byte count alone misses. The whole-archive hash lives on BackupRecord,
      // for the person verifying the file they carried. Staged replacements (e.g. the redacted
      // preferences.json) are archive content like any walked file, so they are in this digest too
      // — leaving them out would reproduce the exact bug this digest exists to catch, in a new place.
      sha256: manifestDigest(archived),
    }],
    repos: opts.repos,
    omittedSecrets: omittedSecrets().map(r => ({ path: r.pattern, restoreWith: r.restoreWith ?? '' })),
  }

  // Staged beside the archive, added under its own name, removed afterwards. Writing it into
  // $HOME would put our bookkeeping in the user's home directory.
  const manifestPath = join(opts.destDir, MANIFEST_NAME)
  const listPath = join(opts.destDir, `.agentistics-filelist-${stamp}`)
  await writeFile(manifestPath, encodeManifest(manifest))
  await writeFile(listPath, files.map(f => f.rel).join('\n') + '\n')

  try {
    const flags = archiver.flag ? [archiver.flag] : []
    // Four roots in one archive: the manifest (staged beside the output), the repos assets
    // (produced during this run), the staged replacements (also produced during this run, under
    // their $HOME-relative name), and the $HOME tree (the explicit file list).
    const assets = opts.assetRoot && existsSync(join(opts.assetRoot, 'repos'))
      ? ['-C', opts.assetRoot, 'repos']
      : []
    const stagedArgs = opts.assetRoot && staged.length
      ? ['-C', opts.assetRoot, ...staged.map(f => f.rel)]
      : []
    await run('tar', [
      ...flags, '-cf', archivePath,
      '-C', opts.destDir, MANIFEST_NAME,
      ...assets, ...stagedArgs,
      '-C', opts.homeDir, '-T', listPath,
    ], { maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    // A failed tar can leave a PARTIAL archive, and it carries a real backup's extension. Nothing
    // recorded it, so nothing would ever delete it, and it would sit in the destination directory
    // looking exactly like a backup somebody could try to restore from.
    await unlink(archivePath).catch(() => {})
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    // One cleanup path for the staged files, on every outcome.
    await unlink(listPath).catch(() => {})
    await unlink(manifestPath).catch(() => {})
  }

  if (!existsSync(archivePath)) return { ok: false, reason: 'tar reported success but wrote nothing' }

  const record: BackupRecord = {
    at: manifest.createdAt,
    path: archivePath,
    layers: opts.layers,
    harnesses: opts.harnesses,
    bytesUncompressed: plannedTotal(sizes, opts.layers),
    archiveBytes: statSync(archivePath).size,   // measured, never predicted
    sha256: await sha256File(archivePath),
    durationMs: Date.now() - started,
    skipped: skipped.length,
  }
  await recordBackup(record)
  log(`wrote ${archivePath}`)
  return { ok: true, record, sizes, skipped }
}
