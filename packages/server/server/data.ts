import { join } from 'path'
import { readFile } from 'fs/promises'
import type { StatsCache, SessionMeta, ProjectGitStats, HealthIssue, HarnessId, WorkflowRun } from '@agentistics/core'
import { mergeStatsCaches, sessionDay, sanitizeStatsCache, normalizeSessionTimes, sessionTokenTotal } from '@agentistics/core'
import { PROJECTS_DIR, SESSION_META_DIR, ARCHIVE_PROJECTS_DIR, ARCHIVE_SESSION_META_DIR, STATS_CACHE_FILE, ARCHIVE_STATS_DIR, ARCHIVE_ENABLED, HOME_DIR, TEAM_MODE, TEAM_CENTRAL, CENTRAL_USER, PARSE_CACHE_ENABLED } from './config'
import { getArchiveMode } from './preferences'
import { writeConsolidated, loadConsolidated } from './consolidate'
import { planProjectFacts, applyProjectFacts, type ResolvedFacts } from './project-facts'
import { mergeLocalAndIngestedSessions, sessionKey } from './session-merge'
import { writeWorkflowRuns, loadWorkflowRuns } from './workflow-store'
import { createLimiter, safeReadDir, safeReadJson, safeStat } from './utils'
import { UUID_RE, decodeProjectDir, getProjectGitStats, getGitRemote } from './git'
// `activeMinutesFromClaudeJsonl` / `contextTokensFromClaudeJsonl` are no longer called
// here — the meta-session enrichment they served now runs inside `cachedEnrich`, which
// reads the transcript once per file VERSION instead of once per build.
import { parseSessionJsonl } from './jsonl'
import type { MachineInfo } from './team-tokens'
import { runHealthChecks, analyzeToolHealthIssues, analyzeCacheStaleness } from './health'
import { openParseCache, NOOP_PARSE_CACHE, type ParseCache } from './parse-cache'
import { cachedParseSession, cachedEnrich } from './parse-cache-jsonl'

/** Extract the model ID from a JSONL file by reading only the first assistant message.
 *  Skips `<synthetic>` — Claude Code sentinel for system-generated turns, not a real model. */
async function extractModelFromJsonl(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, 'utf-8')
    for (const raw of content.split('\n').slice(0, 200)) {
      const line = raw.trim()
      if (!line) continue
      try {
        const e = JSON.parse(line)
        const m = e.message?.model
        if (e.type === 'assistant' && typeof m === 'string' && m && m.startsWith('claude-')) {
          return m as string
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return undefined
}

/** Server-side project shape — sessions carry only the subset the API needs */
export interface ServerProject {
  path: string
  name: string
  sessions: { sessionId: string; created: string }[]
  git_stats?: ProjectGitStats
  /** Normalized git remote (`host/org/repo`, no protocol) of this project's repo, when known. */
  gitRemote?: string
  /** Team/central only: display names of members who own sessions in this project. */
  users?: string[]
}

export interface ApiResponse {
  statsCache: StatsCache
  projects: ServerProject[]
  allSessions: []
  sessions: SessionMeta[]
  healthIssues: HealthIssue[]
  homeDir: string
  harnesses: HarnessId[]
  /** Team/central only: each member's own statsCache, keyed by resolved display name. */
  userStatsCaches?: Record<string, StatsCache>
  /** Team/central only: the same caches keyed by machine id (memberId), un-grouped. */
  machineStatsCaches?: Record<string, StatsCache>
  /** Team/central only: machine id → owner display name + teams. */
  machineOwners?: Record<string, { user: string; teamIds: string[] }>
  workflows?: WorkflowRun[]
}

export interface ScanResult {
  projects: ServerProject[]
  extraSessions: SessionMeta[]
  workflowRuns: WorkflowRun[]
}

export async function loadSessionMetas(roots: string[] = [SESSION_META_DIR]): Promise<Map<string, SessionMeta>> {
  const map = new Map<string, SessionMeta>()
  const limit = createLimiter(20)

  // Roots are in priority order (live first). A session already loaded from a
  // higher-priority root is never overwritten by the archive copy.
  for (const dir of roots) {
    const files = await safeReadDir(dir)
    await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(f =>
          limit(async () => {
          const data = await safeReadJson<Record<string, unknown>>(join(dir, f))
          if (!data) return

          const sessionId = (data.session_id as string) ?? f.replace(/\.json$/, '')
          if (!sessionId) return
          if (map.has(sessionId)) return

          // Normalise languages: may arrive as Record<string,number> or string[]
          let languages: string[] = []
          if (Array.isArray(data.languages)) {
            languages = data.languages as string[]
          } else if (data.languages && typeof data.languages === 'object') {
            languages = Object.keys(data.languages as object)
          }

          const meta: SessionMeta = {
            session_id: sessionId,
            project_path: (data.project_path as string) ?? '',
            start_time: (data.start_time as string) ?? '',
            duration_minutes: (data.duration_minutes as number) ?? 0,
            // Present only on records written by US (the consolidate store / a team push).
            // Claude's own session-meta files have no per-turn timing — for those it stays
            // undefined here and is filled from the transcript in scanProjectDir.
            active_minutes: typeof data.active_minutes === 'number' ? data.active_minutes : undefined,
            user_message_count: (data.user_message_count as number) ?? 0,
            assistant_message_count: (data.assistant_message_count as number) ?? 0,
            tool_counts: (data.tool_counts as Record<string, number>) ?? {},
            tool_output_tokens: (data.tool_output_tokens as Record<string, number>) ?? {},
            agent_file_reads: (data.agent_file_reads as Record<string, number>) ?? {},
            languages,
            git_commits: (data.git_commits as number) ?? 0,
            git_pushes: (data.git_pushes as number) ?? 0,
            input_tokens: (data.input_tokens as number) ?? 0,
            output_tokens: (data.output_tokens as number) ?? 0,
            first_prompt: (data.first_prompt as string) ?? '',
            title: (data.title as string) ?? (data.summary as string) ?? undefined,
            user_interruptions: (data.user_interruptions as number) ?? 0,
            user_response_times: (data.user_response_times as number[]) ?? [],
            tool_errors: (data.tool_errors as number) ?? 0,
            tool_error_categories: (data.tool_error_categories as Record<string, number>) ?? {},
            uses_task_agent: (data.uses_task_agent as boolean) ?? false,
            uses_mcp: (data.uses_mcp as boolean) ?? false,
            uses_web_search: (data.uses_web_search as boolean) ?? false,
            uses_web_fetch: (data.uses_web_fetch as boolean) ?? false,
            lines_added: (data.lines_added as number) ?? 0,
            lines_removed: (data.lines_removed as number) ?? 0,
            files_modified: (data.files_modified as number) ?? 0,
            message_hours: (() => {
              const timestamps = (data.user_message_timestamps as string[]) ?? []
              if (timestamps.length > 0) {
                return timestamps.flatMap(ts => {
                  try { return [new Date(ts).getHours()] } catch { return [] }
                })
              }
              return (data.message_hours as number[]) ?? []
            })(),
            user_message_timestamps: (data.user_message_timestamps as string[]) ?? [],
            harness: 'claude',
            git_remote: (data.git_remote as string) || undefined,
            _source: 'meta',
          }

          map.set(sessionId, meta)
        })
        )
    )
  }

  return map
}

async function scanProjectDir(
  projDir: string,
  rootDirPaths: string[],
  knownIds: Set<string>,
  metaMap: Map<string, SessionMeta>,
  fileLimit: ReturnType<typeof createLimiter>,
  cache: ParseCache
): Promise<{ project: ServerProject; extraSessions: SessionMeta[]; workflowRuns: WorkflowRun[] } | null> {
  // Fallback path (ambiguous for dir names that contain dashes)
  const fallbackPath = decodeProjectDir(projDir)

  const projectSessions: { sessionId: string; created: string }[] = []
  const extraSessions: SessionMeta[] = []
  const workflowRuns: WorkflowRun[] = []
  // Count CWD occurrences to pick the canonical project path (majority wins)
  const cwdCounts: Record<string, number> = { [fallbackPath]: 0 }
  // Dedup sessions across roots — a session present in the live root is never
  // re-processed from the archive root (roots are scanned live-first).
  const seen = new Set<string>()
  // Sibling dedup for workflow discovery, which (per the NOTE below) must run
  // BEFORE `seen` is checked/set for Format B — so it needs its own guard to
  // avoid re-reading + re-extracting the same session's workflows when its
  // `<id>/subagents/workflows/` dir is mirrored across both live and archive roots.
  const seenWorkflowSessions = new Set<string>()

  // rootDirPaths is this encoded dir resolved across PROJECTS_ROOTS, live first.
  for (const projDirPath of rootDirPaths) {
    const dirStat = await safeStat(projDirPath)
    if (!dirStat?.isDirectory()) continue
    const entries = await safeReadDir(projDirPath)

    // Process all entries in this project dir in parallel (no shared limit with outer)
    await Promise.all(entries.map(async entry => {
    // ----------------------------------------------------------
    // Format A: <session-uuid>.jsonl — direct JSONL file
    // ----------------------------------------------------------
    if (entry.endsWith('.jsonl')) {
      const sessionId = entry.replace(/\.jsonl$/, '')
      if (seen.has(sessionId)) return
      seen.add(sessionId)
      const filePath = join(projDirPath, entry)

      projectSessions.push({ sessionId, created: '' })

      // If we already have this session in meta, count its project_path as a CWD vote
      const metaEntry = metaMap.get(sessionId)
      if (metaEntry?.project_path) {
        cwdCounts[metaEntry.project_path] = (cwdCounts[metaEntry.project_path] ?? 0) + 1
      }

      if (!knownIds.has(sessionId)) {
        const session = await fileLimit(() => cachedParseSession(cache, filePath, sessionId, fallbackPath, 'jsonl'))
        cwdCounts[session.project_path] = (cwdCounts[session.project_path] ?? 0) + 1
        extraSessions.push(session)
      } else if (metaEntry && (!metaEntry.model || metaEntry.active_minutes === undefined
        || metaEntry.context_tokens === undefined
        || (metaEntry.uses_task_agent && !metaEntry.agentMetrics))) {
        // Meta session — model, active time and agent metrics all come from the
        // transcript (Claude's own session-meta files carry none of the three), and all
        // three are cached as one unit keyed on the file's version. Wall-clock duration
        // is in the meta file; per-turn active time only exists here, so it has to be
        // computed or the metric is blank for the path that serves MOST Claude sessions.
        await fileLimit(async () => {
          const needsModel = !metaEntry.model
          const needsAgentMetrics = metaEntry.uses_task_agent && !metaEntry.agentMetrics
          const needsActive = metaEntry.active_minutes === undefined
          // Same reason as active time, one metric later: Claude's session-meta files carry no
          // context reading, and this path serves MOST Claude sessions — a gauge computed only
          // inside `parseSessionJsonl` would be blank on nearly every row it exists for.
          const needsContext = metaEntry.context_tokens === undefined
          if (!needsModel && !needsAgentMetrics && !needsActive && !needsContext) return

          const enriched = await cachedEnrich(cache, filePath, metaEntry.model ?? '')
          if (!enriched) return

          if (needsModel && enriched.model) metaEntry.model = enriched.model
          if (needsActive) metaEntry.active_minutes = enriched.activeMinutes ?? undefined
          // `?? undefined` would be wrong here: the pre-cache code left `context_tokens`
          // ALONE when the transcript had no gauge, and writing `undefined` over an
          // existing meta value is not the same as not writing.
          if (needsContext && enriched.contextTokens !== null) metaEntry.context_tokens = enriched.contextTokens
          if (needsAgentMetrics && enriched.agentMetrics) metaEntry.agentMetrics = enriched.agentMetrics
        })
      }
      return
    }

    // ----------------------------------------------------------
    // Format B: <uuid>/ directory with subagents/ inside
    // ----------------------------------------------------------
    if (!UUID_RE.test(entry)) return
    const entryPath = join(projDirPath, entry)
    const entryStat = await safeStat(entryPath)
    if (!entryStat?.isDirectory()) return

    const sessionId = entry
    const subagentsDir = join(entryPath, 'subagents')

    // Discover workflow runs (superpowers-style local workflows) launched from this session.
    // Requires the main session JSONL (not the subagent files) to find launch/completion events.
    // NOTE: this must run BEFORE the `seen` dedup check below — a session commonly has BOTH
    // a `<id>.jsonl` (Format A, processed earlier in this same Promise.all) AND this `<id>/`
    // directory (Format B), and Format A already marks `sessionId` as seen. If workflow
    // discovery were gated on `seen`, it would silently never run for such sessions.
    if (!seenWorkflowSessions.has(sessionId)) {
      seenWorkflowSessions.add(sessionId)
      const workflowsDir = join(subagentsDir, 'workflows')
      const wfDirs = await safeReadDir(workflowsDir)
      if (wfDirs.length > 0) {
        const mainJsonl = join(projDirPath, `${sessionId}.jsonl`)
        const mainContent = await readFile(mainJsonl, 'utf-8').catch(() => '')
        if (mainContent) {
          const { extractWorkflowRuns } = await import('./workflow-metrics')
          const runs = await extractWorkflowRuns(mainContent.split('\n'), sessionId, workflowsDir)
          workflowRuns.push(...runs)
        }
      }
    }

    if (seen.has(sessionId)) return
    seen.add(sessionId)
    let created = ''

    // If we already have this session in meta, count its project_path as a CWD vote
    const metaEntry = metaMap.get(sessionId)
    if (metaEntry?.project_path) {
      cwdCounts[metaEntry.project_path] = (cwdCounts[metaEntry.project_path] ?? 0) + 1
    }

    // Read only the FIRST agent file to get cwd/timestamp
    const agentFiles = (await safeReadDir(subagentsDir))
      .filter(f => f.endsWith('.jsonl'))
      .sort()

    if (agentFiles.length > 0) {
      const agentFilePath = join(subagentsDir, agentFiles[0]!)
      if (!knownIds.has(sessionId)) {
        const session = await fileLimit(() => cachedParseSession(cache, agentFilePath, sessionId, fallbackPath, 'subdir'))
        created = session.start_time
        cwdCounts[session.project_path] = (cwdCounts[session.project_path] ?? 0) + 1
        extraSessions.push(session)
      } else {
        // Already in meta — just grab the timestamp cheaply
        const metaCwdEntry = metaMap.get(sessionId)
        created = metaCwdEntry?.start_time ?? ''
      }
    }

    projectSessions.push({ sessionId, created })
  }))
  }

  if (projectSessions.length === 0) return null

  // Use most-common CWD as canonical project path (majority-vote resolves dash-ambiguity
  // and prevents rogue subagent CWDs from hijacking the project path)
  const projectPath = Object.entries(cwdCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || fallbackPath

  // Normalize all extra sessions to the canonical project path
  for (const s of extraSessions) s.project_path = projectPath

  // Scope git stats to the period of Claude usage (earliest session date)
  const sessionDates = projectSessions
    .map(s => s.created || metaMap.get(s.sessionId)?.start_time || '')
    .filter(Boolean)
  const earliestSession = sessionDates.length > 0
    ? sessionDates.reduce((a, b) => a < b ? a : b)
    : undefined
  const git_stats = await getProjectGitStats(projectPath, earliestSession)
  // Resolve the repo's origin remote once per project. This is the local-machine source of
  // the group-by-repository key; it's stamped onto every session below so it survives being
  // pushed to a central (which has no filesystem access to the member's repos) and persisted
  // to the consolidate store.
  const gitRemote = await getGitRemote(projectPath)

  // Stamp the remote onto this project's sessions so the dimension travels with each session.
  if (gitRemote) {
    for (const s of extraSessions) s.git_remote = gitRemote
    for (const ps of projectSessions) {
      const meta = metaMap.get(ps.sessionId)
      if (meta && !meta.git_remote) meta.git_remote = gitRemote
    }
  }

  return {
    project: {
      path: projectPath,
      name: projectPath.split('/').filter(Boolean).pop() ?? projDir,
      sessions: projectSessions.sort((a, b) => b.created.localeCompare(a.created)),
      git_stats,
      gitRemote,
    },
    extraSessions,
    workflowRuns,
  }
}

/**
 * Read git for every project path that has not been read yet, and stamp what it finds.
 *
 * The IO half of `project-facts.ts`: the plan and the stamping are pure and tested there, this
 * only spends the processes. Reads are memoized per path by the plan itself (one entry per distinct
 * path) and bounded by a limiter — two harnesses in one directory cost one `git config`, not two.
 */
export async function resolveProjectFacts(
  sessions: SessionMeta[],
  projects: ServerProject[],
  alreadyResolved: ReadonlySet<string>,
): Promise<void> {
  const plan = planProjectFacts(sessions, projects, alreadyResolved)
  if (plan.length === 0) return

  const limit = createLimiter(8)
  const facts = new Map<string, ResolvedFacts>()
  await Promise.all(plan.map(({ path, earliest }) => limit(async () => {
    // Both are already total: a path that is gone, or is not a repo, yields '' / undefined rather
    // than throwing. Guarded anyway — one unreadable directory must not fail the whole build.
    const [remote, stats] = await Promise.all([
      getGitRemote(path).catch(() => ''),
      getProjectGitStats(path, earliest || undefined).catch(() => undefined),
    ])
    facts.set(path, { remote: remote ?? '', stats })
  })))

  applyProjectFacts(facts, sessions, projects)
}

export async function scanProjects(
  knownIds: Set<string>,
  metaMap: Map<string, SessionMeta>,
  roots: string[] = [PROJECTS_DIR],
  onProjectComplete?: (completed: number, total: number) => void,
  cache: ParseCache = NOOP_PARSE_CACHE,
): Promise<ScanResult> {
  // Separate limiter just for file reads (not project dir traversal)
  const fileLimit = createLimiter(6)

  // Union encoded project dirs across all roots (live + archive). Each maps to
  // the list of absolute paths that contain it, in root priority order (live first).
  const dirToRoots = new Map<string, string[]>()
  for (const root of roots) {
    for (const d of await safeReadDir(root)) {
      const arr = dirToRoots.get(d) ?? []
      arr.push(join(root, d))
      dirToRoots.set(d, arr)
    }
  }
  const dirEntries = [...dirToRoots.entries()]
  let completed = 0
  const total = dirEntries.length

  // Process project dirs in parallel (they mostly do readdirs + parallel file reads)
  const results = await Promise.all(
    dirEntries.map(([projDir, rootDirPaths]) =>
      scanProjectDir(projDir, rootDirPaths, knownIds, metaMap, fileLimit, cache).then(r => {
        completed++
        onProjectComplete?.(completed, total)
        return r
      })
    )
  )

  const projects: ServerProject[] = []
  const extraSessions: SessionMeta[] = []
  const workflowRuns: WorkflowRun[] = []

  for (const result of results) {
    if (!result) continue
    projects.push(result.project)
    extraSessions.push(...result.extraSessions)
    workflowRuns.push(...result.workflowRuns)
  }

  // Sort projects by session count descending
  projects.sort((a, b) => b.sessions.length - a.sessions.length)

  return { projects, extraSessions, workflowRuns }
}

export function enrichProjectSessions(projects: ServerProject[], metaMap: Map<string, SessionMeta>): void {
  for (const project of projects) {
    for (const s of project.sessions) {
      if (!s.created) {
        const meta = metaMap.get(s.sessionId)
        if (meta?.start_time) s.created = meta.start_time
      }
    }
    // Re-sort after enrichment
    project.sessions.sort((a, b) => b.created.localeCompare(a.created))
  }
}

// ---------------------------------------------------------------------------
// In-memory cache — shared Promise so concurrent requests join the same
// computation instead of spawning separate ones.
//
// State machine:
//   'idle'      → no computation, next request starts one
//   'computing' → in-flight; all requests (including invalidation) wait for it
//   'done'      → resolved; served from cache until TTL expires or invalidated
//
// invalidateCache() transitions 'done' → 'idle' so the next request recomputes.
// While 'computing', invalidations are no-ops — the current computation is used.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000

type CacheStatus = 'idle' | 'computing' | 'done'

let _status: CacheStatus = 'idle'
let _promise: Promise<ApiResponse> | null = null
let _resolvedAt = 0
let _revalidating = false

export function invalidateCache(): void {
  // Mark the cached result stale rather than dropping it, so the NEXT request serves the (stale)
  // cache immediately and refreshes in the background instead of blocking on a full rebuild. A true
  // blocking rebuild only ever happens for the very first build (when no result exists yet).
  if (_status === 'done') _resolvedAt = 0
  // 'computing': no-op — let the in-flight computation finish
}

/** Kick a background rebuild that swaps in the fresh result when done. Non-blocking: callers keep
 *  being served the previous (stale) result meanwhile. Guarded so only one runs at a time. */
function revalidateInBackground(): void {
  if (_revalidating || _status === 'computing') return
  _revalidating = true
  void _buildApiResponse()
    .then(result => { _promise = Promise.resolve(result); _resolvedAt = Date.now(); _status = 'done' })
    .catch(() => { /* keep serving the previous good result on failure */ })
    .finally(() => { _revalidating = false })
}

/** Backfill `git_remote` onto remote-less sessions (and their projects) from any session/project
 *  at the same `project_path` that already carries a remote. Members stamp git_remote at push time
 *  from their local repo, but legacy pushes / older consolidated sessions lack it — without this an
 *  old remote-less session at a now-linked repo shows as a duplicate "no linked repository" card.
 *  The central has NO filesystem access to members' repos (so a git scan can't resolve it there),
 *  which is why the remote is sourced from the sessions themselves. Mutates in place; returns the
 *  number of sessions stamped. */
function backfillGitRemote(sessions: SessionMeta[], projects: ServerProject[]): number {
  const pathToRemote = new Map<string, string>()
  for (const p of projects) if (p.gitRemote) pathToRemote.set(p.path, p.gitRemote)
  for (const s of sessions) {
    if (s.git_remote && s.project_path && !pathToRemote.has(s.project_path)) pathToRemote.set(s.project_path, s.git_remote)
  }
  if (pathToRemote.size === 0) return 0
  let n = 0
  for (const s of sessions) {
    if (!s.git_remote && s.project_path) {
      const r = pathToRemote.get(s.project_path)
      if (r) { s.git_remote = r; n++ }
    }
  }
  for (const p of projects) {
    if (!p.gitRemote) { const r = pathToRemote.get(p.path); if (r) p.gitRemote = r }
  }
  return n
}

export async function buildApiResponse(): Promise<ApiResponse> {
  if (_status === 'computing') return _promise!
  // Stale-while-revalidate: once a result exists, always serve it immediately. When it's older than
  // the TTL, refresh in the background — but never make the caller wait for that rebuild.
  if (_status === 'done' && _promise) {
    if (Date.now() - _resolvedAt >= CACHE_TTL_MS) revalidateInBackground()
    return _promise
  }

  // First build ever (idle) — the only path that blocks.
  _status = 'computing'
  _promise = _buildApiResponse()
    .then(result => {
      _status = 'done'
      _resolvedAt = Date.now()
      return result
    })
    .catch(err => {
      _status = 'idle'
      _promise = null
      throw err
    })
  return _promise
}

/** Merge sessions newer than `statsCache.lastComputedDate` into the cache in-place.
 *  Fills gaps left by Claude Code's own stats-cache updater (e.g. activity from today
 *  that hasn't been rolled into ~/.claude/stats-cache.json yet). Only sessions whose
 *  model starts with `claude-` are counted (skips `<synthetic>` and other sentinels). */
function supplementStatsCache(statsCache: StatsCache, sessions: SessionMeta[]): void {
  if (sessions.length === 0) return
  const lastComputed = statsCache.lastComputedDate ?? ''

  const dailyModel = new Map<string, Map<string, number>>()
  const modelTotals = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>()
  const dailyActivity = new Map<string, { messageCount: number; sessionCount: number; toolCallCount: number }>()

  for (const s of sessions) {
    if (!s.start_time) continue
    // `sessionDay`, not `.slice`: an adapter that wrote the wrong shape must not be able to throw
    // here and take the whole API response with it. See sessionDay.
    const day = sessionDay(s.start_time)
    if (!day) continue
    if (lastComputed && day <= lastComputed) continue

    const da = dailyActivity.get(day) ?? { messageCount: 0, sessionCount: 0, toolCallCount: 0 }
    da.messageCount += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
    da.sessionCount += 1
    da.toolCallCount += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
    dailyActivity.set(day, da)

    const model = s.model
    if (!model || !model.startsWith('claude-')) continue
    const inp = s.input_tokens ?? 0
    const out = s.output_tokens ?? 0
    const cr  = s.cache_read_input_tokens ?? 0
    const cw  = s.cache_creation_input_tokens ?? 0
    const total = inp + out + cr + cw
    if (total === 0) continue

    const byModel = dailyModel.get(day) ?? new Map<string, number>()
    byModel.set(model, (byModel.get(model) ?? 0) + total)
    dailyModel.set(day, byModel)

    const mt = modelTotals.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    mt.input     += inp
    mt.output    += out
    mt.cacheRead += cr
    mt.cacheWrite += cw
    modelTotals.set(model, mt)
  }

  if (dailyActivity.size === 0 && dailyModel.size === 0 && modelTotals.size === 0) return

  // dailyActivity — upsert by date, then sort
  statsCache.dailyActivity = statsCache.dailyActivity ?? []
  const daIndex = new Map(statsCache.dailyActivity.map((d, i) => [d.date, i]))
  for (const [date, v] of dailyActivity) {
    const idx = daIndex.get(date)
    if (idx !== undefined) statsCache.dailyActivity[idx] = { date, ...v }
    else statsCache.dailyActivity.push({ date, ...v })
  }
  statsCache.dailyActivity.sort((a, b) => a.date.localeCompare(b.date))

  // dailyModelTokens — upsert by date
  statsCache.dailyModelTokens = statsCache.dailyModelTokens ?? []
  const dmtIndex = new Map(statsCache.dailyModelTokens.map((d, i) => [d.date, i]))
  for (const [date, byModel] of dailyModel) {
    const tokensByModel: Record<string, number> = {}
    for (const [m, t] of byModel) tokensByModel[m] = t
    const idx = dmtIndex.get(date)
    if (idx !== undefined) statsCache.dailyModelTokens[idx] = { date, tokensByModel }
    else statsCache.dailyModelTokens.push({ date, tokensByModel })
  }
  statsCache.dailyModelTokens.sort((a, b) => a.date.localeCompare(b.date))

  // modelUsage — increment existing entries or create new ones
  statsCache.modelUsage = statsCache.modelUsage ?? {}
  for (const [model, t] of modelTotals) {
    const existing = statsCache.modelUsage[model]
    if (existing) {
      existing.inputTokens             += t.input
      existing.outputTokens            += t.output
      existing.cacheReadInputTokens    += t.cacheRead
      existing.cacheCreationInputTokens += t.cacheWrite
    } else {
      statsCache.modelUsage[model] = {
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadInputTokens: t.cacheRead,
        cacheCreationInputTokens: t.cacheWrite,
        webSearchRequests: 0,
        costUSD: 0,
      }
    }
  }
}

/** Recover history from the latest archive snapshot WITHOUT double-counting.
 *  Daily arrays: add only dates the live cache no longer has. Model totals:
 *  take the per-field max (monotonic — normally a no-op, restores any shrinkage
 *  if Claude ever recomputes a smaller cache after deleting sessions). */
async function mergeArchivedStatsCache(statsCache: StatsCache, enabled: boolean): Promise<void> {
  if (!enabled) return
  const snap = await safeReadJson<StatsCache>(join(ARCHIVE_STATS_DIR, 'latest.json'))
  if (!snap) return
  applyArchivedStats(statsCache, sanitizeStatsCache(snap))
}

export function applyArchivedStats(statsCache: StatsCache, snap: StatsCache): void {
  statsCache.dailyActivity = statsCache.dailyActivity ?? []
  const haveDA = new Set(statsCache.dailyActivity.map(d => d.date))
  for (const d of snap.dailyActivity ?? []) {
    if (!haveDA.has(d.date)) statsCache.dailyActivity.push(d)
  }
  statsCache.dailyActivity.sort((a, b) => a.date.localeCompare(b.date))

  statsCache.dailyModelTokens = statsCache.dailyModelTokens ?? []
  const haveDMT = new Set(statsCache.dailyModelTokens.map(d => d.date))
  for (const d of snap.dailyModelTokens ?? []) {
    if (!haveDMT.has(d.date)) statsCache.dailyModelTokens.push(d)
  }
  statsCache.dailyModelTokens.sort((a, b) => a.date.localeCompare(b.date))

  statsCache.modelUsage = statsCache.modelUsage ?? {}
  for (const [model, snapU] of Object.entries(snap.modelUsage ?? {})) {
    const live = statsCache.modelUsage[model]
    if (!live) { statsCache.modelUsage[model] = snapU; continue }
    live.inputTokens = Math.max(live.inputTokens, snapU.inputTokens)
    live.outputTokens = Math.max(live.outputTokens, snapU.outputTokens)
    live.cacheReadInputTokens = Math.max(live.cacheReadInputTokens, snapU.cacheReadInputTokens)
    live.cacheCreationInputTokens = Math.max(live.cacheCreationInputTokens, snapU.cacheCreationInputTokens)
    live.webSearchRequests = Math.max(live.webSearchRequests ?? 0, snapU.webSearchRequests ?? 0)
  }
}

type ProgressFn = (stage: string, progress: number, detail?: string) => void

async function _buildApiResponseCore(onProgress: ProgressFn): Promise<ApiResponse> {
  const timeoutMs = 300_000 // 5 minutes

  const buildPromise = async () => {
    onProgress('statsCache', 0)
    onProgress('sessions', 0)
    onProgress('health', 0)

    // Resolve archive mode. 'full' reads the raw mirror (union live+archive);
    // 'consolidate' reads live only and gap-fills from the metrics store later.
    const mode = (ARCHIVE_ENABLED ? await getArchiveMode() : 'off') ?? 'off'
    const fullMode = mode === 'full'
    const metaRoots = fullMode ? [SESSION_META_DIR, ARCHIVE_SESSION_META_DIR] : [SESSION_META_DIR]
    const projectRoots = fullMode ? [PROJECTS_DIR, ARCHIVE_PROJECTS_DIR] : [PROJECTS_DIR]

    const [statsCache, metaMap, healthIssues] = await Promise.all([
      safeReadJson<StatsCache>(STATS_CACHE_FILE)
        .then(async v => {
          const sc = sanitizeStatsCache(v ?? ({} as StatsCache))
          await mergeArchivedStatsCache(sc, fullMode)
          onProgress('statsCache', 1)
          return sc
        }),
      loadSessionMetas(metaRoots)
        .then(v => { onProgress('sessions', 1, String(v.size)); return v }),
      runHealthChecks()
        .then(v => { onProgress('health', 1); return v }),
    ])

    onProgress('projects', 0)
    const knownIds = new Set(metaMap.keys())
    const parseCache = PARSE_CACHE_ENABLED ? await openParseCache() : NOOP_PARSE_CACHE
    const { projects, extraSessions, workflowRuns: collectedWorkflowRuns } = await scanProjects(
      knownIds,
      metaMap,
      projectRoots,
      (done, total) => onProgress('projects', total > 0 ? done / total : 1),
      parseCache,
    )
    // Mark everything read this build as live, then drop rows for files not seen in 30
    // days — Claude deletes transcripts at 30 days by default, so their rows are dead
    // weight after that. The cache is derived state: dropping too much costs one
    // reparse, dropping too little costs disk. Neither can cost a wrong number.
    parseCache.flush()
    parseCache.gc(Date.now() - 30 * 24 * 60 * 60 * 1000)
    parseCache.close()
    onProgress('projects', 1, String(projects.length))
    // Every path the Claude walk has already asked git about — including the ones that turned out
    // not to be repositories. `resolveProjectFacts` below skips these rather than re-reading them.
    const gitResolvedPaths = new Set(projects.map(p => p.path))

    // Enrich project session created timestamps from meta where possible
    enrichProjectSessions(projects, metaMap)

    onProgress('finalizing', 0)

    const metaSessions = Array.from(metaMap.values())
    const allSessionsRaw: SessionMeta[] = [...metaSessions, ...extraSessions]

    // Normalise at the boundary — where every harness's sessions ENTER the pipeline — before
    // anything sorts, dedups, or persists them. `start_time`/`end_time` are typed `string`, but
    // that is a compile-time promise only: an adapter can get the shape wrong (Kimi wrote an epoch
    // NUMBER; jsonl.ts's own `ts` extraction was cast, not verified). Fixing it here means every
    // downstream `.localeCompare`/`.slice`/`parseISO` — including the raw `.sort()` calls a few
    // lines down — never has to defend against it individually, and a bad session is never even
    // written to the consolidate store in the first place.
    for (const s of allSessionsRaw) normalizeSessionTimes(s)

    // Deduplicate by session_id — same UUID can appear as both .jsonl AND UUID subdir
    // Prefer: meta > jsonl > subdir
    const sourceRank: Record<string, number> = { meta: 0, jsonl: 1, subdir: 2 }
    const sessionMap = new Map<string, SessionMeta>()
    for (const s of allSessionsRaw) {
      const existing = sessionMap.get(s.session_id)
      if (!existing || (sourceRank[s._source ?? 'subdir'] ?? Infinity) < (sourceRank[existing._source ?? 'subdir'] ?? Infinity)) {
        sessionMap.set(s.session_id, s)
      }
    }
    let sessions = Array.from(sessionMap.values())

    // Persist current per-session metrics so they survive Claude's cleanup, then
    // (consolidate mode) revive sessions that already vanished from disk. Gap-fill
    // adds only ids no longer present live — never double-counts existing sessions.
    if (mode !== 'off') {
      // NOTE: this persists the Claude-only `sessions` array; non-Claude harness
      // sessions are merged in below, AFTER this call, and are intentionally NOT
      // written to the consolidate store yet. If you move this call below the merge,
      // you MUST keep the (harness, session_id) dedup at the end or codex double-counts.
      await writeConsolidated(sessions)
    }

    // Persist discovered workflow runs so they survive Claude's transcript cleanup,
    // then union with the store (live wins by runId) so revived runs from vanished
    // sessions still surface after the 30-day sweep. Gated on archive mode, same as
    // session consolidation above — 'off' means nothing is written or revived, but
    // live discovery (collectedWorkflowRuns, from scanProjects) always runs regardless.
    const liveWorkflows = collectedWorkflowRuns
    if (mode !== 'off') await writeWorkflowRuns(liveWorkflows)
    const storedWorkflows = mode !== 'off' ? await loadWorkflowRuns() : new Map<string, WorkflowRun>()
    const workflowsById = new Map(storedWorkflows)
    for (const r of liveWorkflows) workflowsById.set(r.runId, r)
    // `workflows` stays mutable — team/central workflow runs (from Mongo) are unioned in
    // below, after the team-sessions block, then a final sort is applied.
    // Hide empty runs (0 agents) — including any persisted before extraction started dropping
    // them — so the Dynamic Workflows view never shows "0 agents · nothing ran" skeletons.
    let workflows: WorkflowRun[] = [...workflowsById.values()].filter(r => r.agents.length > 0)
    // Declared here rather than beside the adapter loop below because the consolidate gap-fill
    // revives sessions of EVERY harness, and a harness present only in the store must still
    // reach `AppData.harnesses` — that list is what gates the harness selector and the Compare
    // page. Consolidate mode exists precisely because the harnesses delete their own transcripts,
    // so "its raw files are gone" is the normal case, not an edge one.
    const harnessSet = new Set<HarnessId>(['claude'])
    if (mode === 'consolidate') {
      const stored = await loadConsolidated()
      const liveIds = new Set(sessions.map(s => s.session_id))
      const projByPath = new Map(projects.map(p => [p.path, p]))
      for (const [id, s] of stored) {
        if (liveIds.has(id)) continue
        sessions.push(s)
        harnessSet.add(s.harness)
        const existing = projByPath.get(s.project_path)
        if (existing) {
          existing.sessions.push({ sessionId: id, created: s.start_time })
        } else if (s.project_path) {
          const np: ServerProject = {
            path: s.project_path,
            name: s.project_path.split('/').filter(Boolean).pop() ?? s.project_path,
            sessions: [{ sessionId: id, created: s.start_time }],
            gitRemote: s.git_remote || undefined,
          }
          projects.push(np)
          projByPath.set(s.project_path, np)
        }
      }
    }

    // Backfill git_remote onto remote-less sessions from any session/project at the same path
    // (see backfillGitRemote). This first pass covers LOCAL sessions; on a MEMBER, persist the
    // result to the store so the uploader pushes git_remote (the central can only group by remote
    // and has no filesystem to recover it). It runs AGAIN after the team merge below so a central
    // also backfills the members' sessions it just read from Mongo.
    const localBackfilled = backfillGitRemote(sessions, projects)
    if (localBackfilled > 0 && !TEAM_CENTRAL && mode !== 'off') {
      await writeConsolidated(sessions).catch(err => console.warn('[repo] store git_remote heal failed:', String(err)))
      // The healed sessions now differ (git_remote added) → nudge the uploader to re-push so the
      // central links them without a manual sent-state reset. No-op if not a running member.
      import('./team-uploader').then(m => m.notifyDataChanged()).catch(() => {})
    }

    // Sort sessions by start_time descending (most recent first)
    sessions.sort((a, b) => b.start_time.localeCompare(a.start_time))

    // Post-processing health checks based on session data (tool metrics)
    analyzeToolHealthIssues(sessions, healthIssues)

    // Staleness check runs BEFORE supplementation so the warning reflects the original cache state
    analyzeCacheStaleness(statsCache, sessions, healthIssues)
    // Supplement the cache with sessions newer than lastComputedDate so UI totals stay accurate
    supplementStatsCache(statsCache, sessions)

    // --- Other harnesses (Codex, …): append their normalized sessions ---
    // MUST run AFTER supplementStatsCache so non-Claude sessions never corrupt Claude totals.
    const { getEnabledAdapters } = await import('./adapters/types')
    const extraHarnessSessions: SessionMeta[] = []
    for (const adapter of await getEnabledAdapters()) {
      if (adapter.id === 'claude') continue // already loaded above
      const extra = await adapter.loadSessions().catch(() => [] as SessionMeta[])
      for (const s of extra) {
        // Key by (harness, session_id) so IDs never collide across harnesses
        sessions.push(s)
        extraHarnessSessions.push(s)
        harnessSet.add(s.harness)
        // surface as a project too
        const existing = projects.find(p => p.path === s.project_path && p.path)
        if (existing) {
          existing.sessions.push({ sessionId: s.session_id, created: s.start_time })
          // Backfill the repo remote if the project was created from a session that lacked it.
          if (!existing.gitRemote && s.git_remote) existing.gitRemote = s.git_remote
        } else if (s.project_path) {
          projects.push({
            path: s.project_path,
            name: s.project_path.split('/').filter(Boolean).pop() ?? s.project_path,
            sessions: [{ sessionId: s.session_id, created: s.start_time }],
            gitRemote: s.git_remote || undefined,
          })
        }
      }
    }
    // --- Repository discovery, for every harness ---
    // A repository is a property of a DIRECTORY, not of whichever assistant happened to visit it.
    // Until this ran, `getGitRemote` was only ever called from inside the ~/.claude walk, so a repo
    // used exclusively through Codex/Gemini/Copilot was invisible until a Claude session appeared in
    // it. Measured before this change on a real machine: claude 163 sessions / 95 with a remote,
    // codex 10 / 0, copilot 8 / 1, gemini 15 / 1.
    //
    // It runs BEFORE the writeConsolidated below, so the remote reaches the store — and therefore
    // the uploader and the central, which has no filesystem to recover it from.
    await resolveProjectFacts(sessions, projects, gitResolvedPaths)

    // --- The user's own session names ---
    // A label someone typed in the session manager is the ONE label nothing upstream may overwrite,
    // which is the whole reason to be able to set one. It is stamped here, after every harness's
    // sessions are in one list, and only where the link is unambiguous — `linkManagedSessions`
    // refuses in both directions rather than attributing on a coin flip, because a name on the
    // WRONG conversation is a user reading someone else's work under a title they chose themselves.
    //
    // Before writeConsolidated, so the name reaches the store and survives the harness deleting its
    // transcript — and it is scrubbed by `redactSecrets` on the way to a central exactly like
    // `first_prompt`, which it sits beside in `sessionLabel()`.
    try {
      const { readRegistry } = await import('./sessions/registry')
      const { applySessionLabels, linkManagedSessions } = await import('./sessions/link-sessions')
      applySessionLabels(sessions, linkManagedSessions(await readRegistry(), sessions))
    } catch (err) {
      // A registry that cannot be read costs some labels, never the build.
      console.warn('[session] could not apply session labels:', String(err))
    }

    // Persist non-Claude sessions to the consolidate store too. The Claude-only
    // writeConsolidated() above runs before this merge, so without this the store
    // (and therefore the team uploader, which pushes loadConsolidated()) would only
    // ever carry Claude — a central would never receive Codex/Gemini/Copilot data.
    // The store is namespaced per harness and writeConsolidated dedups by
    // (harness, session_id), so this never collides with the Claude entries.
    if (mode !== 'off' && extraHarnessSessions.length > 0) {
      await writeConsolidated(extraHarnessSessions)
    }

    // --- Team sessions: central reads Mongo (Phase 2); else folder union (Phase 1) ---
    if (TEAM_MODE || TEAM_CENTRAL) {
      let teamSessions: SessionMeta[] = []
      if (TEAM_CENTRAL) {
        const { loadTeamSessionsFromMongo } = await import('./team-source')
        teamSessions = await loadTeamSessionsFromMongo().catch(() => [] as SessionMeta[])
      } else {
        const { loadTeamSessions } = await import('./team-source')
        teamSessions = await loadTeamSessions().catch(() => [] as SessionMeta[])
      }
      // A central very often runs on a machine that is ALSO a member of itself, so the same
      // physical session arrives twice: once from the live `~/.claude` read above, once from
      // Mongo. Both copies share the `session_id`, so appending blindly double-counted that
      // machine everywhere sessions are summed. `mergeLocalAndIngestedSessions` collapses the
      // pair to one row (local data + ingested identity — see session-merge.ts) and tells us
      // which ingested rows were genuinely new, so only THOSE still need a project entry;
      // rows that merged into a local session were already surfaced when that session was
      // scanned, and re-adding them duplicated the project's `sessions[]` list too.
      const mergedTeam = mergeLocalAndIngestedSessions(sessions, teamSessions)
      sessions = mergedTeam.sessions
      for (const s of teamSessions) harnessSet.add(s.harness)
      for (const s of mergedTeam.ingestOnly) {
        const existing = projects.find(p => p.path === s.project_path && p.path)
        if (existing) {
          existing.sessions.push({ sessionId: s.session_id, created: s.start_time })
          // Backfill the repo remote if the project was created from a session that lacked it.
          if (!existing.gitRemote && s.git_remote) existing.gitRemote = s.git_remote
        } else if (s.project_path) {
          projects.push({
            path: s.project_path,
            name: s.project_path.split('/').filter(Boolean).pop() ?? s.project_path,
            sessions: [{ sessionId: s.session_id, created: s.start_time }],
            gitRemote: s.git_remote || undefined,
          })
        }
      }
      // Central: fold team sessions into statsCache so the unfiltered (no user
      // selected) Cost/Tokens KPIs reflect the whole team. Safe on a dedicated
      // central (empty local statsCache → nothing to corrupt); the day<=lastComputed
      // guard inside supplementStatsCache prevents any double-count.
      // NOTE: the central's own `statsCache` is NOT supplemented with team sessions here.
      // Each member's deep history is exposed separately via `userStatsCaches` (below) and
      // aggregated per-selected-member on the frontend, so the numbers match each machine
      // exactly. `statsCache` stays the central machine's own (used for CENTRAL_USER).

      // Second backfill pass: now that the members' sessions (from Mongo) are merged in, link any
      // remote-less session to a repo that ANOTHER session at the same path resolved. Without this
      // the central's own first pass (local sessions only) never touched the team data, so the
      // same repo showed up both linked and unlinked. In-memory only (never persisted centrally).
      backfillGitRemote(sessions, projects)
    }

    // Central self-contribution: the central machine's OWN local sessions have no `user`
    // (team sessions from Mongo always do). When AGENTISTICS_CENTRAL_USER is set, tag those
    // untagged sessions with it so the machine running the central also appears as a member
    // in the dashboard's user filter — one instance, both roles. No double-count: the
    // central never pushes itself to Mongo; it reads its own ~/.claude live.
    if (TEAM_CENTRAL && CENTRAL_USER) {
      for (const s of sessions) {
        if (!s.user) s.user = CENTRAL_USER
      }
    }

    // --- Team workflow runs: central reads Mongo, unioned with local runs ---
    // Mirrors the team-sessions block above: each member pushes its own local
    // WorkflowRun[] (computed metrics only — no chat/prompt text) to the central via
    // team-uploader.ts → POST /api/team/ingest, stored per (org, memberId, runId) in
    // team-workflows.ts. Keyed by runId here too, so a run pushed by its own member never
    // collides with the central's own local discovery of the same run.
    if (TEAM_CENTRAL) {
      const { loadTeamWorkflowsFromMongo } = await import('./team-source')
      const teamWorkflows = await loadTeamWorkflowsFromMongo().catch(() => [] as WorkflowRun[])
      const merged = new Map(workflows.map(w => [w.runId, w]))
      for (const w of teamWorkflows) merged.set(w.runId, w)
      workflows = [...merged.values()]
      // Same self-contribution as sessions: the central's own local runs have no `user` yet
      // (team runs from Mongo always do) — tag them with CENTRAL_USER so they surface under
      // the central machine's own member entry too.
      if (CENTRAL_USER) {
        workflows = workflows.map(w => (w.user ? w : { ...w, user: CENTRAL_USER }))
      }
    }
    workflows.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))

    // Per-member statsCaches: each member's authoritative aggregated history, keyed by the
    // member's CURRENT display name (resolved via the tokens table). The central's own
    // self-contribution is added under CENTRAL_USER. The frontend merges the selected
    // members' caches so KPIs match each machine exactly.
    let userStatsCaches: Record<string, StatsCache> | undefined
    // The same caches un-grouped, one per machine. Keeping BOTH shapes is the point: the
    // display-name grouping above is what the member filter needs, and it is exactly what makes
    // the machine/team filter impossible to serve from `userStatsCaches` — hence this second map.
    let machineStatsCaches: Record<string, StatsCache> | undefined
    let machineOwners: Record<string, { user: string; teamIds: string[] }> | undefined
    if (TEAM_CENTRAL) {
      const { loadAllMemberStats } = await import('./team-stats')
      const { getMemberNameMap, getLiveTokenIds, listMachines } = await import('./team-tokens')
      const [memberStats, nameMap, liveIds, machines] = await Promise.all([
        loadAllMemberStats().catch(() => [] as { memberId: string; user: string; statsCache: StatsCache }[]),
        getMemberNameMap().catch(() => ({} as Record<string, string>)),
        getLiveTokenIds().catch(() => null),
        // The empty fallback must be typed as MachineInfo[], not a narrower literal: a literal
        // missing the effective/inherited/excluded team fields collapses the union and hides them.
        listMachines().catch(() => [] as MachineInfo[]),
      ])
      userStatsCaches = {}
      machineStatsCaches = {}
      for (const m of memberStats) {
        // Skip revoked members — their orphaned statsCache must not keep inflating team KPIs.
        if (liveIds && !liveIds.has(m.memberId)) continue
        // Multiple machines can share one display name (a dev with two machines). Key by name and
        // SUM their caches instead of overwriting — otherwise only the last machine's totals survive.
        const key = nameMap[m.memberId] ?? m.user
        const prev = userStatsCaches[key]
        userStatsCaches[key] = prev ? mergeStatsCaches([prev, m.statsCache]) : m.statsCache
        machineStatsCaches[m.memberId] = m.statsCache
      }
      if (CENTRAL_USER) userStatsCaches[CENTRAL_USER] = statsCache
      // Owner/teams per machine, resolved from the tokens table — NOT from the sessions, so a
      // machine whose individual session docs are gone still resolves to its owner and its cache.
      machineOwners = {}
      for (const m of machines) {
        if (liveIds && !liveIds.has(m.id)) continue
        // EFFECTIVE teams (explicit ∪ inherited-from-owner-accounts − excluded), not the stored
        // ones: this feeds resolveMachineCacheScope(), which expands a team selection into
        // machineStatsCaches keys. With the stored list, a team whose machines are inherited
        // through its member accounts would list the right sessions but resolve fewer caches
        // than the scope covers — the "a scope reports a fraction of itself" failure that
        // cacheBlindScope exists to prevent. Authority checks still use the stored fields.
        machineOwners[m.id] = {
          user: nameMap[m.id] ?? m.user,
          teamIds: m.effectiveTeamIds ?? m.teamIds ?? [],
        }
      }
    }

    sessions.sort((a, b) => b.start_time.localeCompare(a.start_time))

    // Final safety net: dedup by (harness, session_id) — `sessionKey`.
    // This key used to include `user`, which silently disabled it on a central that is also a
    // member of itself: the local read of a session has no `user`, the ingested copy of the SAME
    // session carries the member's display name, so the two keys differed and BOTH rows survived.
    // `session_id` is a UUID — the same id on two rows is always the same session, never two
    // people's work — so `user` must not be part of the identity.
    const seenHarnessKeys = new Set<string>()
    const dedupedSessions = sessions.filter(s => {
      const key = sessionKey(s)
      if (seenHarnessKeys.has(key)) return false
      seenHarnessKeys.add(key)
      return true
    })

    // Tag each project with the set of members who own sessions in it, so the
    // frontend project filter can be scoped to the selected members deterministically
    // (no path re-matching, no fallback-to-all that leaks other members' projects).
    // Built from the final deduped session set, where every team/central session carries `user`.
    const pathToUsers = new Map<string, Set<string>>()
    for (const s of dedupedSessions) {
      if (!s.user || !s.project_path) continue
      let set = pathToUsers.get(s.project_path)
      if (!set) { set = new Set(); pathToUsers.set(s.project_path, set) }
      set.add(s.user)
    }
    for (const p of projects) {
      const set = pathToUsers.get(p.path)
      if (set && set.size > 0) p.users = Array.from(set)
    }

    const totalTokens = dedupedSessions.reduce((sum, s) => sum + sessionTokenTotal(s), 0)
    onProgress('finalizing', 1, String(totalTokens))

    return { statsCache, projects, allSessions: [] as [], sessions: dedupedSessions, healthIssues, homeDir: HOME_DIR, harnesses: Array.from(harnessSet), userStatsCaches, machineStatsCaches, machineOwners, workflows }
  }

  return Promise.race([
    buildPromise(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out after 5 minutes')), timeoutMs)
    ),
  ])
}

async function _buildApiResponse(): Promise<ApiResponse> {
  return _buildApiResponseCore(() => {})
}

// Pub/sub: multiple concurrent stream requests (e.g. React Strict Mode double-firing effects)
// share one real computation instead of fake progress timers.
const _progressListeners = new Set<ProgressFn>()
const _progressSnapshot: Record<string, { progress: number; detail?: string }> = {}

function _broadcastProgress(stage: string, progress: number, detail?: string) {
  _progressSnapshot[stage] = { progress, detail }
  for (const fn of _progressListeners) {
    try { fn(stage, progress, detail) } catch { /* subscriber disconnected */ }
  }
}

/** Streams a build with real per-stage progress. Concurrent callers share one computation. */
export async function buildApiResponseStream(onProgress: ProgressFn): Promise<ApiResponse> {
  const STAGES = ['statsCache', 'sessions', 'health', 'projects', 'finalizing'] as const

  // A result already exists (fresh OR stale) — mark every stage done and serve it instantly. If it's
  // stale, refresh in the background; the caller still gets the cached result now (no 44s wait).
  if (_status === 'done' && _promise) {
    for (const s of STAGES) onProgress(s, 1)
    if (Date.now() - _resolvedAt >= CACHE_TTL_MS) revalidateInBackground()
    return _promise
  }

  // Computation in flight — subscribe to real progress. Replay snapshot for already-done stages.
  if (_status === 'computing' && _promise) {
    for (const [stage, snap] of Object.entries(_progressSnapshot)) {
      onProgress(stage, snap.progress, snap.detail)
    }
    _progressListeners.add(onProgress)
    try {
      return await _promise
    } finally {
      _progressListeners.delete(onProgress)
    }
  }

  // Fresh computation — broadcast real progress to all subscribers
  _progressListeners.clear()
  for (const k of Object.keys(_progressSnapshot)) delete _progressSnapshot[k]
  _progressListeners.add(onProgress)

  _status = 'computing'
  _promise = _buildApiResponseCore(_broadcastProgress)
    .then(result => {
      _status = 'done'
      _resolvedAt = Date.now()
      _progressListeners.clear()
      return result
    })
    .catch(err => {
      _status = 'idle'
      _promise = null
      _progressListeners.clear()
      throw err
    })
  return _promise
}

