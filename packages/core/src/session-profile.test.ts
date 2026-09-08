import { describe, expect, it } from 'bun:test'
import { profileOf } from './session-profile'
import type { SessionMeta } from './types'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-08T12:00:00Z')

/** The narrowest session this module accepts, dated `daysAgo` before NOW. */
function session(daysAgo: number, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: `s${daysAgo}-${Math.random()}`,
    project_path: '/p',
    start_time: new Date(NOW - daysAgo * DAY).toISOString(),
    duration_minutes: 0,
    user_message_count: 0,
    assistant_message_count: 0,
    tool_counts: {},
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: 0,
    output_tokens: 0,
    first_prompt: '',
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
    harness: 'claude',
    ...over,
  }
}

/**
 * A session as `parseSessionJsonl` actually produces it — the transcript WAS read, so the fields
 * that record a measurement are present and may honestly be zero.
 *
 * The plain `session()` above is the other half: a record with no transcript behind it (Claude's
 * own `session-meta` files, or a harness with no reader), which is what `undefined` means. Building
 * fixtures that carry `compact_count: 0` with no `_source` described a session the pipeline cannot
 * produce, which is how the missing-zeros defect stayed invisible to the tests.
 */
function parsed(daysAgo: number, over: Partial<SessionMeta> = {}): SessionMeta {
  return session(daysAgo, { _source: 'jsonl', compact_count: 0, compact_ms: 0, skill_uses: {}, ...over })
}

describe('the window', () => {
  it('keeps sessions inside 30 days and drops the ones outside', () => {
    const p = profileOf([
      session(1, { user_message_count: 10 }),
      session(29, { user_message_count: 10 }),
      session(31, { user_message_count: 999 }),
    ], NOW)
    expect(p.sessions).toBe(2)
    expect(p.metrics.messages.n).toBe(2)
  })

  it('uses the UTC day rule, not the local clock', () => {
    // 23:30 UTC on the boundary day. A local-clock reading at UTC-3 would file this on the next
    // day and move it in or out of the window depending on the machine's timezone.
    const p = profileOf(
      [session(0, { start_time: '2026-08-09T23:30:00Z', user_message_count: 5 })],
      NOW,
    )
    expect(p.sessions).toBe(0)
  })
})

describe('median over mean', () => {
  it('reports both, and they differ on a skewed set', () => {
    // Real shape, measured over 692 sessions: median 30, mean 92. The mean describes no session
    // anybody has, which is why the median is what a card quotes.
    const p = profileOf(
      [1, 2, 3, 4, 500].map(n => session(1, { user_message_count: n })),
      NOW,
    )
    expect(p.metrics.messages.median).toBe(3)
    expect(p.metrics.messages.mean).toBe(102)
  })
})

describe('n is PER METRIC', () => {
  it('counts only the sessions that could have carried the metric', () => {
    // `skill_uses` exists only for sessions whose transcript survived. A shared `n` would average
    // skills over sessions that could never have had one.
    const p = profileOf([
      parsed(1, { user_message_count: 10, skill_uses: { a: 2 } }),
      session(2, { user_message_count: 10 }),
      session(3, { user_message_count: 10 }),
    ], NOW)
    expect(p.metrics.messages.n).toBe(3)
    expect(p.metrics.skills.n).toBe(1)
  })

  it('counts a present-but-empty measurement, and not an absent one', () => {
    // `skill_uses: {}` is "this session used no skills" — a real zero. An absent field is "we
    // cannot know", and it must not be averaged in as a zero.
    const p = profileOf([
      parsed(1, { skill_uses: {} }),
      session(2, {}),
    ], NOW)
    expect(p.metrics.skills.n).toBe(1)
    expect(p.metrics.skills.median).toBe(0)
  })
})

/**
 * THE DENOMINATOR HAS TO BE ABLE TO EXCEED THE NUMERATOR.
 *
 * `n === nonZero` on a rare event means every session that answered answered above zero — which is
 * only ever true when the producer wrote nothing for the sessions that answered zero. Then the
 * median is at least 1 by construction and the panel reports a rare event as typical.
 */
describe('a session that answered ZERO is still in the denominator', () => {
  it('compacts: n exceeds nonZero once the sessions that never compacted are counted', () => {
    const p = profileOf([
      ...Array.from({ length: 17 }, () => parsed(1, { compact_count: 1 })),
      parsed(1, { compact_count: 8 }),
      ...Array.from({ length: 40 }, () => parsed(1, { compact_count: 0 })),
    ], NOW)
    expect(p.metrics.compacts.median).toBe(0)
    expect(p.metrics.compacts.nonZero).toBe(18)
    expect(p.metrics.compacts.n).toBe(58)
    expect(p.metrics.compacts.n).toBeGreaterThan(p.metrics.compacts.nonZero)
  })

  it('skills: a parsed session that invoked none counts', () => {
    const p = profileOf([
      parsed(1, { skill_uses: { a: 1, b: 2 } }),
      ...Array.from({ length: 9 }, () => parsed(1)),
    ], NOW)
    expect(p.metrics.skills.n).toBe(10)
    expect(p.metrics.skills.nonZero).toBe(1)
    expect(p.metrics.skills.median).toBe(0)
  })

  it('subagents: a parsed session that launched none counts, a meta-sourced one does not', () => {
    // `agentMetrics` is absent both when nothing ran and when nothing was measured, so the reader
    // keys off `_source` instead — the parser sets `'jsonl'` exactly when it read this session's
    // own transcript.
    const withAgents = parsed(1, {
      agentMetrics: {
        invocations: [], totalInvocations: 3, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0,
      },
    })
    const p = profileOf([
      withAgents,
      ...Array.from({ length: 5 }, () => parsed(1)),
      session(1, {}),
      session(2, { _source: 'meta' }),
      session(3, { _source: 'subdir' }),
    ], NOW)
    expect(p.metrics.subagents.n).toBe(6)
    expect(p.metrics.subagents.nonZero).toBe(1)
    expect(p.metrics.subagents.median).toBe(0)
  })

  it('mcpServers: a parsed session that called none counts, and an incapable harness does not', () => {
    // `Object.keys(...).length` always yields a number, so before the capability gate every session
    // entered `n` — including harnesses whose adapter never names an MCP tool `mcp__server__tool`.
    const p = profileOf([
      parsed(1, { tool_counts: { 'mcp__db__query': 2, Read: 1 } }),
      parsed(1, { tool_counts: { Read: 4 } }),
      session(1, { harness: 'antigravity', tool_counts: { call_mcp_tool: 3 } }),
      session(1, { harness: 'codex', tool_counts: { Read: 1 } }),
    ], NOW)
    expect(p.metrics.mcpServers.n).toBe(2)
    expect(p.metrics.mcpServers.nonZero).toBe(1)
  })
})

describe('a harness that cannot produce a metric never enters its denominator', () => {
  it('compacts and skills are absent for every harness but claude', () => {
    const p = profileOf([
      parsed(1, { compact_count: 2, skill_uses: { a: 1 } }),
      // A record from another harness that somehow carries the fields is still refused: the gate is
      // HARNESS_CAPABILITIES, not the field's presence, so an adapter writing a look-alike field
      // cannot walk into the denominator with a different meaning.
      session(1, { harness: 'codex', _source: 'jsonl', compact_count: 9, skill_uses: { a: 9 } }),
      session(1, { harness: 'gemini' }),
    ], NOW)
    expect(p.metrics.compacts.n).toBe(1)
    expect(p.metrics.skills.n).toBe(1)
    // …while a metric every harness produces still counts all three.
    expect(p.metrics.messages.n).toBe(3)
  })
})

describe('a start_time that is not a string', () => {
  it('is read rather than thrown on — the store has held epoch numbers', () => {
    // Kimi persisted `start_time` as a number; `consolidate.ts` repairs it on the way in, but this
    // module is an exported pure function anyone may call with what they have.
    const odd = session(1, {})
    ;(odd as unknown as { start_time: number }).start_time = NOW - 86_400_000
    expect(() => profileOf([odd], NOW)).not.toThrow()
  })
})

describe('an empty window', () => {
  it('reports n = 0 rather than a median of 0', () => {
    const p = profileOf([], NOW)
    expect(p.sessions).toBe(0)
    expect(p.metrics.messages.n).toBe(0)
    expect(p.metrics.messages.median).toBe(0)
  })
})
