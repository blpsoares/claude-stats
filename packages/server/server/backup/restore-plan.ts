/**
 * restore-plan.ts — PURE. What a restore would do, decided before anything is written.
 *
 * The whole point of computing this separately is that `agentop restore` can PRINT it. A restore
 * that starts working and reports afterwards gives the user no moment at which to say no.
 *
 * Four rules:
 *
 *  1. **A merge never overwrites something newer.** The same discipline `writeConsolidated`
 *     already applies. A machine that has been running for a week before someone remembers to
 *     restore must not lose that week.
 *  2. **`stats-cache.json` is never written over Claude's own.** Claude owns that file and rewrites
 *     it; ours is redirected into `ARCHIVE_STATS_DIR`, where `applyArchivedStats` already reads it
 *     with per-field `max`, never additive. An existing rule reused rather than a new one invented.
 *  3. **A destination that exists is skipped WITH A REASON.** Cloning over someone's work is the
 *     one failure a backup tool must never have.
 *  4. **The resume is by repo key, and only `done` and `skipped` stop a retry.** A `failed` repo is
 *     attempted again on the next run — that is what makes `agentop restore --repos` safe to run
 *     until it converges.
 */
import { expandHome, restoreArgv, restoreCommands, type RepoEntry, type RepoNote, type RestoreStep } from './repo-manifest'

/** Where a restored `stats-cache.json` actually lands. Mirrors `ARCHIVE_STATS_DIR` in config.ts;
 *  this module stays pure, so the path is expressed $HOME-relative here. */
export const STATS_REDIRECT = '.agentistics/archive/stats-cache/stats-cache.json'

/** `preferences.json`'s $HOME-relative path. It gets its own `RestoreAction` kind (`merge`) rather
 *  than the ordinary newer-wins rule — see `mergePreferences` below. */
export const PREFERENCES_REL = '.agentistics/preferences.json'

export interface StagedFile {
  rel: string
  mtimeMs: number
}

export type RestoreAction =
  | { kind: 'write'; rel: string; redirectTo?: string }
  | { kind: 'skip'; rel: string; reason: 'newer-local' }
  /** `preferences.json` only — see `mergePreferences`. */
  | { kind: 'merge'; rel: string }

/**
 * Which staged files to write. `localMtime` maps a $HOME-relative path to the local file's mtime;
 * an absent key means the machine does not have it.
 */
export function planMetrics(staged: StagedFile[], localMtime: Map<string, number>): RestoreAction[] {
  return staged.map<RestoreAction>(f => {
    if (f.rel === '.claude/stats-cache.json') {
      return { kind: 'write', rel: f.rel, redirectTo: STATS_REDIRECT }
    }
    // `preferences.json` is the one file the tool writes for ITSELF. On the realistic flow —
    // reformat, install, run setup, THEN restore — the local copy is minutes old, so newer-wins
    // would drop it every time, taking the billing timeline and the custom layouts Wave B went to
    // the trouble of carrying redacted along with it. It always merges instead, whichever side is
    // newer.
    if (f.rel === PREFERENCES_REL) {
      return { kind: 'merge', rel: f.rel }
    }
    const local = localMtime.get(f.rel)
    if (local !== undefined && local > f.mtimeMs) {
      return { kind: 'skip', rel: f.rel, reason: 'newer-local' }
    }
    return { kind: 'write', rel: f.rel }
  })
}

export interface PreferencesMerge {
  text: string
  /** Top-level keys the local file did not have, taken from the backup. For the report. */
  tookFromBackup: string[]
}

function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Union `preferences.json`: local keys win, keys the local file does not have are taken from the
 * backup.
 *
 * Newer-wins — the rule for every other staged file — is wrong here specifically. It is right when
 * two copies of the SAME kind of document might each hold updates the other lacks (a session
 * document, say); `preferences.json` is different because the tool overwrites it on every boot, so
 * on the realistic restore flow the local copy is ALWAYS newer and newer-wins would ALWAYS discard
 * the backup's copy — never a rare case, always the outcome. Union means nothing local is
 * overwritten and nothing the backup carried is silently lost.
 *
 * `team` is never merged, in either direction. Its tokens were stripped before the file traveled
 * (`stageRedactedFiles`), and a half-`team` block landing on an already-configured machine — or
 * overwriting a teamless one with a stub that still can't authenticate — is worse than leaving the
 * local file's own team state exactly as it is.
 */
export function mergePreferences(localText: string, archivedText: string): PreferencesMerge {
  const archived = safeParseObject(archivedText)
  if (!archived) return { text: localText, tookFromBackup: [] }

  const local = safeParseObject(localText)
  if (!local) {
    // Nothing local worth preserving — an unparseable local file cannot be merged INTO, so the
    // archived copy replaces it wholesale, still minus `team`.
    const { team: _team, ...rest } = archived
    return { text: JSON.stringify(rest, null, 2), tookFromBackup: Object.keys(rest) }
  }

  const tookFromBackup: string[] = []
  const merged: Record<string, unknown> = { ...local }
  for (const key of Object.keys(archived)) {
    if (key === 'team') continue
    if (!(key in local)) {
      merged[key] = archived[key]
      tookFromBackup.push(key)
    }
  }
  return { text: JSON.stringify(merged, null, 2), tookFromBackup }
}

export type RepoStepState = 'pending' | 'done' | 'skipped' | 'half-restored'

export interface RepoStep {
  key: string
  mainPath: string
  state: RepoStepState
  /** Why it is skipped, or why it was not attempted. */
  reason?: RepoNote | 'destination-exists' | 'skipped-earlier' | 'half-restored'
  /** The reason recorded by a previous failed attempt, so the report can say what went wrong. */
  previousFailure?: string
  /** What RUNS — structured argv, never joined. Some steps are `optional` — see `RestoreStep`. */
  argv: RestoreStep[]
  /** What PRINTS — the same plan, joined. */
  commands: string[]
}

export interface RestoreState {
  repos: Record<string, { state: 'done' | 'failed' | 'skipped'; reason?: string }>
}

export function emptyRestoreState(): RestoreState {
  return { repos: {} }
}

export function planRepos(
  entries: RepoEntry[],
  state: RestoreState,
  destExists: (absPath: string) => boolean,
  homeDir: string,
  /** Where the archive was extracted. Empty while PRINTING a plan (nothing is extracted yet). */
  assetDir = '',
): RepoStep[] {
  return entries.map<RepoStep>(e => {
    const base = { key: e.key, mainPath: e.mainPath }
    const prior = state.repos[e.key]

    if (prior?.state === 'done') return { ...base, state: 'done', argv: [], commands: [] }
    if (prior?.state === 'skipped') {
      // A repo skipped on an earlier run stays skipped, but the REASON may no longer apply (it was
      // `gone` and the directory is back). Say which it is rather than printing `undefined`.
      return {
        ...base,
        state: 'skipped',
        reason: e.note ?? 'skipped-earlier',
        argv: [],
        commands: [],
      }
    }

    // `too-large` is a real, cloneable repository; every other note means there is nothing to clone.
    if (e.note && e.note !== 'too-large') {
      return { ...base, state: 'skipped', reason: e.note, argv: [], commands: [] }
    }

    // A repo that failed after its clone leaves the destination behind. Checking `destExists` first
    // — as this did — turns every such repo into a permanent silent skip, which is worse than the
    // failure: the CLI tells the user to re-run, the re-run does nothing, and it exits 0.
    if (prior?.state === 'failed' && destExists(expandHome(e.mainPath, homeDir))) {
      return {
        ...base,
        state: 'half-restored',
        reason: 'half-restored',
        previousFailure: prior.reason ?? 'unknown',
        argv: [], commands: [],
      }
    }

    if (destExists(expandHome(e.mainPath, homeDir))) {
      return { ...base, state: 'skipped', reason: 'destination-exists', argv: [], commands: [] }
    }

    return {
      ...base,
      state: 'pending',
      previousFailure: prior?.state === 'failed' ? (prior.reason ?? 'unknown') : undefined,
      argv: restoreArgv(e, homeDir, assetDir),
      commands: restoreCommands(e, homeDir),   // printed form stays archive-relative
    }
  })
}

/** The steps a run would actually attempt. */
export function remaining(steps: RepoStep[]): RepoStep[] {
  return steps.filter(s => s.state === 'pending')
}

/**
 * Rewrite an old $HOME prefix to the new one inside a restored JSON document.
 *
 * A no-op when they are equal. The boundary check matters: a bare replace of `/home/old` also hits
 * `/home/older`, corrupting every path belonging to an unrelated user whose name starts the same
 * way. Only a path separator, a quote, or the end of the string may follow.
 */
export function rewriteHome(text: string, oldHome: string, newHome: string): string {
  if (oldHome === newHome || !oldHome) return text
  const escaped = oldHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`${escaped}(?=["/\\\\]|$)`, 'g'), newHome)
}
