/**
 * backup-routes.ts — the web dashboard's read of the backup engine: per-harness coverage, the
 * current configuration, and the backup history, plus triggering a run and configuring it.
 *
 * This is the THIRD surface over the same engine `agentop backup` and the cockpit's `backup` tab
 * call (`cli-backup.ts`'s `readBackupPrefs`/`performBackup`/`measuredLayerSizes`, `backup-store.ts`,
 * `backup-size.ts`, `schedule.ts`). It decides nothing: every number here is read straight off the
 * same functions `cli-start.ts`'s `backupStatus`/`runBackup` call for the cockpit, and every write
 * goes through the same three writers `agentop backup config` calls, so the three front doors can
 * never disagree about what a backup covers or how it is configured.
 */
import { hostname } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { readPreferences, resolveArchiveMode, type ArchiveMode } from './preferences'
import {
  readBackupPrefs, performBackup, layerSizesNow,
  writeBackupLayers, writeBackupScheduleLayers, writeBackupSchedule,
} from './cli-backup'
import { BACKUP_LAYERS, omittedSecrets, type BackupLayer } from './backup/backup-plan'
import { formatBytes, layerTotal, retainedTotal } from './backup/backup-size'
import { githubFitVerdict, type GithubFitVerdict } from './backup/backup-github'
import { lastBackup, lastPerHarness, lastRun, loadBackupHistory, type BackupPresence } from './backup/backup-store'
import { SCHEDULE_IDS, scheduleStatus, type ScheduleId } from './backup/schedule'
import { loadConsolidated } from './consolidate'

export interface BackupHarnessJson {
  id: HarnessId
  enabled: boolean
  sessions: number
  sizeLabel: string
  /** ISO — see `ControlBackupHarness.lastBackupAt` for why this is an instant. */
  lastBackupAt?: string
  /** A backup once covered this harness and that file is gone — see `backup-store.ts`'s
   *  `markPresence`. Never rendered as a reassuring date. */
  lastBackupGone?: boolean
}

export interface BackupHistoryJson {
  at: string
  layers: string[]
  harnesses: HarnessId[]
  bytesLabel: string
  /** How many paths the walk skipped — `undefined` reads as "not known", never as zero. */
  skipped?: number
  /** `present` / `pruned` / `missing` — see `backup-store.ts`'s `markPresence`. Computed here,
   *  never re-derived by the client: a `missing` file and one that was `pruned` on purpose, by
   *  retention, look identical from the outside (both are simply "not on disk"), and only the
   *  server, holding the prune events, can tell them apart. */
  presence: BackupPresence
}

export interface BackupStatusJson {
  /** One row per `HARNESS_ORDER` member — never a literal list. */
  harnesses: BackupHarnessJson[]
  config: {
    layers: BackupLayer[]
    /** Layers a SCHEDULED run writes — see `cli-backup.ts`'s `BackupPrefs.scheduleLayers`.
     *  Deliberately separate from `layers`: a schedule that inherited a manual run's layers would
     *  fill a disk the first time `raw` was added to one run. */
    scheduleLayers: BackupLayer[]
    destDir: string
    schedule: string
    /** False while the server is stopped — see `schedule.ts`'s `inactive-no-server`. The row
     *  must say so rather than a "next at…" that will not arrive. */
    scheduleActive: boolean
    /** Hours between runs when `schedule` is `'custom'`; null when it has never been set. */
    customHours: number | null
    keep: number
    /** What EVERY retained backup occupies together, already formatted. */
    retainedLabel: string
    secretsCount: number
    last?: { at: string; bytesLabel: string; skipped?: number }
    /**
     * Every layer's measured weight on this machine, already formatted — see `cli-backup.ts`'s
     * `measuredLayerSizes`. `repos` is `null`: it is produced during a run, not measurable ahead of
     * one, and the format picker renders that as "known after running" rather than a guessed number.
     */
    layerSizes: Record<BackupLayer, string | null>
    /**
     * Whether the layers ticked for a MANUAL run would fit a single GitHub Release asset (2 GB
     * per file), reasoned only from the measured uncompressed total — see `backup-github.ts`.
     * Recomputed on every read, so it changes the moment a checkbox's round trip lands.
     */
    githubFit: GithubFitVerdict
    /** The same verdict for the SCHEDULED run's own layer set. */
    scheduleGithubFit: GithubFitVerdict
    /** This machine's history-preservation mode, when chosen — see `preferences.ts`'s
     *  `resolveArchiveMode`. Absent reads the same as anything other than `'full'`: the `archive`
     *  layer is frozen either way. */
    archiveMode?: ArchiveMode
  }
  /** Newest first. */
  history: BackupHistoryJson[]
}

/** Everything a format/recurrence picker may change in one call. All fields optional — a picker
 *  sends only what it changed, `updateBackupConfig` normalizes and writes it. */
export interface BackupConfigPatch {
  layers?: BackupLayer[]
  scheduleLayers?: BackupLayer[]
  schedule?: ScheduleId
  /** Hours between runs, when `schedule` is `'custom'`. */
  customHours?: number
}

/**
 * The whole tab's worth of facts, in one read — the same shape `cli-start.ts`'s `backupStatus`
 * builds for the cockpit, plus the history list the design's web surface also shows.
 */
export async function readBackupStatus(): Promise<BackupStatusJson> {
  const p = await readPreferences()
  const prefs = readBackupPrefs(p)
  const [measured, consolidated, entries] = await Promise.all([
    Promise.resolve(layerSizesNow()),
    loadConsolidated().catch(() => new Map()),
    loadBackupHistory().catch(() => []),
  ])

  const sessionCounts: Partial<Record<HarnessId, number>> = {}
  for (const sess of consolidated.values()) {
    const h = (sess.harness ?? 'claude') as HarnessId
    sessionCounts[h] = (sessionCounts[h] ?? 0) + 1
  }
  const byHarness = measured?.sizes.metrics.byHarness ?? {}
  const emptyLayerLabels: Record<BackupLayer, string | null> = { metrics: null, repos: null, archive: null, raw: null }
  const layerSizes = measured?.labels ?? emptyLayerLabels
  // The same measurement, in raw bytes — see `BackupStatusJson.config.layerBytes`.
  const layerBytes: Record<BackupLayer, number | null> = measured
    ? {
        metrics: layerTotal(measured.sizes, 'metrics'),
        repos: null,
        archive: layerTotal(measured.sizes, 'archive'),
        raw: layerTotal(measured.sizes, 'raw'),
      }
    : { metrics: null, repos: null, archive: null, raw: null }
  const archiveMode = resolveArchiveMode(p)
  const perHarnessLast = lastPerHarness(entries)

  const harnesses: BackupHarnessJson[] = HARNESS_ORDER.map(id => {
    const at = perHarnessLast[id]
    // A recorded backup once covered this harness and its file is gone — checked only when there
    // is no PRESENT one, same rule `cli-start.ts` follows.
    const gone = !at && entries.some(e => e.harnesses.includes(id))
    return {
      id,
      enabled: prefs.harnesses.includes(id),
      sessions: sessionCounts[id] ?? 0,
      sizeLabel: formatBytes(byHarness[id] ?? 0),
      ...(at ? { lastBackupAt: at } : {}),
      ...(gone ? { lastBackupGone: true } : {}),
    }
  })

  // What you can RESTORE from — files still on disk. Unchanged, and deliberately not `lastRun`:
  // this is the card that says you are covered, and a timestamp pointing at a file that is gone is
  // the difference between knowing you are unprotected and believing you are not.
  const last = lastBackup(entries)
  // The SCHEDULE's question is "when did one last run", which a pruned file still answers — see
  // `lastRun`. Reading `lastBackup` here made "next run" say `now` forever on any machine that
  // uploads to GitHub and deletes the local copy.
  const lastAt = lastRun(entries)?.at ?? null
  const st = scheduleStatus({
    schedule: prefs.schedule,
    customHours: prefs.customHours,
    lastAt,
    nowMs: Date.now(),
    serverRunning: existsSync(join(AGENTISTICS_DATA_DIR, 'events-producer.json')),
  })

  return {
    harnesses,
    config: {
      layers: prefs.layers,
      scheduleLayers: prefs.scheduleLayers,
      destDir: prefs.destDir,
      schedule: prefs.schedule,
      // Sent even when the schedule is not `custom`, so switching to it in the interface shows the
      // number the user last chose rather than an empty field.
      customHours: prefs.customHours ?? null,
      scheduleActive: st.kind === 'next',
      keep: prefs.keep,
      retainedLabel: formatBytes(retainedTotal(entries.filter(e => e.present))),
      secretsCount: omittedSecrets().length,
      layerSizes,
      githubFit: githubFitVerdict(prefs.layers, layerBytes),
      scheduleGithubFit: githubFitVerdict(prefs.scheduleLayers, layerBytes),
      ...(archiveMode ? { archiveMode } : {}),
      ...(last
        ? { last: { at: last.at, bytesLabel: formatBytes(last.archiveBytes), skipped: last.skipped } }
        : {}),
    },
    history: entries.map(e => ({
      at: e.at,
      layers: e.layers,
      harnesses: e.harnesses,
      bytesLabel: formatBytes(e.archiveBytes),
      skipped: e.skipped,
      presence: e.presence,
    })),
  }
}

/**
 * Run a backup now, with the configured layers and harnesses — the web's "Run backup now" button.
 * Calls `performBackup`, the ONE implementation `agentop backup` and the cockpit's `b` key both
 * call; this route decides nothing about what a backup carries.
 *
 * Unlike the cockpit, the web has no streaming detail pane to draw progress into, so the log lines
 * are simply discarded — the caller learns the outcome, not the play-by-play, exactly like
 * `agentop backup` run without a terminal attached would.
 */
export async function runBackupNow(): Promise<
  { ok: true; bytesLabel: string; skipped?: number } | { ok: false; reason: string }
> {
  const prefs = readBackupPrefs(await readPreferences())
  const result = await performBackup(
    prefs,
    { layers: prefs.layers, harnesses: prefs.harnesses, destDir: prefs.destDir },
    () => {},
  )
  return result.ok
    ? { ok: true, bytesLabel: formatBytes(result.record.archiveBytes), skipped: result.record.skipped }
    : { ok: false, reason: result.reason }
}

/**
 * The web's format/recurrence pickers — `POST /api/backup/config`. Validates each field it was
 * given (a picker sends only what changed), writes it through the same three functions
 * `agentop backup config` and the cockpit's layer editor call, and hands back a fresh
 * `readBackupStatus()` so the picker's own state and the server's never drift apart for the one
 * round trip it takes to press a checkbox.
 *
 * `metrics` cannot be removed from either layer set — `writeBackupLayers` /
 * `writeBackupScheduleLayers` enforce that (`backup-plan.ts`'s `withMetrics`), so a request that
 * tried to drop it is normalized rather than rejected: the picker's own metrics row is
 * non-interactive, so the only way this happens is a stale or hand-crafted request.
 */
export async function updateBackupConfig(
  patch: BackupConfigPatch,
): Promise<{ ok: true; status: BackupStatusJson } | { ok: false; reason: string }> {
  if (patch.layers) {
    const bad = patch.layers.filter(l => !BACKUP_LAYERS.includes(l))
    if (bad.length) return { ok: false, reason: `unknown layer: ${bad.join(', ')}` }
    await writeBackupLayers(patch.layers)
  }
  if (patch.scheduleLayers) {
    const bad = patch.scheduleLayers.filter(l => !BACKUP_LAYERS.includes(l))
    if (bad.length) return { ok: false, reason: `unknown layer: ${bad.join(', ')}` }
    await writeBackupScheduleLayers(patch.scheduleLayers)
  }
  if (patch.schedule) {
    if (!SCHEDULE_IDS.includes(patch.schedule)) return { ok: false, reason: `unknown schedule: ${patch.schedule}` }
    // The number is validated for SHAPE here and clamped by `intervalMs` — the one place that
    // decides both, so a hand-edited preferences file cannot get past a check that lives in a route.
    if (patch.customHours !== undefined
      && (!Number.isFinite(patch.customHours) || patch.customHours <= 0)) {
      return { ok: false, reason: 'custom schedule takes a positive number of hours' }
    }
    await writeBackupSchedule(patch.schedule, patch.customHours)
  }
  return { ok: true, status: await readBackupStatus() }
}

/* ── GitHub versioning, as Settings → Backup and the cockpit see it ──────────────────────────── */

/**
 * What a ROUTE may say about the GitHub configuration.
 *
 * There is no `token` field and there must never be one. `toStatus` in `github-store.ts` makes the
 * same promise for its own shape; this one adds the fields the settings screen needs to render its
 * controls, and `backup-routes.test.ts` asserts the absence over the whole serialized value rather
 * than field by field — a field added later that happened to carry the token would pass a
 * key-by-key check.
 */
export type GithubSection =
  | {
    configured: false
    /**
     * Whether this machine can authenticate through the GitHub CLI it already has — so the form can
     * OFFER that instead of asking for a token, which is the better answer when it is available:
     * nothing is stored at all.
     *
     * Two refusal reasons, not one: "install gh" and "run `gh auth login`" are different
     * instructions and one sentence covering both would be right for neither.
     */
    gh: { usable: true; account: string } | { usable: false; reason: 'not-installed' | 'logged-out' }
  }
  | {
    configured: true
    url: string
    /** `owner/repo`, for display. */
    repo: string
    /** What this machine is called in its release tags — see `releaseTag`. */
    label: string
    /** How many of THIS machine's releases to keep. 0 = keep them all. */
    keepRemote: number
    deleteLocalAfterUpload: boolean
    /** Which credential this machine uses. `'gh'` means NOTHING is stored here. */
    auth: 'token' | 'gh'
    /**
     * A better name for this machine than the one stored, or null.
     *
     * Non-null only when the stored label is the hostname (a default nobody typed) AND a central
     * holds a real name for the same machine. Offered, never applied: the label rides in the
     * release tag, so switching it splits this machine's history in two. See `suggestedLabel`.
     */
    suggestedLabel: string | null
  }

export async function readGithubSection(file?: string): Promise<GithubSection> {
  const { readGithubConfig } = await import('./backup/github-store')
  const config = await readGithubConfig(file)
  if (!config) {
    const { describeGhAuth, probeGh } = await import('./backup/github-cli')
    // Probed only on the UNCONFIGURED path: it spawns a process and makes a network call, and a
    // configured machine has no question left for it to answer.
    return { configured: false, gh: describeGhAuth(await probeGh()) }
  }
  return {
    configured: true,
    url: config.url,
    repo: `${config.owner}/${config.repo}`,
    label: config.label ?? hostname(),
    keepRemote: config.keepRemote,
    deleteLocalAfterUpload: config.deleteLocalAfterUpload,
    auth: config.auth ?? 'token',
    suggestedLabel: await labelSuggestion(config.label ?? hostname()),
  }
}

/** The offer, or null. A preferences read that fails offers nothing — a suggestion is a
 *  convenience and must never be a reason a settings page cannot load. */
async function labelSuggestion(stored: string): Promise<string | null> {
  try {
    const { readPreferences } = await import('./preferences')
    const { defaultMachineLabel, suggestedLabel } = await import('./backup/machine-label')
    const prefs = await readPreferences() as { team?: { connections?: { id: string; machineName?: string }[] } }
    const fromCentral = defaultMachineLabel('', prefs.team?.connections ?? [])
    return suggestedLabel(stored, hostname(), fromCentral || null)
  } catch {
    return null
  }
}

export interface GithubSectionUpdate {
  label?: string
  keepRemote?: number
  deleteLocalAfterUpload?: boolean
}

/**
 * Change the settings a person can change WITHOUT re-entering the token.
 *
 * Renaming a machine or changing retention must not ask for a PAT again: a flow that demands a
 * credential to perform something unrelated to it is a flow that teaches people to paste
 * credentials. Setting the repository up (which genuinely needs a token, and verifies it) stays
 * with `setupGithubBackup`.
 *
 * An unconfigured machine is REFUSED rather than having a config invented for it — a config with a
 * label and no repository or token is one every later step would fail on, further from the cause.
 */
export async function updateGithubSection(
  update: GithubSectionUpdate, file?: string,
): Promise<{ ok: true; section: GithubSection } | { ok: false; reason: string }> {
  const { readGithubConfig, writeGithubConfig } = await import('./backup/github-store')
  const config = await readGithubConfig(file)
  if (!config) return { ok: false, reason: 'not_configured' }

  if (update.keepRemote !== undefined
    && (!Number.isInteger(update.keepRemote) || update.keepRemote < 0)) {
    return { ok: false, reason: 'bad_keep_remote' }
  }
  const label = update.label?.trim()
  if (update.label !== undefined && !label) return { ok: false, reason: 'bad_label' }

  await writeGithubConfig({
    ...config,
    label: label ?? config.label,
    keepRemote: update.keepRemote ?? config.keepRemote,
    deleteLocalAfterUpload: update.deleteLocalAfterUpload ?? config.deleteLocalAfterUpload,
  }, file)
  return { ok: true, section: await readGithubSection(file) }
}

export interface ConnectGithubInput {
  url: string
  /** A GitHub PAT. Written to the 0600 config and NEVER echoed back — see the return type. */
  token: string
  /** `'gh'` uses the GitHub CLI already on this machine and stores nothing. */
  auth?: 'token' | 'gh'
  /** Test-only: stands in for `gh auth token`. */
  askGh?: () => Promise<import('./backup/github-cli').GhTokenResult>
  /** Test-only injection points, mirroring `setupGithubBackup`'s own. */
  file?: string
  fetchImpl?: import('./backup/github-api').FetchLike
}

/**
 * Connect a private GitHub repository from the INTERFACE — the form behind Settings → Backup and
 * the same five checks `agentop backup github setup` performs, because it is the same function.
 *
 * This lives on a route rather than only in the CLI because the interface is where the user asked
 * for it, and the objection that kept it out — a token box on a page someone else could reach —
 * is already answered by the guard that was there all along: `/api/backup` requires `localShell`,
 * which is FALSE on the `public` profile and opt-in on `lan`. On a dashboard anyone else can open,
 * this route does not exist. Restating that gate here would be a second copy of a rule that is
 * already enforced in one place.
 *
 * The reply is the ordinary `GithubSection` — no token, not even the one just accepted — so a page
 * rendering the result has nothing extra to hold or leak.
 */
export async function connectGithub(
  input: ConnectGithubInput,
): Promise<{ ok: true; section: GithubSection } | { ok: false; reason: string }> {
  if (!input.url.trim()) return { ok: false, reason: 'a repository URL is required.' }

  // WHERE the credential for the four checks comes from. In `gh` mode there is no token field on
  // the form at all, so requiring one here refused the very mode that exists to avoid asking —
  // which is exactly how this shipped, and what the screen said was "a GitHub personal access
  // token is required".
  //
  // An empty token is still refused in `token` mode, and worth refusing: `setupGithubBackup` would
  // ask GitHub about the repository with no credential and get a 404 for a private one, which
  // reads as "not found" and sends the user to check a URL that was right.
  let token = input.token.trim()
  if (input.auth === 'gh') {
    const { resolveGithubAuth } = await import('./backup/github-cli')
    const r = await resolveGithubAuth({ auth: 'gh', token: '' }, input.askGh)
    if (!r.ok) return { ok: false, reason: r.reason }
    token = r.token
  } else if (!token) {
    return { ok: false, reason: 'a GitHub personal access token is required.' }
  }

  const { setupGithubBackup } = await import('./backup/github-setup')
  const result = await setupGithubBackup({
    url: input.url.trim(),
    token,
    auth: input.auth,
    file: input.file,
    fetchImpl: input.fetchImpl,
  })
  if (!result.ok) return { ok: false, reason: result.message }
  return { ok: true, section: await readGithubSection(input.file) }
}

/* ── Restoring, from the interface ───────────────────────────────────────────────────────────── */

/**
 * The ONE restore in flight, if any.
 *
 * A single slot rather than a map: two restores at once would write the same `$HOME` from two
 * directions, and the second would be reading files the first is still replacing. A second request
 * while one runs is REFUSED and told which one is running, rather than queued behind it — a restore
 * is not something to start by accident twice.
 */
let currentRestore: import('./backup/restore-routes').RestoreJob | null = null

export function readRestoreJob(): import('./backup/restore-routes').RestoreJob | null {
  return currentRestore
}

/**
 * Download a release and restore it. Returns as soon as the job EXISTS — the work continues in the
 * background and the interface follows it through `readRestoreJob`.
 */
export async function startRestore(
  input: { url: string; tag: string; token?: string; withRepos: boolean },
): Promise<{ ok: true; job: import('./backup/restore-routes').RestoreJob } | { ok: false; reason: string }> {
  const rr = await import('./backup/restore-routes')

  if (currentRestore && (currentRestore.state === 'queued' || currentRestore.state === 'running')) {
    return { ok: false, reason: `a restore is already running (${currentRestore.tag}).` }
  }

  const cred = await rr.restoreCredential({ token: input.token })
  if (!cred.ok) return { ok: false, reason: cred.reason }

  const { parseRepoUrl } = await import('./backup/github-api')
  const parsed = parseRepoUrl(input.url)
  if (!parsed) return { ok: false, reason: `"${input.url}" is not a github.com repository URL.` }

  const job = rr.newRestoreJob({ tag: input.tag, withRepos: input.withRepos })
  currentRestore = job
  job.state = 'running'

  // Deliberately NOT awaited. See `RestoreJob`: the repos phase clones every repository the backup
  // mapped and holding a request open for that times out in a proxy, in the browser, or both.
  void runRestoreJob(job, { ...input, owner: parsed.owner, repo: parsed.repo, token: cred.token })

  return { ok: true, job }
}

async function runRestoreJob(
  job: import('./backup/restore-routes').RestoreJob,
  input: { owner: string; repo: string; tag: string; token: string; withRepos: boolean },
): Promise<void> {
  const rr = await import('./backup/restore-routes')
  const log = (l: string): void => { rr.restoreJobLine(job, l) }
  try {
    const { downloadBackupRelease } = await import('./backup/github-restore')
    const dl = await downloadBackupRelease(input.owner, input.repo, input.token, input.tag, {
      onLine: log,
      // No question is asked here: the person already chose this release from a list that showed
      // its date, size, layers and session count. A second confirmation with nobody at the terminal
      // would simply hang.
      confirmDownload: async () => true,
    })
    if (dl.status !== 'downloaded') {
      rr.finishRestoreJob(job, {
        ok: false,
        reason: dl.status === 'cancelled' ? 'the download was cancelled' : dl.reason,
      })
      return
    }

    const { restoreMetrics, restoreRepos, readManifestOf } = await import('./backup/restore')
    const metrics = await restoreMetrics({ archive: dl.archivePath, homeDir: HOME_DIR, onLine: log })
    if (!metrics.ok) {
      rr.finishRestoreJob(job, { ok: false, reason: metrics.reason })
      return
    }

    if (!input.withRepos) {
      rr.finishRestoreJob(job, { ok: true, written: metrics.written, skipped: metrics.skipped })
      return
    }

    const decoded = await readManifestOf(dl.archivePath)
    if (!decoded.ok) {
      // The metrics ARE restored at this point. Reporting a plain failure would tell the user
      // nothing came back, when in fact everything except the repositories did.
      rr.finishRestoreJob(job, {
        ok: false,
        reason: `metrics were restored (${metrics.written} files); the repository plan could not be `
          + `read, so no repository was cloned (${decoded.reason})`,
      })
      return
    }
    const repos = await restoreRepos({
      manifest: decoded.manifest, archive: dl.archivePath, homeDir: HOME_DIR, onLine: log,
    })
    log(`repositories: ${repos.succeeded}/${repos.attempted} restored`)
    rr.finishRestoreJob(job, { ok: true, written: metrics.written, skipped: metrics.skipped })
  } catch (e) {
    rr.finishRestoreJob(job, { ok: false, reason: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * Forget the repository this machine versions to.
 *
 * Deletes only the LOCAL configuration. The releases already on GitHub are NOT touched, and saying
 * so is the whole reason this is not called "delete": a person pressing it wants to stop sending
 * from this machine, not to destroy the copies that are the point of having sent them. Reconnecting
 * the same repository later finds them, and the "already uploaded?" check recognises them.
 *
 * Idempotent: a machine with no config is already disconnected, and reporting that as a failure
 * would send somebody looking for a problem that is not there.
 */
export async function disconnectGithub(
  file?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { GITHUB_BACKUP_CONFIG_FILE } = await import('./backup/github-store')
  const { rm } = await import('fs/promises')
  try {
    await rm(file ?? GITHUB_BACKUP_CONFIG_FILE, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
