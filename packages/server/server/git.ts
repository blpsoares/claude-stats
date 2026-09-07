import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { ProjectGitStats } from '@agentistics/core'
import { openGitStatsCache, NOOP_GIT_STATS_CACHE, type GitStatsCache } from './git-stats-cache'
import { GIT_STATS_CACHE_FILE } from './config'
import { normalizeGitRemote } from '@agentistics/core'

const execFileAsync = promisify(execFile)

/** Run git WITHOUT a shell.
 *
 *  Two defects came from going through `/bin/sh -c`. A timeout kills the process `exec` started —
 *  the SHELL — and the `git` underneath it survives, orphaned, still holding its hundreds of
 *  megabytes: that is why processes outlived the server that spawned them and had to be reaped by
 *  hand. And every argument was interpolated into a command string, so a repository path
 *  containing a quote was a broken command at best.
 *
 *  `execFile` makes git the direct child, so the timeout lands on the process actually doing the
 *  work, and arguments are passed as a vector — no quoting, no shell. */
async function git(
  repoPath: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number }
): Promise<string> {
  // On Windows a POSIX path is a WSL path and git must be reached through `wsl`.
  const useWsl = process.platform === 'win32' && repoPath.startsWith('/')
  const file = useWsl ? 'wsl' : 'git'
  const argv = useWsl ? ['git', '-C', repoPath, ...args] : ['-C', repoPath, ...args]
  const { stdout } = await execFileAsync(file, argv, { ...opts, env: gitEnv() })
  return stdout
}

// UUID regex: 8-4-4-4-12 hex groups
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Decode a Claude project directory name back to a filesystem path. */
export function decodeProjectDir(dirName: string): string {
  // Claude encodes absolute paths by replacing every '/' with '-'
  // The leading '-' corresponds to the leading '/' of an absolute path
  if (dirName.startsWith('-')) {
    return dirName.replace(/-/g, '/')
  }
  // Relative or unknown — just return as-is prefixed with /
  return '/' + dirName.replace(/-/g, '/')
}

/** Cost guards for repository statistics.
 *
 *  `git log --numstat` computes a diff for EVERY commit it walks. Measured on a 363-commit repo
 *  with a 287MB pack under WSL2: 18.5s and 478MB RSS for ONE call. Three things then turned that
 *  cost into a permanent storm:
 *
 *   - a 10s timeout on an 18s walk meant the call was killed every single time, so the work was
 *     never merely expensive, it was expensive AND always discarded;
 *   - a killed walk returns `undefined`, which is also how "not a git repo" is reported, so the
 *     caller fell through to its workspace fallback and scanned the subdirectories — and
 *     `git -C <subdir>` resolves to the SAME repository, so one repo was walked once per
 *     subdirectory, with the `--since` window dropped on each;
 *   - nothing was memoized, so the 30s data cache re-ran all of it, forever.
 *
 *  Observed: ~9 concurrent `git log --numstat` processes at 100-300MB each, indefinitely, none of
 *  which could ever finish. The guards below make the walk finish, run once, and be remembered. */
const STATS_MAX_COMMITS = 500
/** Above the measured cost of a large repo, so the walk COMPLETES and its result can be cached.
 *  A timeout below the real cost is the worst of both worlds: full price, no result, every time. */
const STATS_TIMEOUT_MS = 45_000
/** `numstat` output is read into memory whole. 32MB is far above any real repo's walk and still
 *  bounded, where exec's default let a pathological repo grow the heap unchecked. */
const STATS_MAX_BUFFER = 32 * 1024 * 1024
/** Repository history does not change on the 30s cadence the data cache rebuilds on. */
const STATS_TTL_MS = 10 * 60_000
/** A single walk peaks near half a gigabyte. The callers' own limiter is 8-wide, which is a 4GB
 *  peak on a laptop; this cap is inside the module so no caller can exceed it by accident. */
const STATS_MAX_CONCURRENT = 2

/** Environment for every git call: no credential prompt, and no inherited repository.
 *
 *  `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` OVERRIDE `-C <path>`. The server is routinely
 *  started from inside a git context — a hook, a worktree command — and one inherited variable
 *  would silently point every one of these reads at a repository other than the one asked for. */
const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

export async function getGitFileStats(
  projectPath: string,
  afterIso: string,
  beforeIso: string
): Promise<{ linesAdded: number; linesRemoved: number; filesModified: number }> {
  const empty = { linesAdded: 0, linesRemoved: 0, filesModified: 0 }
  if (!projectPath || !afterIso || !beforeIso) return empty
  try {
    // add 1 minute buffer on each side so the commits made during the session are included
    const after = new Date(new Date(afterIso).getTime() - 60_000).toISOString()
    const before = new Date(new Date(beforeIso).getTime() + 60_000).toISOString()
    // Bounded like the repo walk: a session window is small, but `--numstat` output is read into
    // memory whole, and the default buffer is what makes a pathological repo unbounded.
    const stdout = await git(
      projectPath,
      ['log', '--numstat', `--after=${after}`, `--before=${before}`, '--format='],
      { timeout: 5000, maxBuffer: STATS_MAX_BUFFER }
    )
    let linesAdded = 0, linesRemoved = 0
    const filesSeen = new Set<string>()
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (m) {
        linesAdded += parseInt(m[1]!, 10)
        linesRemoved += parseInt(m[2]!, 10)
        filesSeen.add(m[3]!)
      }
    }
    return { linesAdded, linesRemoved, filesModified: filesSeen.size }
  } catch {
    return empty
  }
}

/**
 * Read a repo's `origin` remote URL and return it normalized (`host/org/repo`, no protocol),
 * or `undefined` when the path isn't a git repo or has no origin remote. Reuses the same
 * Windows/WSL split and no-prompt env guard as the stats helpers so a misconfigured
 * remote can never hang the scan. This is the local-machine source of the group-by-repo key.
 */
export async function getGitRemote(projectPath: string): Promise<string | undefined> {
  try {
    const stdout = await git(
      projectPath,
      ['config', '--get', 'remote.origin.url'],
      { timeout: 3000, maxBuffer: 1024 * 1024 }
    )
    const normalized = normalizeGitRemote(stdout.trim())
    return normalized || undefined
  } catch {
    return undefined
  }
}


/** Bounded queue for the expensive walks only. Cheap metadata reads do not pass through it. */
let statsRunning = 0
const statsQueue: (() => void)[] = []

async function withStatsSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (statsRunning >= STATS_MAX_CONCURRENT) {
    await new Promise<void>(resolve => statsQueue.push(resolve))
  }
  statsRunning++
  try {
    return await fn()
  } finally {
    statsRunning--
    statsQueue.shift()?.()
  }
}

/** The on-disk half of the memo, opened once and shared.
 *
 *  The in-process memo dies with the process, and on a real machine the server restarts
 *  constantly — an upgrade, a crash, a `dev:api` left running, a supervisor relaunching it. Every
 *  restart used to pay the full price again for numbers already computed. Rows are keyed on a
 *  COMMIT, so they can never be stale: they are facts about an immutable object, not guesses about
 *  the current state. */
let diskCache: GitStatsCache | null = null
let diskCacheOpening: Promise<GitStatsCache> | null = null

async function disk(): Promise<GitStatsCache> {
  if (diskCache) return diskCache
  if (!diskCacheOpening) {
    // Read the override at OPEN time, not at import time, so a caller (a test, a sandboxed run)
    // can point this at its own file rather than the user's real store.
    const file = process.env.AGENTISTICS_GIT_STATS_CACHE_FILE || GIT_STATS_CACHE_FILE
    diskCacheOpening = openGitStatsCache(file)
      .then(c => { diskCache = c; return c })
      .catch(() => NOOP_GIT_STATS_CACHE)
  }
  return diskCacheOpening
}

/** Drop rows not read since `cutoffMs`. Called by the build that owns the cadence. */
export async function gcGitStatsCache(cutoffMs: number): Promise<number> {
  return (await disk()).gc(cutoffMs)
}

interface Memo<T> { at: number; value: T }
const toplevelMemo = new Map<string, Memo<string | undefined>>()
const statsMemo = new Map<string, Memo<ProjectGitStats | undefined>>()
const statsInflight = new Map<string, Promise<ProjectGitStats | undefined>>()

function memoRead<T>(memo: Map<string, Memo<T>>, key: string): { hit: true; value: T } | { hit: false } {
  const entry = memo.get(key)
  if (!entry || Date.now() - entry.at >= STATS_TTL_MS) return { hit: false }
  return { hit: true, value: entry.value }
}

/** Drop the IN-PROCESS memos. The disk rows are deliberately left: they are keyed on immutable
 *  commits, so there is nothing there to be wrong. Exported for tests and for a caller that knows
 *  the working trees moved under it; the TTL covers the ordinary case. */
export function clearGitStatsCache(): void {
  toplevelMemo.clear()
  statsMemo.clear()
  walkCount = 0
  // Also drop the open handle, so a caller that has just repointed the store gets the new one.
  try { diskCache?.close() } catch { /* already closed */ }
  diskCache = null
  diskCacheOpening = null
}

/** How many `--numstat` walks have actually been spent since the last cache clear.
 *
 *  The whole defect was doing this work repeatedly, so "how many times did it run" is the property
 *  worth pinning — a test that only checks the returned numbers passes just as happily on code that
 *  recomputes them thirty-four times. Reset by `clearGitStatsCache`. */
export function gitStatsWalkCount(): number {
  return walkCount
}
let walkCount = 0

/** `HEAD` for a path, as a commit SHA — the identity the stats memo is keyed on.
 *
 *  A `--numstat` walk is a pure function of (starting commit, window), so the SHA is the exact key.
 *  It buys two things the repository ROOT could not:
 *
 *   - worktrees collapse. A linked worktree has its OWN toplevel (`.worktrees/x` is not the parent
 *     repo), so keying on the root left 34 worktrees of one repository walking the shared history
 *     34 times. Every worktree parked on the same commit now shares one walk.
 *   - it self-invalidates. Commit, and the SHA changes, so the new numbers appear on the next read
 *     instead of waiting out the TTL — which is what makes a 10 minute TTL safe to have at all.
 *
 *  Not memoized: `rev-parse HEAD` costs ~0.02s, and memoizing it is precisely how the cache would
 *  go stale on the commit it must notice. */
async function resolveHead(repoPath: string): Promise<string | undefined> {
  try {
    const stdout = await git(repoPath, ['rev-parse', 'HEAD'], { timeout: 3000, maxBuffer: 1024 * 1024 })
    return stdout.trim() || undefined
  } catch {
    // No HEAD: an empty repository. Nothing to walk, and nothing to cache under a commit.
    return undefined
  }
}

/** The repository ROOT containing `projectPath`, or `undefined` when it is not inside a repo.
 *
 *  This does two jobs. It is the "is this a repo at all" probe that `rev-parse --git-dir` used to
 *  be — but it also gives the repo an IDENTITY: every subdirectory, and every path that reaches
 *  the same working tree, resolves to the same toplevel. That identity is what lets the memo below
 *  be shared and what lets the workspace fallback skip subdirectories of a repo it already walked.
 *  Memoized: a directory does not change which repository it belongs to. */
async function resolveToplevel(projectPath: string): Promise<string | undefined> {
  const cached = memoRead(toplevelMemo, projectPath)
  if (cached.hit) return cached.value
  let value: string | undefined
  try {
    const stdout = await git(projectPath, ['rev-parse', '--show-toplevel'], { timeout: 3000, maxBuffer: 1024 * 1024 })
    value = stdout.trim() || undefined
  } catch {
    value = undefined
  }
  toplevelMemo.set(projectPath, { at: Date.now(), value })
  return value
}

/** Commit count and first-commit date over the same window as the walk, WITHOUT `--numstat`.
 *
 *  Metadata-only log is ~300x cheaper than the same walk with diffs (measured: 0.06s vs 18.5s on
 *  the repo above). That is what makes `STATS_MAX_COMMITS` safe: when the cap truncates the diff
 *  walk, `commits` and `since` are still reported for the FULL window from here, and only the line
 *  and file totals are those of the newest `STATS_MAX_COMMITS` commits. */
async function countCommits(
  toplevel: string,
  sinceArgs: string[]
): Promise<{ commits: number; since: string } | undefined> {
  try {
    const stdout = await git(
      toplevel,
      ['log', '--format=%ai', ...sinceArgs, 'HEAD'],
      { timeout: 15_000, maxBuffer: STATS_MAX_BUFFER }
    )
    const dates = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    if (dates.length === 0) return undefined
    return { commits: dates.length, since: dates[dates.length - 1]! }
  } catch {
    return undefined
  }
}

/** The expensive half: walk `--numstat` and sum it. Bounded in commits, time and buffer. */
async function walkRepoStats(toplevel: string, sinceIso?: string): Promise<ProjectGitStats | undefined> {
  const sinceArgs = sinceIso ? [`--since=${sinceIso}`] : []
  const totals = await countCommits(toplevel, sinceArgs)
  // No commits in the window is a complete, cacheable answer — not a reason to look elsewhere.
  if (!totals) return undefined

  return withStatsSlot(async () => {
    walkCount++
    try {
      const stdout = await git(
        toplevel,
        ['log', '--numstat', '--format=COMMIT %H %ai', `--max-count=${STATS_MAX_COMMITS}`, ...sinceArgs, 'HEAD'],
        { timeout: STATS_TIMEOUT_MS, maxBuffer: STATS_MAX_BUFFER }
      )
      let linesAdded = 0, linesRemoved = 0
      const filesSeen = new Set<string>()
      for (const line of stdout.split('\n')) {
        if (line.startsWith('COMMIT ')) continue
        const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (m) {
          linesAdded += parseInt(m[1]!, 10)
          linesRemoved += parseInt(m[2]!, 10)
          filesSeen.add(m[3]!)
        }
      }
      return {
        commits: totals.commits,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        files_modified: filesSeen.size,
        since: totals.since,
      }
    } catch {
      // A walk that times out or fails still reports the commit count it got cheaply, rather than
      // returning `undefined` — which the caller cannot distinguish from "not a repository".
      return {
        commits: totals.commits,
        lines_added: 0,
        lines_removed: 0,
        files_modified: 0,
        since: totals.since,
      }
    }
  })
}

/** Stats for one repository root, memoized on (root, window).
 *
 *  Keyed on (HEAD commit, window), not on the path: every subdirectory of a repo and every worktree
 *  parked on the same commit share one walk, and a new commit is picked up immediately rather than
 *  at the end of the TTL. Concurrent callers join the in-flight promise instead of starting a
 *  second one, and the result — INCLUDING `undefined` — is cached, so a repo with nothing to report
 *  is asked once per TTL rather than on every 30s rebuild. */
async function statsForRepoRoot(toplevel: string, sinceIso?: string): Promise<ProjectGitStats | undefined> {
  const head = await resolveHead(toplevel)
  if (!head) return undefined
  const key = `${head}\u0000${sinceIso ?? ''}`
  const cached = memoRead(statsMemo, key)
  if (cached.hit) return cached.value

  const running = statsInflight.get(key)
  if (running) return running

  const run = (async () => {
    // Disk before walk: a restart, or a second instance, must not re-derive what is already known
    // about this commit. Promoted into the in-process memo so the next read costs no query.
    const stored = (await disk()).get(key)
    if (stored) {
      statsMemo.set(key, { at: Date.now(), value: stored.value })
      return stored.value
    }
    return walkRepoStats(toplevel, sinceIso)
  })()
    .then(value => {
      statsMemo.set(key, { at: Date.now(), value })
      void disk().then(c => c.set(key, value)).catch(() => {})
      return value
    })
    .catch(() => {
      statsMemo.set(key, { at: Date.now(), value: undefined })
      return undefined
    })
    .finally(() => { statsInflight.delete(key) })

  statsInflight.set(key, run)
  return run
}

export async function getProjectGitStats(projectPath: string, sinceIso?: string): Promise<ProjectGitStats | undefined> {
  // The common case: projectPath is inside a git repo. Note what this now does NOT do — a path
  // that IS a repository never falls through to the subdirectory scan below, whatever its stats
  // come back as. "This repo has no commits in the window" and "this directory is not a repo" are
  // different answers, and only the second one is a reason to go looking somewhere else.
  const toplevel = await resolveToplevel(projectPath)
  if (toplevel) return statsForRepoRoot(toplevel, sinceIso)

  // Fallback: projectPath is not itself a repo, so it may be a workspace folder holding several.
  // Scan one level of subdirectories and aggregate across the DISTINCT repositories found.
  let entries: { name: string; isDirectory(): boolean }[] = []
  try {
    entries = await readdir(projectPath, { withFileTypes: true })
  } catch {
    return undefined
  }

  const subdirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => join(projectPath, e.name))
  const seenRoots = new Set<string>()
  let combined: ProjectGitStats | undefined
  for (const sub of subdirs) {
    // Deduplicate by repository root: several subdirectories of one repo are one repo, and
    // aggregating them would multiply that repo's history into the total as well as its cost.
    const subRoot = await resolveToplevel(sub)
    if (!subRoot || seenRoots.has(subRoot)) continue
    seenRoots.add(subRoot)
    // The window is kept here. It used to be dropped on the grounds that bootstrapped repos have
    // commits predating any session — but combined with the fallback firing on every timeout, that
    // made the most expensive possible walk the one that ran most often.
    const stats = await statsForRepoRoot(subRoot, sinceIso)
    if (!stats) continue
    if (!combined) {
      combined = { ...stats }
    } else {
      combined.commits += stats.commits
      combined.lines_added += stats.lines_added
      combined.lines_removed += stats.lines_removed
      combined.files_modified += stats.files_modified
      if (stats.since && (!combined.since || stats.since < combined.since)) combined.since = stats.since
    }
  }
  return combined
}
