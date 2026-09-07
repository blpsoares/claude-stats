import { describe, test, expect } from 'bun:test'
import type { AppData, ModelUsage, SessionMeta, StatsCache } from '@agentistics/core'
import { calcCost, emptyStatsCache } from '@agentistics/core'

function usage(inputTokens: number, outputTokens: number): ModelUsage {
  return {
    inputTokens, outputTokens,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0,
  }
}
import { harnessRows, overviewTotals, activitySeries, projectRows, modelRows, sessionRows } from './selectors'

// Fixtures

function session(over: Partial<SessionMeta> & { session_id: string }): SessionMeta {
  return {
    project_path: '/home/u/proj', start_time: '2026-07-20T10:00:00Z',
    duration_minutes: 5, user_message_count: 1, assistant_message_count: 1,
    tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
    git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0,
    first_prompt: '', user_interruptions: 0, user_response_times: [], tool_errors: 0,
    tool_error_categories: {}, uses_task_agent: false, uses_mcp: false,
    uses_web_search: false, uses_web_fetch: false, lines_added: 0, lines_removed: 0,
    files_modified: 0, message_hours: [], user_message_timestamps: [],
    ...over,
  } as SessionMeta
}

function agents(totalInvocations: number): SessionMeta['agentMetrics'] {
  return { invocations: [], totalInvocations, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0, unmeasuredInvocations: 0 }
}

function appData(over: Partial<AppData> = {}): AppData {
  return {
    statsCache: emptyStatsCache(), sessions: [], projects: [], allSessions: [],
    harnesses: ['claude'], ...over,
  } as AppData
}

/** A statsCache carrying deep Claude history that the session list does NOT contain. */
function claudeCache(): StatsCache {
  return {
    ...emptyStatsCache(),
    totalSessions: 500, totalMessages: 9000,
    modelUsage: {
      'claude-sonnet-4-6': usage(1_000_000, 200_000),
    },
  }
}

// harnessRows — the Claude-only statsCache rule

describe('harnessRows', () => {
  test('aggregates Claude from statsCache, not from the session list', () => {
    const data = appData({
      statsCache: claudeCache(),
      // Only ONE claude session survives individually; the cache knows about 500.
      sessions: [session({ session_id: 'a', harness: 'claude', input_tokens: 10 })],
      harnesses: ['claude'],
    })

    const claude = harnessRows(data).find(r => r.harness === 'claude')!

    expect(claude.sessions).toBe(500)
    expect(claude.tokens).toBe(1_200_000)
    expect(claude.costUSD).toBeCloseTo(calcCost(usage(1_000_000, 200_000), 'claude-sonnet-4-6'), 6)
  })

  test('aggregates a non-Claude harness from per-session sums', () => {
    const data = appData({
      statsCache: claudeCache(),
      sessions: [
        session({ session_id: 'c1', harness: 'codex', model: 'gpt-5', input_tokens: 100, output_tokens: 50 }),
        session({ session_id: 'c2', harness: 'codex', model: 'gpt-5', input_tokens: 300, output_tokens: 10 }),
      ],
      harnesses: ['claude', 'codex'],
    })

    const codex = harnessRows(data).find(r => r.harness === 'codex')!

    expect(codex.sessions).toBe(2)
    expect(codex.tokens).toBe(460)
  })

  test('never lets the Claude statsCache leak into a non-Claude harness total', () => {
    const data = appData({
      statsCache: claudeCache(),
      sessions: [session({ session_id: 'c1', harness: 'codex', model: 'gpt-5', input_tokens: 100 })],
      harnesses: ['claude', 'codex'],
    })

    const codex = harnessRows(data).find(r => r.harness === 'codex')!

    expect(codex.sessions).toBe(1)
    expect(codex.tokens).toBe(100)
  })

  test('only returns harnesses present in data.harnesses', () => {
    const data = appData({ sessions: [], harnesses: ['claude'] })
    expect(harnessRows(data).map(r => r.harness)).toEqual(['claude'])
  })

  test('treats a session with no harness field as claude', () => {
    const data = appData({
      sessions: [session({ session_id: 'x', model: 'gpt-5', input_tokens: 100 })],
      harnesses: ['codex'],
    })
    // The legacy session defaults to claude, so codex must not claim it.
    expect(harnessRows(data).find(r => r.harness === 'codex')!.sessions).toBe(0)
  })
})

// overviewTotals

describe('overviewTotals', () => {
  test('sums Claude cache totals and non-Claude session sums together', () => {
    const data = appData({
      statsCache: claudeCache(),
      sessions: [session({ session_id: 'c1', harness: 'codex', model: 'gpt-5', input_tokens: 400, output_tokens: 60 })],
      harnesses: ['claude', 'codex'],
    })

    const t = overviewTotals(data)

    expect(t.sessions).toBe(501)          // 500 from the cache + 1 codex session
    expect(t.tokens).toBe(1_200_000 + 460)
  })

  test('is all zeros for an empty dataset', () => {
    const t = overviewTotals(appData({ harnesses: [] }))
    expect(t).toEqual({ sessions: 0, tokens: 0, costUSD: 0, messages: 0 })
  })
})

// activitySeries — the sparkline input

describe('activitySeries', () => {
  const today = new Date('2026-07-28T12:00:00Z')

  test('returns one point per requested day, oldest first', () => {
    const data = appData({
      statsCache: {
        ...emptyStatsCache(),
        dailyActivity: [
          { date: '2026-07-28', messageCount: 5, sessionCount: 1 },
          { date: '2026-07-26', messageCount: 3, sessionCount: 1 },
        ],
      } as StatsCache,
    })

    // oldest first: 07-26 (3 msgs), 07-27 (silent), 07-28 (5 msgs)
    expect(activitySeries(data, 3, today)).toEqual([3, 0, 5])
  })

  test('fills days with no activity with zero rather than omitting them', () => {
    const data = appData({ statsCache: emptyStatsCache() })
    expect(activitySeries(data, 4, today)).toEqual([0, 0, 0, 0])
  })
})

// projectRows

describe('projectRows', () => {
  test('ranks projects by cost, highest first', () => {
    const data = appData({
      sessions: [
        session({ session_id: 'a', project_path: '/p/cheap', model: 'claude-sonnet-4-6', input_tokens: 10 }),
        session({ session_id: 'b', project_path: '/p/pricey', model: 'claude-sonnet-4-6', input_tokens: 5_000_000 }),
      ],
      harnesses: ['claude'],
    })

    expect(projectRows(data).map(r => r.name)).toEqual(['pricey', 'cheap'])
  })

  test('groups every session of one project into a single row', () => {
    const data = appData({
      sessions: [
        session({ session_id: 'a', project_path: '/p/one', model: 'claude-sonnet-4-6', input_tokens: 10 }),
        session({ session_id: 'b', project_path: '/p/one', model: 'claude-sonnet-4-6', input_tokens: 20 }),
      ],
      harnesses: ['claude'],
    })

    const rows = projectRows(data)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessions).toBe(2)
    expect(rows[0]!.tokens).toBe(30)
  })
})

// modelRows

describe('modelRows', () => {
  test('merges the Claude statsCache usage with non-Claude session usage per model', () => {
    const data = appData({
      statsCache: claudeCache(),
      sessions: [session({ session_id: 'c', harness: 'codex', model: 'gpt-5', input_tokens: 700 })],
      harnesses: ['claude', 'codex'],
    })

    const rows = modelRows(data)
    const sonnet = rows.find(r => r.model === 'claude-sonnet-4-6')!
    const gpt = rows.find(r => r.model === 'gpt-5')!

    expect(sonnet.tokens).toBe(1_200_000)
    expect(gpt.tokens).toBe(700)
  })

  test('ranks models by cost, highest first', () => {
    const data = appData({
      statsCache: claudeCache(),
      sessions: [session({ session_id: 'c', harness: 'codex', model: 'gpt-5', input_tokens: 1 })],
      harnesses: ['claude', 'codex'],
    })
    expect(modelRows(data)[0]!.model).toBe('claude-sonnet-4-6')
  })
})

// sessionRows

describe('sessionRows', () => {
  test('orders sessions newest first', () => {
    const data = appData({
      sessions: [
        session({ session_id: 'old', start_time: '2026-07-01T10:00:00Z' }),
        session({ session_id: 'new', start_time: '2026-07-27T10:00:00Z' }),
      ],
    })
    expect(sessionRows(data).map(r => r.id)).toEqual(['new', 'old'])
  })

  test('marks a session that is open in a live process', () => {
    const data = appData({
      sessions: [session({ session_id: 'live-one' }), session({ session_id: 'dead-one' })],
      liveSessionIds: ['live-one'],
    })
    const rows = sessionRows(data)
    expect(rows.find(r => r.id === 'live-one')!.live).toBe(true)
    expect(rows.find(r => r.id === 'dead-one')!.live).toBe(false)
  })

  test('falls back to the first prompt when a session has no title, stripping command wrappers', () => {
    const data = appData({
      sessions: [session({
        session_id: 's',
        first_prompt: '<command-name>/commit</command-name>fix the parser',
      })],
    })
    expect(sessionRows(data)[0]!.label).toBe('fix the parser')
  })

  test('honours the limit option', () => {
    const data = appData({
      sessions: [session({ session_id: 'a' }), session({ session_id: 'b' }), session({ session_id: 'c' })],
    })
    expect(sessionRows(data, { limit: 2 })).toHaveLength(2)
  })
})

// agent invocations — the metric HARNESS_CAPABILITIES actually differentiates

describe('harnessRows agent counts', () => {
  test('counts agent invocations recorded on Claude sessions', () => {
    const data = appData({
      statsCache: claudeCache(),
      sessions: [
        session({ session_id: 'a', harness: 'claude', agentMetrics: agents(2) }),
        session({ session_id: 'b', harness: 'claude', agentMetrics: agents(1) }),
      ],
      harnesses: ['claude'],
    })
    expect(harnessRows(data).find(r => r.harness === 'claude')!.agents).toBe(3)
  })

  test('reports zero agents for a harness that records none', () => {
    const data = appData({
      sessions: [session({ session_id: 'c', harness: 'codex', model: 'gpt-5' })],
      harnesses: ['codex'],
    })
    expect(harnessRows(data).find(r => r.harness === 'codex')!.agents).toBe(0)
  })
})
