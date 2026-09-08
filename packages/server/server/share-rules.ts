/**
 * share-rules.ts — PURE. Decides what a single central connection may receive.
 *
 * Contract: no I/O, no Mongo, no `preferences`, no `config`. Only @agentistics/core types
 * and helpers. Everything here is unit-tested against fixtures, because a mistake in this
 * file leaks a repository the user believes is hidden.
 *
 * Fail-closed is the rule everywhere: when attribution is uncertain, the session is NOT
 * shared. A privacy control that guesses in the permissive direction is not a control.
 */

import { createHash } from 'node:crypto'
import { NO_REPO_KEY, normalizeGitRemote, emptyStatsCache, sessionDay as dayOfStartTime } from '@agentistics/core'
import type { SessionMeta, WorkflowRun, StatsCache, ShareSource } from '@agentistics/core'

export type RepoKey = string

/**
 * Case- and alias-folded comparison key. `normalizeGitRemote` lowercases the host but
 * PRESERVES path case and does not alias SSH front doors, so the same repo cloned as
 * `git@github.com:Acme/API.git` and as `https://github.com/acme/api` would otherwise produce
 * two keys — two picker rows, two independent rules, and blocking the one the user
 * recognizes leaves the other shared.
 *
 * This folding lives HERE and not in `normalizeGitRemote`, which also keys the Repositories
 * page and tags: changing it there has a blast radius this feature does not need.
 */
export function canonicalRepoKey(key: string): RepoKey {
  const lower = (key ?? '').toLowerCase()
  if (!lower) return ''
  const slash = lower.indexOf('/')
  if (slash <= 0) return lower
  const host = lower.slice(0, slash).replace(/^(ssh|altssh)\./, '')
  return host + lower.slice(slash)
}

/** The stored denylist → a canonical lookup set. Junk is dropped; '' folds to the sentinel
 *  for backward compatibility, but only '__no_repo__' is ever persisted. */
export function normalizeDenied(denied: readonly string[] | null | undefined): Set<RepoKey> {
  const out = new Set<RepoKey>()
  for (const raw of denied ?? []) {
    if (typeof raw !== 'string') continue
    if (raw === NO_REPO_KEY || raw === '') { out.add(NO_REPO_KEY); continue }
    const key = canonicalRepoKey(normalizeGitRemote(raw))
    if (key) out.add(key)
  }
  return out
}

export function hasRestrictions(denied: readonly string[] | null | undefined): boolean {
  return normalizeDenied(denied).size > 0
}

export interface PathRepoIndex {
  /** project_path → the remote it resolves to (canonical). */
  resolved: Map<string, RepoKey>
  /** project_path → every distinct remote ever seen under it, when more than one. */
  conflicts: Map<string, Set<RepoKey>>
}

type ProjectLike = { path: string; gitRemote?: string }

/**
 * Learn path → remote from sessions that carry one AND from ServerProject.gitRemote.
 *
 * The project seed is load-bearing: only the Copilot adapter sets `git_remote` among the
 * non-Claude adapters, and data.ts runs its persisted backfill against the Claude-only
 * session array before the harness merge — so the consolidate store carries every Codex /
 * Gemini / Kimi / agy session with no remote, permanently. A directory used exclusively by a
 * non-Claude harness has no session to learn from; the project record does.
 */
export function buildPathRepoIndex(
  sessions: readonly SessionMeta[],
  projects?: readonly ProjectLike[],
): PathRepoIndex {
  const resolved = new Map<string, RepoKey>()
  const seen = new Map<string, Set<RepoKey>>()

  const observe = (path: string, remote: string | undefined) => {
    if (!path) return
    const key = canonicalRepoKey(normalizeGitRemote(remote))
    if (!key) return
    if (!resolved.has(path)) resolved.set(path, key)
    const set = seen.get(path) ?? new Set<RepoKey>()
    set.add(key)
    seen.set(path, set)
  }

  for (const s of sessions) observe(s.project_path, s.git_remote)
  for (const p of projects ?? []) observe(p.path, p.gitRemote)

  const conflicts = new Map<string, Set<RepoKey>>()
  for (const [path, set] of seen) if (set.size > 1) conflicts.set(path, set)
  return { resolved, conflicts }
}

/** The repo bucket a session belongs to. Never returns ''. */
export function repoKeyOf(
  s: Pick<SessionMeta, 'git_remote' | 'project_path'>,
  index?: PathRepoIndex,
): RepoKey {
  // Re-normalizing is idempotent and cheap insurance against a legacy consolidate-store
  // entry written before remotes were normalized.
  const own = canonicalRepoKey(normalizeGitRemote(s.git_remote))
  if (own) return own
  const viaPath = index?.resolved.get(s.project_path)
  if (viaPath) return viaPath
  return NO_REPO_KEY
}

/**
 * A rule set as `sessionShared` consumes it: a mode plus the sources it applies to, each keyed
 * as `${type}:${value}` — `repo:<canonical key>`, `project:<project_path>`, or the fixed
 * `none:` bucket (value is always `''` for that type). Building this Set is the caller's job
 * (e.g. from `ShareSource[]`); this module only ever reads it.
 */
export interface ShareRules {
  mode: 'denylist' | 'allowlist'
  sources: ReadonlySet<string>
}

/** The `repo` / `none` source key for a resolved repo bucket. Never `repo:${NO_REPO_KEY}` —
 *  the `none` dimension is a distinct type from a repo whose value happens to be the sentinel. */
function repoSourceKey(key: RepoKey): string {
  return key === NO_REPO_KEY ? 'none:' : `repo:${key}`
}

/** The `project` source key for a project path. */
function projectSourceKey(path: string): string {
  return `project:${path}`
}

/** Whether a session matches ANY source, on either dimension. Path ambiguity (`conflictPaths`)
 *  is handled by the caller, one repo key at a time — it is a repo-dimension concern only. */
function matchesAnySource(
  s: Pick<SessionMeta, 'git_remote' | 'project_path'>,
  sources: ReadonlySet<string>,
  index?: PathRepoIndex,
): boolean {
  if (sources.has(repoSourceKey(repoKeyOf(s, index)))) return true
  if (s.project_path && sources.has(projectSourceKey(s.project_path))) return true
  return false
}

/**
 * A session is shared according to `rules.mode`:
 * - **denylist**: shared iff it matches NO source, AND — when its directory is known to hold
 *   more than one repo — none of those repos is a denied source either.
 * - **allowlist**: shared iff it matches SOME source, AND — same ambiguous-directory case —
 *   every repo that could be behind that path is an allowed source too.
 *
 * `scanProjectDir` stamps one remote on every session of a directory and `getProjectGitStats`
 * even scans one level of subdirectories for workspace folders, so a workspace holding a
 * shared and a blocked repo would otherwise ship the blocked repo's `first_prompt` and
 * `title` under the shared key. Annotating the ambiguity and sharing anyway is a fail-open —
 * hence the conflict check runs in BOTH modes, fail-closed each time.
 */
export function sessionShared(
  s: Pick<SessionMeta, 'git_remote' | 'project_path'>,
  rules: ShareRules,
  index?: PathRepoIndex,
): boolean {
  const { mode, sources } = rules
  const conflict = index?.conflicts.get(s.project_path)

  if (mode === 'allowlist') {
    // Empty sources means nothing is listed — the reading that leaks is "no restriction".
    if (sources.size === 0) return false
    if (!matchesAnySource(s, sources, index)) return false
    if (conflict) for (const key of conflict) if (!sources.has(repoSourceKey(key))) return false
    return true
  }

  // denylist
  if (sources.size === 0) return true
  if (matchesAnySource(s, sources, index)) return false
  if (conflict) for (const key of conflict) if (sources.has(repoSourceKey(key))) return false
  return true
}

/** The legacy denylist-of-repo-keys shape, adapted into a `ShareRules` for `sessionShared`.
 *  Every existing caller in this file (and every caller outside it, unchanged by this task)
 *  still passes a plain `ReadonlySet<RepoKey>` denylist — this is the one place that gets
 *  translated into the new `${type}:${value}` keying, so their behavior is inherited exactly. */
export function denylistRules(denied: ReadonlySet<RepoKey>): ShareRules {
  const sources = new Set<string>()
  for (const key of denied) sources.add(repoSourceKey(key))
  return { mode: 'denylist', sources }
}

// ---------------------------------------------------------------------------
// Task 4 — the typed-source shape (`mode` + `ShareSource[]`) the routes now carry.
//
// The legacy denylist-of-repo-keys functions above stay exactly as they were — every existing
// caller (and every existing test) keeps behaving identically. These siblings are the general
// case: a source is `repo` (a canonical remote key), `project` (a project_path) or `none` (the
// unattributed bucket), and the mode can be `denylist` OR `allowlist`. `sessionShared` (above)
// already accepts this shape directly (`ShareRules`); everything below is plumbing that turns the
// PERSISTED `TeamConnection.sources`/`shareMode` into that shape, and the handful of list-level
// operations (filter, denied-id set, signature) `team-rules.ts`/`team-uploader.ts` need built from
// it — the same operations `filterShared`/`deniedSessionIds`/`denialSignature` provide for the
// legacy shape, so the two dimensions and two modes reach every downstream consumer identically.
// ---------------------------------------------------------------------------

/** The canonical `${type}:${value}` key for a single typed source — the same keying
 *  `ShareRules.sources` expects. Repo values are folded through `canonicalRepoKey`/
 *  `normalizeGitRemote`, exactly like the legacy denylist, so the same repository entered via two
 *  URL forms still collapses to one rule. Project values compare verbatim — `project_path` is
 *  already a stable, canonical string (see data.ts). `none` always keys as the fixed `none:`
 *  bucket, ignoring whatever `value` happens to hold. Junk (an unresolvable repo, a blank project
 *  path) returns `null` and is dropped by every caller below — the API boundary is expected to
 *  have already rejected it; this is the second, defensive layer. */
function sourceKey(source: ShareSource): string | null {
  if (!source || typeof source.value !== 'string') return null
  if (source.type === 'none') return 'none:'
  if (source.type === 'repo') {
    const key = canonicalRepoKey(normalizeGitRemote(source.value))
    return key ? repoSourceKey(key) : null
  }
  if (source.type === 'project') {
    return source.value ? projectSourceKey(source.value) : null
  }
  return null
}

/** The stored typed source list → the canonical key Set `sessionShared`'s `ShareRules.sources`
 *  consumes. Order-, case- and normalization-independent; junk entries are dropped. */
export function normalizeSources(sources: readonly ShareSource[] | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const raw of sources ?? []) {
    const key = sourceKey(raw)
    if (key) out.add(key)
  }
  return out
}

/** Build the `ShareRules` `sessionShared` (and everything below) consumes from a connection's
 *  stored mode + typed sources. `mode` absent/junk reads as `'denylist'` — the same default
 *  `@agentistics/core`'s `migrateTeamConfig` applies, so a connection read straight off disk and
 *  one read through this function agree. The one place that does this translation. */
export function shareRulesOf(
  mode: 'denylist' | 'allowlist' | undefined,
  sources: readonly ShareSource[] | undefined,
): ShareRules {
  return { mode: mode === 'allowlist' ? 'allowlist' : 'denylist', sources: normalizeSources(sources) }
}

/** Whether this connection currently applies ANY restriction. Allowlist mode is ALWAYS a
 *  restriction — even an EMPTY allowlist is the strictest possible case (shares nothing), not the
 *  absence of one. Denylist mode is a restriction only once it names at least one source, exactly
 *  like the legacy `hasRestrictions`. */
export function sourcesRestrict(
  mode: 'denylist' | 'allowlist' | undefined,
  sources: readonly ShareSource[] | undefined,
): boolean {
  if (mode === 'allowlist') return true
  return normalizeSources(sources).size > 0
}

/** The fail-closed default applied the moment a DENYLIST connection acquires its first
 *  restriction — mirrors `withUnresolvedDenied`, but scoped to denylist mode only: in allowlist
 *  mode the unattributed bucket is already hidden by default like everything not explicitly
 *  listed, so there is nothing to add. A no-op in allowlist mode and on an empty list (nothing to
 *  attach the sentinel to — the zero→non-zero transition is the caller's job, same as before). */
export function withUnresolvedSources(
  mode: 'denylist' | 'allowlist' | undefined,
  sources: readonly ShareSource[],
): ShareSource[] {
  if (mode === 'allowlist') return [...sources]
  if (sources.length === 0) return []
  return sources.some(s => s.type === 'none') ? [...sources] : [...sources, { type: 'none' as const, value: '' }]
}

/** Stable fingerprint of a connection's rules — mode AND typed sources, order-, case- and
 *  normalization-independent. Unlike `denialSignature` (repo keys only, denylist only), this
 *  covers the mode: switching denylist ↔ allowlist with the exact same source list still changes
 *  the signature, because the set of shared sessions inverts even though `sources` itself did not
 *  change — and the retroactive-removal detector (`planRulesReconcile`) must fire for that. */
export function rulesSignature(
  mode: 'denylist' | 'allowlist' | undefined,
  sources: readonly ShareSource[] | undefined,
): string {
  const m = mode === 'allowlist' ? 'allowlist' : 'denylist'
  const keys = [...normalizeSources(sources)].sort()
  return createHash('sha256').update(m + '\n' + keys.join('\n')).digest('hex')
}

/** `rulesSignature` for "no rules have ever been declared" — the one sentinel value a missing
 *  `rulesHash` reads as (team-rules.ts rule 2), computed once so `team-rules.ts`,
 *  `team-connections.ts` and `team-migrate.ts` can never drift apart on what that sentinel is. */
export function emptyRulesSignature(): string {
  return rulesSignature('denylist', [])
}

export function filterSharedRules<T extends Pick<SessionMeta, 'git_remote' | 'project_path'>>(
  sessions: readonly T[],
  rules: ShareRules,
  index?: PathRepoIndex,
): T[] {
  return sessions.filter(s => sessionShared(s, rules, index))
}

/** Sessions the CURRENT rules actively exclude — the general-shape sibling of
 *  `deniedSessionIds`, same "denial, never absence" contract. */
export function deniedSessionIdsRules(
  sessions: readonly SessionMeta[],
  rules: ShareRules,
  index?: PathRepoIndex,
): Set<string> {
  const out = new Set<string>()
  for (const s of sessions) {
    if (s.session_id && !sessionShared(s, rules, index)) out.add(s.session_id)
  }
  return out
}

export function filterShared<T extends Pick<SessionMeta, 'git_remote' | 'project_path'>>(
  sessions: readonly T[],
  denied: ReadonlySet<RepoKey>,
  index?: PathRepoIndex,
): T[] {
  if (denied.size === 0) return [...sessions]
  const rules = denylistRules(denied)
  return sessions.filter(s => sessionShared(s, rules, index))
}

/**
 * What a restricted connection may learn about the assistants running RIGHT NOW.
 *
 * The reverse channel (`team-agent-client.ts` → `team-live.ts`) is a second way out of this
 * machine, and it used to bypass the denylist entirely: the uploader withheld a repo's metrics
 * while the live reporter kept announcing that repo's `session_id` every 8 seconds — and the
 * `cwd` of any process too new to have a transcript. Withholding the metrics of a repo whose
 * name and activity you broadcast is not a privacy control. Every outbound path applies the
 * same rule, so this one runs through `sessionShared` like the uploader does.
 *
 * Fail-closed on ALL THREE halves, which is stricter than `filterShared` and deliberately so:
 *
 * - A live id whose session we cannot find is dropped. It cannot be attributed to a repo, and
 *   the central could not render it anyway (it resolves live ids against the sessions it was
 *   pushed), so keeping it only ever leaked an identifier for a row nobody could see.
 * - An ACTIVITY is keyed by `session_id` and is judged by that same predicate, key by key. It
 *   used to be sent unfiltered beside the two filtered fields, so a withheld repo's session
 *   announced its id AND its state (`working` / `waiting` / `waiting-approval` / `exited`) every
 *   8 seconds — enough to count a hidden project's sessions and watch them work. That the
 *   central most likely has no document to render it against is a statement about today's
 *   rendering, not about the boundary.
 * - A process is reported only when its `cwd` resolves POSITIVELY to a repo that is not denied.
 *   A process has no session to attribute, and `cwd` is the sensitive field here — a path is
 *   often the repo name. Under restrictions an unrecognized directory is withheld rather than
 *   assumed innocent.
 *
 * ONE function decides the whole `live-sessions` FRAME. The caller must never assemble a field of
 * that message beside this result — that is exactly how the activities came to be sent unfiltered
 * — so anything added to the live message is added here, where the rule already lives.
 *
 * **It is not, and never was, a statement about the SOCKET.** `live-sessions` was the only
 * member→central send when this was written; the machine-fleet relay now sends three more
 * (`sessions/machine-fleet.ts`), and they carry their own application of `cwdShared` — the read
 * half filtering rows, the act half refusing a verb aimed at a row this connection cannot see. Both
 * halves of that relay must keep going through `cwdShared`; the act half once did not, and a
 * central could drive `kill` / `rename` / `resume` against a withheld session.
 *
 * With no restrictions the snapshot passes through untouched — the common case pays nothing.
 */
/**
 * May something known only by its DIRECTORY be shown to this central?
 *
 * The rule for anything that has a `cwd` and no session to attribute it to: a live process, and a
 * row of the session fleet relayed to a machine's owning account. It is deliberately stricter than
 * `sessionShared`, and the reason is worth keeping: **positive resolution only**. `repoKeyOf` falls
 * back to `NO_REPO_KEY` for an unknown path, which under a denylist reads as "shared" unless the
 * user also denied the no-repo bucket — and `cwd` is the sensitive field here, because a path is
 * usually the repository's name. So an unrecognized directory is withheld in BOTH modes.
 *
 * Extracted from `filterLiveShared`, which now calls it, so the relayed fleet and the live-session
 * snapshot cannot drift into two different answers about the same directory.
 */
export function cwdShared(cwd: string, rules: ShareRules, index?: PathRepoIndex): boolean {
  // An unrestricted denylist shares everything; an allowlist NEVER takes this shortcut, because an
  // empty one is the strictest rule there is rather than the absence of one.
  if (rules.mode === 'denylist' && rules.sources.size === 0) return true
  const key = index?.resolved.get(cwd)
  if (!key) return false
  const matched = rules.sources.has(repoSourceKey(key)) || rules.sources.has(projectSourceKey(cwd))
  return rules.mode === 'allowlist' ? matched : !matched
}

export function filterLiveShared<
  P extends { cwd: string },
  A extends string = 'working' | 'waiting' | 'waiting-approval' | 'exited',
>(
  snapshot: {
    liveSessionIds: readonly string[]
    liveProcesses: readonly P[]
    liveSessionActivities?: Readonly<Record<string, A>> | null
  },
  sessions: readonly Pick<SessionMeta, 'session_id' | 'git_remote' | 'project_path'>[],
  rules: ShareRules,
  index?: PathRepoIndex,
): { liveSessionIds: string[]; liveProcesses: P[]; liveSessionActivities: Record<string, A> } {
  // Only an unrestricted DENYLIST passes the snapshot through. An allowlist is always a
  // restriction — an empty one shares nothing — so it must never take this shortcut.
  if (rules.mode === 'denylist' && rules.sources.size === 0) {
    return {
      liveSessionIds: [...snapshot.liveSessionIds],
      liveProcesses: [...snapshot.liveProcesses],
      liveSessionActivities: { ...(snapshot.liveSessionActivities ?? {}) },
    }
  }
  const byId = new Map(sessions.map(s => [s.session_id, s]))
  const idShared = (id: string): boolean => {
    const s = byId.get(id)
    return !!s && sessionShared(s, rules, index)
  }
  const liveSessionIds = snapshot.liveSessionIds.filter(idShared)
  // Judged key by key against the rule, never by intersecting with `liveSessionIds` above: that
  // would inherit whatever that list happens to hold rather than asking the question, and an
  // activity for an id the snapshot did not list would then pass on a technicality.
  const liveSessionActivities: Record<string, A> = {}
  for (const [id, activity] of Object.entries(snapshot.liveSessionActivities ?? {})) {
    if (idShared(id)) liveSessionActivities[id] = activity as A
  }
  const liveProcesses = snapshot.liveProcesses.filter(p => cwdShared(p.cwd, rules, index))
  return { liveSessionIds, liveProcesses, liveSessionActivities }
}

/**
 * Sessions the denylist ACTIVELY excludes — the only legitimate removal trigger.
 *
 * Never define this as "in the sent-state but absent from the store": `loadConsolidated()`
 * swallows every error and returns empty, `writeConsolidated` writes non-atomically from the
 * same process, and a container can start before its bind mount is ready. Any of those makes
 * a cycle read short, and an absence-based trigger would then ask the central to delete
 * perfectly valid sessions and drop them from the sent-state — silent, permanent loss.
 */
export function deniedSessionIds(
  sessions: readonly SessionMeta[],
  denied: ReadonlySet<RepoKey>,
  index?: PathRepoIndex,
): Set<string> {
  const out = new Set<string>()
  if (denied.size === 0) return out
  const rules = denylistRules(denied)
  for (const s of sessions) {
    if (s.session_id && !sessionShared(s, rules, index)) out.add(s.session_id)
  }
  return out
}

export function sharedSessionIds(sessions: readonly Pick<SessionMeta, 'session_id'>[]): Set<string> {
  const out = new Set<string>()
  for (const s of sessions) if (s.session_id) out.add(s.session_id)
  return out
}

/**
 * A workflow run has no repo of its own — it is shared iff its owning session is, and a run
 * whose session is unknown is DROPPED. `WorkflowRun` carries `name`, `phases`,
 * `agents[].label` and `totals`, which leak task descriptions and cost.
 */
export function filterSharedWorkflows(
  runs: readonly WorkflowRun[],
  sharedIds: ReadonlySet<string>,
): WorkflowRun[] {
  return runs.filter(r => !!r.sessionId && sharedIds.has(r.sessionId))
}

/**
 * The fail-closed default applied the moment a connection acquires its FIRST restriction.
 *
 * Unresolved is not the same fact as new. The sentinel covers remote-less folders, every
 * non-Claude session whose adapter never sets a remote, and store entries written before
 * remote stamping — all of which carry `project_path`, `first_prompt`, `title` and cost.
 * It is written into the PERSISTED list (never applied as a hidden runtime rule) so the
 * picker can show it pre-blocked and the user can deliberately un-block it.
 */
export function withUnresolvedDenied(denied: readonly string[]): string[] {
  if (denied.length === 0) return []
  return denied.includes(NO_REPO_KEY) ? [...denied] : [...denied, NO_REPO_KEY]
}

/** Stable fingerprint of a denylist — order-, case- and normalization-independent. */
export function denialSignature(denied: readonly string[] | null | undefined): string {
  const keys = [...normalizeDenied(denied)].sort()
  return createHash('sha256').update(keys.join('\n')).digest('hex')
}

// ---------------------------------------------------------------------------
// The per-session gates, defined ONCE.
//
// `accumulateClaudeSessions`, `deniedDeltaByDay` and `sumUsage` must agree exactly: the terms
// they produce are subtracted from one another. They used to carry three hand-written copies of
// the same four checks under a comment claiming they "mirror exactly" — an edit to one copy is a
// silent under-subtraction, which is the FAIL-OPEN direction (a denied repo's tokens ride out).
// ---------------------------------------------------------------------------

/** The day a session contributes to, or `null` when it contributes to nothing.
 *  `claudeOnly` is false only for data.ts's supplement path, which runs before the harness
 *  merge and therefore only ever sees Claude sessions anyway. */
function sessionDay(s: Pick<SessionMeta, 'start_time' | 'harness'>, claudeOnly = true): string | null {
  if (!s.start_time) return null
  if (claudeOnly && (s.harness ?? 'claude') !== 'claude') return null
  return dayOfStartTime(s.start_time) || null
}

/** Session START hour on the LOCAL clock, like every adapter (reading a UTC timestamp as local
 *  put the peak-usage chart hours off for four harnesses once already). `null` when unparseable. */
function sessionHour(s: Pick<SessionMeta, 'start_time'>): number | null {
  const hour = new Date(s.start_time).getHours()
  return Number.isFinite(hour) ? hour : null
}

interface SessionTokens {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** The token gate: only a `claude-` model id with a nonzero four-field sum contributes tokens.
 *  `null` means "this session contributes activity but no tokens". */
function sessionTokens(s: SessionMeta): SessionTokens | null {
  const model = s.model
  if (!model || !model.startsWith('claude-')) return null
  const input = s.input_tokens ?? 0
  const output = s.output_tokens ?? 0
  const cacheRead = s.cache_read_input_tokens ?? 0
  const cacheWrite = s.cache_creation_input_tokens ?? 0
  const total = input + output + cacheRead + cacheWrite
  if (total === 0) return null
  return { model, input, output, cacheRead, cacheWrite, total }
}

export interface ClaudeAccumulator {
  dailyActivity: Map<string, { messageCount: number; sessionCount: number; toolCallCount: number }>
  dailyModel: Map<string, Map<string, number>>
  modelTotals: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
  /** Session START hour (0-23) → count. NOT message hours — see buildSharedStatsCache. */
  hourCounts: Map<number, number>
  totalSessions: number
  totalMessages: number
  /** Earliest ISO start_time seen, '' when none. */
  firstStart: string
}

/**
 * The accumulation core, extracted from data.ts's supplementStatsCache so the supplement path
 * and the connection-scoped build cannot drift apart.
 *
 * @param opts.after      skip days `<= after` (the caller's lastComputedDate watermark)
 * @param opts.claudeOnly drop non-Claude sessions entirely. FALSE for data.ts, which is called
 *                        before the harness merge and therefore only ever sees Claude sessions;
 *                        TRUE for buildSharedStatsCache, which is handed the whole store.
 */
export function accumulateClaudeSessions(
  sessions: readonly SessionMeta[],
  opts?: { after?: string; claudeOnly?: boolean },
): ClaudeAccumulator {
  const after = opts?.after ?? ''
  const claudeOnly = opts?.claudeOnly ?? false

  const acc: ClaudeAccumulator = {
    dailyActivity: new Map(), dailyModel: new Map(), modelTotals: new Map(),
    hourCounts: new Map(), totalSessions: 0, totalMessages: 0, firstStart: '',
  }

  for (const s of sessions) {
    const day = sessionDay(s, claudeOnly)
    if (day === null) continue
    if (after && day <= after) continue

    const messages = (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
    const da = acc.dailyActivity.get(day) ?? { messageCount: 0, sessionCount: 0, toolCallCount: 0 }
    da.messageCount += messages
    da.sessionCount += 1
    da.toolCallCount += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
    acc.dailyActivity.set(day, da)

    acc.totalSessions += 1
    acc.totalMessages += messages
    if (!acc.firstStart || s.start_time < acc.firstStart) acc.firstStart = s.start_time

    const hour = sessionHour(s)
    if (hour !== null) acc.hourCounts.set(hour, (acc.hourCounts.get(hour) ?? 0) + 1)

    const t = sessionTokens(s)
    if (!t) continue

    const byModel = acc.dailyModel.get(day) ?? new Map<string, number>()
    byModel.set(t.model, (byModel.get(t.model) ?? 0) + t.total)
    acc.dailyModel.set(day, byModel)

    const mt = acc.modelTotals.get(t.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    mt.input += t.input; mt.output += t.output; mt.cacheRead += t.cacheRead; mt.cacheWrite += t.cacheWrite
    acc.modelTotals.set(t.model, mt)
  }

  return acc
}

/**
 * A Claude StatsCache derived ONLY from the sessions passed in. Supplies the from-boundary
 * half of the attribution split (Task 6) and stands alone in tests.
 *
 * Field decisions verified against a real ~/.claude/stats-cache.json, not assumed:
 * - `lastComputedDate: ''` — the field asserts "Claude has already rolled up every day to
 *   here". Claiming a watermark this cache cannot back makes any consumer running the
 *   `day <= lastComputed → skip` guard drop legitimate gap-fill.
 * - `hourCounts` counts SESSIONS BY START HOUR (Σ hourCounts === totalSessions on the real
 *   file), not messages.
 * - `modelUsage[].costUSD` and `.webSearchRequests` stay 0 — the real file stores 0 too, and
 *   every consumer prices via calcCost(). A real number here would make this cache behave
 *   DIFFERENTLY from a real one.
 * - `longestSession` is zeroed: the real field is wall-clock ms including idle, while
 *   `duration_minutes` is active time. Synthesizing it puts incompatible units into
 *   mergeStatsCaches's max. Nothing in web/ reads it.
 */
export function buildSharedStatsCache(
  sessions: readonly SessionMeta[],
  opts?: { version?: number },
): StatsCache {
  const acc = accumulateClaudeSessions(sessions, { claudeOnly: true })
  const out = emptyStatsCache()
  if (opts?.version !== undefined) out.version = opts.version

  out.dailyActivity = [...acc.dailyActivity.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date))

  out.dailyModelTokens = [...acc.dailyModel.entries()]
    .map(([date, byModel]) => ({ date, tokensByModel: Object.fromEntries(byModel) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  for (const [model, t] of acc.modelTotals) {
    out.modelUsage[model] = {
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadInputTokens: t.cacheRead,
      cacheCreationInputTokens: t.cacheWrite,
      webSearchRequests: 0,
      costUSD: 0,
    }
  }

  out.totalSessions = acc.totalSessions
  out.totalMessages = acc.totalMessages
  out.firstSessionDate = acc.firstStart
  out.hourCounts = Object.fromEntries([...acc.hourCounts.entries()].map(([h, c]) => [String(h), c]))
  return out
}

/** UTC day arithmetic on a YYYY-MM-DD string. '' for anything unparseable. */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The first day whose cache rows are session-derived, and therefore decomposable by repository:
 * the day AFTER Claude's rollup watermark.
 *
 * Measured, not assumed: for every day at or before `lastComputedDate` the consolidate store is a
 * strict SUBSET of Claude's rollup (4 stored sessions against 9 rolled up on one real day; per-day
 * reconciliation matched 0 of 23 days), so those rows cannot be decomposed by anyone — including
 * this machine. Every later day is written by `supplementStatsCache` from the very session set this
 * module filters, so rebuilding it from `shared` is exact and the date-less subtraction reconciles
 * by construction.
 *
 * `''` means Claude has rolled up nothing, so the entire cache is gap-filled and EVERY day is
 * decomposable. It is not a refusal signal — treat it as "everything decomposable".
 *
 * `null` means a watermark IS present but could not be parsed as a calendar day. This is a
 * DIFFERENT fact from "nothing rolled up" and must not collapse into `''`: an unparseable
 * watermark says nothing about which days are session-derived, so `buildSplitStatsCache` must
 * refuse rather than treat the whole cache as decomposable (which would rebuild every rollup
 * row from the store's necessarily-partial subset) or as entirely prehistory (which would ship
 * the rollup verbatim, denylist and all).
 */
export function attributionBoundary(real: StatsCache): string | null {
  const watermark = real?.lastComputedDate ?? ''
  if (!watermark) return ''
  const next = nextDay(watermark)
  return next || null
}

/** What the denylist excluded from one day, measured while that day was still decomposable. */
export interface DeniedDayDelta {
  sessionCount: number
  messageCount: number
  toolCallCount: number
  tokensByModel: Record<string, number>
  usageByModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
  hourCounts: Record<string, number>
}
export type DeniedLedger = Record<string, DeniedDayDelta>

/**
 * Per-day denied contribution over the decomposable window (`day >= boundary`). Pure.
 * Mirrors `accumulateClaudeSessions`'s gates exactly — harness, start_time, the `claude-` model
 * id and the zero-token continue — so the two can be subtracted from each other.
 *
 * This is a LOWER BOUND for a denied session whose `model` is missing, not a `claude-` id, or
 * whose four token fields sum to zero: `tokensByModel` / `usageByModel` skip that session (the
 * `continue` below), yet Claude's own rollup DOES attribute whatever tokens it recorded once the
 * day crosses the watermark. The gap between what this function measures and what the rollup
 * later reports is real and cannot be closed from session data — those tokens stay in the pushed
 * cache permanently, sealed or not. `sessionCount` / `messageCount` / `toolCallCount` /
 * `hourCounts` have no such gap: they come straight off the session record.
 */
export function deniedDeltaByDay(
  allStored: readonly SessionMeta[],
  shared: readonly SessionMeta[],
  boundary: string | null,
): DeniedLedger {
  const keep = sharedSessionIds(shared)
  const out: DeniedLedger = {}
  for (const s of allStored) {
    const day = sessionDay(s)
    if (day === null) continue
    if (boundary && day < boundary) continue
    if (!s.session_id || keep.has(s.session_id)) continue

    const d = out[day] ?? (out[day] = {
      sessionCount: 0, messageCount: 0, toolCallCount: 0,
      tokensByModel: {}, usageByModel: {}, hourCounts: {},
    })
    d.sessionCount += 1
    d.messageCount += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
    d.toolCallCount += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
    const hour = sessionHour(s)
    if (hour !== null) {
      const k = String(hour)
      d.hourCounts[k] = (d.hourCounts[k] ?? 0) + 1
    }

    const t = sessionTokens(s)
    if (!t) continue
    d.tokensByModel[t.model] = (d.tokensByModel[t.model] ?? 0) + t.total
    const u = d.usageByModel[t.model] ?? (d.usageByModel[t.model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    u.input += t.input; u.output += t.output; u.cacheRead += t.cacheRead; u.cacheWrite += t.cacheWrite
  }
  return out
}

/**
 * Advance the seal as Claude's watermark moves.
 *
 * A day filtered today joins the undecomposable rollup tomorrow, and the denied repository's volume
 * for it would silently start shipping. So the delta measured while the day was still decomposable
 * is sealed as it crosses, and subtracted from the rollup row forever after. A day already sealed is
 * never re-sealed — the first measurement was taken when the day was fully session-derived, and any
 * later one would be taken against a store that is now a subset.
 *
 * CALLER CONTRACT: this must be invoked on EVERY push cycle, without skipping one. A day only
 * seals while it is still in `prev.pending` and the boundary has just passed it; a skipped cycle
 * whose window spans both — the day entering `pending` AND crossing the boundary — loses that
 * day's seal forever, and its denied volume ships once the day becomes prehistory.
 */
export function advanceSeal(
  prev: { sealed: DeniedLedger; pending: DeniedLedger },
  fresh: DeniedLedger,
  boundary: string | null,
): { sealed: DeniedLedger; pending: DeniedLedger } {
  const sealed: DeniedLedger = { ...(prev.sealed ?? {}) }
  for (const [day, delta] of Object.entries(prev.pending ?? {})) {
    if (boundary && day < boundary && !sealed[day]) sealed[day] = delta
  }
  return { sealed, pending: { ...fresh } }
}

/**
 * Sessions Claude has already rolled up — the size of the block no rule can split.
 *
 * `null` when the boundary is unusable (a present but unparseable watermark). That is a
 * different fact from "nothing precedes the boundary", and it feeds a user-facing confirm
 * dialog: reporting 0 there would tell the user no unfilterable block exists when the truth is
 * that its size is unknown. `''` (Claude rolled up nothing) genuinely means 0.
 */
export function prehistoryCount(real: StatsCache, boundary: string | null): number | null {
  if (boundary === null) return null
  if (boundary === '') return 0
  return (real?.dailyActivity ?? [])
    .filter(d => d.date < boundary)
    .reduce((a, d) => a + d.sessionCount, 0)
}

/**
 * Does any DENIED repo have a stored CLAUDE session inside the rollup window? Drives the specific
 * variant of the confirm copy. A false answer is not proof of absence — the store holds only a
 * subset of that window — which is why the generic copy is always shown too.
 *
 * `null` when the boundary is unusable (present but unparseable watermark): the question cannot
 * be answered at all, and answering `false` would put the reassuring copy in front of the user on
 * no evidence. `''` (nothing rolled up) means there IS no rollup window, hence a real `false`.
 */
export function deniedTouchesPrehistory(
  allStored: readonly SessionMeta[],
  denied: ReadonlySet<RepoKey>,
  boundary: string | null,
  index?: PathRepoIndex,
): boolean | null {
  if (boundary === null) return null
  if (boundary === '' || denied.size === 0) return false
  const rules = denylistRules(denied)
  for (const s of allStored) {
    const day = sessionDay(s)
    if (day === null || day >= boundary) continue
    if (!sessionShared(s, rules, index)) return true
  }
  return false
}

/** Per-model token totals over the days `>= from`. No hour map: `hourCounts` describes the
 *  rollup alone and never gains a term from the decomposable window (§4.3b). */
function sumUsage(sessions: readonly SessionMeta[], from: string) {
  const totals = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>()
  for (const s of sessions) {
    const day = sessionDay(s)
    if (day === null || day < from) continue
    const t = sessionTokens(s)
    if (!t) continue
    const acc = totals.get(t.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    acc.input += t.input; acc.output += t.output; acc.cacheRead += t.cacheRead; acc.cacheWrite += t.cacheWrite
    totals.set(t.model, acc)
  }
  return { totals }
}

/**
 * The cache a RESTRICTED connection pushes.
 *
 * Days `>= boundary` are rebuilt from `shared`. Earlier days are Claude's rollup row minus their
 * sealed delta, or verbatim when unsealed. `hourCounts`, `totalSessions` and `totalMessages` are
 * NOT gap-filled by `supplementStatsCache`, so they describe the rollup alone — they are reduced by
 * the seal and never gain a `kept` term. Every value is copied, summed or subtracted; nothing is
 * estimated, ratioed or prorated.
 *
 * PRECONDITION: `real` was supplemented from the SAME session array passed here as `allStored`.
 * It is CHECKED, not trusted — a store that has shrunk between the two reads (files pruned, a
 * partial store re-read) is refused below, because the lost day's row would vanish from the
 * output while `real.modelUsage` still carried its tokens: a fail-open for a denied repo.
 *
 * Returns null rather than an unsplit or inconsistent cache when:
 * - `real` is missing,
 * - the store yields no Claude session while `real` reports data (cold-store signature),
 * - a decomposable day (`>= boundary`) present in `real` has no Claude session left in the store
 *   (partial shrinkage — the precondition above),
 * - `boundary` is `null` — a watermark IS present but could not be parsed, which is a fact
 *   distinct from "nothing rolled up" and must not be treated as either extreme, or
 * - `real` is self-contradictory: no watermark (`lastComputedDate === ''`) yet it still reports a
 *   nonzero `totalSessions` or a non-empty `hourCounts` — both of which describe the rollup ALONE
 *   and must be zero when there is no rollup.
 */
export function buildSplitStatsCache(input: {
  real: StatsCache
  allStored: readonly SessionMeta[]
  shared: readonly SessionMeta[]
  boundary: string | null
  sealed: DeniedLedger
}): StatsCache | null {
  const { real, allStored, shared, boundary, sealed } = input
  if (!real) return null

  // An unparseable (but present) watermark says nothing about which days are session-derived.
  if (boundary === null) return null

  // No watermark means no rollup: totalSessions/hourCounts describe the rollup alone and must be
  // zero. A cache claiming otherwise is internally inconsistent input, not a valid empty rollup.
  if (!real.lastComputedDate && ((real.totalSessions ?? 0) > 0 || Object.keys(real.hourCounts ?? {}).length > 0)) {
    return null
  }

  // Cold-store signature: a populated cache while the store yields no Claude session means the
  // store was not read, not that the machine did nothing. Push nothing rather than the unsplit cache.
  const realHasData = (real.dailyActivity?.length ?? 0) > 0 || (real.totalSessions ?? 0) > 0
  const storeHasClaude = allStored.some(s => !!s.start_time && (s.harness ?? 'claude') === 'claude')
  if (realHasData && !storeHasClaude) return null

  // boundary '' means Claude rolled up nothing, so NO day is prehistory.
  const isPrehistory = (day: string) => boundary !== '' && day < boundary

  // PARTIAL store shrinkage — the precondition above, made cheaply detectable here rather than
  // trusted. Every decomposable day the cache reports must still have a Claude session in the
  // store: the day is rebuilt from `fromShared` alone, so a day the store has lost loses its
  // daily row entirely while `real.modelUsage` still carries its tokens and the `attributable`
  // term subtracts nothing — a denied repo's volume rides out. The cold-store guard above only
  // catches TOTAL loss. Refuse, like every other unsatisfiable case.
  // PRECONDITION, asserted rather than trusted: `real` must have been supplemented from the very
  // array passed as `allStored`. For every decomposable day the cache's rows were WRITTEN by that
  // array, so recomputing them from it must reproduce them exactly.
  //
  // This is not a data-quality check — it is what makes the subtraction sound. A day the store
  // covers only partly still appears, so a presence-only guard passes it: `attributable` then
  // under-subtracts and a denied session's tokens ride out in `modelUsage`, which is the whole
  // fail-open this closes. Measured on a real machine, feeding `loadConsolidated()` here while the
  // cache was supplemented from the live session array made one day disagree (5 stored sessions
  // against 12 in the cache) — exactly the mistake this refuses.
  //
  // Prehistory days are exempt: there the store is legitimately a strict subset of Claude's rollup
  // and reconciliation is impossible by construction (see §4.3b).
  const fromStored = buildSharedStatsCache(allStored)
  const storedActivity = new Map(fromStored.dailyActivity.map(d => [d.date, d]))
  const storedTokens = new Map(fromStored.dailyModelTokens.map(d => [d.date, d.tokensByModel]))

  const sameTokens = (a: Record<string, number>, b: Record<string, number>): boolean => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false
    return true
  }

  for (const d of real.dailyActivity ?? []) {
    if (isPrehistory(d.date)) continue
    const mine = storedActivity.get(d.date)
    if (!mine) return null
    if (mine.sessionCount !== d.sessionCount) return null
    if (mine.messageCount !== d.messageCount) return null
    if (mine.toolCallCount !== d.toolCallCount) return null
  }
  for (const d of real.dailyModelTokens ?? []) {
    if (isPrehistory(d.date)) continue
    const mine = storedTokens.get(d.date)
    if (!mine || !sameTokens(mine, d.tokensByModel)) return null
  }
  // The reverse direction is the same disagreement: a decomposable day the store knows and the
  // cache does not means `real` was built from a smaller set than `allStored`.
  const realActivityDays = new Set((real.dailyActivity ?? []).map(d => d.date))
  for (const d of fromStored.dailyActivity) {
    if (!isPrehistory(d.date) && !realActivityDays.has(d.date)) return null
  }

  const fromShared = buildSharedStatsCache(shared)

  const out = emptyStatsCache()
  out.version = real.version
  out.lastComputedDate = real.lastComputedDate
  // firstSessionDate is an exact ISO timestamp of one session. When boundary === '' the whole
  // cache is session-derived, so the shared set is the only honest source: taking `real`'s there
  // would ship the exact start instant of the machine's earliest session even when that session
  // belongs to a denied repo. With a rollup present the earliest session is prehistory by
  // definition — nothing the rules can reach — and `real` is correct.
  out.firstSessionDate = boundary === '' ? fromShared.firstSessionDate : real.firstSessionDate
  // totalSpeculationTimeSavedMs is copied with NO seal term, deliberately. It is a single global
  // scalar: Claude publishes no daily series for it and SessionMeta carries no per-session
  // equivalent, so there is nothing to measure a denied delta FROM — any subtraction would be an
  // estimate, and §4.3b forbids estimates in the split. It is also repo-blind in substance: a
  // duration total carries no project path, model, name or count that could distinguish one
  // repository from another, unlike the fields that do get sealed.
  out.totalSpeculationTimeSavedMs = real.totalSpeculationTimeSavedMs

  // --- longestSession names a single session; zero it when that session is one we withhold.
  //     Absence from the store (prehistory, whose transcripts are gone) is NOT proof of denial —
  //     only a session present in the store AND excluded from `shared` is zeroed. ---
  const sharedIds = sharedSessionIds(shared)
  const storedIds = sharedSessionIds(allStored)
  const namedSession = real.longestSession?.sessionId ?? ''
  out.longestSession = (namedSession && storedIds.has(namedSession) && !sharedIds.has(namedSession))
    ? { sessionId: '', duration: 0, messageCount: 0, timestamp: '' }
    : { ...real.longestSession }

  // --- dailyActivity: rollup minus seal, then the rebuilt window ---
  const activity = (real.dailyActivity ?? [])
    .filter(d => isPrehistory(d.date))
    .map(d => {
      const seal = sealed?.[d.date]
      if (!seal) return { ...d }
      return {
        date: d.date,
        messageCount: Math.max(0, d.messageCount - seal.messageCount),
        sessionCount: Math.max(0, d.sessionCount - seal.sessionCount),
        toolCallCount: Math.max(0, d.toolCallCount - seal.toolCallCount),
      }
    })
  for (const d of fromShared.dailyActivity) if (!isPrehistory(d.date)) activity.push({ ...d })
  out.dailyActivity = activity.sort((a, b) => a.date.localeCompare(b.date))

  // --- dailyModelTokens: same three-way rule, per model ---
  const daily = (real.dailyModelTokens ?? [])
    .filter(d => isPrehistory(d.date))
    .map(d => {
      const seal = sealed?.[d.date]
      if (!seal) return { date: d.date, tokensByModel: { ...d.tokensByModel } }
      const tokensByModel: Record<string, number> = {}
      for (const [model, value] of Object.entries(d.tokensByModel)) {
        const left = Math.max(0, value - (seal.tokensByModel[model] ?? 0))
        if (left > 0) tokensByModel[model] = left
      }
      return { date: d.date, tokensByModel }
    })
  for (const d of fromShared.dailyModelTokens) if (!isPrehistory(d.date)) daily.push({ date: d.date, tokensByModel: { ...d.tokensByModel } })
  out.dailyModelTokens = daily.sort((a, b) => a.date.localeCompare(b.date))

  // --- modelUsage: real − sealed − attributable + kept, subtraction clamped ---
  const attributable = sumUsage(allStored, boundary)
  const kept = sumUsage(shared, boundary)
  const sealedUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>()
  for (const [day, delta] of Object.entries(sealed ?? {})) {
    // A seal is only meaningful against the prehistory row it was subtracted from. If the
    // boundary ever regresses (a restored backup, a regenerated stats-cache.json with an older
    // watermark), a previously-sealed day can find itself back in the rebuilt-from-shared window,
    // which already excludes the denied session on its own — applying the seal there too would
    // double-subtract.
    if (!isPrehistory(day)) continue
    for (const [model, u] of Object.entries(delta.usageByModel)) {
      const acc = sealedUsage.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      acc.input += u.input; acc.output += u.output; acc.cacheRead += u.cacheRead; acc.cacheWrite += u.cacheWrite
      sealedUsage.set(model, acc)
    }
  }

  const models = new Set([
    ...Object.keys(real.modelUsage ?? {}),
    ...attributable.totals.keys(),
    ...kept.totals.keys(),
    ...sealedUsage.keys(),
  ])
  for (const model of models) {
    const r = real.modelUsage?.[model]
    const a = attributable.totals.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const k = kept.totals.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const sl = sealedUsage.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const usage = {
      inputTokens: Math.max(0, (r?.inputTokens ?? 0) - sl.input - a.input) + k.input,
      outputTokens: Math.max(0, (r?.outputTokens ?? 0) - sl.output - a.output) + k.output,
      cacheReadInputTokens: Math.max(0, (r?.cacheReadInputTokens ?? 0) - sl.cacheRead - a.cacheRead) + k.cacheRead,
      cacheCreationInputTokens: Math.max(0, (r?.cacheCreationInputTokens ?? 0) - sl.cacheWrite - a.cacheWrite) + k.cacheWrite,
      webSearchRequests: 0,
      costUSD: 0,
    }
    if (usage.inputTokens || usage.outputTokens || usage.cacheReadInputTokens || usage.cacheCreationInputTokens) {
      out.modelUsage[model] = usage
    }
  }

  // --- rollup-only fields: reduced by the seal, never given a kept term ---
  let sealedSessions = 0
  let sealedMessages = 0
  const sealedHours = new Map<string, number>()
  for (const [day, delta] of Object.entries(sealed ?? {})) {
    if (!isPrehistory(day)) continue // see the comment on sealedUsage above
    sealedSessions += delta.sessionCount
    sealedMessages += delta.messageCount
    for (const [h, c] of Object.entries(delta.hourCounts)) sealedHours.set(h, (sealedHours.get(h) ?? 0) + c)
  }
  out.totalSessions = Math.max(0, (real.totalSessions ?? 0) - sealedSessions)
  out.totalMessages = Math.max(0, (real.totalMessages ?? 0) - sealedMessages)
  for (const [h, c] of Object.entries(real.hourCounts ?? {})) {
    const left = Math.max(0, c - (sealedHours.get(h) ?? 0))
    if (left > 0) out.hourCounts[h] = left
  }

  return out
}
