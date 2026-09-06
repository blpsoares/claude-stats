import { describe, expect, it } from 'bun:test'
import { looksUnmeasured, migrateAgentMetrics } from './agents'
import type { AgentInvocation, SessionAgentMetrics } from './types'

const inv = (over: Partial<AgentInvocation> = {}): AgentInvocation => ({
  toolUseId: 't1', agentType: 'general-purpose', description: 'Task 1', status: 'completed',
  totalTokens: 100, totalDurationMs: 1000, totalToolUseCount: 2,
  inputTokens: 10, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10,
  toolStats: { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 },
  costUSD: 0.5, ...over,
})
const metrics = (invocations: AgentInvocation[]): SessionAgentMetrics => ({
  invocations,
  totalInvocations: invocations.length,
  totalTokens: invocations.reduce((s, i) => s + i.totalTokens, 0),
  totalDurationMs: invocations.reduce((s, i) => s + i.totalDurationMs, 0),
  totalCostUSD: invocations.reduce((s, i) => s + i.costUSD, 0),
})

describe('migrateAgentMetrics — a record stored before `unmeasured` existed', () => {
  it('marks the zero-filled launch record, which the new rule would read as a measurement', () => {
    // Tokens AND cost AND duration all zero: a real agent that read nothing, cost nothing and took
    // no time does not exist. `loadConsolidated` revives 74 sessions in this state here.
    const after = migrateAgentMetrics(metrics([inv({ totalTokens: 0, totalDurationMs: 0, costUSD: 0 })]))
    expect(after.invocations[0]!.unmeasured).toBe(true)
    expect(after.unmeasuredInvocations).toBe(1)
  })

  it('leaves a genuinely measured record exactly as written', () => {
    const before = metrics([inv()])
    expect(migrateAgentMetrics(before)).toBe(before)
  })

  it('does not mistake an ordinary zero for the signature', () => {
    // Zero tool calls, zero lines and zero cache are ordinary measurements; only all THREE of
    // tokens, cost and duration being zero is the launch record.
    expect(looksUnmeasured(inv({ totalTokens: 0, costUSD: 0, totalDurationMs: 800 }))).toBe(false)
    expect(looksUnmeasured(inv({ totalToolUseCount: 0 }))).toBe(false)
  })

  it('never re-marks a record the new reader already marked', () => {
    expect(looksUnmeasured(inv({ unmeasured: true, totalTokens: 0, totalDurationMs: 0, costUSD: 0 }))).toBe(false)
  })

  it('is idempotent', () => {
    const once = migrateAgentMetrics(metrics([inv({ totalTokens: 0, totalDurationMs: 0, costUSD: 0 })]))
    expect(migrateAgentMetrics(once)).toBe(once)
  })

  it('never throws on a record whose invocations are not an array', () => {
    const junk = { invocations: null } as unknown as SessionAgentMetrics
    expect(migrateAgentMetrics(junk)).toBe(junk)
  })
})
