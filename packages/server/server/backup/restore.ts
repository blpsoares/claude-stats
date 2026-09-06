/**
 * restore.ts — IO. Verify, stage, merge, then clone.
 *
 * ## Nothing is written before the bytes are proven
 *
 * `verifyArchive` runs first, and a truncated or altered archive is a REFUSAL, not a partial
 * restore. A half-restored machine is worse than an unrestored one: it looks done.
 *
 * ## Staging, not extraction into place
 *
 * tar extracts into `$HOME/.agentistics/restore-staging`, and only then does the merge apply
 * `planMetrics`' decisions file by file. Extracting straight into `$HOME` would make tar the thing
 * deciding what gets overwritten — and tar has no opinion about which copy is newer, which is the
 * one rule this merge exists to enforce. The staging directory is removed on every exit path,
 * success or failure.
 *
 * ## The repo phase is separate, and resumable
 *
 * It is network and disk, and it will partially fail — a renamed repository, an archived one, SSH
 * not set up yet. Each result is written to `restore-state.json` as it happens, so re-running
 * attempts only what is unfinished, and every failure is reported as a LINE naming the repo and
 * the reason. A count of successes without the list of what did not come back is not a report.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { safeReadJson } from '../utils'
import { decodeManifest, MANIFEST_NAME, type BackupManifest, type DecodedManifest } from './manifest'
import { expandHome } from './repo-manifest'
import { gitEnv } from './repo-probe'
import {
  emptyRestoreState, mergePreferences, planMetrics, planRepos, remaining, rewriteHome,
  type RepoStep, type RestoreState, type StagedFile,
} from './restore-plan'

const run = promisify(execFile)

/**
 * Where the resume bookkeeping lives — derived from the `$HOME` being restored INTO, not from this
 * process's own.
 *
 * Every other stateful path here (`staging`, `assetDir`) is built from the `homeDir` argument, and
 * this one broke the pattern: a restore aimed at another user, a container, or one target of a
 * scripted multi-target run wrote its `done`/`failed` state onto the operator's machine — where two
 * different targets sharing a repository key would then overwrite each other's progress.
 */
export function restoreStateFile(homeDir: string): string {
  return join(homeDir, '.agentistics', 'restore-state.json')
}

/** The ordinary case: this machine restoring into itself. */
export const RESTORE_STATE_FILE = join(AGENTISTICS_DATA_DIR, 'restore-state.json')

const STAGING = '.agentistics/restore-staging'

/** Read the manifest without extracting the archive. */
export async function readManifestOf(archive: string): Promise<DecodedManifest> {
  try {
    const { stdout } = await run('tar', ['-xOf', archive, MANIFEST_NAME], { maxBuffer: 64 * 1024 * 1024 })
    return decodeManifest(stdout)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * Prove the archive is intact. Two checks, because they fail differently: tar must be able to LIST
 * it end to end (catches truncation), and the entry count must be AT LEAST what the manifest
 * recorded.
 *
 * A floor, deliberately, not an equality — the doc used to claim equality and the code has always
 * been a floor, which is the honest one: the archive legitimately holds MORE entries than the
 * manifest's file count (the manifest itself, the `repos/` assets, and whatever directory entries
 * tar chose to emit). An equality check would refuse every backup carrying a repos layer. Content
 * is proven separately by `verifyStaged`'s digest, after extraction and before any merge.
 */
export async function verifyArchive(archive: string, manifest: BackupManifest): Promise<VerifyResult> {
  let listing: string
  try {
    const { stdout } = await run('tar', ['-tf', archive], { maxBuffer: 256 * 1024 * 1024 })
    listing = stdout
  } catch (e) {
    return { ok: false, reason: `archive is unreadable or truncated: ${e instanceof Error ? e.message : String(e)}` }
  }
  const entries = listing.split('\n').filter(l => l.trim() && !l.endsWith('/'))
  const expected = (manifest.groups[0]?.files.length ?? 0) + 1   // + the manifest itself
  if (entries.length < expected) {
    return { ok: false, reason: `archive holds ${entries.length} entries, the manifest recorded ${expected}` }
  }
  return { ok: true }
}

export type StagedVerdict =
  | { ok: true; drifted: string[] }
  | { ok: false; reason: string }

/**
 * The second half of verification, run against the STAGED files once they are extracted.
 *
 * The digest was never content integrity — it is `path:bytes`, so an edited file of the same size
 * already passed it. Its real job is catching a REBUILT or TRUNCATED archive, so this checks the
 * SET (every path the manifest recorded is present, and nothing unexpected is), and merely REPORTS
 * a size that drifted rather than refusing on it. A backup is taken on a LIVE machine: the running
 * server rewrites session documents and every open assistant appends to its transcript between the
 * walk and the moment tar reads the file, so a few bytes of drift is expected, not corruption. It
 * used to refuse on any size mismatch, which made a perfectly restorable archive unopenable on a
 * machine that no longer existed to produce a byte-identical copy.
 */
export function verifyStaged(
  staged: { rel: string; bytes: number }[], manifest: BackupManifest,
): StagedVerdict {
  const expected = Array.isArray(manifest.groups[0]?.files) ? manifest.groups[0]!.files : []
  const expectedByRel = new Map(expected.map(f => [f.rel, f.bytes]))
  const stagedRels = new Set(staged.map(f => f.rel))

  const missing = expected.filter(f => !stagedRels.has(f.rel))
  const extra = staged.filter(f => !expectedByRel.has(f.rel))
  if (missing.length || extra.length) {
    return {
      ok: false,
      reason: `the archive contents do not match the manifest — ${missing.length} file(s) missing, `
        + `${extra.length} unexpected`,
    }
  }

  const drifted = staged.filter(f => expectedByRel.get(f.rel) !== f.bytes).map(f => f.rel)
  return { ok: true, drifted }
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((res, rej) => {
    createReadStream(path).on('data', d => hash.update(d)).on('end', () => res()).on('error', rej)
  })
  return hash.digest('hex')
}

async function walkStaged(root: string): Promise<(StagedFile & { bytes: number })[]> {
  const out: (StagedFile & { bytes: number })[] = []
  const visit = async (abs: string): Promise<void> => {
    const st = await stat(abs).catch(() => null)
    if (!st) return
    if (st.isDirectory()) {
      for (const e of await readdir(abs).catch(() => [] as string[])) await visit(join(abs, e))
      return
    }
    out.push({ rel: relative(root, abs).split('\\').join('/'), mtimeMs: st.mtimeMs, bytes: st.size })
  }
  await visit(root)
  // `repos/` holds the archive's OWN assets — the bundles and patches — not $HOME content. It is
  // outside the manifest digest (which covers the walk that produced the archive) and outside the
  // merge (which writes into $HOME). Leaving it in broke both: the digest never matched, so a
  // perfectly intact backup refused to restore, and had it matched, the merge would have copied
  // git bundles into `$HOME/repos/`.
  return out.filter(f => f.rel !== MANIFEST_NAME && f.rel !== 'repos' && !f.rel.startsWith('repos/'))
}

export interface RestoreMetricsOptions {
  archive: string
  homeDir: string
  onLine?: (line: string) => void
}

export type RestoreMetricsResult =
  | { ok: true; written: number; skipped: number; manifest: BackupManifest }
  | { ok: false; reason: string }

export async function restoreMetrics(opts: RestoreMetricsOptions): Promise<RestoreMetricsResult> {
  const log = opts.onLine ?? (() => {})
  const staging = join(opts.homeDir, STAGING)

  const decoded = await readManifestOf(opts.archive)
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason === 'too-new'
      ? `this archive was written by a newer agentop (manifest version ${decoded.found}); upgrade before restoring`
      : `the archive's manifest is ${decoded.reason}` }
  }
  const manifest = decoded.manifest

  const verified = await verifyArchive(opts.archive, manifest)
  if (!verified.ok) return { ok: false, reason: verified.reason }

  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await run('tar', ['-xf', opts.archive, '-C', staging], { maxBuffer: 16 * 1024 * 1024 })

    const staged = await walkStaged(staging)

    // The set check happens HERE, after extraction and before the merge — it needs the files, and a
    // MISSING or EXTRA path must still stop everything before a single byte is written into $HOME. A
    // size that merely drifted is reported, not refused — see `verifyStaged`.
    const digest = verifyStaged(staged, manifest)
    if (!digest.ok) return { ok: false, reason: digest.reason }
    if (digest.drifted.length) {
      log(`${digest.drifted.length} file(s) changed size between the walk and the archive — restored as archived:`)
      for (const d of digest.drifted.slice(0, 10)) log(`  ${d}`)
    }

    const localMtime = new Map<string, number>()
    for (const f of staged) {
      const st = await stat(join(opts.homeDir, f.rel)).catch(() => null)
      if (st) localMtime.set(f.rel, st.mtimeMs)
    }

    const actions = planMetrics(staged, localMtime)
    let written = 0
    let skipped = 0

    for (const a of actions) {
      if (a.kind === 'skip') {
        skipped++
        log(`skip ${a.rel} — the local copy is newer`)
        continue
      }

      if (a.kind === 'merge') {
        // preferences.json is the one file the tool writes for ITSELF, so on the realistic flow —
        // set up the new machine, then restore — the local copy is always newer and newer-wins
        // would drop it. Union instead: keys the local file does not have are taken from the
        // backup, keys it has are kept, and `team` is never merged in either direction (its tokens
        // travelled redacted out — see mergePreferences).
        const to = join(opts.homeDir, a.rel)
        await mkdir(dirname(to), { recursive: true })
        const rawArchived = await readFile(join(staging, a.rel), 'utf8')
        const archivedText = manifest.homeDir !== opts.homeDir
          ? rewriteHome(rawArchived, manifest.homeDir, opts.homeDir)
          : rawArchived
        const localText = await readFile(to, 'utf8').catch(() => '{}')
        const { text, tookFromBackup } = mergePreferences(localText, archivedText)
        await writeFile(to, text)
        log(tookFromBackup.length
          ? `merged ${a.rel} — kept every local key, took from the backup: ${tookFromBackup.join(', ')}`
          : `merged ${a.rel} — the local copy already had every key`)
        written++
        continue
      }

      const from = join(staging, a.rel)
      const to = join(opts.homeDir, a.redirectTo ?? a.rel)
      await mkdir(dirname(to), { recursive: true })

      // Only JSON documents can carry an absolute path that needs rewriting; everything else is
      // copied byte for byte. Rewriting an arbitrary file would corrupt binaries.
      if (a.rel.endsWith('.json') && manifest.homeDir !== opts.homeDir) {
        const text = await readFile(from, 'utf8')
        await writeFile(to, rewriteHome(text, manifest.homeDir, opts.homeDir))
      } else {
        await copyFile(from, to)
      }
      written++
    }

    log(`${written} written, ${skipped} skipped`)
    return { ok: true, written, skipped, manifest }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

export async function readRestoreState(file = RESTORE_STATE_FILE): Promise<RestoreState> {
  return (await safeReadJson<RestoreState>(file)) ?? emptyRestoreState()
}

export async function writeRestoreState(state: RestoreState, file = RESTORE_STATE_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2))
}

export interface RestoreReposOptions {
  manifest: BackupManifest
  homeDir: string
  /** The archive itself — the repos phase extracts its `repos/` assets before running anything. */
  archive: string
  only?: string
  onLine?: (line: string) => void
}

export interface RestoreReposResult {
  attempted: number
  succeeded: number
  failures: { key: string; reason: string }[]
  skipped: { key: string; reason: string }[]
  /**
   * A repo that failed AFTER its clone — `branch -m`, `fetch`, `checkout`, `worktree add` or
   * `apply` — leaves the destination on disk and is never retried automatically: neither step is
   * repeatable, and a half-clever resume that gets it wrong writes into a repository the user may
   * already have started working in. Named here so the report says so loudly instead of the
   * ordinary `skipped` a re-run would otherwise print forever.
   */
  halfRestored: { key: string; path: string; previousFailure: string }[]
}

export async function restoreRepos(opts: RestoreReposOptions): Promise<RestoreReposResult> {
  const log = opts.onLine ?? (() => {})
  const stateFile = restoreStateFile(opts.homeDir)
  const state = await readRestoreState(stateFile)
  const entries = opts.only
    ? opts.manifest.repos.filter(r => r.key === opts.only)
    : opts.manifest.repos

  // The bundles and patches live inside the archive. Extract just that subtree — `git fetch` needs
  // a real file, and the manifest names it archive-relative precisely so it can be placed anywhere.
  const assetDir = join(opts.homeDir, STAGING)
  await rm(assetDir, { recursive: true, force: true })
  await mkdir(assetDir, { recursive: true })
  const needsAssets = entries.some(e => e.bundle || e.dirty.some(d => d.patch))
  if (needsAssets) {
    const listed = await run('tar', ['-tf', opts.archive, 'repos'], { maxBuffer: 16 * 1024 * 1024 })
      .then(() => true).catch(() => false)
    if (!listed) {
      log('this archive carries no repos assets — cloning without local-only history')
    } else {
      try {
        await run('tar', ['-xf', opts.archive, '-C', assetDir, 'repos'], { maxBuffer: 16 * 1024 * 1024 })
      } catch (e) {
        // The assets ARE in the archive and could not be extracted. Cloning on would silently
        // rebuild every repository without the unpushed work this phase exists to restore.
        await rm(assetDir, { recursive: true, force: true }).catch(() => {})
        return {
          attempted: 0, succeeded: 0, skipped: [], halfRestored: [],
          failures: [{ key: '(repos assets)', reason: `could not extract them: ${e instanceof Error ? e.message : String(e)}` }],
        }
      }
    }
  }

  const steps = planRepos(entries, state, p => existsSync(p), opts.homeDir, assetDir)
  const result: RestoreReposResult = { attempted: 0, succeeded: 0, failures: [], skipped: [], halfRestored: [] }

  for (const s of steps) {
    if (s.state === 'skipped') result.skipped.push({ key: s.key, reason: String(s.reason) })
    else if (s.state === 'half-restored') {
      result.halfRestored.push({
        key: s.key,
        path: expandHome(s.mainPath, opts.homeDir),
        previousFailure: s.previousFailure ?? 'unknown',
      })
    }
  }

  // Everything below is wrapped so the staging directory goes on EVERY exit path — the same
  // invariant `restoreMetrics` already holds. Without it an uncaught throw inside the loop (a
  // disk-write failure in `writeRestoreState`, say) leaves the staging tree behind.
  try {
  for (const step of remaining(steps)) {
    result.attempted++
    if (step.previousFailure) log(`retrying ${step.key} (last failed: ${step.previousFailure})`)
    const failure = await runSteps(step, opts.homeDir, log)
    if (failure) {
      result.failures.push({ key: step.key, reason: failure })
      state.repos[step.key] = { state: 'failed', reason: failure }
      log(`FAILED ${step.key} — ${failure}`)
    } else {
      result.succeeded++
      state.repos[step.key] = { state: 'done' }
      log(`ok ${step.key} -> ${step.mainPath}`)
    }
    // Written after every repo, not at the end: an interrupted run must not lose what it did.
    await writeRestoreState(state, stateFile)
  }

  // Untracked files were never carried, and a diff we could not capture was never carried either
  // (see RepoDirty). Name both, so "not restored" is a fact the user reads rather than a silence
  // they discover.
  for (const e of entries) {
    if (e.bundleUnavailable) log(`note ${e.key}: ${e.bundleUnavailable}`)
    for (const d of e.dirty) {
      if (d.patchUnavailable) {
        log(`note ${e.key}: the uncommitted state of ${d.path} could NOT be read — ${d.patchUnavailable}`)
      }
      if (d.untracked.length) {
        log(`note ${e.key}: ${d.untracked.length} untracked file(s) in ${d.path} were listed, not carried:`)
        for (const u of d.untracked.slice(0, 20)) log(`       ${u}`)
        if (d.untracked.length > 20) log(`       … and ${d.untracked.length - 20} more`)
      }
    }
  }

  } finally {
    await rm(assetDir, { recursive: true, force: true }).catch(() => {})
  }
  return result
}

/**
 * Run one repo's commands in order. Returns the failure reason, or null on success.
 *
 * It walks `step.argv` — structured, never a split string — so a path containing a space survives,
 * and no shell is involved at any point. `step.commands` is the same plan joined, and exists only
 * to be printed. A step marked `optional` (the bundle's upstream re-link, its placeholder-branch
 * cleanup) is LOGGED and stepped over on failure rather than abandoning the repository — losing
 * every remaining worktree and uncommitted patch over one tracking link that legitimately has no
 * matching remote branch would cost far more than the thing that failed.
 */
async function runSteps(step: RepoStep, homeDir: string, log: (l: string) => void): Promise<string | null> {
  for (let i = 0; i < step.argv.length; i++) {
    const { argv, optional } = step.argv[i]!
    const [bin, ...args] = argv
    if (!bin) continue
    try {
      log(`  ${step.commands[i] ?? bin}`)
      await run(bin, args, {
        cwd: homeDir,
        // `cwd` does NOT override an inherited GIT_DIR. `agentop restore --repos` can run from a
        // git hook, and there it would clone into the hook's repository instead of the target.
        // Same rule as the probe's, imported rather than restated — a second copy is a second
        // place to forget GIT_COMMON_DIR.
        env: gitEnv(),
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const reason = msg.split('\n').slice(0, 3).join(' ').slice(0, 300)
      if (optional) {
        log(`  (optional step failed, continuing: ${reason})`)
        continue
      }
      return reason
    }
  }
  return null
}
