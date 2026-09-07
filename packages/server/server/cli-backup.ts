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
import { cliStrings, resolveLang, type CliStrings } from './cli-i18n'
import { BACKUP_LAYERS, planSources, withMetrics, type BackupLayer } from './backup/backup-plan'
import { formatBytes, layerTotal, plannedTotal, type BackupSizes } from './backup/backup-size'
import { lastBackup, lastPerHarness, lastRun, loadBackupHistory, recordPrune, toPrune } from './backup/backup-store'
import { runBackup, walkSources } from './backup/backup'
import { probeAll, candidatePaths, createBundle, capturePatch, listUntracked } from './backup/repo-probe'
import { groupRepos, expandHome, assetRel, type RepoEntry } from './backup/repo-manifest'
import { planRepos } from './backup/restore-plan'
import { readManifestOf, restoreMetrics, restoreRepos, readRestoreState, restoreStateFile } from './backup/restore'
import { MIN_CUSTOM_HOURS, SCHEDULE_IDS, scheduleStatus, type ScheduleId } from './backup/schedule'
import { loadConsolidated } from './consolidate'
import { confirm, maskedInput } from './cli-ui'
import { parseRepoUrl, repoUrlHost } from './backup/github-api'
import { readGithubConfig } from './backup/github-store'
import { setupGithubBackup } from './backup/github-setup'
import { backupNotification } from './backup/backup-notify'
import { cachedSizes, resetSizeCache, storeSizes } from './backup/size-cache'
import { syncBackupToGithub } from './backup/github-upload'
import {
  downloadBackupRelease, groupReleasesByMachine, listBackupReleases, newestForMachine,
} from './backup/github-restore'
import { BACKUP_DOC_WORKFLOW_PATH, installGithubBackupWorkflow } from './backup/github-workflow'
import type { ReleaseSummary } from './backup/backup-github'
import type { GithubBackupConfig } from './backup/github-store'

const DEFAULT_LAYERS: BackupLayer[] = ['metrics', 'repos']
const DEFAULT_KEEP = 7
const DEFAULT_MAX_BUNDLE = 200 * 1024 * 1024

export interface BackupPrefs {
  schedule: ScheduleId
  /** Hours between runs when `schedule` is `'custom'`. Undefined otherwise. */
  customHours?: number
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
    // Carried raw. `intervalMs` is the ONE place that clamps and defaults it, so a hand-edited
    // preferences file cannot smuggle a five-minute backup past a validation that lives elsewhere.
    customHours: typeof b.customHours === 'number' ? b.customHours : undefined,
    layers,
    scheduleLayers: (b.scheduleLayers as BackupLayer[] | undefined) ?? DEFAULT_LAYERS,
    harnesses: (b.harnesses as HarnessId[] | undefined)?.filter(h => HARNESS_ORDER.includes(h)) ?? [...HARNESS_ORDER],
    destDir: b.destDir ?? join(AGENTISTICS_DATA_DIR, 'backups'),
    keep: typeof b.keep === 'number' && b.keep > 0 ? b.keep : DEFAULT_KEEP,
    maxBundleBytes: typeof b.maxBundleBytes === 'number' && b.maxBundleBytes > 0
      ? b.maxBundleBytes : DEFAULT_MAX_BUNDLE,
  }
}

export interface MeasuredLayers {
  /**
   * Every layer's measured weight on this machine, already formatted. `repos` is deliberately
   * `null`, never an estimate: its content (bundles, patches) does not exist anywhere in $HOME
   * until a backup actually runs `buildRepoManifest` — shelling out to git per candidate directory,
   * which is not a "measure a size" operation, it is the operation itself. A surface renders `null`
   * as "known after a backup runs", never as `0` — the same N/A-versus-a-confident-0 rule
   * `HARNESS_CAPABILITIES` applies to a metric.
   */
  labels: Record<BackupLayer, string | null>
  /** The raw walk, kept around so a caller that also needs the metrics layer's per-harness split
   *  (the harness coverage table) does not have to walk $HOME a second time for it. */
  sizes: BackupSizes
}

/**
 * What each layer weighs on THIS machine right now — the numbers every format picker (cockpit,
 * web, `agentop backup config`) shows beside its rows, so the choice is informed rather than a
 * guess. Measured via the same `walkSources` a real backup walks, over `metrics`, `archive` and
 * `raw` — the three layers that are files sitting in $HOME today.
 */
/**
 * The cached measurement, refreshing in the background when it is stale.
 *
 * This is what every SURFACE calls. It returns instantly — the cached value, or `null` when
 * nothing has been measured yet — and never blocks a page on a filesystem walk. Measured: walking
 * every layer takes 7.2s on a real machine (15.341 files in the `raw` layer alone), and Settings →
 * Backup sat on "Loading" for the whole of it.
 *
 * `null` is rendered as "not measured yet" by the surfaces, never as a zero: a confident `0` beside
 * a layer holding gigabytes is worse than an honest blank.
 */
export function layerSizesNow(): MeasuredLayers | null {
  const hit = cachedSizes()
  if (hit) return hit
  // Not awaited: the caller gets `null` now and the next read gets the figures. A second call
  // while one is in flight simply re-measures — cheap next to the alternative of a lock that can
  // be left held by a walk that threw.
  void measuredLayerSizes().then(v => { storeSizes(v) }).catch(() => { /* the surfaces say "unknown" */ })
  return null
}

export async function measuredLayerSizes(): Promise<MeasuredLayers> {
  const { sizes } = await walkSources(
    HOME_DIR, planSources({ layers: ['metrics', 'archive', 'raw'], harnesses: HARNESS_ORDER }),
  )
  return {
    labels: {
      metrics: formatBytes(layerTotal(sizes, 'metrics')),
      repos: null,
      archive: formatBytes(layerTotal(sizes, 'archive')),
      raw: formatBytes(layerTotal(sizes, 'raw')),
    },
    sizes,
  }
}

/**
 * The three writers behind every surface that configures a backup — the cockpit's layer editor and
 * schedule row, the web format/recurrence pickers, and `agentop backup config`. One implementation
 * each, so a preference written by any of the three reads back identically from any of the others.
 */
export async function writeBackupLayers(layers: BackupLayer[]): Promise<BackupLayer[]> {
  const normalized = withMetrics(layers)
  const p = await readPreferences()
  await writePreferences({ ...p, backup: { ...(p.backup ?? {}), layers: normalized } })
  return normalized
}

/** Deliberately separate from `writeBackupLayers` — see `BackupPrefs.scheduleLayers`: a schedule
 *  that inherited the manual layers would fill a disk the first time `raw` was added to one run. */
export async function writeBackupScheduleLayers(layers: BackupLayer[]): Promise<BackupLayer[]> {
  const normalized = withMetrics(layers)
  const p = await readPreferences()
  await writePreferences({ ...p, backup: { ...(p.backup ?? {}), scheduleLayers: normalized } })
  return normalized
}

export async function writeBackupSchedule(schedule: ScheduleId, customHours?: number): Promise<void> {
  const p = await readPreferences()
  // `customHours` is written only when it was given, so switching to `weekly` and back to `custom`
  // returns to the number the user had chosen rather than to a default they never picked.
  await writePreferences({
    ...p,
    backup: {
      ...(p.backup ?? {}),
      schedule,
      ...(customHours === undefined ? null : { customHours }),
    },
  })
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
  | { kind: 'schedule'; schedule: ScheduleId; customHours?: number }
  | {
      kind: 'config'
      /** Each field present only when the matching flag was given. All absent means "print the
       *  current configuration" — `runBackupCli` tells the two apart, never a bare empty object. */
      layers?: BackupLayer[]
      schedule?: ScheduleId
      scheduleLayers?: BackupLayer[]
    }
  | { kind: 'status' }
  | { kind: 'github-status' }
  | { kind: 'github-setup'; url: string }
  | { kind: 'github-install-workflow' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

/** `a,b,c` -> `BackupLayer[]`, or an error message naming the bad token(s). Shared by `--layers`
 *  and `--schedule-layers` — one parser, so the two flags can never accept different vocabularies. */
function parseLayerList(raw: string): BackupLayer[] | { error: string } {
  const list = raw.split(',').map(s => s.trim()).filter(Boolean)
  const bad = list.filter(l => !BACKUP_LAYERS.includes(l as BackupLayer))
  if (bad.length) return { error: `unknown layer: ${bad.join(', ')} (known: ${BACKUP_LAYERS.join(', ')})` }
  return list as BackupLayer[]
}

export function parseBackupArgs(argv: string[]): BackupArgs {
  const [first, ...rest] = argv

  if (first === 'help' || first === '--help' || first === '-h') return { kind: 'help' }
  if (first === 'status') return { kind: 'status' }
  if (first === 'github') {
    const sub = rest[0]
    if (sub === 'status') return { kind: 'github-status' }
    if (sub === 'setup') {
      const url = rest[1]
      if (!url) {
        return {
          kind: 'error',
          message: 'github setup requires a repository URL, e.g. '
            + 'agentop backup github setup https://github.com/you/agentistics-backups',
        }
      }
      return { kind: 'github-setup', url }
    }
    if (sub === 'install-workflow') return { kind: 'github-install-workflow' }
    return { kind: 'error', message: 'github takes one of: setup <url>, status, install-workflow' }
  }
  if (first === 'schedule') {
    const id = rest[0]
    if (!id || !SCHEDULE_IDS.includes(id as ScheduleId)) {
      return { kind: 'error', message: `schedule takes one of: ${SCHEDULE_IDS.join(', ')}` }
    }
    if (id === 'custom') {
      // `schedule custom` with no number is not an error — `intervalMs` defaults it to daily and
      // says so. Refusing here would make the CLI stricter than the rule it is enforcing.
      const raw = rest[1]
      if (raw === undefined) return { kind: 'schedule', schedule: 'custom' }
      const hours = Number(raw)
      if (!Number.isFinite(hours) || hours <= 0) {
        return { kind: 'error', message: 'schedule custom takes a number of hours, e.g. `schedule custom 6`' }
      }
      return { kind: 'schedule', schedule: 'custom', customHours: hours }
    }
    return { kind: 'schedule', schedule: id as ScheduleId }
  }

  if (first === 'config') {
    const out: { layers?: BackupLayer[]; schedule?: ScheduleId; scheduleLayers?: BackupLayer[] } = {}

    const li = rest.indexOf('--layers')
    if (li !== -1) {
      const parsed = parseLayerList(rest[li + 1] ?? '')
      if ('error' in parsed) return { kind: 'error', message: parsed.error }
      out.layers = parsed
    }

    const sli = rest.indexOf('--schedule-layers')
    if (sli !== -1) {
      const parsed = parseLayerList(rest[sli + 1] ?? '')
      if ('error' in parsed) return { kind: 'error', message: parsed.error }
      out.scheduleLayers = parsed
    }

    const si = rest.indexOf('--schedule')
    if (si !== -1) {
      const id = rest[si + 1]
      if (!id || !SCHEDULE_IDS.includes(id as ScheduleId)) {
        return { kind: 'error', message: `--schedule takes one of: ${SCHEDULE_IDS.join(', ')}` }
      }
      out.schedule = id as ScheduleId
    }

    return { kind: 'config', ...out }
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
  agentop backup config [--layers a,b] [--schedule <off|daily|weekly>] [--schedule-layers a,b]
  agentop backup status
  agentop backup github setup <url>
  agentop backup github status
  agentop backup github install-workflow
  agentop restore <archive|repository-url> [--repos] [--only <repo>] [--release <tag>] [--from <machine>]
  agentop restore github --list <repository-url>

Carry this machine's whole agentistics history to another one.

  A backup always holds your computed metrics and a repository manifest that can rebuild every
  checkout, worktree, unpushed branch and uncommitted diff. --with-archive adds the mirrored
  transcripts; --with-raw adds the harness directories themselves.

  \`agentop backup config\` with no flags prints the current layers, schedule and schedule-layers.
  Layers are metrics,repos,archive,raw — metrics is always included even if you leave it out.
  A schedule never carries the repos layer; \`agentop backup\` (or the cockpit's \`b\`) is what
  rebuilds the repository manifest.

  Live credentials are NEVER included. \`restore\` prints each one and the command that
  re-establishes it.

  \`github setup <url>\` connects a PRIVATE GitHub repository to hold versioned backups (asks for a
  token, never echoed). The repository must already be private and the token must be able to push
  to it — both are checked before anything is written. \`github status\` prints what is configured.
  Setup also installs \`${BACKUP_DOC_WORKFLOW_PATH}\`, which keeps a \`BACKUPS.md\` in that repository
  up to date on every release; \`github install-workflow\` installs it on its own (idempotent — it
  never overwrites one that is already there).

  \`agentop restore <repository-url>\` is the path back on a machine that has nothing but the URL:
  it asks for a token if none is stored, lists releases, shows what would be downloaded and asks,
  verifies the sha256 against the release body before touching anything, and only then hands off to
  the ordinary restore above. \`--release <tag>\` restores a specific release instead of the newest,
  and \`--from <machine>\` takes the newest backup of ONE machine — needed whenever several machines
  version to the same repository, where "the newest" would otherwise be whichever ran last.
  \`agentop restore github --list <url>\` shows what is there without downloading anything.`

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

    // A repo with no remote has no other home, so it needs its whole history.
    // The name carries the CHECKOUT as well as the remote: one remote cloned twice is two entries,
    // and a name from the remote alone had the second overwrite the first's bundle. See `assetRel`.
    const rel = assetRel(e.key, e.mainPath, '.bundle')
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
        patchRel = assetRel(e.key, dir, '.patch')
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
 *
 * Each deletion is itself RECORDED (`recordPrune`) — the history distinguishes a backup deleted
 * on purpose, by retention, from one that vanished for some other reason. Without that second
 * event, every row past `keep` would read exactly like a real loss.
 */
export async function pruneOldBackups(keep: number, log: (l: string) => void): Promise<void> {
  const entries = await loadBackupHistory()
  for (const old of toPrune(entries, keep)) {
    await rm(old.path, { force: true }).catch(() => {})
    await recordPrune(old.path)
    log(`pruned ${old.path}`)
  }
}

/**
 * Run one backup end to end — the repository manifest, the archive, the pruning — and report it.
 *
 * The ONE implementation `agentop backup` and the cockpit's `b` key both call. It used to live
 * inline inside `runBackupCli`, which meant the cockpit would have had to grow a second copy of
 * the same try/finally over `mkdtemp` to run a backup from the `backup` tab — the exact
 * "one gesture implemented twice" shape `task-reopen.ts` exists to have fixed once. Neither
 * caller decides anything here: `layers`/`harnesses`/`destDir` are handed in already resolved
 * (explicit flags vs. configured layers is `runBackupCli`'s call to make, not this function's).
 */
export async function performBackup(
  prefs: BackupPrefs,
  run: { layers: BackupLayer[]; harnesses: HarnessId[]; destDir: string },
  log: (l: string) => void,
  /** True when the DAEMON started this. Travels into every toast: a notification nobody asked for
   *  has to say why it appeared. */
  scheduled = false,
): Promise<import('./backup/backup').BackupResult> {
  const stageRoot = await mkdtemp(join(tmpdir(), 'agentistics-backup-'))
  // Best-effort by construction: a backup must never fail because a toast could not be delivered,
  // and on the CLI there is no dashboard listening at all.
  const notify = (n: Parameters<typeof backupNotification>[0]): void => {
    void import('../server/sse')
      .then(m => m.broadcastNotification(backupNotification(n)))
      .catch(() => { /* nobody is listening; the log already said it */ })
  }
  notify({ phase: 'started', layers: run.layers, scheduled })
  try {
    const repos = run.layers.includes('repos') ? await buildRepoManifest(prefs, stageRoot, log) : []
    const result = await runBackup({
      homeDir: HOME_DIR, destDir: run.destDir, layers: run.layers, harnesses: run.harnesses,
      repos, assetRoot: stageRoot, agentopVersion: CURRENT_VERSION, hostname: hostname(), onLine: log,
    })
    if (!result.ok) {
      notify({ phase: 'failed', layers: run.layers, scheduled, reason: result.reason })
      return result
    }

    log(`before compression: ${formatBytes(plannedTotal(result.sizes, run.layers))}`)
    log(`archive:            ${formatBytes(result.record.archiveBytes)}`)
    log(`sha256:             ${result.record.sha256}`)

    // Pruning deletes the FILES and leaves the records. The store is append-only (see BACKUPS_FILE)
    // and already holds the rule that makes rewriting unnecessary: a record whose file is gone is
    // reported absent by `markPresence` from then on, which is the truth and is what the history is
    // for. Rewriting the file to drop them would reintroduce exactly the read-modify-write race the
    // append-only shape exists to remove.
    await pruneOldBackups(prefs.keep, log)

    // Not configured is a silent no-op — most machines never set this up. Configured, this walks
    // the whole confirmation ladder (`github-upload.ts`) and only deletes the local file once the
    // upload is confirmed byte-for-byte; a failed confirmation logs why and leaves it in place.
    // The numbers just changed, and a five-minute-old measurement would now be wrong in the one
    // moment somebody is most likely to look at them.
    resetSizeCache()
    notify({
      phase: 'done', layers: run.layers, scheduled,
      bytesLabel: formatBytes(result.record.archiveBytes),
      skipped: result.record.skipped,
    })

    await syncBackupToGithub(result.record, { log, onOutcome: notify, scheduled })
    return result
  } catch (e) {
    // A throw here is the case the `!result.ok` branch above cannot see — a staging failure, a full
    // disk mid-tar. Reported rather than swallowed into a stack trace nobody is watching.
    notify({
      phase: 'failed', layers: run.layers, scheduled,
      reason: e instanceof Error ? e.message : String(e),
    })
    throw e
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
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
    await writeBackupSchedule(parsed.schedule, parsed.customHours)
    log(parsed.schedule === 'custom'
      ? `schedule: every ${Math.max(MIN_CUSTOM_HOURS, parsed.customHours ?? 24)}h`
      : `schedule: ${parsed.schedule}`)
    if (parsed.schedule !== 'off') {
      log('Scheduled backups run inside `agentop server`. With the server stopped, none run.')
    }
    return 0
  }

  if (parsed.kind === 'github-status') {
    const config = await readGithubConfig()
    if (!config) {
      log('github backup: not configured.')
      log('Run `agentop backup github setup <url>` to connect a private GitHub repository.')
      return 0
    }
    log('github backup: configured')
    log(`  repository: ${config.owner}/${config.repo}`)
    log(`  url:        ${config.url}`)
    log(`  keep:       ${config.keepRemote === 0 ? 'all releases' : `${config.keepRemote} release(s)`}`)
    log(`  delete local after a confirmed upload: ${config.deleteLocalAfterUpload ? 'yes' : 'no'}`)
    return 0
  }

  if (parsed.kind === 'github-setup') {
    // The token is asked for HERE, never taken as an argv token — a value on the command line ends
    // up in shell history and in `ps`. `maskedInput` suppresses the terminal echo.
    const token = await maskedInput('GitHub personal access token (never echoed)')
    if (!token) { console.error('a token is required.'); return 1 }
    const result = await setupGithubBackup({ url: parsed.url, token })
    if (!result.ok) { console.error(result.message); return 1 }
    log(`github backup configured: ${result.config.owner}/${result.config.repo}`)
    log(`The token is stored at ${join(AGENTISTICS_DATA_DIR, 'github-backup.json')} (mode 0600) `
      + 'and is never included in a backup.')

    // Best-effort: setup already succeeded, so a workflow problem is reported, not fatal — the
    // user can retry it on its own with `github install-workflow`.
    const workflow = await installGithubBackupWorkflow(result.config.owner, result.config.repo, result.config.token)
    if (!workflow.ok) {
      log(`note: could not install the backup-doc workflow (${workflow.message}) — run `
        + '`agentop backup github install-workflow` to try again.')
    } else if (workflow.status === 'already-exists') {
      log(`${BACKUP_DOC_WORKFLOW_PATH} already exists on this repository — left untouched.`)
    } else {
      log(`installed ${BACKUP_DOC_WORKFLOW_PATH}, which keeps BACKUPS.md up to date on every backup.`)
    }
    return 0
  }

  if (parsed.kind === 'github-install-workflow') {
    const config = await readGithubConfig()
    if (!config) {
      console.error('github backup is not configured yet. Run `agentop backup github setup <url>` first.')
      return 1
    }
    const result = await installGithubBackupWorkflow(config.owner, config.repo, config.token)
    if (!result.ok) { console.error(result.message); return 1 }
    if (result.status === 'already-exists') {
      log(`${BACKUP_DOC_WORKFLOW_PATH} already exists on ${config.owner}/${config.repo} — left untouched.`)
    } else {
      log(`installed ${BACKUP_DOC_WORKFLOW_PATH} on ${config.owner}/${config.repo}.`)
    }
    return 0
  }

  if (parsed.kind === 'config') {
    const nothingGiven = parsed.layers === undefined && parsed.schedule === undefined
      && parsed.scheduleLayers === undefined
    if (nothingGiven) {
      const measured = await measuredLayerSizes().catch(() => null)
      const sizeLabel = (l: BackupLayer) => measured ? (measured.labels[l] ?? 'known after running') : 'unknown'
      log(`layers:          ${prefs.layers.join(', ')}`)
      for (const l of BACKUP_LAYERS) log(`  ${l.padEnd(9)} ${prefs.layers.includes(l) ? 'on ' : 'off'}  ${sizeLabel(l)}`)
      log(`schedule:        ${prefs.schedule}`)
      log(`schedule-layers: ${prefs.scheduleLayers.join(', ')}`)
      if (prefs.schedule !== 'off' && prefs.scheduleLayers.includes('repos')) {
        log('  note: a scheduled run never carries the repos layer — `agentop backup` builds it, not a schedule.')
      }
      log(`dest:            ${prefs.destDir}`)
      log(`keep:            ${prefs.keep}`)
      return 0
    }

    if (parsed.layers) {
      const written = await writeBackupLayers(parsed.layers)
      log(`layers: ${written.join(', ')}`)
    }
    if (parsed.scheduleLayers) {
      const written = await writeBackupScheduleLayers(parsed.scheduleLayers)
      log(`schedule-layers: ${written.join(', ')}`)
      if (written.includes('repos')) {
        log('  note: a scheduled run never carries the repos layer — `agentop backup` builds it, not a schedule.')
      }
    }
    if (parsed.schedule) {
      await writeBackupSchedule(parsed.schedule)
      log(`schedule: ${parsed.schedule}`)
    }
    return 0
  }

  if (parsed.kind === 'status') {
    const entries = await loadBackupHistory()
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
    // `last` above is what you can RESTORE from; the schedule asks when one last RAN, and a
    // pruned backup still answers that. See `lastRun`.
    const st = scheduleStatus({
      schedule: prefs.schedule, customHours: prefs.customHours,
      lastAt: lastRun(entries)?.at ?? null, nowMs: Date.now(),
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

  // The digest can only ever catch a REBUILT or TRUNCATED archive (see `verifyStaged`) — a file that
  // merely changed size between the walk and tar's read is expected on a live machine, where the
  // running server rewrites session documents and every open assistant appends to its transcript.
  // Said up front, using the same producer heartbeat `agentop backup status` already reads, so a
  // size drift reported on restore reads as an explained fact rather than a surprise.
  if (existsSync(join(AGENTISTICS_DATA_DIR, 'events-producer.json'))) {
    log('note: the agentop server is running, so session files may change while this backup is taken.')
    log('      Files that change are archived as read and reported on restore; nothing is lost.')
  }

  if (parsed.planOnly) {
    // Its own stage root, separate from `performBackup`'s: a plan is not a run, and building the
    // repository manifest is the one thing the two share, so it is the one thing duplicated here
    // rather than pulled into a function neither caller would recognise as "run a backup".
    const stageRoot = await mkdtemp(join(tmpdir(), 'agentistics-backup-'))
    try {
      const repos = layers.includes('repos') ? await buildRepoManifest(effective, stageRoot, log) : []
      log(`layers:    ${layers.join(', ')}`)
      log(`harnesses: ${parsed.harnesses.join(', ')}`)
      log(`repos:     ${repos.filter(r => !r.note).length} cloneable, ${repos.filter(r => r.note).length} noted`)
      log(`dest:      ${destDir}`)
      log('(nothing was written — drop --plan to run it)')
      return 0
    } finally {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  const result = await performBackup(effective, { layers, harnesses: parsed.harnesses, destDir }, log)
  if (!result.ok) { console.error(`backup failed: ${result.reason}`); return 1 }
  return 0
}

/**
 * Everything that happens once a verified archive is sitting on disk — unchanged whether that
 * archive was typed directly on the command line or just downloaded and hash-verified from a
 * GitHub release. This is the "existing restore takes over unchanged" the plan asks for: there is
 * exactly one implementation, so a fix here can never apply to one entry path and not the other.
 */
async function runRestorePhases(
  archive: string, opts: { reposPhase: boolean; only?: string }, log: (l: string) => void, s: CliStrings,
): Promise<number> {
  if (!existsSync(archive)) { console.error(`no such archive: ${archive}`); return 1 }

  const decoded = await readManifestOf(archive)
  if (!decoded.ok) {
    console.error(decoded.reason === 'too-new'
      ? `this archive was written by a newer agentop (manifest version ${decoded.found}) — upgrade first`
      : `the archive's manifest is ${decoded.reason}`)
    return 1
  }
  const manifest = decoded.manifest

  if (!opts.reposPhase) {
    const r = await restoreMetrics({ archive, homeDir: HOME_DIR, onLine: log })
    if (!r.ok) { console.error(`restore failed: ${r.reason}`); return 1 }
    log(`metrics: ${r.written} written, ${r.skipped} skipped (a newer local copy always wins)`)

    log('')
    log(s.backupSecretsOmitted)
    for (const secret of manifest.omittedSecrets) log(`  ${secret.path.padEnd(38)} ${secret.restoreWith}`)

    log('')
    // `restoreRepos` (restore.ts) reads its resume state from `restoreStateFile(homeDir)`. Reading
    // the default `RESTORE_STATE_FILE` here instead is only ever the same file when `AGENTISTICS_DIR`
    // is unset — with it set, the printed plan and the run it precedes would disagree about what is
    // already done.
    const steps = planRepos(manifest.repos, await readRestoreState(restoreStateFile(HOME_DIR)), p => existsSync(p), HOME_DIR)
    const pending = steps.filter(step => step.state === 'pending')
    log(`Repository plan: ${pending.length} to clone, ${steps.length - pending.length} skipped.`)
    for (const step of steps.filter(x => x.state === 'skipped')) log(`  skip ${step.key} — ${step.reason}`)
    log('')
    log(`Run \`agentop restore ${archive} --repos\` to execute it. It is resumable.`)
    return 0
  }

  const r = await restoreRepos({ manifest, homeDir: HOME_DIR, archive, only: opts.only, onLine: log })
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

/** The one-line summary shown before "download this?" — everything the plan asks for is already in
 *  the release body, so this never touches the network again. */
function describeReleaseForConfirm(summary: ReleaseSummary): string[] {
  return [
    `  created:   ${summary.createdAt}`,
    `  host:      ${summary.hostname}`,
    `  size:      ${formatBytes(summary.archiveBytes)}`,
    `  layers:    ${summary.layers.join(', ')}`,
    `  harnesses: ${summary.harnesses.join(', ')}`,
    `  sessions:  ${summary.sessionCount}`,
  ]
}

/**
 * `agentop restore github --list <url>` — what exists on the repository, without downloading a
 * single byte. A fresh machine may only want to know before spending any bandwidth at all.
 */
async function runRestoreGithubList(url: string, log: (l: string) => void): Promise<number> {
  const parsed = parseRepoUrl(url)
  if (!parsed) {
    const host = repoUrlHost(url)
    console.error(host
      ? `"${host}" is not github.com — this only works with a repository on github.com.`
      : `could not read "${url}" as a GitHub repository URL.`)
    return 1
  }

  const stored = await readGithubConfig()
  const token = stored && stored.owner === parsed.owner && stored.repo === parsed.repo
    ? stored.token
    : await maskedInput('GitHub personal access token (never echoed)')
  if (!token) { console.error('a token is required.'); return 1 }

  const result = await listBackupReleases(parsed.owner, parsed.repo, token)
  if (!result.ok) { console.error(result.message); return 1 }
  if (!result.releases.length) {
    log(`no \`backup-\` releases found on ${parsed.owner}/${parsed.repo}.`)
    return 0
  }
  const groups = groupReleasesByMachine(result.releases)
  log(`${result.releases.length} backup release(s) on ${parsed.owner}/${parsed.repo}, `
    + `${groups.length} machine(s), newest first:`)
  for (const g of groups) {
    log('')
    log(g.machine === null
      // Never folded into a machine, and never presented as one: these are releases nothing places.
      ? '  (no machine recorded — from a version before machines were named)'
      : `  machine: ${g.machine}   —   restore with \`agentop restore <url> --from ${g.machine}\``)
    for (const r of g.releases) {
      log('')
      log(`    ${r.tagName}`)
      if (r.summary) for (const line of describeReleaseForConfirm(r.summary)) log(`    ${line}`)
      else log('      (its body could not be decoded — an incompatible or hand-made release)')
    }
  }
  return 0
}

/**
 * Resolve a `token` for restoring FROM `parsed`, asking only when nothing usable is already
 * stored. A stored config for a DIFFERENT repository is not reused silently — a token scoped to
 * one repository is not evidence it can read another, and using it anyway would be indistinguishable
 * from a mistake in the URL. Offers to save the token via the same `setupGithubBackup` every other
 * path writes through, but a decline (or a save that fails its own checks) never stops the restore
 * that is already in progress — the token already proved it can read this repository's releases.
 */
async function resolveRestoreToken(
  parsed: { owner: string; repo: string }, url: string, config: GithubBackupConfig | null, log: (l: string) => void,
): Promise<string | null> {
  if (config && config.owner === parsed.owner && config.repo === parsed.repo) return config.token

  log('no GitHub token is stored on this machine yet.')
  const token = await maskedInput('GitHub personal access token (never echoed)')
  if (!token) return null

  const save = await confirm('Save this token for future backups and restores?', false)
  if (save) {
    const result = await setupGithubBackup({ url, token })
    if (result.ok) log(`saved: ${result.config.owner}/${result.config.repo}`)
    else log(`not saved (${result.message}) — continuing with this restore anyway.`)
  }
  return token
}

export async function runRestoreCli(argv: string[]): Promise<number> {
  const log = (l: string) => console.log(l)
  const s = cliStrings(await resolveLang())
  const first = argv[0]
  if (!first || first === '--help') { console.log(USAGE); return first ? 0 : 1 }

  if (first === 'github') {
    const rest = argv.slice(1)
    if (rest[0] !== '--list' || !rest[1]) { console.error('usage: agentop restore github --list <url>'); return 1 }
    return runRestoreGithubList(rest[1], log)
  }

  const reposPhase = argv.includes('--repos')
  const oi = argv.indexOf('--only')
  const only = oi !== -1 ? argv[oi + 1] : undefined
  const ri = argv.indexOf('--release')
  let releaseTagArg = ri !== -1 ? argv[ri + 1] : undefined
  if (ri !== -1 && !releaseTagArg) { console.error('--release requires a tag'); return 1 }
  const fi = argv.indexOf('--from')
  const fromMachine = fi !== -1 ? argv[fi + 1] : undefined
  if (fi !== -1 && !fromMachine) { console.error('--from requires a machine name'); return 1 }

  let archive: string
  if (existsSync(first)) {
    archive = first
  } else {
    // Not a file on this disk — try it as a repository URL. `parseRepoUrl` runs before any
    // network request, exactly as it does in `github-setup.ts`: sending a token to a host the
    // user mistyped is the one outcome this code must never produce.
    const parsed = parseRepoUrl(first)
    if (!parsed) {
      const host = repoUrlHost(first)
      console.error(host
        ? `"${first}" is not an existing file, and "${host}" is not github.com — this restores `
          + 'from an existing archive or a github.com repository URL.'
        : `"${first}" is neither an existing archive file nor a GitHub repository URL agentop `
          + 'recognises (expected https://github.com/owner/repo, owner/repo, or '
          + 'git@github.com:owner/repo.git).')
      return 1
    }

    const config = await readGithubConfig()
    const token = await resolveRestoreToken(parsed, first, config, log)
    if (!token) { console.error('a token is required.'); return 1 }

    // Which MACHINE. One repository can hold several machines' backups, and "the newest release"
    // is then whichever machine ran last — restoring the wrong computer onto this one, silently.
    // So a repository holding more than one machine REFUSES to guess and names the flag; a
    // repository holding one keeps working exactly as before.
    if (!releaseTagArg) {
      const listed = await listBackupReleases(parsed.owner, parsed.repo, token)
      if (!listed.ok) { console.error(listed.message); return 1 }
      const groups = groupReleasesByMachine(listed.releases)
      if (fromMachine) {
        const pick = newestForMachine(listed.releases, fromMachine)
        if (!pick) {
          console.error(`no backup of "${fromMachine}" on ${parsed.owner}/${parsed.repo}. `
            + `Machines here: ${groups.map(g => g.machine ?? '(unnamed)').join(', ') || 'none'}.`)
          return 1
        }
        releaseTagArg = pick.tagName
        log(`restoring the newest backup of ${fromMachine}: ${pick.tagName}`)
      } else if (groups.length > 1) {
        console.error(`${parsed.owner}/${parsed.repo} holds backups from ${groups.length} machines, `
          + 'so "the newest" would pick whichever ran last. Name one:')
        for (const g of groups) {
          const newest = g.releases[0]
          console.error(g.machine === null
            ? `  (unnamed machine) — use --release ${newest?.tagName ?? ''}`
            : `  --from ${g.machine}   (${g.releases.length} backup(s), newest ${newest?.publishedAt ?? '?'})`)
        }
        return 1
      }
    }

    const outcome = await downloadBackupRelease(parsed.owner, parsed.repo, token, releaseTagArg, {
      onLine: log,
      confirmDownload: async summary => {
        log(`about to download:`)
        for (const line of describeReleaseForConfirm(summary)) log(line)
        return confirm('Download and restore from this backup?', true)
      },
    })

    if (outcome.status === 'cancelled') { log('cancelled — nothing was downloaded.'); return 0 }
    if (outcome.status === 'error') { console.error(outcome.reason); return 1 }
    archive = outcome.archivePath
  }

  return runRestorePhases(archive, { reposPhase, only }, log, s)
}
