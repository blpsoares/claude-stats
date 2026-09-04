/**
 * cli-backup.ts — `agentop backup` and `agentop restore`.
 *
 * Every decision is already made by a pure module: `backup-plan.ts` says what goes in,
 * `repo-manifest.ts` says how a repository is rebuilt, `restore-plan.ts` says what a restore would
 * do, `schedule.ts` says whether one is due. This file parses argv, calls, and prints.
 *
 * The one rule it owns is about printing: **a failure is a LINE naming the thing and the reason.**
 * A run that clones 89 repositories will partially fail, and a count of successes without the list
 * of what did not come back is not a report.
 */
import { hostname, tmpdir } from 'os'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { readPreferences, writePreferences, type Preferences } from './preferences'
import { CURRENT_VERSION } from './version'
import { cliStrings, resolveLang } from './cli-i18n'
import type { BackupLayer } from './backup/backup-plan'
import { formatBytes, plannedTotal } from './backup/backup-size'
import { markPresence, readBackups, lastBackup, lastPerHarness, toPrune } from './backup/backup-store'
import { runBackup } from './backup/backup'
import { probeAll, candidatePaths, createBundle, capturePatch, listUntracked } from './backup/repo-probe'
import { groupRepos, expandHome, type RepoEntry } from './backup/repo-manifest'
import { planRepos } from './backup/restore-plan'
import { readManifestOf, restoreMetrics, restoreRepos, readRestoreState } from './backup/restore'
import { SCHEDULE_IDS, scheduleStatus, type ScheduleId } from './backup/schedule'
import { loadConsolidated } from './consolidate'

const DEFAULT_LAYERS: BackupLayer[] = ['metrics', 'repos']
const DEFAULT_KEEP = 7
const DEFAULT_MAX_BUNDLE = 200 * 1024 * 1024

export interface BackupPrefs {
  schedule: ScheduleId
  layers: BackupLayer[]
  scheduleLayers: BackupLayer[]
  harnesses: HarnessId[]
  destDir: string
  keep: number
  maxBundleBytes: number
}

/** Read the preference block, clamped. Absent reads as OFF — a machine must not start writing
 *  gigabytes because it was upgraded. */
export function readBackupPrefs(p: Preferences): BackupPrefs {
  const b = p.backup ?? {}
  const layers = (b.layers as BackupLayer[] | undefined) ?? DEFAULT_LAYERS
  return {
    schedule: SCHEDULE_IDS.includes(b.schedule as ScheduleId) ? (b.schedule as ScheduleId) : 'off',
    layers,
    scheduleLayers: (b.scheduleLayers as BackupLayer[] | undefined) ?? DEFAULT_LAYERS,
    harnesses: (b.harnesses as HarnessId[] | undefined)?.filter(h => HARNESS_ORDER.includes(h)) ?? [...HARNESS_ORDER],
    destDir: b.destDir ?? join(AGENTISTICS_DATA_DIR, 'backups'),
    keep: typeof b.keep === 'number' && b.keep > 0 ? b.keep : DEFAULT_KEEP,
    maxBundleBytes: typeof b.maxBundleBytes === 'number' && b.maxBundleBytes > 0
      ? b.maxBundleBytes : DEFAULT_MAX_BUNDLE,
  }
}

export type BackupArgs =
  | {
      kind: 'run'
      layers: BackupLayer[]
      /** Whether a `--with-*` flag was actually given. False means "use the configured layers". */
      layersFromFlags: boolean
      harnesses: HarnessId[]
      destDir?: string
      maxBundleBytes?: number
      planOnly: boolean
    }
  | { kind: 'schedule'; schedule: ScheduleId }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

export function parseBackupArgs(argv: string[]): BackupArgs {
  const [first, ...rest] = argv

  if (first === 'help' || first === '--help' || first === '-h') return { kind: 'help' }
  if (first === 'status') return { kind: 'status' }
  if (first === 'schedule') {
    const id = rest[0]
    if (!id || !SCHEDULE_IDS.includes(id as ScheduleId)) {
      return { kind: 'error', message: `schedule takes one of: ${SCHEDULE_IDS.join(', ')}` }
    }
    return { kind: 'schedule', schedule: id as ScheduleId }
  }

  const args = first === undefined ? [] : argv
  const layers: BackupLayer[] = [...DEFAULT_LAYERS]
  const wantsArchive = args.includes('--with-archive')
  const wantsRaw = args.includes('--with-raw')
  if (wantsArchive) layers.push('archive')
  if (wantsRaw) layers.push('raw')

  let harnesses: HarnessId[] = [...HARNESS_ORDER]
  const hi = args.indexOf('--harness')
  if (hi !== -1) {
    const list = (args[hi + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const bad = list.filter(h => !HARNESS_ORDER.includes(h as HarnessId))
    if (bad.length) {
      return { kind: 'error', message: `unknown harness: ${bad.join(', ')} (known: ${HARNESS_ORDER.join(', ')})` }
    }
    harnesses = HARNESS_ORDER.filter(h => list.includes(h))
  }

  const di = args.indexOf('--dest')
  const destDir = di !== -1 ? args[di + 1] : undefined

  // A repository with no remote has no other home, so it gets a FULL bundle — and a full bundle of
  // a large repository is tens of megabytes. The ceiling is what stops one such repo dominating the
  // archive; over it, the repo is reported by name rather than silently omitted.
  let maxBundleBytes: number | undefined
  const mi = args.indexOf('--max-bundle')
  if (mi !== -1) {
    const mb = Number(args[mi + 1])
    if (!Number.isFinite(mb) || mb <= 0) {
      return { kind: 'error', message: '--max-bundle takes a size in megabytes, e.g. --max-bundle 200' }
    }
    maxBundleBytes = mb * 1024 * 1024
  }

  return {
    kind: 'run', layers, layersFromFlags: wantsArchive || wantsRaw,
    harnesses, destDir, maxBundleBytes, planOnly: args.includes('--plan'),
  }
}

const USAGE = `Usage:
  agentop backup [--with-archive] [--with-raw] [--harness a,b] [--dest DIR]
                 [--max-bundle MB] [--plan]
  agentop backup schedule <off|daily|weekly>
  agentop backup status
  agentop restore <archive> [--repos] [--only <repo>]

Carry this machine's whole agentistics history to another one.

  A backup always holds your computed metrics and a repository manifest that can rebuild every
  checkout, worktree, unpushed branch and uncommitted diff. --with-archive adds the mirrored
  transcripts; --with-raw adds the harness directories themselves.

  Live credentials are NEVER included. \`restore\` prints each one and the command that
  re-establishes it.`

/**
 * Build the repository manifest: probe every directory the store knows, bundle, patch.
 *
 * `stageRoot` is the directory whose `repos/` subtree is handed to `runBackup` as `assetRoot` and
 * copied verbatim into the archive. Every `bundle` and `patch` recorded on a `RepoEntry` is
 * therefore an ARCHIVE-RELATIVE path (`repos/…`), never a path on this machine — the restore
 * resolves it against wherever it extracted.
 */
async function buildRepoManifest(
  prefs: BackupPrefs, stageRoot: string, log: (l: string) => void,
): Promise<RepoEntry[]> {
  const reposDir = join(stageRoot, 'repos')
  await mkdir(reposDir, { recursive: true })
  const sessions = [...(await loadConsolidated()).values()]
  const paths = candidatePaths(sessions)
  log(`probing ${paths.length} directories with git`)
  const facts = await probeAll(paths)
  const entries = groupRepos(facts, HOME_DIR)

  for (const e of entries) {
    if (e.note === 'gone' || e.note === 'not-a-repo' || e.note === 'outside-home') continue
    const main = expandHome(e.mainPath, HOME_DIR)
    const safe = e.key.replace(/[^A-Za-z0-9._-]/g, '_')

    // A repo with no remote has no other home, so it needs its whole history.
    const rel = `repos/${safe}.bundle`
    const res = await createBundle(main, join(stageRoot, rel), {
      full: e.note === 'no-remote', maxBytes: prefs.maxBundleBytes,
    })
    if (res === 'written') e.bundle = rel
    else if (res === 'too-large') {
      e.note = 'too-large'
      log(`  ${e.key}: bundle over the ceiling — cloning without local-only history`)
    } else if (res === 'failed') {
      e.bundleUnavailable = 'git bundle failed — this repository restores WITHOUT its unpushed commits'
      log(`  ${e.key}: ${e.bundleUnavailable}`)
    }
    // 'empty' is the happy case: every local commit is already on the remote.

    for (const dir of [e.mainPath, ...e.worktrees.map(w => w.path)]) {
      const abs = expandHome(dir, HOME_DIR)
      const patch = await capturePatch(abs)
      const listed = await listUntracked(abs)
      const untracked = listed.kind === 'files' ? listed.files : []

      // A tree we could not read is RECORDED as unread, never as clean or empty. Either half
      // failing is enough: skipping a directory whose state was never established is the silence
      // this whole module is built to avoid. The restore prints the reason.
      const unread = patch.kind === 'unavailable' ? patch.reason
        : listed.kind === 'unavailable' ? listed.reason
        : null
      if (unread) {
        log(`  ${e.key}: ${dir} could not be read — ${unread}`)
        e.dirty.push({ path: dir, patch: null, untracked, patchUnavailable: unread })
        continue
      }
      if (patch.kind === 'clean' && !untracked.length) continue

      let patchRel: string | null = null
      if (patch.kind === 'patch') {
        // One patch per WORKING TREE, not per repo: a checkout and each of its worktrees are
        // different trees with different uncommitted work, and one file per repo would have them
        // overwrite each other.
        const dirSlug = dir.replace(/[^A-Za-z0-9._-]/g, '_')
        patchRel = `repos/${safe}__${dirSlug}.patch`
        await writeFile(join(stageRoot, patchRel), patch.text)
      }
      // `untracked` is a LIST of names and never the contents — see RepoDirty in repo-manifest.ts.
      e.dirty.push({ path: dir, patch: patchRel, untracked })
    }
  }
  return entries
}

/**
 * Delete the FILES of backups beyond `keep`, newest first. The records stay: the store is
 * append-only and `markPresence` reports a missing file as absent from then on.
 */
export async function pruneOldBackups(keep: number, log: (l: string) => void): Promise<void> {
  const entries = markPresence(await readBackups(), p => existsSync(p))
  for (const old of toPrune(entries, keep)) {
    await rm(old.path, { force: true }).catch(() => {})
    log(`pruned ${old.path}`)
  }
}

export async function runBackupCli(argv: string[]): Promise<number> {
  const parsed = parseBackupArgs(argv)
  const log = (l: string) => console.log(l)

  // The early returns come BEFORE any preference read. `resolveLang()` calls `readPreferences()`,
  // and `agentop backup help` should not touch the disk to print a usage string.
  if (parsed.kind === 'help') { console.log(USAGE); return 0 }
  if (parsed.kind === 'error') { console.error(parsed.message); console.error(); console.error(USAGE); return 1 }

  const s = cliStrings(await resolveLang())
  const prefs = readBackupPrefs(await readPreferences())

  if (parsed.kind === 'schedule') {
    const p = await readPreferences()
    await writePreferences({ ...p, backup: { ...(p.backup ?? {}), schedule: parsed.schedule } })
    log(`schedule: ${parsed.schedule}`)
    if (parsed.schedule !== 'off') {
      log('Scheduled backups run inside `agentop server`. With the server stopped, none run.')
    }
    return 0
  }

  if (parsed.kind === 'status') {
    const entries = markPresence(await readBackups(), p => existsSync(p))
    const last = lastBackup(entries)
    log(last
      ? `last backup: ${last.at} · ${formatBytes(last.archiveBytes)} · ${last.path}`
      : s.backupNoneOnDisk)
    // An incomplete backup must not read as a complete one. `undefined` is not zero: a record
    // written before this field existed does not know, and says so.
    if (last && last.skipped === undefined) {
      log('  (this record predates skip tracking — whether anything was skipped is not known)')
    } else if (last?.skipped) {
      log(`  WARNING: ${last.skipped} path(s) were skipped — re-run \`agentop backup\` to see which`)
    }
    const per = lastPerHarness(entries)
    for (const h of HARNESS_ORDER) log(`  ${h.padEnd(12)} ${per[h] ?? 'never'}`)
    const st = scheduleStatus({
      schedule: prefs.schedule, lastAt: last?.at ?? null, nowMs: Date.now(),
      serverRunning: existsSync(join(AGENTISTICS_DATA_DIR, 'events-producer.json')),
    })
    log(st.kind === 'inactive-no-server'
      ? s.backupScheduleNoServer
      : st.kind === 'off' ? s.backupScheduleOff : `schedule: next at ${new Date(st.nextAtMs).toISOString()}`)
    return 0
  }

  const destDir = parsed.destDir ?? prefs.destDir
  const effective = { ...prefs, maxBundleBytes: parsed.maxBundleBytes ?? prefs.maxBundleBytes }

  // Explicit flags win; otherwise the configured layers; otherwise the built-in default. A
  // preference that is read and never consulted is worse than no preference at all — the user sets
  // it, nothing changes, and they are left guessing which of the two they got wrong.
  const layers = parsed.layersFromFlags ? parsed.layers : effective.layers

  // ONE try/finally, from the mkdtemp to the end.
  //
  // `buildRepoManifest` used to sit outside it, and it is not exception-free: the `mkdir` for the
  // staging subtree and the `writeFile` for each patch are raw fs calls that throw on a permission
  // error or a full disk, unlike the probe helpers, which report `unavailable` instead. A throw
  // there left the temp root behind holding however many git bundles had already been written.
  const stageRoot = await mkdtemp(join(tmpdir(), 'agentistics-backup-'))
  try {
    const repos = layers.includes('repos')
      ? await buildRepoManifest(effective, stageRoot, log)
      : []

    if (parsed.planOnly) {
      log(`layers:    ${layers.join(', ')}`)
      log(`harnesses: ${parsed.harnesses.join(', ')}`)
      log(`repos:     ${repos.filter(r => !r.note).length} cloneable, ${repos.filter(r => r.note).length} noted`)
      log(`dest:      ${destDir}`)
      log('(nothing was written — drop --plan to run it)')
      return 0
    }

    const result = await runBackup({
      homeDir: HOME_DIR, destDir, layers, harnesses: parsed.harnesses,
      repos, assetRoot: stageRoot, agentopVersion: CURRENT_VERSION, hostname: hostname(), onLine: log,
    })
    if (!result.ok) { console.error(`backup failed: ${result.reason}`); return 1 }

    log(`before compression: ${formatBytes(plannedTotal(result.sizes, layers))}`)
    log(`archive:            ${formatBytes(result.record.archiveBytes)}`)
    log(`sha256:             ${result.record.sha256}`)

    // Pruning deletes the FILES and leaves the records. The store is append-only (see BACKUPS_FILE)
    // and already holds the rule that makes rewriting unnecessary: a record whose file is gone is
    // reported absent by `markPresence` from then on, which is the truth and is what the history is
    // for. Rewriting the file to drop them would reintroduce exactly the read-modify-write race the
    // append-only shape exists to remove.
    await pruneOldBackups(prefs.keep, log)
    return 0
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export async function runRestoreCli(argv: string[]): Promise<number> {
  const log = (l: string) => console.log(l)
  const s = cliStrings(await resolveLang())
  const archive = argv[0]
  if (!archive || archive === '--help') { console.log(USAGE); return archive ? 0 : 1 }
  if (!existsSync(archive)) { console.error(`no such archive: ${archive}`); return 1 }

  const reposPhase = argv.includes('--repos')
  const oi = argv.indexOf('--only')
  const only = oi !== -1 ? argv[oi + 1] : undefined

  const decoded = await readManifestOf(archive)
  if (!decoded.ok) {
    console.error(decoded.reason === 'too-new'
      ? `this archive was written by a newer agentop (manifest version ${decoded.found}) — upgrade first`
      : `the archive's manifest is ${decoded.reason}`)
    return 1
  }
  const manifest = decoded.manifest

  if (!reposPhase) {
    const r = await restoreMetrics({ archive, homeDir: HOME_DIR, onLine: log })
    if (!r.ok) { console.error(`restore failed: ${r.reason}`); return 1 }
    log(`metrics: ${r.written} written, ${r.skipped} skipped (a newer local copy always wins)`)

    log('')
    log(s.backupSecretsOmitted)
    for (const secret of manifest.omittedSecrets) log(`  ${secret.path.padEnd(38)} ${secret.restoreWith}`)

    log('')
    const steps = planRepos(manifest.repos, await readRestoreState(), p => existsSync(p), HOME_DIR)
    const pending = steps.filter(step => step.state === 'pending')
    log(`Repository plan: ${pending.length} to clone, ${steps.length - pending.length} skipped.`)
    for (const step of steps.filter(x => x.state === 'skipped')) log(`  skip ${step.key} — ${step.reason}`)
    log('')
    log('Run `agentop restore <archive> --repos` to execute it. It is resumable.')
    return 0
  }

  const r = await restoreRepos({ manifest, homeDir: HOME_DIR, archive, only, onLine: log })
  log('')
  log(`${r.succeeded}/${r.attempted} repositories restored.`)
  for (const f of r.failures) log(`  FAILED ${f.key} — ${f.reason}`)
  for (const skip of r.skipped) log(`  skipped ${skip.key} — ${skip.reason}`)
  if (r.failures.length) log('Re-run the same command to retry only the failures.')
  if (r.halfRestored.length) {
    log('')
    log('These repositories were PARTLY restored and will not be retried automatically:')
    for (const h of r.halfRestored) {
      log(`  ${h.key} at ${h.path}`)
      log(`    the earlier run failed after cloning: ${h.previousFailure}`)
    }
    log('  Inspect them, then remove the directory and re-run to restore each from scratch.')
  }
  return r.failures.length || r.halfRestored.length ? 1 : 0
}
