import { expect, test } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { sessionStats, statReason } from './sessionStats'

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 's1', harness: 'claude', model: 'claude-opus-5',
  input_tokens: 100, output_tokens: 200,
  cache_read_input_tokens: 5_000, cache_creation_input_tokens: 300,
  user_message_count: 4, assistant_message_count: 9,
  git_commits: 2, lines_added: 30, lines_removed: 5, files_modified: 3,
  active_minutes: 12,
  ...over,
} as SessionMeta)

test('a conversation the store has not seen is NULL everywhere, never zero', () => {
  // Zero would be true only by accident, and wrong a minute later.
  const s = sessionStats('claude', 's1', undefined)
  expect(s.tokens).toBeNull()
  expect(s.costUSD).toBeNull()
  expect(s.context).toBeNull()
  expect(s.messages).toBeNull()
  expect(s.git).toBeNull()
})

test('tokens are all FOUR counters, and the pair is reported separately', () => {
  const s = sessionStats('claude', 's1', meta())
  expect(s.tokens).toEqual({ input: 100, output: 200, cacheRead: 5_000, cacheWrite: 300 })
  // "sem cache" on screen is the conversational pair — never the label for the total.
  expect(s.conversation).toEqual({ input: 100, output: 200 })
})

test('cost is priced WITH the cache counters', () => {
  const withCache = sessionStats('claude', 's1', meta())!.costUSD!
  const withoutCache = sessionStats('claude', 's1', meta({
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  }))!.costUSD!
  // Zeroing the cache prices the cheap few per cent of the volume — the two must differ.
  expect(withCache).toBeGreaterThan(withoutCache)
})

test('a harness that cannot produce a metric gets NULL, and the reason says which', () => {
  // Codex reports no agent metrics; the panel must say so rather than print "0 subagents".
  const s = sessionStats('codex', 's1', meta({ harness: 'codex' }))
  expect(s.subagents).toBeNull()
  expect(statReason('codex', 'agents')).toBe('harness')
  // Claude CAN, so an absent figure there means the store has not caught up.
  expect(statReason('claude', 'agents')).toBe('unrecorded')
})

test('the context fraction is UNCLAMPED — a session really can exceed its window', () => {
  const s = sessionStats('claude', 's1', meta({
    context_tokens: 250_000, context_window: 200_000,
  } as Partial<SessionMeta>))
  expect(s.context?.fraction).toBeGreaterThan(1)
})

test('a window the harness DECLARED outranks the table', () => {
  // It knows the deployment and any per-session cap; a model id cannot express either.
  const s = sessionStats('claude', 's1', meta({
    context_tokens: 100_000, context_window: 128_000,
  } as Partial<SessionMeta>))
  expect(s.context?.window).toBe(128_000)
})

test('no window anywhere means NO bar, not a 0%', () => {
  const s = sessionStats('claude', 's1', meta({ model: 'a-model-nobody-has-priced' }))
  expect(s.context).toBeNull()
})

test('subagents are counted and summed when the harness has them', () => {
  const s = sessionStats('claude', 's1', meta({
    agentMetrics: { invocations: [
      { totalTokens: 10, costUSD: 1 }, { totalTokens: 5, costUSD: 0.5 },
    ] },
  } as unknown as Partial<SessionMeta>))
  expect(s.subagents).toEqual({ count: 2, tokens: 15, costUSD: 1.5 })
})
