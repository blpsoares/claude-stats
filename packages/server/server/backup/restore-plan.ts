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
import { expandHome, restoreArgv, restoreCommands, type RepoEntry, type RepoNote } from './repo-manifest'

/** Where a restored `stats-cache.json` actually lands. Mirrors `ARCHIVE_STATS_DIR` in config.ts;
 *  this module stays pure, so the path is expressed $HOME-relative here. */
export const STATS_REDIRECT = '.agentistics/archive/stats-cache/stats-cache.json'

export interface StagedFile {
  rel: string
  mtimeMs: number
}

export type RestoreAction =
  | { kind: 'write'; rel: string; redirectTo?: string }
  | { kind: 'skip'; rel: string; reason: 'newer-local' }

/**
 * Which staged files to write. `localMtime` maps a $HOME-relative path to the local file's mtime;
 * an absent key means the machine does not have it.
 */
export function planMetrics(staged: StagedFile[], localMtime: Map<string, number>): RestoreAction[] {
  return staged.map<RestoreAction>(f => {
    if (f.rel === '.claude/stats-cache.json') {
      return { kind: 'write', rel: f.rel, redirectTo: STATS_REDIRECT }
    }
    const local = localMtime.get(f.rel)
    if (local !== undefined && local > f.mtimeMs) {
      return { kind: 'skip', rel: f.rel, reason: 'newer-local' }
    }
    return { kind: 'write', rel: f.rel }
  })
}

export type RepoStepState = 'pending' | 'done' | 'skipped'

export interface RepoStep {
  key: string
  mainPath: string
  state: RepoStepState
  /** Why it is skipped, or why it was not attempted. */
  reason?: RepoNote | 'destination-exists'
  /** The reason recorded by a previous failed attempt, so the report can say what went wrong. */
  previousFailure?: string
  /** What RUNS — structured argv, never joined. */
  argv: string[][]
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
      return { ...base, state: 'skipped', reason: e.note ?? undefined, argv: [], commands: [] }
    }

    // `too-large` is a real, cloneable repository; every other note means there is nothing to clone.
    if (e.note && e.note !== 'too-large') {
      return { ...base, state: 'skipped', reason: e.note, argv: [], commands: [] }
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
