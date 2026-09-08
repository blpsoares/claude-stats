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
      session(1, { user_message_count: 10, skill_uses: { a: 2 } }),
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
      session(1, { skill_uses: {} }),
      session(2, {}),
    ], NOW)
    expect(p.metrics.skills.n).toBe(1)
    expect(p.metrics.skills.median).toBe(0)
  })
})

describe('compacts', () => {
  it('is zero-median with a long tail, and reports how many sessions ever had one', () => {
    const p = profileOf([
      ...Array.from({ length: 17 }, () => session(1, { compact_count: 1 })),
      session(1, { compact_count: 8 }),
      ...Array.from({ length: 40 }, () => session(1, { compact_count: 0 })),
    ], NOW)
    expect(p.metrics.compacts.median).toBe(0)
    expect(p.metrics.compacts.nonZero).toBe(18)
    expect(p.metrics.compacts.n).toBe(58)
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
