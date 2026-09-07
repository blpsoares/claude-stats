import { test, expect } from 'bun:test'
import { NO_REPO_KEY, normalizeGitRemote, bucketSharedBy, planProposalApply } from '@agentistics/core'
import type { SessionMeta, WorkflowRun, HarnessId, ShareSource } from '@agentistics/core'
import {
  canonicalRepoKey, normalizeDenied, buildPathRepoIndex, repoKeyOf, sessionShared,
  filterShared, deniedSessionIds, sharedSessionIds, filterSharedWorkflows,
  withUnresolvedDenied, denialSignature, hasRestrictions, filterLiveShared, denylistRules,
  normalizeSources, shareRulesOf, sourcesRestrict, withUnresolvedSources,
  rulesSignature, emptyRulesSignature, filterSharedRules, deniedSessionIdsRules,
} from './share-rules'

function s(over: Partial<SessionMeta> & { session_id: string }): SessionMeta {
  return {
    project_path: '/p', start_time: '2026-06-20T10:00:00Z', duration_minutes: 0,
    user_message_count: 0, assistant_message_count: 0, tool_counts: {}, tool_output_tokens: {},
    agent_file_reads: {}, languages: [], git_commits: 0, git_pushes: 0,
    input_tokens: 0, output_tokens: 0, first_prompt: '', user_interruptions: 0,
    user_response_times: [], tool_errors: 0, tool_error_categories: {}, uses_task_agent: false,
    uses_mcp: false, uses_web_search: false, uses_web_fetch: false, lines_added: 0,
    lines_removed: 0, files_modified: 0, message_hours: [], user_message_timestamps: [],
    harness: 'claude' as HarnessId,
    ...over,
  }
}

// --- keys and normalization ---

test('NO_REPO_KEY cannot collide with a real remote', () => {
  expect(NO_REPO_KEY.includes('/')).toBe(false)
  expect(normalizeGitRemote(NO_REPO_KEY)).toBe('')
})

test('repoKeyOf: a remote gives its key, a missing one gives the sentinel', () => {
  expect(repoKeyOf(s({ session_id: 'a', git_remote: 'github.com/org/repo' }))).toBe('github.com/org/repo')
  expect(repoKeyOf(s({ session_id: 'b', git_remote: undefined }))).toBe(NO_REPO_KEY)
  expect(repoKeyOf(s({ session_id: 'c', git_remote: '' }))).toBe(NO_REPO_KEY)
})

test('canonicalRepoKey folds case and ssh front-door hosts', () => {
  expect(canonicalRepoKey('GitHub.com/Acme/API')).toBe('github.com/acme/api')
  expect(canonicalRepoKey('ssh.github.com/acme/api')).toBe('github.com/acme/api')
  expect(canonicalRepoKey('altssh.bitbucket.org/t/r')).toBe('bitbucket.org/t/r')
})

test('the same repo cloned over ssh and https is ONE key', () => {
  const viaSsh = repoKeyOf(s({ session_id: 'a', git_remote: normalizeGitRemote('git@github.com:Acme/API.git') }))
  const viaHttps = repoKeyOf(s({ session_id: 'b', git_remote: normalizeGitRemote('https://github.com/acme/api') }))
  expect(viaSsh).toBe(viaHttps)
})

test('normalizeDenied canonicalizes, folds the sentinel and drops junk', () => {
  const set = normalizeDenied(['', '__no_repo__', 'junk', 'GitHub.com/O/R.git'])
  expect(set.has(NO_REPO_KEY)).toBe(true)
  expect(set.has('github.com/o/r')).toBe(true)
  expect(set.has('junk')).toBe(false)
  expect(set.size).toBe(2)
})

test('normalizeDenied on empty input, and hasRestrictions', () => {
  expect(normalizeDenied(undefined).size).toBe(0)
  expect(normalizeDenied([]).size).toBe(0)
  expect(hasRestrictions(undefined)).toBe(false)
  expect(hasRestrictions([])).toBe(false)
  expect(hasRestrictions(['github.com/o/r'])).toBe(true)
  expect(hasRestrictions([NO_REPO_KEY])).toBe(true)
})

// --- the path index ---

test('buildPathRepoIndex: first writer wins, a second remote makes a conflict', () => {
  const idx = buildPathRepoIndex([
    s({ session_id: 'a', project_path: '/ws', git_remote: 'github.com/o/one' }),
    s({ session_id: 'b', project_path: '/ws', git_remote: 'github.com/o/two' }),
  ])
  expect(idx.resolved.get('/ws')).toBe('github.com/o/one')
  expect(idx.conflicts.get('/ws')).toEqual(new Set(['github.com/o/one', 'github.com/o/two']))
})

test('buildPathRepoIndex is seeded from project.gitRemote too', () => {
  const idx = buildPathRepoIndex([], [{ path: '/codex-only', gitRemote: 'github.com/o/repo' }])
  expect(idx.resolved.get('/codex-only')).toBe('github.com/o/repo')
})

test('repoKeyOf resolves a remote-less session through the index, but never overrides its own', () => {
  const idx = buildPathRepoIndex([s({ session_id: 'a', project_path: '/ws', git_remote: 'github.com/o/one' })])
  expect(repoKeyOf(s({ session_id: 'x', project_path: '/ws' }), idx)).toBe('github.com/o/one')
  expect(repoKeyOf(s({ session_id: 'y', project_path: '/ws', git_remote: 'github.com/o/other' }), idx)).toBe('github.com/o/other')
  expect(repoKeyOf(s({ session_id: 'z', project_path: '/elsewhere' }), idx)).toBe(NO_REPO_KEY)
})

// --- filtering ---

test('an empty denylist shares everything, including unresolved sessions', () => {
  const all = [s({ session_id: 'a', git_remote: 'github.com/o/r' }), s({ session_id: 'b' })]
  expect(filterShared(all, normalizeDenied([]))).toHaveLength(2)
})

test('denying one remote drops exactly its sessions', () => {
  const all = [
    s({ session_id: 'a', git_remote: 'github.com/o/secret' }),
    s({ session_id: 'b', git_remote: 'github.com/o/public' }),
    s({ session_id: 'c' }),
  ]
  const out = filterShared(all, normalizeDenied(['github.com/o/secret']))
  expect(out.map(x => x.session_id)).toEqual(['b', 'c'])
})

test('denying the sentinel drops only unresolved sessions', () => {
  const all = [s({ session_id: 'a', git_remote: 'github.com/o/r' }), s({ session_id: 'b' })]
  const out = filterShared(all, normalizeDenied([NO_REPO_KEY]))
  expect(out.map(x => x.session_id)).toEqual(['a'])
})

test('filterShared preserves order, returns a new array and never mutates', () => {
  const all = [s({ session_id: 'a' }), s({ session_id: 'b', git_remote: 'github.com/o/r' }), s({ session_id: 'c' })]
  const snapshot = JSON.stringify(all)
  const out = filterShared(all, normalizeDenied(['github.com/o/r']))
  expect(out).not.toBe(all)
  expect(out.map(x => x.session_id)).toEqual(['a', 'c'])
  expect(JSON.stringify(all)).toBe(snapshot)
})

test('non-Claude sessions obey the same rule', () => {
  const all = [s({ session_id: 'a', harness: 'codex', git_remote: 'github.com/o/secret' })]
  expect(filterShared(all, normalizeDenied(['github.com/o/secret']))).toHaveLength(0)
})

test('a remote-less non-Claude session in a denied folder is dropped via the index', () => {
  const idx = buildPathRepoIndex([s({ session_id: 'claude1', project_path: '/repo', git_remote: 'github.com/o/secret' })])
  const codex = s({ session_id: 'codex1', harness: 'codex', project_path: '/repo' })
  expect(sessionShared(codex, denyRepo('github.com/o/secret'), idx)).toBe(false)
})

test('a conflicting path fails CLOSED — denied if ANY remote under it is denied', () => {
  const idx = buildPathRepoIndex([
    s({ session_id: 'a', project_path: '/ws', git_remote: 'github.com/o/public' }),
    s({ session_id: 'b', project_path: '/ws', git_remote: 'github.com/o/secret' }),
  ])
  const inPublic = s({ session_id: 'c', project_path: '/ws', git_remote: 'github.com/o/public' })
  expect(sessionShared(inPublic, denyRepo('github.com/o/secret'), idx)).toBe(false)
})

// --- Task 3: the predicate learns projects and allowlist mode ---

/** Builds a `ShareRules` object the way a caller would, keyed as `${type}:${value}`. */
function rules(mode: 'denylist' | 'allowlist', entries: Array<{ type: 'repo' | 'project' | 'none'; value?: string }>): { mode: 'denylist' | 'allowlist'; sources: Set<string> } {
  const sources = new Set<string>()
  for (const e of entries) sources.add(`${e.type}:${e.value ?? ''}`)
  return { mode, sources }
}
function denyRepo(...values: string[]) { return rules('denylist', values.map(value => ({ type: 'repo' as const, value }))) }
function allowRepo(...values: string[]) { return rules('allowlist', values.map(value => ({ type: 'repo' as const, value }))) }
function denyProject(...values: string[]) { return rules('denylist', values.map(value => ({ type: 'project' as const, value }))) }
function allowProject(...values: string[]) { return rules('allowlist', values.map(value => ({ type: 'project' as const, value }))) }
function denyNone() { return rules('denylist', [{ type: 'none' as const }]) }
function allowNone() { return rules('allowlist', [{ type: 'none' as const }]) }

test('THE HEADLINE ALLOWLIST INVARIANT: an allowlist with an empty source set shares NOTHING', () => {
  const rulesEmpty = rules('allowlist', [])
  expect(rulesEmpty.sources.size).toBe(0)
  const withRepo = s({ session_id: 'a', git_remote: 'github.com/o/r' })
  const noRepo = s({ session_id: 'b' })
  expect(sessionShared(withRepo, rulesEmpty)).toBe(false)
  expect(sessionShared(noRepo, rulesEmpty)).toBe(false)
})

test('a project rule denies its exact project_path, and allows it in allowlist mode', () => {
  const inProject = s({ session_id: 'a', project_path: '/work/app' })
  const elsewhere = s({ session_id: 'b', project_path: '/work/other' })
  expect(sessionShared(inProject, denyProject('/work/app'))).toBe(false)
  expect(sessionShared(elsewhere, denyProject('/work/app'))).toBe(true)
  expect(sessionShared(inProject, allowProject('/work/app'))).toBe(true)
  expect(sessionShared(elsewhere, allowProject('/work/app'))).toBe(false)
})

test('a project rule catches a remote-less session (no repo to key on at all)', () => {
  const remoteLess = s({ session_id: 'a', project_path: '/loose/folder', git_remote: undefined })
  expect(sessionShared(remoteLess, denyProject('/loose/folder'))).toBe(false)
  expect(sessionShared(remoteLess, allowProject('/loose/folder'))).toBe(true)
  // A DIFFERENT project is untouched by the rule.
  const other = s({ session_id: 'b', project_path: '/other/folder', git_remote: undefined })
  expect(sessionShared(other, denyProject('/loose/folder'))).toBe(true)
  expect(sessionShared(other, allowProject('/loose/folder'))).toBe(false)
})

test('a repo rule catches a session whose project was never named elsewhere (the worktree case)', () => {
  // No PathRepoIndex at all: the session carries its OWN remote directly, so repoKeyOf never
  // needs the index to resolve it. This is the everyday case of a repo cloned into a brand new
  // worktree path nobody has seen before.
  const freshWorktree = s({ session_id: 'a', project_path: '/tmp/worktree-created-today', git_remote: 'github.com/o/secret' })
  expect(sessionShared(freshWorktree, denyRepo('github.com/o/secret'))).toBe(false)
  expect(sessionShared(freshWorktree, allowRepo('github.com/o/secret'))).toBe(true)
})

test('a repo rule also catches a remote-less session THROUGH the path index (worktree resolved via a sibling session)', () => {
  const idx = buildPathRepoIndex([s({ session_id: 'seed', project_path: '/ws', git_remote: 'github.com/o/secret' })])
  const noRemote = s({ session_id: 'a', project_path: '/ws', git_remote: undefined })
  expect(sessionShared(noRemote, denyRepo('github.com/o/secret'), idx)).toBe(false)
  expect(sessionShared(noRemote, allowRepo('github.com/o/secret'), idx)).toBe(true)
})

test('the `none` bucket matches only a session that resolves to no repository at all', () => {
  const noRepo = s({ session_id: 'a', git_remote: undefined })
  const withRepo = s({ session_id: 'b', git_remote: 'github.com/o/r' })
  expect(sessionShared(noRepo, denyNone())).toBe(false)
  expect(sessionShared(withRepo, denyNone())).toBe(true)
  expect(sessionShared(noRepo, allowNone())).toBe(true)
  expect(sessionShared(withRepo, allowNone())).toBe(false)
})

test('DENY WINS ACROSS DIMENSIONS in denylist mode: a blocked repo denies even when the project is not listed', () => {
  const inBlockedRepo = s({ session_id: 'a', project_path: '/some/unlisted/path', git_remote: 'github.com/o/secret' })
  // Only a repo source is denied; nothing names this session's project at all.
  expect(sessionShared(inBlockedRepo, denyRepo('github.com/o/secret'))).toBe(false)
})

test('in allowlist mode, matching EITHER an allowed repo or an allowed project is enough', () => {
  const viaRepo = s({ session_id: 'a', project_path: '/unlisted', git_remote: 'github.com/o/allowed' })
  const viaProject = s({ session_id: 'b', project_path: '/allowed/path', git_remote: 'github.com/o/other' })
  const allowBoth = rules('allowlist', [{ type: 'repo', value: 'github.com/o/allowed' }, { type: 'project', value: '/allowed/path' }])
  expect(sessionShared(viaRepo, allowBoth)).toBe(true)
  expect(sessionShared(viaProject, allowBoth)).toBe(true)
})

test('a session matching nothing: denylist shares it, allowlist withholds it — the two AGREE only in the direction each defines', () => {
  const untouched = s({ session_id: 'a', project_path: '/nowhere', git_remote: 'github.com/o/unrelated' })
  const someRule = rules('denylist', [{ type: 'repo', value: 'github.com/o/other' }])
  const someAllow = rules('allowlist', [{ type: 'repo', value: 'github.com/o/other' }])
  expect(sessionShared(untouched, someRule)).toBe(true)
  expect(sessionShared(untouched, someAllow)).toBe(false)
})

test('conflictPaths survives, denylist direction: shared only if EVERY repo under the path is undenied', () => {
  const idx = buildPathRepoIndex([
    s({ session_id: 'seedA', project_path: '/ws', git_remote: 'github.com/o/public' }),
    s({ session_id: 'seedB', project_path: '/ws', git_remote: 'github.com/o/secret' }),
  ])
  const inPublic = s({ session_id: 'c', project_path: '/ws', git_remote: 'github.com/o/public' })
  // The session's OWN remote is fine, but a sibling repo sharing its path is denied.
  expect(sessionShared(inPublic, denyRepo('github.com/o/secret'), idx)).toBe(false)
  // Neither conflicting repo is denied: shared.
  expect(sessionShared(inPublic, denyRepo('github.com/o/unrelated'), idx)).toBe(true)
})

test('conflictPaths survives, allowlist direction: shared only if ALL repos under the path are allowed', () => {
  const idx = buildPathRepoIndex([
    s({ session_id: 'seedA', project_path: '/ws', git_remote: 'github.com/o/public' }),
    s({ session_id: 'seedB', project_path: '/ws', git_remote: 'github.com/o/secret' }),
  ])
  const inPublic = s({ session_id: 'c', project_path: '/ws', git_remote: 'github.com/o/public' })
  // Only the session's own remote is allowed; the sibling repo under the same path is not —
  // the ambiguity must fail closed, not open.
  expect(sessionShared(inPublic, allowRepo('github.com/o/public'), idx)).toBe(false)
  // Both conflicting repos allowed: shared.
  expect(sessionShared(inPublic, allowRepo('github.com/o/public', 'github.com/o/secret'), idx)).toBe(true)
})

test('withUnresolvedDenied adds the sentinel only once restrictions exist, idempotently', () => {
  expect(withUnresolvedDenied([])).toEqual([])
  const once = withUnresolvedDenied(['github.com/o/r'])
  expect(once).toContain(NO_REPO_KEY)
  expect(withUnresolvedDenied(once)).toEqual(once)
})

test('deniedSessionIds returns ids that are present AND excluded — never merely absent', () => {
  const all = [s({ session_id: 'a', git_remote: 'github.com/o/secret' }), s({ session_id: 'b' })]
  const ids = deniedSessionIds(all, normalizeDenied(['github.com/o/secret']))
  expect([...ids]).toEqual(['a'])
  expect(deniedSessionIds([], normalizeDenied(['github.com/o/secret'])).size).toBe(0)
})

// --- workflows ---

function run(runId: string, sessionId: string): WorkflowRun {
  return {
    runId, name: 'audit', sessionId, status: 'completed', startedAt: '2026-06-20T10:00:00Z',
    durationMs: 0, phases: [], agents: [],
    totals: { agentCount: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, durationMs: 0, toolUses: 0 },
  }
}

test('filterSharedWorkflows keeps a run whose session is shared', () => {
  expect(filterSharedWorkflows([run('r1', 'a')], new Set(['a']))).toHaveLength(1)
})

test('filterSharedWorkflows fails CLOSED for a denied or unknown session', () => {
  expect(filterSharedWorkflows([run('r1', 'a')], new Set(['b']))).toHaveLength(0)
  expect(filterSharedWorkflows([run('r1', 'unknown')], new Set())).toHaveLength(0)
})

test('sharedSessionIds collects the ids of the filtered set', () => {
  expect(sharedSessionIds([s({ session_id: 'a' }), s({ session_id: 'b' })])).toEqual(new Set(['a', 'b']))
})

// --- signature ---

test('denialSignature is order-, case- and normalization-independent', () => {
  const a = denialSignature(['github.com/o/r', 'GitHub.com/O/Two'])
  const b = denialSignature(['github.com/o/two', 'github.com/o/r'])
  expect(a).toBe(b)
})

test('denialSignature changes when an entry is added or removed, and [] is stable', () => {
  expect(denialSignature([])).toBe(denialSignature([]))
  expect(denialSignature([])).not.toBe(denialSignature(['github.com/o/r']))
  expect(denialSignature(['github.com/o/r'])).not.toBe(denialSignature(['github.com/o/r', 'github.com/o/s']))
})

// --- accumulateClaudeSessions / buildSharedStatsCache ---

import { emptyStatsCache } from '@agentistics/core'
import type { StatsCache } from '@agentistics/core'
import { accumulateClaudeSessions, buildSharedStatsCache } from './share-rules'

/** 2026-06-20T09:30 LOCAL — hour bucketing is local-clock, like every adapter. */
function localAt(day: string, hour: number): string {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:30:00`).toISOString()
}

test('buildSharedStatsCache on an empty set equals emptyStatsCache (bar version)', () => {
  expect(buildSharedStatsCache([])).toEqual(emptyStatsCache())
  expect(buildSharedStatsCache([], { version: 4 }).version).toBe(4)
})

test('non-Claude sessions contribute to NOTHING', () => {
  const out = buildSharedStatsCache([
    s({ session_id: 'x', harness: 'codex', start_time: localAt('2026-06-20', 9), user_message_count: 5, input_tokens: 100, model: 'gpt-5.4' }),
  ])
  expect(out).toEqual(emptyStatsCache())
})

test('lastComputedDate stays empty even for a multi-month input', () => {
  const out = buildSharedStatsCache([
    s({ session_id: 'a', start_time: localAt('2026-02-01', 9) }),
    s({ session_id: 'b', start_time: localAt('2026-06-20', 9) }),
  ])
  expect(out.lastComputedDate).toBe('')
})

test('totals match the sum of dailyActivity — the invariant the real file holds', () => {
  const out = buildSharedStatsCache([
    s({ session_id: 'a', start_time: localAt('2026-06-20', 9), user_message_count: 3, assistant_message_count: 4 }),
    s({ session_id: 'b', start_time: localAt('2026-06-21', 14), user_message_count: 1, assistant_message_count: 1 }),
  ])
  expect(out.totalSessions).toBe(out.dailyActivity.reduce((a, d) => a + d.sessionCount, 0))
  expect(out.totalMessages).toBe(out.dailyActivity.reduce((a, d) => a + d.messageCount, 0))
  expect(out.totalSessions).toBe(2)
  expect(out.totalMessages).toBe(9)
})

test('hourCounts buckets SESSION START hours on the local clock, and sums to totalSessions', () => {
  const out = buildSharedStatsCache([
    s({ session_id: 'a', start_time: localAt('2026-06-20', 9), message_hours: [1, 1, 1, 1] }),
    s({ session_id: 'b', start_time: localAt('2026-06-21', 9), message_hours: [2, 2] }),
    s({ session_id: 'c', start_time: localAt('2026-06-21', 15), message_hours: [3] }),
  ])
  expect(out.hourCounts['9']).toBe(2)
  expect(out.hourCounts['15']).toBe(1)
  expect(Object.values(out.hourCounts).reduce((a, b) => a + b, 0)).toBe(out.totalSessions)
})

test('dailyModelTokens sums the four token kinds per claude model per day, and skips foreign ids', () => {
  const out = buildSharedStatsCache([
    s({
      session_id: 'a', start_time: localAt('2026-06-20', 9), model: 'claude-opus-5',
      input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
    }),
    s({ session_id: 'b', start_time: localAt('2026-06-20', 9), model: '<synthetic>', input_tokens: 999 }),
  ])
  const day = out.dailyModelTokens.find(d => d.date === '2026-06-20')!
  expect(day.tokensByModel['claude-opus-5']).toBe(100)
  expect(day.tokensByModel['<synthetic>']).toBeUndefined()
  // The <synthetic> session still counts as activity.
  expect(out.totalSessions).toBe(2)
})

test('modelUsage keeps costUSD and webSearchRequests at 0, like the real file', () => {
  const out = buildSharedStatsCache([
    s({ session_id: 'a', start_time: localAt('2026-06-20', 9), model: 'claude-opus-5', input_tokens: 10, uses_web_search: true }),
  ])
  expect(out.modelUsage['claude-opus-5']!.inputTokens).toBe(10)
  expect(out.modelUsage['claude-opus-5']!.costUSD).toBe(0)
  expect(out.modelUsage['claude-opus-5']!.webSearchRequests).toBe(0)
})

test('firstSessionDate is the earliest FULL ISO start_time', () => {
  const early = localAt('2026-02-06', 8)
  const out = buildSharedStatsCache([
    s({ session_id: 'a', start_time: localAt('2026-06-20', 9) }),
    s({ session_id: 'b', start_time: early }),
  ])
  expect(out.firstSessionDate).toBe(early)
  expect(out.firstSessionDate.length).toBeGreaterThan(10)
  expect(buildSharedStatsCache([]).firstSessionDate).toBe('')
})

test('longestSession is the zero value even with a long session present', () => {
  const out = buildSharedStatsCache([s({ session_id: 'a', start_time: localAt('2026-06-20', 9), duration_minutes: 400 })])
  expect(out.longestSession).toEqual({ sessionId: '', duration: 0, messageCount: 0, timestamp: '' })
})

test('a session with no start_time is skipped without throwing', () => {
  expect(() => buildSharedStatsCache([s({ session_id: 'a', start_time: '' })])).not.toThrow()
  expect(buildSharedStatsCache([s({ session_id: 'a', start_time: '' })]).totalSessions).toBe(0)
})

test('the output carries NO key outside the StatsCache shape', () => {
  const out = buildSharedStatsCache([s({ session_id: 'a', start_time: localAt('2026-06-20', 9) })])
  expect(Object.keys(out).sort()).toEqual(Object.keys(emptyStatsCache()).sort())
})

test('end to end: a denied repo contributes to no field at all', () => {
  const all = [
    s({ session_id: 'keep', start_time: localAt('2026-06-20', 9), model: 'claude-opus-5', input_tokens: 10, git_remote: 'github.com/o/public', user_message_count: 1 }),
    s({ session_id: 'drop', start_time: localAt('2026-06-20', 11), model: 'claude-opus-5', input_tokens: 500, git_remote: 'github.com/o/secret', user_message_count: 9 }),
  ]
  const out = buildSharedStatsCache(filterShared(all, normalizeDenied(['github.com/o/secret'])))
  expect(out.totalSessions).toBe(1)
  expect(out.totalMessages).toBe(1)
  expect(out.modelUsage['claude-opus-5']!.inputTokens).toBe(10)
  expect(out.dailyModelTokens[0]!.tokensByModel['claude-opus-5']).toBe(10)
  expect(out.hourCounts['11']).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('secret')
})

test('accumulateClaudeSessions honours `after` exclusively (<=), and includes all without it', () => {
  const sessions = [
    s({ session_id: 'a', start_time: localAt('2026-06-20', 9) }),
    s({ session_id: 'b', start_time: localAt('2026-06-22', 9) }),
    s({ session_id: 'c', start_time: localAt('2026-06-23', 9) }),
  ]
  expect(accumulateClaudeSessions(sessions, { after: '2026-06-22' }).totalSessions).toBe(1)
  expect(accumulateClaudeSessions(sessions).totalSessions).toBe(3)
})

test('accumulateClaudeSessions without claudeOnly counts every harness — the data.ts contract', () => {
  const mixed = [
    s({ session_id: 'a', start_time: localAt('2026-06-20', 9) }),
    s({ session_id: 'b', harness: 'codex', start_time: localAt('2026-06-20', 9) }),
  ]
  expect(accumulateClaudeSessions(mixed).totalSessions).toBe(2)
  expect(accumulateClaudeSessions(mixed, { claudeOnly: true }).totalSessions).toBe(1)
})

// --- attributionBoundary / buildSplitStatsCache / prehistoryCount / deniedTouchesPrehistory ---

import {
  attributionBoundary, buildSplitStatsCache, prehistoryCount, deniedTouchesPrehistory,
  deniedDeltaByDay, advanceSeal,
} from './share-rules'
import type { DeniedLedger } from './share-rules'

/**
 * A cache shaped like the real one: Claude rolled up through 2026-06-22 (prehistory), and
 * 2026-06-25 is gap-filled by supplementStatsCache from the store. hourCounts / totalSessions /
 * totalMessages cover the ROLLUP ONLY — that asymmetry is real and load-bearing.
 */
function realCache(): StatsCache {
  return {
    ...emptyStatsCache(),
    version: 4,
    lastComputedDate: '2026-06-22',
    dailyActivity: [
      { date: '2026-02-06', messageCount: 100, sessionCount: 10, toolCallCount: 50 },
      { date: '2026-06-25', messageCount: 9, sessionCount: 2, toolCallCount: 4 },
    ],
    dailyModelTokens: [
      { date: '2026-02-06', tokensByModel: { 'claude-opus-5': 1000 } },
      { date: '2026-06-25', tokensByModel: { 'claude-opus-5': 510 } },
    ],
    modelUsage: {
      'claude-opus-5': {
        inputTokens: 1510, outputTokens: 0, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0,
      },
    },
    totalSessions: 10,      // rollup only
    totalMessages: 100,     // rollup only
    firstSessionDate: '2026-02-06T00:53:42.012Z',
    hourCounts: { '8': 10 }, // rollup only
  }
}

/** The store — only the gap-filled day. Reproduces realCache()'s 2026-06-25 row exactly. */
function storeSessions(): SessionMeta[] {
  return [
    s({ session_id: 'keep', start_time: localAt('2026-06-25', 9), model: 'claude-opus-5', input_tokens: 10, git_remote: 'github.com/o/public', user_message_count: 1, tool_counts: { Read: 2 } }),
    s({ session_id: 'drop', start_time: localAt('2026-06-25', 11), model: 'claude-opus-5', input_tokens: 500, git_remote: 'github.com/o/secret', user_message_count: 8, tool_counts: { Bash: 2 } }),
  ]
}

const NO_SEAL: DeniedLedger = {}

test('attributionBoundary is the day AFTER Claude’s watermark', () => {
  expect(attributionBoundary(realCache())).toBe('2026-06-23')
  expect(attributionBoundary({ ...emptyStatsCache(), lastComputedDate: '2026-12-31' })).toBe('2027-01-01')
})

test('attributionBoundary is empty when Claude has rolled up nothing — everything is decomposable', () => {
  expect(attributionBoundary(emptyStatsCache())).toBe('')
})

test('THE HEADLINE INVARIANT: denying nothing makes the split a no-op, with NO field excepted', () => {
  const all = storeSessions()
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out).toEqual(realCache())
})

test('totals drop by exactly the denied contribution and by nothing else', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  const june = out.dailyActivity.find(d => d.date === '2026-06-25')!
  expect(june.sessionCount).toBe(1)
  expect(june.messageCount).toBe(1)
  expect(june.toolCallCount).toBe(2)
  expect(out.dailyModelTokens.find(d => d.date === '2026-06-25')!.tokensByModel['claude-opus-5']).toBe(10)
  expect(out.modelUsage['claude-opus-5']!.inputTokens).toBe(1510 - 500)
})

test('the rollup half is untouched: prehistory rows, hourCounts and totals are verbatim', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out.dailyActivity.find(d => d.date === '2026-02-06')).toEqual({ date: '2026-02-06', messageCount: 100, sessionCount: 10, toolCallCount: 50 })
  expect(out.hourCounts).toEqual({ '8': 10 })   // no +kept term: the rollup never covered the gap-filled window
  expect(out.totalSessions).toBe(10)
  expect(out.totalMessages).toBe(100)
  expect(out.lastComputedDate).toBe('2026-06-22')
  expect(out.firstSessionDate).toBe('2026-02-06T00:53:42.012Z')
})

test('deniedDeltaByDay measures only the decomposable window, and only denied sessions', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const led = deniedDeltaByDay(all, shared, '2026-06-23')
  expect(Object.keys(led)).toEqual(['2026-06-25'])
  const d = led['2026-06-25']!
  expect(d.sessionCount).toBe(1)
  expect(d.messageCount).toBe(8)
  expect(d.toolCallCount).toBe(2)
  expect(d.tokensByModel['claude-opus-5']).toBe(500)
  expect(d.usageByModel['claude-opus-5']!.input).toBe(500)
  expect(d.hourCounts['11']).toBe(1)
  // A day before the boundary contributes nothing, even when it holds a denied session.
  expect(deniedDeltaByDay(all, shared, '2026-07-01')).toEqual({})
})

test('deniedDeltaByDay is empty when nothing is denied', () => {
  const all = storeSessions()
  expect(deniedDeltaByDay(all, all, '2026-06-23')).toEqual({})
})

test('advanceSeal seals a pending day once the watermark passes it, and never re-seals', () => {
  const pending = deniedDeltaByDay(storeSessions(), filterShared(storeSessions(), normalizeDenied(['github.com/o/secret'])), '2026-06-23')
  const first = advanceSeal({ sealed: {}, pending }, {}, '2026-06-26')
  expect(Object.keys(first.sealed)).toEqual(['2026-06-25'])
  expect(first.pending).toEqual({})
  // A second pass with a different value must not overwrite the sealed one.
  const tampered = { '2026-06-25': { ...pending['2026-06-25']!, sessionCount: 99 } }
  const second = advanceSeal({ sealed: first.sealed, pending: tampered }, {}, '2026-06-27')
  expect(second.sealed['2026-06-25']!.sessionCount).toBe(1)
})

test('advanceSeal leaves a still-decomposable day pending', () => {
  const pending = deniedDeltaByDay(storeSessions(), filterShared(storeSessions(), normalizeDenied(['github.com/o/secret'])), '2026-06-23')
  const out = advanceSeal({ sealed: {}, pending }, pending, '2026-06-23')
  expect(out.sealed).toEqual({})
  expect(Object.keys(out.pending)).toEqual(['2026-06-25'])
})

test('THE SEAL INVARIANT: a day keeps its denied volume withheld after the watermark passes it', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const pending = deniedDeltaByDay(all, shared, '2026-06-23')
  const { sealed } = advanceSeal({ sealed: {}, pending }, {}, '2026-06-26')

  // Claude has now rolled 2026-06-25 up: it appears in the rollup half with the FULL numbers.
  const rolled: StatsCache = {
    ...realCache(),
    lastComputedDate: '2026-06-25',
    totalSessions: 12, totalMessages: 109,
    hourCounts: { '8': 10, '9': 1, '11': 1 },
  }
  const out = buildSplitStatsCache({ real: rolled, allStored: all, shared, boundary: '2026-06-26', sealed })!

  const june = out.dailyActivity.find(d => d.date === '2026-06-25')!
  expect(june.sessionCount).toBe(1)          // 2 rolled up minus 1 sealed
  expect(june.messageCount).toBe(1)
  expect(june.toolCallCount).toBe(2)
  expect(out.dailyModelTokens.find(d => d.date === '2026-06-25')!.tokensByModel['claude-opus-5']).toBe(10)
  expect(out.totalSessions).toBe(11)         // 12 minus the sealed session
  expect(out.totalMessages).toBe(101)
  expect(out.hourCounts['11']).toBeUndefined() // the denied session's start hour is withheld
  expect(out.hourCounts['9']).toBe(1)
  expect(out.modelUsage['claude-opus-5']!.inputTokens).toBe(1010)
})

test('an unsealed prehistory day is emitted verbatim — absence of a seal never zeroes a row', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out.dailyActivity.find(d => d.date === '2026-02-06')!.sessionCount).toBe(10)
})

test('a seal larger than the rollup row clamps at 0 rather than going negative', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const huge: DeniedLedger = {
    '2026-02-06': {
      sessionCount: 999, messageCount: 999, toolCallCount: 999,
      tokensByModel: { 'claude-opus-5': 99999 },
      usageByModel: { 'claude-opus-5': { input: 99999, output: 0, cacheRead: 0, cacheWrite: 0 } },
      hourCounts: { '8': 999 },
    },
  }
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: huge })!
  const feb = out.dailyActivity.find(d => d.date === '2026-02-06')!
  expect(feb.sessionCount).toBe(0)
  expect(feb.messageCount).toBe(0)
  expect(out.totalSessions).toBe(0)
  expect(out.hourCounts['8']).toBeUndefined()
  expect(out.modelUsage['claude-opus-5']!.inputTokens).toBe(10) // 1510 clamped to 0, minus 510, plus kept 10
})

test('THE CLAMP IS EXACT, not merely non-negative', () => {
  // real.modelUsage lags behind the store (5 < the 510 attributable). The prehistory term
  // clamps to 0 and the kept term must SURVIVE: max(0, 5-510) + 510 = 510, not 5.
  const lagging: StatsCache = {
    ...realCache(),
    modelUsage: { 'claude-opus-5': { inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } },
  }
  const all = storeSessions()
  const out = buildSplitStatsCache({ real: lagging, allStored: all, shared: all, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out.modelUsage['claude-opus-5']!.inputTokens).toBe(510)
})

test('a boundary of ‘’ means every day is decomposable', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  // gapFilledCache() is COHERENT: no watermark, so every rollup-only field is zero and every
  // daily row reproduces the store exactly. (The old fixture here carried a 1510-token
  // modelUsage against a 510-token store with an empty lastComputedDate — internally
  // inconsistent input, so it could not catch a regression.)
  const out = buildSplitStatsCache({ real: gapFilledCache(), allStored: all, shared, boundary: '', sealed: NO_SEAL })!
  expect(out.dailyActivity).toHaveLength(1)
  expect(out.dailyActivity[0]!.sessionCount).toBe(1)
  expect(out.dailyActivity[0]!.messageCount).toBe(1)
  expect(out.dailyModelTokens[0]!.tokensByModel['claude-opus-5']).toBe(10)
  expect(out.modelUsage['claude-opus-5']!.inputTokens).toBe(10)
  expect(JSON.stringify(out)).not.toContain('secret')
})

test('buildSplitStatsCache refuses rather than shipping an unsplit cache', () => {
  const all = storeSessions()
  expect(buildSplitStatsCache({ real: null as unknown as StatsCache, allStored: all, shared: all, boundary: '2026-06-23', sealed: NO_SEAL })).toBeNull()
  // cold store against a populated cache
  expect(buildSplitStatsCache({ real: realCache(), allStored: [], shared: [], boundary: '2026-06-23', sealed: NO_SEAL })).toBeNull()
})

test('the split output carries no key outside the StatsCache shape', () => {
  const all = storeSessions()
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(Object.keys(out).sort()).toEqual(Object.keys(emptyStatsCache()).sort())
})

test('prehistoryCount counts the ROLLUP’s sessions, and is 0 when nothing is rolled up', () => {
  expect(prehistoryCount(realCache(), '2026-06-23')).toBe(10)
  expect(prehistoryCount(realCache(), '')).toBe(0)
})

test('deniedTouchesPrehistory ignores non-Claude sessions', () => {
  const denied = normalizeDenied(['github.com/o/secret'])
  const claudeOld = [s({ session_id: 'a', start_time: localAt('2026-02-06', 8), git_remote: 'github.com/o/secret' })]
  const codexOld = [s({ session_id: 'b', harness: 'codex', start_time: localAt('2026-02-06', 8), git_remote: 'github.com/o/secret' })]
  expect(deniedTouchesPrehistory(claudeOld, denied, '2026-06-23')).toBe(true)
  expect(deniedTouchesPrehistory(codexOld, denied, '2026-06-23')).toBe(false)
  expect(deniedTouchesPrehistory(claudeOld, normalizeDenied(['github.com/o/public']), '2026-06-23')).toBe(false)
  expect(deniedTouchesPrehistory(claudeOld, denied, '')).toBe(false)
})

// --- review round 1 fixes: longestSession leak, seal double-subtraction on a regressed
//     boundary, unparseable/self-contradictory watermark handling, no duplicate merged dates ---

test('REVIEW FIX 1: longestSession naming a denied STORED session is zeroed', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const named: StatsCache = { ...realCache(), longestSession: { sessionId: 'drop', duration: 999, messageCount: 3, timestamp: 'x' } }
  const out = buildSplitStatsCache({ real: named, allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out.longestSession).toEqual({ sessionId: '', duration: 0, messageCount: 0, timestamp: '' })
})

test('REVIEW FIX 1: longestSession naming a SHARED session survives untouched', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const kept: StatsCache = { ...realCache(), longestSession: { sessionId: 'keep', duration: 999, messageCount: 3, timestamp: 'x' } }
  const out = buildSplitStatsCache({ real: kept, allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out.longestSession).toEqual({ sessionId: 'keep', duration: 999, messageCount: 3, timestamp: 'x' })
})

test('REVIEW FIX 1: longestSession naming a session absent from the store (prehistory) is kept — absence is not proof of denial', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const prehistoric: StatsCache = { ...realCache(), longestSession: { sessionId: 'gone-from-store', duration: 42, messageCount: 1, timestamp: 'y' } }
  const out = buildSplitStatsCache({ real: prehistoric, allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out.longestSession).toEqual({ sessionId: 'gone-from-store', duration: 42, messageCount: 1, timestamp: 'y' })
})

test('REVIEW FIX 2: a seal is not re-applied once its day is no longer prehistory (boundary regression)', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const pending = deniedDeltaByDay(all, shared, '2026-06-23')
  const { sealed } = advanceSeal({ sealed: {}, pending }, {}, '2026-06-26')
  expect(Object.keys(sealed)).toEqual(['2026-06-25'])

  // The boundary regresses back to BEFORE the sealed day (a restored backup / regenerated
  // stats-cache.json with an older watermark) — 2026-06-25 is now >= boundary again, so it is
  // rebuilt from `shared` (which already excludes the denied session). The seal must NOT also
  // subtract from it, or the day's volume is removed twice.
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed })!
  const unsealedOut = buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out).toEqual(unsealedOut)
  const june = out.dailyActivity.find(d => d.date === '2026-06-25')!
  expect(june.sessionCount).toBe(1) // from `shared` alone, not further reduced by the stale seal
})

test('REVIEW FIX 3: attributionBoundary distinguishes "nothing rolled up" from an unparseable watermark', () => {
  expect(attributionBoundary(emptyStatsCache())).toBe('')
  expect(attributionBoundary({ ...emptyStatsCache(), lastComputedDate: 'not-a-real-date' })).toBeNull()
})

test('REVIEW FIX 3: buildSplitStatsCache refuses when the boundary is null (unparseable watermark)', () => {
  const all = storeSessions()
  const real: StatsCache = { ...realCache(), lastComputedDate: 'not-a-real-date' }
  expect(attributionBoundary(real)).toBeNull()
  expect(buildSplitStatsCache({ real, allStored: all, shared: all, boundary: attributionBoundary(real), sealed: NO_SEAL })).toBeNull()
})

test('REVIEW FIX 3: buildSplitStatsCache refuses a self-contradictory cache — no watermark but a nonzero rollup-only field', () => {
  const all = storeSessions()
  const noWatermarkButSessions: StatsCache = { ...emptyStatsCache(), lastComputedDate: '', totalSessions: 5 }
  expect(buildSplitStatsCache({ real: noWatermarkButSessions, allStored: all, shared: all, boundary: '', sealed: NO_SEAL })).toBeNull()

  const noWatermarkButHours: StatsCache = { ...emptyStatsCache(), lastComputedDate: '', hourCounts: { '8': 1 } }
  expect(buildSplitStatsCache({ real: noWatermarkButHours, allStored: all, shared: all, boundary: '', sealed: NO_SEAL })).toBeNull()
})

test('REVIEW FIX 5: the merged dailyActivity and dailyModelTokens carry no duplicate dates', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  const activityDates = out.dailyActivity.map(d => d.date)
  const tokenDates = out.dailyModelTokens.map(d => d.date)
  expect(new Set(activityDates).size).toBe(activityDates.length)
  expect(new Set(tokenDates).size).toBe(tokenDates.length)
})

// --- review round 2 fixes: partial store shrinkage, firstSessionDate at boundary '',
//     unusable-boundary signalling, and the boundary-'' no-op invariant ---

test('REVIEW FIX I1: a decomposable day the store has LOST makes the split refuse', () => {
  // real reports 2026-06-25 (a day >= boundary) but the store no longer holds any session for
  // it — the row would be dropped while real.modelUsage still carries its 510 tokens and the
  // attributable term subtracts nothing, so a denied repo's volume would ride out.
  const shrunk = storeSessions().filter(x => x.session_id === 'never-matches')
  const stillHasAnotherDay = [...shrunk, s({ session_id: 'other', start_time: localAt('2026-06-28', 9), model: 'claude-opus-5', input_tokens: 1 })]
  expect(buildSplitStatsCache({
    real: realCache(), allStored: stillHasAnotherDay, shared: stillHasAnotherDay,
    boundary: '2026-06-23', sealed: NO_SEAL,
  })).toBeNull()
})

test('REVIEW FIX I1: a day missing only from dailyModelTokens is caught too', () => {
  const all = storeSessions()
  const extraTokenDay: StatsCache = {
    ...realCache(),
    dailyModelTokens: [
      ...realCache().dailyModelTokens,
      { date: '2026-06-27', tokensByModel: { 'claude-opus-5': 99 } }, // no session in the store
    ],
  }
  expect(buildSplitStatsCache({ real: extraTokenDay, allStored: all, shared: all, boundary: '2026-06-23', sealed: NO_SEAL })).toBeNull()
})

test('REVIEW FIX I1: a PREHISTORY day absent from the store is fine — that is the normal case', () => {
  const all = storeSessions() // holds nothing for 2026-02-06, which realCache() reports
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: NO_SEAL })).not.toBeNull()
})

/** A cache that is ENTIRELY session-derived: Claude has rolled up nothing, so every rollup-only
 *  field is zero and every daily row reproduces the store exactly. */
function gapFilledCache(): StatsCache {
  return {
    ...emptyStatsCache(),
    version: 4,
    lastComputedDate: '',
    dailyActivity: [{ date: '2026-06-25', messageCount: 9, sessionCount: 2, toolCallCount: 4 }],
    dailyModelTokens: [{ date: '2026-06-25', tokensByModel: { 'claude-opus-5': 510 } }],
    modelUsage: {
      'claude-opus-5': {
        inputTokens: 510, outputTokens: 0, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0,
      },
    },
    totalSessions: 0, totalMessages: 0, hourCounts: {},
    firstSessionDate: localAt('2026-06-25', 9),
  }
}

test('THE HEADLINE INVARIANT AT boundary "": denying nothing is a deep-equal no-op', () => {
  const all = storeSessions()
  const out = buildSplitStatsCache({ real: gapFilledCache(), allStored: all, shared: all, boundary: '', sealed: NO_SEAL })!
  expect(out).toEqual(gapFilledCache())
})

test('REVIEW FIX I2: at boundary "" firstSessionDate comes from the SHARED set, not from real', () => {
  const all = storeSessions()
  // The earliest session belongs to the denied repo: its exact ISO start must not ship.
  const earlyDenied = s({ session_id: 'drop-early', start_time: localAt('2026-06-25', 1), model: 'claude-opus-5', input_tokens: 7, git_remote: 'github.com/o/secret' })
  const withEarly = [earlyDenied, ...all]
  const real: StatsCache = {
    ...gapFilledCache(),
    dailyActivity: [{ date: '2026-06-25', messageCount: 9, sessionCount: 3, toolCallCount: 4 }],
    dailyModelTokens: [{ date: '2026-06-25', tokensByModel: { 'claude-opus-5': 517 } }],
    firstSessionDate: earlyDenied.start_time,
  }
  const shared = filterShared(withEarly, normalizeDenied(['github.com/o/secret']))
  const out = buildSplitStatsCache({ real, allStored: withEarly, shared, boundary: '', sealed: NO_SEAL })!
  expect(out.firstSessionDate).toBe(localAt('2026-06-25', 9)) // the earliest SHARED session
  expect(out.firstSessionDate).not.toBe(earlyDenied.start_time)
})

test('REVIEW FIX I2: with a rollup present firstSessionDate stays verbatim from real (it is prehistory)', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out.firstSessionDate).toBe('2026-02-06T00:53:42.012Z')
})

test('REVIEW FIX I2: totalSpeculationTimeSavedMs is copied verbatim — no per-session source to seal from', () => {
  const all = storeSessions()
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  const real: StatsCache = { ...realCache(), totalSpeculationTimeSavedMs: 123456 }
  const out = buildSplitStatsCache({ real, allStored: all, shared, boundary: '2026-06-23', sealed: NO_SEAL })!
  expect(out.totalSpeculationTimeSavedMs).toBe(123456)
})

test('prehistoryCount and deniedTouchesPrehistory signal an UNUSABLE boundary distinctly', () => {
  const denied = normalizeDenied(['github.com/o/secret'])
  const claudeOld = [s({ session_id: 'a', start_time: localAt('2026-02-06', 8), git_remote: 'github.com/o/secret' })]
  // null (unparseable watermark) is not the same fact as '' (nothing rolled up).
  expect(prehistoryCount(realCache(), null)).toBeNull()
  expect(deniedTouchesPrehistory(claudeOld, denied, null)).toBeNull()
  expect(prehistoryCount(realCache(), '')).toBe(0)
  expect(deniedTouchesPrehistory(claudeOld, denied, '')).toBe(false)
})

test('hourCounts is bucketed on the LOCAL clock — discriminating under an explicit offset', () => {
  // Restoring by DELETING process.env.TZ does not restore the ambient zone in this runtime —
  // the mutated zone stays cached and leaks into every test file that runs afterwards (it broke
  // antigravity-parse.test.ts, whose fixture assumes a UTC runtime). So capture the ambient
  // OFFSET first and restore an explicit zone that reproduces it.
  const tz = process.env.TZ
  const ambientOffsetMin = new Date().getTimezoneOffset() // minutes BEHIND UTC
  try {
    process.env.TZ = 'America/Sao_Paulo' // UTC-3, no DST since 2019
    const out = buildSharedStatsCache([s({ session_id: 'a', start_time: '2026-06-21T04:30:00Z' })])
    expect(out.hourCounts['1']).toBe(1)   // 04:30Z is 01:30 local
    expect(out.hourCounts['4']).toBeUndefined() // a getUTCHours() implementation fails here
  } finally {
    if (tz !== undefined) process.env.TZ = tz
    else if (ambientOffsetMin === 0) process.env.TZ = 'UTC'
    else {
      // Etc/GMT signs are inverted: Etc/GMT+3 is UTC-3, which is what a +180 offset means.
      const hours = ambientOffsetMin / 60
      process.env.TZ = `Etc/GMT${hours > 0 ? '+' : '-'}${Math.abs(hours)}`
    }
  }
  expect(new Date().getTimezoneOffset()).toBe(ambientOffsetMin) // the zone really is back
})

// ---------------------------------------------------------------------------
// The same-array precondition, asserted rather than trusted
// ---------------------------------------------------------------------------

test('sub-day shrinkage REFUSES — a decomposable day the store only partly covers', () => {
  // real says 2026-06-25 had 2 sessions; the store now holds only one of them.
  const all = [storeSessions()[0]!]
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: {} })).toBeNull()
})

test('a token disagreement on a decomposable day REFUSES', () => {
  const all = storeSessions().map(s => ({ ...s, input_tokens: s.input_tokens + 1 }))
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })).toBeNull()
})

test('a message-count disagreement on a decomposable day REFUSES', () => {
  const all = storeSessions()
  all[0]!.user_message_count += 3
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })).toBeNull()
})

test('a decomposable day the STORE has and the cache does not also REFUSES', () => {
  const all = [
    ...storeSessions(),
    s({ session_id: 'extra', start_time: localAt('2026-06-30', 9), model: 'claude-opus-5', input_tokens: 7, user_message_count: 1 }),
  ]
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })).toBeNull()
})

test('PREHISTORY days are never checked — the store is legitimately a subset there', () => {
  // realCache()'s 2026-02-06 row (10 sessions) has no counterpart in the store at all.
  const all = storeSessions()
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })
  expect(out).not.toBeNull()
  expect(out!.dailyActivity.find(d => d.date === '2026-02-06')!.sessionCount).toBe(10)
})

test('non-Claude sessions in the store do not trip the precondition', () => {
  const all = [...storeSessions(), s({ session_id: 'cx', harness: 'codex', start_time: localAt('2026-06-25', 9), user_message_count: 4 })]
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })
  expect(out).not.toBeNull()
})

// ---------------------------------------------------------------------------
// Task 4 — the typed-source shape (mode + ShareSource[])
// ---------------------------------------------------------------------------

const repoSrc = (value: string): ShareSource => ({ type: 'repo', value })
const projectSrc = (value: string): ShareSource => ({ type: 'project', value })
const noneSrc = (): ShareSource => ({ type: 'none', value: '' })

test('normalizeSources canonicalizes repo values and folds "none" to a fixed key', () => {
  const out = normalizeSources([repoSrc('https://github.com/Acme/API.git'), repoSrc('git@github.com:acme/api.git'), noneSrc()])
  expect(out).toEqual(new Set(['repo:github.com/acme/api', 'none:']))
})

test('normalizeSources keeps project paths verbatim, as their own dimension', () => {
  const out = normalizeSources([projectSrc('/home/alice/work/repo')])
  expect(out).toEqual(new Set(['project:/home/alice/work/repo']))
})

test('normalizeSources drops junk (unresolvable repo, blank project path)', () => {
  const out = normalizeSources([repoSrc(''), projectSrc(''), { type: 'repo', value: 123 as unknown as string }])
  expect(out.size).toBe(0)
})

test('shareRulesOf: mode absent/junk reads as denylist, same default as migrateTeamConfig', () => {
  expect(shareRulesOf(undefined, [repoSrc('github.com/o/r')]).mode).toBe('denylist')
  expect(shareRulesOf('bogus' as never, []).mode).toBe('denylist')
  expect(shareRulesOf('allowlist', []).mode).toBe('allowlist')
})

test('sourcesRestrict: allowlist is ALWAYS a restriction, even empty', () => {
  expect(sourcesRestrict('allowlist', [])).toBe(true)
  expect(sourcesRestrict('allowlist', [repoSrc('github.com/o/r')])).toBe(true)
})

test('sourcesRestrict: denylist is a restriction only once it names a source', () => {
  expect(sourcesRestrict('denylist', [])).toBe(false)
  expect(sourcesRestrict(undefined, undefined)).toBe(false)
  expect(sourcesRestrict('denylist', [repoSrc('github.com/o/r')])).toBe(true)
})

test('withUnresolvedSources: denylist mode auto-adds the none bucket exactly once', () => {
  expect(withUnresolvedSources('denylist', [])).toEqual([])
  expect(withUnresolvedSources('denylist', [repoSrc('github.com/o/r')])).toEqual([repoSrc('github.com/o/r'), noneSrc()])
  const already = [repoSrc('github.com/o/r'), noneSrc()]
  expect(withUnresolvedSources('denylist', already)).toEqual(already)
})

test('withUnresolvedSources: allowlist mode never adds the none bucket — nothing to add', () => {
  expect(withUnresolvedSources('allowlist', [])).toEqual([])
  expect(withUnresolvedSources('allowlist', [repoSrc('github.com/o/r')])).toEqual([repoSrc('github.com/o/r')])
})

test('rulesSignature covers the mode — same sources, different mode, different signature', () => {
  const sources = [repoSrc('github.com/o/r')]
  expect(rulesSignature('denylist', sources)).not.toBe(rulesSignature('allowlist', sources))
})

test('rulesSignature is order/case/normalization independent, like denialSignature', () => {
  const a = rulesSignature('denylist', [repoSrc('github.com/o/r1'), repoSrc('github.com/o/r2')])
  const b = rulesSignature('denylist', [repoSrc('GitHub.com/O/r2'), repoSrc('github.com/O/R1')])
  expect(a).toBe(b)
})

test('emptyRulesSignature is rulesSignature(denylist, [])', () => {
  expect(emptyRulesSignature()).toBe(rulesSignature('denylist', []))
})

test('filterSharedRules / deniedSessionIdsRules: allowlist with an empty source set shares nothing', () => {
  const sessions = [s({ session_id: 'a', project_path: '/p/a', git_remote: 'https://github.com/o/r' })]
  const rules = shareRulesOf('allowlist', [])
  expect(filterSharedRules(sessions, rules)).toEqual([])
  expect(deniedSessionIdsRules(sessions, rules)).toEqual(new Set(['a']))
})

test('filterSharedRules / deniedSessionIdsRules: a project rule catches a remote-less session', () => {
  const sessions = [s({ session_id: 'a', project_path: '/p/a', git_remote: '' })]
  const denylistRules = shareRulesOf('denylist', [projectSrc('/p/a')])
  expect(filterSharedRules(sessions, denylistRules)).toEqual([])
  expect(deniedSessionIdsRules(sessions, denylistRules)).toEqual(new Set(['a']))

  const allowlistRules = shareRulesOf('allowlist', [projectSrc('/p/a')])
  expect(filterSharedRules(sessions, allowlistRules)).toEqual(sessions)
  expect(deniedSessionIdsRules(sessions, allowlistRules)).toEqual(new Set())
})

test('filterSharedRules / deniedSessionIdsRules: a repo rule catches a session whose project was never named', () => {
  const sessions = [s({ session_id: 'a', project_path: '', git_remote: 'https://github.com/o/secret' })]
  const rules = shareRulesOf('denylist', [repoSrc('github.com/o/secret')])
  expect(filterSharedRules(sessions, rules)).toEqual([])
  expect(deniedSessionIdsRules(sessions, rules)).toEqual(new Set(['a']))
})

test('deny wins across dimensions in denylist mode: a blocked repo denies even if the project is not listed', () => {
  const sessions = [s({ session_id: 'a', project_path: '/p/a', git_remote: 'https://github.com/o/secret' })]
  const rules = shareRulesOf('denylist', [repoSrc('github.com/o/secret')])
  expect(deniedSessionIdsRules(sessions, rules)).toEqual(new Set(['a']))
})

test('in allowlist mode, matching either an allowed repo or an allowed project is enough', () => {
  const byRepo = s({ session_id: 'r', project_path: '/p/other', git_remote: 'https://github.com/o/allowed' })
  const byProject = s({ session_id: 'p', project_path: '/p/allowed', git_remote: 'https://github.com/o/other' })
  const rules = shareRulesOf('allowlist', [repoSrc('github.com/o/allowed'), projectSrc('/p/allowed')])
  expect(deniedSessionIdsRules([byRepo, byProject], rules)).toEqual(new Set())
})

// ---------------------------------------------------------------------------
// The same-array precondition, asserted rather than trusted
// ---------------------------------------------------------------------------

test('sub-day shrinkage REFUSES — a decomposable day the store only partly covers', () => {
  // real says 2026-06-25 had 2 sessions; the store now holds only one of them.
  const all = [storeSessions()[0]!]
  const shared = filterShared(all, normalizeDenied(['github.com/o/secret']))
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared, boundary: '2026-06-23', sealed: {} })).toBeNull()
})

test('a token disagreement on a decomposable day REFUSES', () => {
  const all = storeSessions().map(s => ({ ...s, input_tokens: s.input_tokens + 1 }))
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })).toBeNull()
})

test('a message-count disagreement on a decomposable day REFUSES', () => {
  const all = storeSessions()
  all[0]!.user_message_count += 3
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })).toBeNull()
})

test('a decomposable day the STORE has and the cache does not also REFUSES', () => {
  const all = [
    ...storeSessions(),
    s({ session_id: 'extra', start_time: localAt('2026-06-30', 9), model: 'claude-opus-5', input_tokens: 7, user_message_count: 1 }),
  ]
  expect(buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })).toBeNull()
})

test('PREHISTORY days are never checked — the store is legitimately a subset there', () => {
  // realCache()'s 2026-02-06 row (10 sessions) has no counterpart in the store at all.
  const all = storeSessions()
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })
  expect(out).not.toBeNull()
  expect(out!.dailyActivity.find(d => d.date === '2026-02-06')!.sessionCount).toBe(10)
})

test('non-Claude sessions in the store do not trip the precondition', () => {
  const all = [...storeSessions(), s({ session_id: 'cx', harness: 'codex', start_time: localAt('2026-06-25', 9), user_message_count: 4 })]
  const out = buildSplitStatsCache({ real: realCache(), allStored: all, shared: all, boundary: '2026-06-23', sealed: {} })
  expect(out).not.toBeNull()
})

// --- the live channel (reverse WebSocket) obeys the same denylist as the uploader ---

const LIVE_SESSIONS = [
  s({ session_id: 'open-blocked', project_path: '/w/secret', git_remote: 'github.com/acme/secret' }),
  s({ session_id: 'open-shared', project_path: '/w/public', git_remote: 'github.com/acme/public' }),
]
const liveIndex = () => buildPathRepoIndex(LIVE_SESSIONS)

test('an unrestricted connection gets the live snapshot untouched', () => {
  const snap = {
    liveSessionIds: ['open-blocked', 'open-shared'],
    liveProcesses: [{ cwd: '/anywhere' }],
    liveSessionActivities: { 'open-blocked': 'working', 'open-shared': 'waiting' } as const,
  }
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied([])))
  expect(out.liveSessionIds).toEqual(['open-blocked', 'open-shared'])
  expect(out.liveProcesses).toHaveLength(1)
  expect(out.liveSessionActivities).toEqual({ 'open-blocked': 'working', 'open-shared': 'waiting' })
})

test('a snapshot with no activities yields an empty map, never undefined', () => {
  // The caller sends `shared.liveSessionActivities` verbatim; a missing map must still be a map,
  // or the frame carries `undefined` where the central expects an object.
  const snap = { liveSessionIds: ['open-shared'], liveProcesses: [] }
  expect(filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied([]))).liveSessionActivities).toEqual({})
  const restricted = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied(['github.com/acme/secret'])), liveIndex())
  expect(restricted.liveSessionActivities).toEqual({})
})

// The leak this exists to close: the uploader withheld the repo's metrics while the reverse
// channel announced its session id every 8 seconds.
test('a denied repo\'s open session id never leaves the machine', () => {
  const snap = { liveSessionIds: ['open-blocked', 'open-shared'], liveProcesses: [] }
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied(['github.com/acme/secret'])), liveIndex())
  expect(out.liveSessionIds).toEqual(['open-shared'])
})

test('a live id with no matching session is dropped, not passed through', () => {
  // Unattributable to any repo, and the central resolves live ids against the sessions it was
  // pushed — so keeping it only ever leaked an identifier for a row nobody could render.
  const snap = { liveSessionIds: ['ghost'], liveProcesses: [] }
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied(['github.com/acme/secret'])), liveIndex())
  expect(out.liveSessionIds).toEqual([])
})

test('a process is reported only when its cwd resolves to a repo that is not denied', () => {
  const snap = {
    liveSessionIds: [],
    liveProcesses: [{ cwd: '/w/secret' }, { cwd: '/w/public' }, { cwd: '/w/never-seen' }],
  }
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied(['github.com/acme/secret'])), liveIndex())
  // /w/secret is denied; /w/never-seen cannot be attributed, and cwd is often the repo name —
  // under restrictions an unrecognized directory is withheld rather than assumed innocent.
  expect(out.liveProcesses.map(p => p.cwd)).toEqual(['/w/public'])
})

test('denying the no-repo bucket alone still withholds unattributable processes', () => {
  const snap = { liveSessionIds: [], liveProcesses: [{ cwd: '/w/never-seen' }] }
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied([NO_REPO_KEY])), liveIndex())
  expect(out.liveProcesses).toEqual([])
})

test('the alias folding that guards filterShared guards the live channel too', () => {
  const snap = { liveSessionIds: ['open-blocked'], liveProcesses: [] }
  // Denied under a different SSH/case spelling of the same remote.
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied(['git@github.com:Acme/Secret.git'])), liveIndex())
  expect(out.liveSessionIds).toEqual([])
})

// The leak issue #214 closed: `sessionActivities` travelled beside the two filtered fields and was
// itself unfiltered, so a withheld repo's session announced its id AND its state every 8 seconds.
test("a denied session's activity is dropped while the shared one's survives", () => {
  const snap = {
    liveSessionIds: ['open-blocked', 'open-shared'],
    liveProcesses: [],
    liveSessionActivities: { 'open-blocked': 'waiting-approval', 'open-shared': 'working' } as const,
  }
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied(['github.com/acme/secret'])), liveIndex())
  expect(out.liveSessionActivities).toEqual({ 'open-shared': 'working' })
})

test('an activity keyed by a session we cannot find is dropped, like the id would be', () => {
  const snap = {
    liveSessionIds: [],
    liveProcesses: [],
    liveSessionActivities: { ghost: 'working' } as const,
  }
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied(['github.com/acme/secret'])), liveIndex())
  expect(out.liveSessionActivities).toEqual({})
})

test('an allowlist keeps only the allowed session\'s activity', () => {
  const snap = {
    liveSessionIds: ['open-blocked', 'open-shared'],
    liveProcesses: [],
    liveSessionActivities: { 'open-blocked': 'working', 'open-shared': 'waiting' } as const,
  }
  const rules = { mode: 'allowlist' as const, sources: new Set(['repo:github.com/acme/public']) }
  const out = filterLiveShared(snap, LIVE_SESSIONS, rules, liveIndex())
  expect(out.liveSessionIds).toEqual(['open-shared'])
  expect(out.liveSessionActivities).toEqual({ 'open-shared': 'waiting' })
})

test('an EMPTY allowlist shares no activity at all', () => {
  const snap = {
    liveSessionIds: ['open-shared'],
    liveProcesses: [],
    liveSessionActivities: { 'open-shared': 'working' } as const,
  }
  const out = filterLiveShared(snap, LIVE_SESSIONS, { mode: 'allowlist', sources: new Set() }, liveIndex())
  expect(out.liveSessionActivities).toEqual({})
})

// Enumerated over the RESULT'S OWN KEYS rather than field by field: the point of moving the
// activities into this function is that ONE function decides the whole outgoing frame, so a field
// added to it later is covered by this test instead of needing another one — which is precisely
// what did not happen when `sessionActivities` was added at the call site.
test("nothing about a denied session appears in ANY field of the outgoing frame", () => {
  const snap = {
    liveSessionIds: ['open-blocked', 'open-shared'],
    liveProcesses: [{ cwd: '/w/secret' }, { cwd: '/w/public' }],
    liveSessionActivities: { 'open-blocked': 'waiting-approval', 'open-shared': 'working' } as const,
  }
  const out = filterLiveShared(snap, LIVE_SESSIONS, denylistRules(normalizeDenied(['github.com/acme/secret'])), liveIndex())

  expect(Object.keys(out).sort()).toEqual(['liveProcesses', 'liveSessionActivities', 'liveSessionIds'])
  for (const value of Object.values(out)) {
    const json = JSON.stringify(value)
    expect(json).not.toContain('open-blocked')
    expect(json).not.toContain('secret')
  }
  // ...and the shared half is still there, or an all-empty frame would pass the check above.
  expect(out.liveSessionIds).toEqual(['open-shared'])
  expect(out.liveProcesses.map(p => p.cwd)).toEqual(['/w/public'])
  expect(out.liveSessionActivities).toEqual({ 'open-shared': 'working' })
})

// --- the cross-check that keeps THIS file the single source of the sharing semantics ------------
//
// `@agentistics/core`'s `bucketSharedBy` answers the same question one BUCKET at a time, so that
// the reverse warning (a sibling's announced rules withholding a repository the user is about to
// start sharing) can be evaluated in the browser bundle, which may never import this module. That
// is a second implementation, and a second implementation of a privacy rule is exactly how a
// picker ends up confidently contradicting what the uploader actually does. This test is the
// guard: every combination below must come out identical on both sides.

test('bucketSharedBy agrees with sessionShared on every mode x dimension x bucket combination', () => {
  const API = 'https://github.com/acme/api'
  const WEB = 'git@github.com:Acme/Web.git'
  const sourceSets: ShareSource[][] = [
    [],
    [{ type: 'repo', value: API }],
    [{ type: 'repo', value: WEB }],
    [{ type: 'project', value: '/home/a/api' }],
    [{ type: 'none', value: '' }],
    [{ type: 'repo', value: API }, { type: 'project', value: '/home/a/web' }],
    [{ type: 'repo', value: 'not a remote at all' }],
  ]
  // Each bucket is stated twice: as the (git_remote, project_path) pair `sessionShared` consumes,
  // and as the (repoKey, projectPath) pair a picker row names.
  const buckets: { remote: string; path: string }[] = [
    { remote: API, path: '/home/a/api' },
    { remote: WEB, path: '/home/a/web' },
    { remote: API, path: '' },
    { remote: '', path: '/home/a/api' },
    { remote: '', path: '' },
    { remote: 'https://github.com/acme/untouched', path: '/home/a/untouched' },
  ]

  let sharedSeen = 0
  let withheldSeen = 0
  let compared = 0
  for (const mode of ['denylist', 'allowlist'] as const) {
    for (const sources of sourceSets) {
      for (const b of buckets) {
        const viaSession = sessionShared(
          { git_remote: b.remote, project_path: b.path },
          shareRulesOf(mode, sources),
        )
        const viaBucket = bucketSharedBy(
          // A session with no resolvable remote lands in the unattributed bucket, which a picker
          // row names with the sentinel — `repoKeyOf` is what makes that mapping this file's, not
          // the caller's.
          { repoKey: repoKeyOf({ git_remote: b.remote, project_path: b.path }), projectPath: b.path },
          { shareMode: mode, sources },
        )
        expect(`${mode}|${JSON.stringify(sources)}|${b.remote}|${b.path}|${viaBucket}`)
          .toBe(`${mode}|${JSON.stringify(sources)}|${b.remote}|${b.path}|${viaSession}`)
        compared++
        if (viaSession) sharedSeen++
        else withheldSeen++
      }
    }
  }
  // Without these the loop above would pass just as happily over an empty table, or over one that
  // only ever produced `true` on both sides — the two shapes of vacuous test this repo has shipped
  // before.
  expect(compared).toBe(2 * sourceSets.length * buckets.length)
  expect(sharedSeen).toBeGreaterThan(0)
  expect(withheldSeen).toBeGreaterThan(0)
})

// The same guard for the APPLY arithmetic (`planProposalApply`, `@agentistics/core`). It composes
// two rule sets; `sessionShared` — this file — is what decides whether the composition actually
// shares a session. The property is one sentence: applying a sibling's proposal may only ever
// NARROW what this machine shares. Anything else is the button that hides things starting to share
// something the user had chosen to hide.

test('planProposalApply never shares a session the current rules already withheld', () => {
  const API = 'https://github.com/acme/api'
  const SECRET = 'git@github.com:Acme/Secret.git'
  const ruleSets: { shareMode: 'denylist' | 'allowlist'; sources: ShareSource[] }[] = []
  for (const mode of ['denylist', 'allowlist'] as const) {
    for (const sources of [
      [],
      [{ type: 'repo', value: API }] as ShareSource[],
      [{ type: 'repo', value: SECRET }] as ShareSource[],
      [{ type: 'repo', value: API }, { type: 'repo', value: SECRET }] as ShareSource[],
      [{ type: 'none', value: '' }] as ShareSource[],
      [{ type: 'project', value: '/home/a/secret' }] as ShareSource[],
    ]) ruleSets.push({ shareMode: mode, sources })
  }
  const sessions = [
    s({ session_id: 'a', git_remote: API, project_path: '/home/a/api' }),
    s({ session_id: 'b', git_remote: SECRET, project_path: '/home/a/secret' }),
    s({ session_id: 'c', git_remote: '', project_path: '/home/a/none' }),
    s({ session_id: 'd', git_remote: '', project_path: '/home/a/secret' }),
    // A workspace directory holding BOTH repos — this is what puts `sessionShared`'s
    // ambiguous-directory clause (`PathRepoIndex.conflicts`) on the merge's path. Without it the
    // table exercised only the unambiguous half, and the fail-closed conflict rule — the one part
    // of the semantics `planProposalApply` deliberately does not model — was covered by reading
    // rather than by running.
    s({ session_id: 'e', git_remote: API, project_path: '/home/a/workspace' }),
    s({ session_id: 'f', git_remote: SECRET, project_path: '/home/a/workspace' }),
  ]
  const index = buildPathRepoIndex(sessions)
  expect(index.conflicts.get('/home/a/workspace')?.size).toBe(2)

  let narrowed = 0
  let compared = 0
  for (const current of ruleSets) {
    for (const proposal of ruleSets) {
      const { merged } = planProposalApply(current, proposal)
      for (const session of sessions) {
        const before = sessionShared(session, shareRulesOf(current.shareMode, current.sources), index)
        const after = sessionShared(session, shareRulesOf(merged.shareMode, merged.sources), index)
        // The property. `after && !before` is the bug; `!after && before` is a legitimate narrowing.
        expect(`${session.session_id}|${after && !before}`).toBe(`${session.session_id}|false`)
        if (before && !after) narrowed++
        compared++
      }
    }
  }
  // Not vacuous: the table is non-empty AND it really does narrow somewhere, so a `merged` that
  // simply echoed `current` would not pass this.
  expect(compared).toBe(ruleSets.length * ruleSets.length * sessions.length)
  expect(narrowed).toBeGreaterThan(0)
})
