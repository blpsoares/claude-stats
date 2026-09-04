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
import { tmpdir } from 'os'
import { createReadStream, existsSync, statSync } from 'fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, unlink } from 'fs/promises'
import { dirname, join, relative } from 'path'
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
      // A source ROOT that is ABSENT is the ordinary "this harness is not installed" case and is
      // not reported. A root that exists and cannot be READ is a hole in the backup, and only the
      // errno separates them — without this check a permission error on ~/.claude produced an
      // empty claude layer inside a backup reporting complete success.
      const code = (e as NodeJS.ErrnoException).code
      if (!isRoot || code !== 'ENOENT') skipped.push({ rel, reason: 'unreadable', detail: errText(e) })
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

/**
 * Write `preferences.json` into a stage root with its live tokens removed, and report it as a
 * `WalkedFile` — it stats what it wrote itself, since `runBackup` needs the same bytes/layer/harness
 * shape as anything the ordinary walk produced, for the digest and the manifest's file count alike.
 *
 * The redaction mirrors what `preferences.ts` already does for its own API read-out — this is not a
 * new rule, it is the existing one applied to the copy that leaves the machine.
 *
 * This is called from INSIDE `runBackup`, not passed in by a caller. It used to be the other way
 * around — an optional `stagedRels` a caller supplied — and that shape let a caller omit it by
 * omitting an argument, which is exactly what the scheduled backup did: every unattended run
 * silently dropped the billing timeline (which exists in no other file on any machine), the custom
 * layouts, `archiveMode`, and the backup configuration itself, while still reporting success.
 */
export async function stageRedactedFiles(
  homeDir: string, stageRoot: string, log: (l: string) => void,
): Promise<WalkedFile[]> {
  const rel = '.agentistics/preferences.json'
  const raw = await readFile(join(homeDir, rel), 'utf-8').catch(() => null)
  if (raw === null) return []

  let prefs: Record<string, unknown>
  try {
    prefs = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Unparseable preferences are not carried at all: a file we cannot read is a file whose tokens
    // we cannot prove we removed.
    log('preferences.json could not be parsed — it is NOT in this backup')
    return []
  }

  const team = prefs.team as Record<string, unknown> | undefined
  if (team) {
    delete team.token
    const conns = team.connections
    if (Array.isArray(conns)) {
      for (const c of conns) if (c && typeof c === 'object') delete (c as Record<string, unknown>).token
    }
  }

  const dest = join(stageRoot, rel)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, JSON.stringify(prefs, null, 2))
  const st = await stat(dest)
  return [{ rel, bytes: st.size, layer: 'metrics', harness: null }]
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

  // Staged replacements are built HERE, not passed in. `preferences.json` must be redacted before
  // it travels, and the previous shape — an optional `stagedRels` supplied by the caller — meant a
  // caller could omit it by omitting an argument, which is exactly what the scheduled run did:
  // every unattended backup silently lost the billing timeline while reporting success. A payload
  // that is only complete when the caller remembers something is a payload that will be incomplete.
  const prefStage = await mkdtemp(join(tmpdir(), 'agentistics-staged-'))
  try {
    // Staged replacements join the walked files for every purpose except which root tar reads them
    // from. They must be in the digest — they are $HOME content and the restore merges them.
    const staged = await stageRedactedFiles(opts.homeDir, prefStage, log)
    for (const f of staged) addBytes(sizes, f.layer, f.harness, f.bytes)
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
      // (produced during this run), the staged replacements (redacted here, under their
      // $HOME-relative name), and the $HOME tree (the explicit file list).
      const assets = opts.assetRoot && existsSync(join(opts.assetRoot, 'repos'))
        ? ['-C', opts.assetRoot, 'repos']
        : []
      const stagedArgs = staged.length ? ['-C', prefStage, ...staged.map(f => f.rel)] : []
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
  } finally {
    await rm(prefStage, { recursive: true, force: true }).catch(() => {})
  }
}
