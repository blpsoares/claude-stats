/**
 * What counts as a ROUND — the person's turns, and nothing the harness wrote under their name.
 *
 * Both defects here were found by recounting four real transcripts by hand and comparing: the
 * parser's round count exceeded the truth by 22, 15, 7 and 1 — the `isMeta` count of each session
 * exactly, plus one compaction summary. On a session that had run 22 local commands, "rounds" read
 * 65 for 43 messages a person actually sent.
 */
import { describe, expect, it, test } from 'bun:test'
import { isHumanUserEntry, isUserRoleMessage } from './jsonl'

const user = (over: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { content: 'do the thing' },
  ...over,
})

describe('isHumanUserEntry', () => {
  it('counts a message the person typed', () => {
    expect(isHumanUserEntry(user())).toBe(true)
    expect(isHumanUserEntry(user({ message: { content: [{ type: 'text', text: 'hi' }] } }))).toBe(true)
  })

  it('refuses a tool result being fed back', () => {
    expect(isHumanUserEntry(user({
      message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] },
    }))).toBe(false)
  })

  it('refuses an entry the HARNESS injected under the user role', () => {
    // `<local-command-caveat>`: nobody typed it, so it is not a round and not a turn boundary.
    expect(isHumanUserEntry(user({
      isMeta: true,
      message: { content: '<local-command-caveat>Caveat: the messages below…</local-command-caveat>' },
    }))).toBe(false)
  })

  it('refuses a compaction summary', () => {
    // "This session is being continued from a previous conversation that ran out of context" —
    // written by the harness when it compacts, under the user's role.
    expect(isHumanUserEntry(user({
      isCompactSummary: true,
      message: { content: 'This session is being continued from a previous conversation…' },
    }))).toBe(false)
  })

  it('is not fooled by a mixed message that merely contains a tool result', () => {
    // Only a PURE tool-result array is the tool talking. A person's message that also carries one
    // is still theirs.
    expect(isHumanUserEntry(user({
      message: { content: [{ type: 'text', text: 'and now this' }, { type: 'tool_result' }] },
    }))).toBe(true)
  })

  it('answers false for anything that is not a user entry', () => {
    expect(isHumanUserEntry({ type: 'assistant', message: { content: 'x' } })).toBe(false)
    expect(isHumanUserEntry({})).toBe(false)
  })
})

describe('TWO QUESTIONS, TWO PREDICATES', () => {
  /**
   * These were one function for a release, and the chat paid for it. `chat-tail.ts` gates on "is
   * this a user-role entry I should classify" and was handed "did a person take a turn", which had
   * just grown an `isMeta`/`isCompactSummary` exclusion for the round counter. Every injected entry
   * was then DROPPED before `classifyUserEntry` could name it, so no skill load, no attached image
   * and no message from another session was drawn in the conversation at all. Measured: the same
   * fixture yielded `[{system: 'the session was resumed'}]` before and `[]` after.
   */
  const injected = { type: 'user', isMeta: true, message: { content: 'Continue from where you left off.' } }
  const compacted = { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued' } }
  const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }

  test('the CHAT keeps an injected entry — it has a note to draw for it', () => {
    expect(isUserRoleMessage(injected)).toBe(true)
    expect(isUserRoleMessage(compacted)).toBe(true)
  })

  test('the COUNTER rejects the same entry — nobody took a turn', () => {
    expect(isHumanUserEntry(injected)).toBe(false)
    expect(isHumanUserEntry(compacted)).toBe(false)
  })

  test('a pure tool_result is neither, which is the one thing they agree on', () => {
    expect(isUserRoleMessage(toolResult)).toBe(false)
    expect(isHumanUserEntry(toolResult)).toBe(false)
  })

  test('an ordinary message is both', () => {
    const typed = { type: 'user', message: { content: 'oi' } }
    expect(isUserRoleMessage(typed)).toBe(true)
    expect(isHumanUserEntry(typed)).toBe(true)
  })
})
