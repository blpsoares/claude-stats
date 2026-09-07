import { test, expect } from 'bun:test'
import { summarizeSubagentTranscript } from './subagent-parse'

/** One assistant turn of a subagent transcript, as Claude Code writes it. */
function assistant(model: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: extra.timestamp ?? '2026-09-01T10:00:00.000Z',
    message: { model, usage, content: extra.content ?? [] },
  })
}

test('usage is summed PER MODEL — a subagent may run a cheaper model than its parent', () => {
  const s = summarizeSubagentTranscript([
    assistant('claude-haiku-4-5-20251001', { input_tokens: 8, output_tokens: 100, cache_read_input_tokens: 90, cache_creation_input_tokens: 2 }),
    assistant('claude-haiku-4-5-20251001', { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }),
    assistant('claude-sonnet-5', { input_tokens: 1, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 3 }),
  ])

  expect(s.usage).toEqual([
    { model: 'claude-haiku-4-5-20251001', inputTokens: 10, outputTokens: 150, cacheReadTokens: 100, cacheWriteTokens: 2 },
    { model: 'claude-sonnet-5', inputTokens: 1, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 3 },
  ])
})

test('the span is the first and last timestamp of the transcript', () => {
  const s = summarizeSubagentTranscript([
    assistant('m', { output_tokens: 1 }, { timestamp: '2026-09-01T10:00:00.000Z' }),
    assistant('m', { output_tokens: 1 }, { timestamp: '2026-09-01T10:02:30.000Z' }),
  ])
  expect(s.firstMs).toBe(Date.parse('2026-09-01T10:00:00.000Z'))
  expect(s.lastMs).toBe(Date.parse('2026-09-01T10:02:30.000Z'))
})

test('a transcript with no timestamp reports no span, never a zero duration', () => {
  const s = summarizeSubagentTranscript([
    JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { output_tokens: 1 }, content: [] } }),
  ])
  expect(s.firstMs).toBeNull()
  expect(s.lastMs).toBeNull()
})

test('junk lines and blank lines are skipped without throwing', () => {
  const s = summarizeSubagentTranscript(['', '   ', 'not json at all', assistant('m', { output_tokens: 4 })])
  expect(s.usage).toEqual([{ model: 'm', inputTokens: 0, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 }])
})

/** A tool_use item inside an assistant turn. */
function toolUse(name: string) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-01T10:00:00.000Z',
    message: { model: 'm', content: [{ type: 'tool_use', id: 't1', name, input: {} }] },
  })
}

test('tool uses are counted and bucketed the way the panel reads them', () => {
  const s = summarizeSubagentTranscript([
    toolUse('Read'), toolUse('Grep'), toolUse('Glob'), toolUse('Bash'), toolUse('Bash'),
    toolUse('Edit'), toolUse('Write'), toolUse('MultiEdit'), toolUse('WebFetch'),
  ])
  expect(s.toolUseCount).toBe(9)
  expect(s.toolStats.readCount).toBe(1)
  expect(s.toolStats.searchCount).toBe(2)
  expect(s.toolStats.bashCount).toBe(2)
  expect(s.toolStats.editFileCount).toBe(3)
  expect(s.toolStats.otherToolCount).toBe(1)
})

test('lines changed come from the edit patch the transcript already carries', () => {
  const s = summarizeSubagentTranscript([
    JSON.stringify({
      type: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
      toolUseResult: {
        structuredPatch: [
          { lines: [' kept', '-gone', '+new', '+also new'] },
          { lines: ['-gone too'] },
        ],
      },
    }),
  ])
  expect(s.toolStats.linesAdded).toBe(2)
  expect(s.toolStats.linesRemoved).toBe(2)
})

test('a nested subagent is NAMED so its own transcript can be found', () => {
  const s = summarizeSubagentTranscript([
    JSON.stringify({ type: 'user', toolUseResult: { agentId: 'aNested1', isAsync: true } }),
    JSON.stringify({ type: 'user', toolUseResult: { agentId: 'aNested2', isAsync: true } }),
    JSON.stringify({ type: 'user', toolUseResult: { stdout: 'no agent here' } }),
  ])
  expect(s.childAgentIds).toEqual(['aNested1', 'aNested2'])
})

test('the same nested subagent named twice is one child, never two', () => {
  const s = summarizeSubagentTranscript([
    JSON.stringify({ type: 'user', toolUseResult: { agentId: 'aNested1' } }),
    JSON.stringify({ type: 'user', toolUseResult: { agentId: 'aNested1' } }),
  ])
  expect(s.childAgentIds).toEqual(['aNested1'])
})

// --- the numbers one invocation reports, from its own transcript and everything it spawned ---

import { agentNumbers } from './subagent-parse'
import { calcCost } from '@agentistics/core'

const emptyStats = { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 }
function summary(over: Partial<Parameters<typeof agentNumbers>[0]> = {}) {
  return { usage: [], firstMs: null, lastMs: null, toolUseCount: 0, toolStats: { ...emptyStats }, childAgentIds: [], ...over }
}

test('cost prices each model at ITS OWN rate — a haiku child under an opus parent is not opus money', () => {
  const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 30000, cacheWriteTokens: 400 }
  const n = agentNumbers(summary({ usage: [{ model: 'claude-haiku-4-5-20251001', ...usage }] }), [])

  const asHaiku = calcCost(
    { inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 30000, cacheCreationInputTokens: 400, webSearchRequests: 0, costUSD: 0 },
    'claude-haiku-4-5-20251001',
  )
  expect(n.costUSD).toBeCloseTo(asHaiku, 10)

  const asOpus = calcCost(
    { inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 30000, cacheCreationInputTokens: 400, webSearchRequests: 0, costUSD: 0 },
    'claude-opus-5',
  )
  expect(n.costUSD).toBeLessThan(asOpus)
})

test('tokens is ALL FOUR counters — a subagent read of the cache is most of its volume', () => {
  const n = agentNumbers(summary({
    usage: [{ model: 'claude-sonnet-5', inputTokens: 8, outputTokens: 100, cacheReadTokens: 97781, cacheWriteTokens: 261 }],
  }), [])
  expect(n.totalTokens).toBe(8 + 100 + 97781 + 261)
})

test('a nested subagent counts inside the invocation that spawned it', () => {
  const root = summary({
    usage: [{ model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    toolUseCount: 3,
    toolStats: { ...emptyStats, bashCount: 3 },
  })
  const nested = summary({
    usage: [{ model: 'claude-sonnet-5', inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    toolUseCount: 2,
    toolStats: { ...emptyStats, readCount: 2, linesAdded: 4 },
  })

  const n = agentNumbers(root, [nested])
  expect(n.inputTokens).toBe(15)
  expect(n.outputTokens).toBe(27)
  expect(n.totalToolUseCount).toBe(5)
  expect(n.toolStats.bashCount).toBe(3)
  expect(n.toolStats.readCount).toBe(2)
  expect(n.toolStats.linesAdded).toBe(4)
})

test('duration is the ROOT agent’s own span — a nested agent runs inside it, not after it', () => {
  const root = summary({ firstMs: 1000, lastMs: 61000 })
  const nested = summary({ firstMs: 5000, lastMs: 9000 })
  expect(agentNumbers(root, [nested]).totalDurationMs).toBe(60000)
})
