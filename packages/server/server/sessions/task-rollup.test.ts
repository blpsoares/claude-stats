import { describe, expect, it } from 'bun:test'
import { rollupAttempt } from './task-rollup'
import type { RollupSession } from './task-rollup'
import type { SessionMeta } from '@agentistics/core'

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 's1', project_path: '/repo', start_time: '2026-09-05T10:00:00.000Z',
  harness: 'claude', user_message_count: 3, active_minutes: 10,
  input_tokens: 100, output_tokens: 50,
  cache_read_input_tokens: 800, cache_creation_input_tokens: 50,
  ...over,
} as SessionMeta)

const link = (over: Partial<RollupSession> = {}): RollupSession => ({
  rowId: 'r1', provenance: 'assigned', meta: meta(), costUSD: 1, costMeasured: false, ...over,
})

describe('rollupAttempt', () => {
  it('sums rounds across the sessions of one attempt', () => {
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', meta: meta({ user_message_count: 3 }) }),
      link({ rowId: 'r2', meta: meta({ session_id: 's2', user_message_count: 4 }) }),
    ] })
    expect(r.rounds).toBe(7)
    expect(r.sessionsUsed).toBe(2)
  })

  it('counts tokens as all four counters, never input plus output', () => {
    // input+output alone is 0.34% of the volume on real data: not slightly low, roughly 300x off.
    const r = rollupAttempt({ sessions: [link()] })
    expect(r.tokens).toBe(1000)
  })

  it('reports a metric the harness cannot produce as null, never zero', () => {
    // copilot reports no tokens. A confident 0 beside a real cost reads as a free session.
    const r = rollupAttempt({ sessions: [link({
      meta: meta({
        harness: 'copilot',
        input_tokens: undefined, output_tokens: undefined,
        cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined,
      }),
      costUSD: null,
    })] })
    expect(r.tokens).toBeNull()
    expect(r.costUSD).toBeNull()
  })

  it('counts cost provenance per session and never merges the two', () => {
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', costUSD: 2, costMeasured: true }),
      link({ rowId: 'r2', costUSD: 3, costMeasured: false }),
    ] })
    expect(r.costUSD).toBe(5)
    expect(r.costMeasuredSessions).toBe(1)
    expect(r.costEstimatedSessions).toBe(1)
  })

  it('counts how each session was linked, so a short rollup can say why', () => {
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', provenance: 'assigned' }),
      link({ rowId: 'r2', provenance: 'observed' }),
      link({ rowId: 'r3', provenance: 'none', meta: null, costUSD: null }),
    ] })
    expect(r.provenance).toEqual({ assigned: 1, observed: 1, none: 1 })
    expect(r.sessionsUsed).toBe(3)
    expect(r.sessionsLinked).toBe(2)
  })

  it('an unlinked session still counts as a session used', () => {
    // "This attempt needed three sessions" is true whether or not the third could be priced.
    const r = rollupAttempt({ sessions: [link({ provenance: 'none', meta: null, costUSD: null })] })
    expect(r.sessionsUsed).toBe(1)
    expect(r.rounds).toBeNull()
  })

  it('keeps copilot credits out of the money and in their own field', () => {
    const r = rollupAttempt({ sessions: [link({
      meta: meta({ harness: 'copilot' }), costUSD: null,
      credits: { nanoAiu: 404_356_500, premiumRequests: 1 },
    })] })
    expect(r.costUSD).toBeNull()
    expect(r.credits).toEqual({ nanoAiu: 404_356_500, premiumRequests: 1 })
  })

  it('refuses a single money figure when the attempt mixes credits and dollars', () => {
    // A cross-harness total spanning copilot is not a number; it is two numbers in one column.
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', costUSD: 2 }),
      link({ rowId: 'r2', meta: meta({ harness: 'copilot' }), costUSD: null,
             credits: { nanoAiu: 1, premiumRequests: 1 } }),
    ] })
    expect(r.mixedCurrency).toBe(true)
  })

  it('is not mixed when only dollars, or only credits, are present', () => {
    expect(rollupAttempt({ sessions: [link({ costUSD: 2 })] }).mixedCurrency).toBe(false)
    expect(rollupAttempt({ sessions: [link({
      costUSD: null, credits: { nanoAiu: 1, premiumRequests: 1 },
    })] }).mixedCurrency).toBe(false)
  })

  it('an empty attempt reports nulls and zero sessions, never zeroes for the metrics', () => {
    // An attempt whose sessions have all been cleaned up has not cost zero; it is unmeasurable.
    const r = rollupAttempt({ sessions: [] })
    expect(r.sessionsUsed).toBe(0)
    expect([r.rounds, r.tokens, r.costUSD, r.credits]).toEqual([null, null, null, null])
  })

  it('sums active minutes only over the sessions that reported them', () => {
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', meta: meta({ active_minutes: 10 }) }),
      link({ rowId: 'r2', meta: meta({ session_id: 's2', active_minutes: undefined }) }),
    ] })
    expect(r.activeMinutes).toBe(10)
  })
})
