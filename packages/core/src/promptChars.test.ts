import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from './types'
import { aggregatePromptChars, sessionPromptAverages } from './promptChars'

const s = (p: Partial<SessionMeta>): SessionMeta => ({
  session_id: 'x', project_path: '/p', start_time: '2026-09-08T00:00:00.000Z',
  duration_minutes: 0, active_minutes: 0,
  user_message_count: 0, assistant_message_count: 0,
  tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
  git_commits: 0, git_pushes: 0,
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  first_prompt: '', user_interruptions: 0, user_response_times: [],
  tool_errors: 0, uses_task_agent: false, uses_mcp: false,
  uses_web_search: false, uses_web_fetch: false,
  lines_added: 0, lines_removed: 0, files_modified: 0,
  ...p,
} as SessionMeta)

describe('sessionPromptAverages', () => {
  it('divides the characters by the messages they were counted from', () => {
    const a = sessionPromptAverages(s({
      user_chars: 300, user_char_messages: 4,
      assistant_chars: 2400, assistant_char_messages: 3,
    }))
    expect(a.user).toBe(75)
    expect(a.assistant).toBe(800)
  })

  /**
   * A RECORD WRITTEN BEFORE THIS EXISTED IS NOT A SESSION OF EMPTY PROMPTS.
   *
   * The consolidate store is full of them, and every one would read as an average of 0 — a
   * confident number for something nobody measured. Same rule `HARNESS_CAPABILITIES` applies to a
   * metric and `contextFraction` applies to a gauge: absent is `null`, and the surface says N/A.
   */
  it('answers null where the characters were never recorded', () => {
    const a = sessionPromptAverages(s({ user_message_count: 4, assistant_message_count: 3 }))
    expect(a.user).toBeNull()
    expect(a.assistant).toBeNull()
  })

  it('answers null rather than dividing by no messages at all', () => {
    const a = sessionPromptAverages(s({
      user_chars: 0, user_char_messages: 0,
      assistant_chars: 0, assistant_char_messages: 0,
    }))
    expect(a.user).toBeNull()
    expect(a.assistant).toBeNull()
  })

  /** The two sides are independent: one being unmeasured must not withhold the other. */
  it('answers each side on its own', () => {
    const a = sessionPromptAverages(s({
      user_chars: 100, user_char_messages: 2,
      assistant_message_count: 5,
    }))
    expect(a.user).toBe(50)
    expect(a.assistant).toBeNull()
  })
})

describe('aggregatePromptChars', () => {
  /**
   * THE AVERAGE OF AVERAGES IS THE WRONG NUMBER, and it is the one that comes out if you take the
   * per-session figure and mean it. A session with one prompt and a session with eighty cannot
   * weigh the same. So the sums are carried and divided ONCE, at the end.
   */
  it('weighs by messages, not by sessions', () => {
    const out = aggregatePromptChars([
      s({ user_chars: 10, user_char_messages: 1 }),
      s({ user_chars: 8000, user_char_messages: 80 }),
    ])
    // Mean of the two per-session averages would be (10 + 100) / 2 = 55. The right answer is
    // 8010 / 81.
    expect(out.user).toBeCloseTo(8010 / 81, 6)
    expect(out.user).not.toBeCloseTo(55, 0)
  })

  /**
   * HOW MUCH OF THE SET THE NUMBER ACTUALLY COVERS, reported rather than implied.
   *
   * `stats-cache.json` holds no characters and Claude deletes transcripts after 30 days, so an
   * "all time" average is really an average over what is still readable. A surface that cannot say
   * so is a surface that overclaims — the same reason `AgentInvocation.unmeasured` is counted
   * instead of being folded into the totals.
   */
  it('counts the sessions it could not measure', () => {
    const out = aggregatePromptChars([
      s({ user_chars: 100, user_char_messages: 2 }),
      s({ user_message_count: 9 }),
      s({ user_message_count: 4 }),
    ])
    expect(out.userSessions).toBe(1)
    expect(out.sessions).toBe(3)
    expect(out.user).toBe(50)
  })

  it('answers null for a set where nothing was measured, never 0', () => {
    const out = aggregatePromptChars([s({ user_message_count: 3 }), s({})])
    expect(out.user).toBeNull()
    expect(out.assistant).toBeNull()
    expect(out.userSessions).toBe(0)
  })

  it('answers null for an empty set', () => {
    const out = aggregatePromptChars([])
    expect(out.user).toBeNull()
    expect(out.assistant).toBeNull()
    expect(out.sessions).toBe(0)
  })

  /**
   * A session whose characters were recorded but whose message count is zero contributes NOTHING
   * to either side of the division — including it would put characters over a denominator that
   * never saw them.
   */
  it('ignores a session with characters and no messages', () => {
    const out = aggregatePromptChars([
      s({ user_chars: 500, user_char_messages: 0 }),
      s({ user_chars: 100, user_char_messages: 2 }),
    ])
    expect(out.user).toBe(50)
    expect(out.userSessions).toBe(1)
  })
})

/**
 * THE DENOMINATOR IS THE MESSAGES THAT SAID SOMETHING, and this test is the measurement that
 * forced it.
 *
 * The first version divided by `assistant_message_count`, which for Claude counts every `assistant`
 * event — and measured on real transcripts on 2026-09-08, only 334 of 1.316 of them (25%) carry any
 * text at all; the rest are `tool_use` blocks. The average came out 79 characters against a real
 * 312, a 4x understatement that looked entirely plausible. So each side carries its OWN count of
 * the messages that contributed characters, and the two halves of the division are written in the
 * same statement.
 */
describe('the denominator', () => {
  it('ignores the message counts entirely', () => {
    const a = sessionPromptAverages(s({
      user_chars: 1000, user_char_messages: 2,
      // A wildly different count of ALL messages must not touch the answer.
      user_message_count: 40,
    }))
    expect(a.user).toBe(500)
  })

  it('answers null when characters were recorded against no message at all', () => {
    expect(sessionPromptAverages(s({ user_chars: 900, user_char_messages: 0 })).user).toBeNull()
  })
})
