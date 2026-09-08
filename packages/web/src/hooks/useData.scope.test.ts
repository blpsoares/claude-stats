/**
 * useData.scope.test.ts — filter-scope invariants for useDerivedStats.
 *
 * These tests encode ONE rule: whatever scope the active filters describe, every number the
 * hook returns must come from that scope and nothing else. `stats-cache.json` is Claude-only
 * and has no project/repo/tag/model granularity, so any output derived from it must fall back
 * to per-session aggregation as soon as a filter narrows the scope along a dimension the cache
 * cannot represent.
 *
 * Today that fallback is decided independently at each call site (`useData.ts:846`, `:870`,
 * `:955`, `:1015`) with a DIFFERENT condition list each time, so some outputs leak the global
 * Claude history into a filtered view. The tests marked LEAK below fail against current code —
 * they are the measurement, not the fix.
 *
 * useDerivedStats is a hook (a single useMemo), so `react` is stubbed to run the memo body
 * eagerly. No React renderer, no new dependency.
 */
import { describe, test, expect, mock } from 'bun:test'
import * as React from 'react'
import { emptyStatsCache } from '@agentistics/core'
import type { AppData, Filters, SessionMeta, StatsCache } from '@agentistics/core'
import type { TagDef } from '../lib/tagMatch'

/**
 * `mock.module` replaces the module for the WHOLE test process and never unwinds, so this stub
 * is also what every test file that runs after this one sees. A hooks-only stub therefore broke
 * unrelated suites: `lucide-react` calls `react.createContext` at import time, which was absent,
 * so StatCard.test.ts and splitInlinedHistory.test.ts failed in a full `bun test` run while
 * passing in isolation.
 *
 * Spreading the real React keeps every other export intact and overrides only the hooks this
 * file needs to run the memo body eagerly. The real module is captured by the import above,
 * which is evaluated before this call.
 *
 * Every override that stays must still be FAITHFUL to the hook it replaces, for the same reason:
 * whatever runs after this file gets this React. `useState` ignoring a lazy initializer handed the
 * component the function itself as its state — `useTerminalSize` does `useState(currentSize)`, so
 * every Ink surface rendered after this file came out at a width of `undefined`.
 */
mock.module('react', () => ({
  ...React,
  default: (React as { default?: unknown }).default ?? React,
  // ONLY `useMemo`, and that is the whole list on purpose. `useDerivedStats` — the only thing this
  // file calls — uses no other hook, and every extra override LEAKS: `mock.module` replaces the
  // module for the whole process and never unwinds, so whatever runs after this file gets it.
  //
  // Three leaks have been found this way, each from an override nothing here needed. A hooks-only
  // stub broke `lucide-react`'s `createContext`. A `useState` ignoring its lazy initializer gave
  // `useTerminalSize` a function as its size. And a `useState` whose SETTER does nothing, plus a
  // no-op `useEffect`, left every Ink screen on its first frame forever — the TUI's session tests
  // timed out at `sessions() called 0 times` in a full run while passing alone.
  //
  // So the rule is not "make the stub faithful", it is "override nothing this file does not call".
  useMemo: <T>(fn: () => T) => fn(),
}))

const { useDerivedStats } = await import('./useData')

// Fixtures

const REPO_A = 'github.com/org/alpha'
const REPO_B = 'github.com/org/beta'

function mkSession(over: Partial<SessionMeta> & Pick<SessionMeta, 'session_id' | 'harness'>): SessionMeta {
  return {
    project_path: '/home/u/alpha',
    start_time: '2026-07-01T10:00:00.000Z',
    end_time: '2026-07-01T11:00:00.000Z',
    duration_minutes: 60,
    user_message_count: 5,
    assistant_message_count: 5,
    tool_counts: { Read: 2 },
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: 1000,
    output_tokens: 500,
    first_prompt: 'hello',
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: 0,
    tool_error_categories: {},
    uses_task_agent: false,
    uses_mcp: false,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: [],
    user_message_timestamps: [],
    ...over,
  } as SessionMeta
}

/** Deep Claude history that exists ONLY as an aggregate: 5 consecutive days, 10 sessions each.
 *  It predates every session in the fixture and belongs to no repo/project the filters select. */
function historyStatsCache(): StatsCache {
  const sc = emptyStatsCache()
  sc.lastComputedDate = '2026-01-05'
  sc.dailyActivity = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'].map(date => ({
    date,
    sessionCount: 10,
    messageCount: 100,
    toolCallCount: 50,
  })) as StatsCache['dailyActivity']
  // modelUsage must match the history dailyActivity claims. Leaving it empty made the cache-backed
  // unfiltered cost smaller than a SINGLE machine's session-derived cost, so "subset < total"
  // failed for a reason that cannot occur in real data — the cache always covers that history.
  sc.modelUsage = {
    'claude-opus-5': {
      inputTokens: 5_000_000, outputTokens: 1_000_000,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 0,
    },
  } as StatsCache['modelUsage']
  return sc
}

const SESSIONS: SessionMeta[] = [
  mkSession({ session_id: 'c1', harness: 'claude', model: 'claude-opus-5',    git_remote: REPO_A, project_path: '/home/u/alpha', start_time: '2026-07-01T10:00:00.000Z', memberId: 'machine-1', user: 'vini', teamIds: ['team-1'] }),
  mkSession({ session_id: 'c2', harness: 'claude', model: 'claude-sonnet-4-6', git_remote: REPO_B, project_path: '/home/u/beta',  start_time: '2026-07-02T10:00:00.000Z', memberId: 'machine-2', user: 'vini', teamIds: ['team-2'] }),
  mkSession({ session_id: 'x1', harness: 'codex',  model: 'gpt-5.4-mini',      git_remote: REPO_A, project_path: '/home/u/alpha', start_time: '2026-07-03T10:00:00.000Z', memberId: 'machine-1', user: 'vini', teamIds: ['team-1'] }),
  mkSession({ session_id: 'p1', harness: 'copilot', model: 'gpt-5-mini',       git_remote: REPO_B, project_path: '/home/u/beta',  start_time: '2026-07-04T10:00:00.000Z', memberId: 'machine-2', user: 'vini', teamIds: ['team-2'] }),
]

const DATA: AppData = {
  statsCache: historyStatsCache(),
  sessions: SESSIONS,
  projects: [],
  allSessions: [],
  harnesses: ['claude', 'codex', 'copilot'],
}

const TAG_ALPHA: TagDef = { _id: 't1', name: 'alpha', sources: [{ type: 'repo', value: REPO_A }] }

function mkFilters(over: Partial<Filters> = {}): Filters {
  return { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [], ...over }
}

/** The hook is a plain useMemo — with react stubbed it returns the derived object directly. */
function derive(filters: Filters, tags: TagDef[] = []) {
  const d = useDerivedStats(DATA, filters, tags)
  if (!d) throw new Error('derived is null')
  return d
}

/** Sessions of the fixture that belong to a repo — the ceiling for any repo-scoped count. */
const SESSIONS_IN_REPO_A = SESSIONS.filter(s => s.git_remote === REPO_A).length // 2

// Session scoping — the list the user actually sees

describe('scope invariant: filteredSessions', () => {
  test('harness filter yields only that harness', () => {
    const d = derive(mkFilters({ harnesses: ['codex'] }))
    expect(d.filteredSessions.length).toBeGreaterThan(0)
    expect(d.filteredSessions.every(s => s.harness === 'codex')).toBe(true)
  })

  test('a model filter implies its harness — no Claude session survives a Codex model', () => {
    const d = derive(mkFilters({ models: ['gpt-5.4-mini'] }))
    expect(d.filteredSessions.length).toBeGreaterThan(0)
    expect(d.filteredSessions.every(s => s.harness === 'codex')).toBe(true)
  })

  test('repo filter yields only that repo', () => {
    const d = derive(mkFilters({ repos: [REPO_A] }))
    expect(d.filteredSessions.every(s => s.git_remote === REPO_A)).toBe(true)
  })
})

// Aggregate scoping — the numbers rendered next to that list

describe('scope invariant: statsCache must not leak into a narrowed scope', () => {
  test('LEAK — repo filter: allTimeTotalSessions counts the global Claude history', () => {
    const d = derive(mkFilters({ repos: [REPO_A] }))
    // Only 2 fixture sessions live in REPO_A. The 50 aggregated sessions in statsCache belong
    // to no repo and cannot be attributed to one.
    expect(d.allTimeTotalSessions).toBeLessThanOrEqual(SESSIONS_IN_REPO_A)
  })

  test('LEAK — project filter: allTimeTotalSessions counts the global Claude history', () => {
    const d = derive(mkFilters({ projects: ['/home/u/alpha'] }))
    expect(d.allTimeTotalSessions).toBeLessThanOrEqual(2)
  })

  test('LEAK — tag filter: allTimeTotalSessions counts the global Claude history', () => {
    const d = derive(mkFilters({ tags: ['t1'] }), [TAG_ALPHA])
    expect(d.allTimeTotalSessions).toBeLessThanOrEqual(SESSIONS_IN_REPO_A)
  })

  test('LEAK — repo filter: longestStreak counts days from the global Claude history', () => {
    const d = derive(mkFilters({ repos: [REPO_A] }))
    // REPO_A has 2 sessions on 2 non-consecutive days (Jul 1 and Jul 3) → longest streak 1.
    // The 5 consecutive January days exist only in the Claude-wide aggregate.
    expect(d.longestStreak).toBeLessThanOrEqual(2)
  })

  test('LEAK — tag filter: longestStreak counts days from the global Claude history', () => {
    const d = derive(mkFilters({ tags: ['t1'] }), [TAG_ALPHA])
    expect(d.longestStreak).toBeLessThanOrEqual(2)
  })

  test('LEAK — machine filter: totalSessions counts the global Claude history', () => {
    // machine-1 owns 2 fixture sessions. `sessionFiltered` (useData.ts:870) does not list
    // `machines`, so the KPIs keep reading the Claude-wide aggregate.
    const d = derive(mkFilters({ machines: ['machine-1'] }))
    expect(d.totalSessions).toBeLessThanOrEqual(2)
  })

  test('LEAK — machine filter: totalCostUSD counts the global Claude history', () => {
    const one = derive(mkFilters({ machines: ['machine-1'] })).totalCostUSD
    const all = derive(mkFilters()).totalCostUSD
    // Scoping to one of two machines must not return the unfiltered cost.
    expect(one).toBeLessThan(all)
  })

  test('LEAK — machine filter: totalToolCalls counts the global Claude history', () => {
    const d = derive(mkFilters({ machines: ['machine-1'] }))
    expect(d.totalToolCalls).toBeLessThanOrEqual(4) // 2 sessions x 2 Read calls
  })

  test('LEAK — team filter: totalSessions counts the global Claude history', () => {
    const d = derive(mkFilters({ teams: ['team-1'] }))
    expect(d.totalSessions).toBeLessThanOrEqual(2)
  })

  test('non-Claude harness filter keeps allTimeTotalSessions off statsCache', () => {
    // This path IS gated today (nonClaudeHarness) — it documents the behavior the leaking
    // call sites should converge on.
    const d = derive(mkFilters({ harnesses: ['codex'] }))
    expect(d.allTimeTotalSessions).toBe(1)
  })
})

// Machine scope — every number rendered next to a machine-filtered view

describe('scope invariant: a machine filter scopes the whole derived object', () => {
  // machine-1 owns c1 (claude, 1000 in / 500 out) and x1 (codex, 1000 in / 500 out).
  const machine1 = () => derive(mkFilters({ machines: ['machine-1'] }))

  test('token totals come from that machine only', () => {
    const d = machine1()
    expect(d.inputTokens).toBe(2000)
    expect(d.outputTokens).toBe(1000)
  })

  test('heatmap contains no day that exists only in the global Claude aggregate', () => {
    const d = machine1()
    expect(d.heatmapData.some(p => p.date.startsWith('2026-01'))).toBe(false)
  })

  test('model breakdown lists only models that machine used', () => {
    const d = machine1()
    expect(Object.keys(d.modelUsage).sort()).toEqual(['claude-opus-5', 'gpt-5.4-mini'])
  })

  test('longestStreak counts only that machine\'s days', () => {
    const d = machine1()
    expect(d.longestStreak).toBeLessThanOrEqual(2)
  })

  test('allTimeTotalSessions counts only that machine\'s sessions', () => {
    const d = machine1()
    expect(d.allTimeTotalSessions).toBeLessThanOrEqual(2)
  })

  test('a machine filter changes the cost — two machines cannot both report the total', () => {
    const one = machine1().totalCostUSD
    const two = derive(mkFilters({ machines: ['machine-2'] })).totalCostUSD
    const all = derive(mkFilters()).totalCostUSD
    expect(one).toBeLessThan(all)
    expect(two).toBeLessThan(all)
  })
})

// Cross-dimension consistency

describe('scope invariant: per-harness sums reconcile with the unified view', () => {
  test('sum of per-harness filtered sessions equals the unfiltered session count', () => {
    const all = derive(mkFilters()).filteredSessions.length
    const perHarness = (['claude', 'codex', 'copilot'] as const)
      .map(h => derive(mkFilters({ harnesses: [h] })).filteredSessions.length)
      .reduce((a, b) => a + b, 0)
    expect(perHarness).toBe(all)
  })
})
