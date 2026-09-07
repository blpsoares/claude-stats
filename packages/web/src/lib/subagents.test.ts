import { describe, expect, it } from 'bun:test'
import {
  SUBAGENT_POLL_MS, appendPage, forkCount, runningCount, subagentCount,
  subagentStatusText, subagentsPollMs, subagentsStateOf, unmeasuredText, unpricedText,
  type SubagentRow, type SubagentsState,
} from './subagents'

const row = (o: Partial<SubagentRow> = {}): SubagentRow => ({
  agentId: 'a1', status: 'finished', isFork: false,
  tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  totalTokens: 4, costUSD: 0.01, toolCalls: 2, turns: 3, ...o,
})

/** A ready state, with the split the server sends. `total` defaults to agents + forks. */
const ready = (o: Partial<Extract<SubagentsState, { phase: 'ready' }>> = {}): SubagentsState => {
  const agents = o.agents ?? 0
  const forks = o.forks ?? 0
  return {
    phase: 'ready', rows: o.rows ?? [], agents, forks,
    total: o.total ?? agents + forks, hasMore: o.hasMore ?? false,
  }
}

describe('subagentsStateOf — three answers, never one empty box', () => {
  it('keeps "this harness cannot report them" apart from "it ran none"', () => {
    expect(subagentsStateOf({ ok: true, supported: false, message: 'codex does not…' }).phase).toBe('unsupported')
    expect(subagentsStateOf({ ok: true, supported: true, rows: [], total: 0, agents: 0, forks: 0, hasMore: false }))
      .toEqual({ phase: 'ready', rows: [], total: 0, agents: 0, forks: 0, hasMore: false })
  })

  it('keeps a refusal apart from both', () => {
    expect(subagentsStateOf({ ok: false, message: 'gone' }).phase).toBe('failed')
  })
})

describe('subagentCount — the tab never says 0 for something it cannot count', () => {
  it('counts a supported session', () => {
    // Every agent, not what is loaded — a paged tab would otherwise say 20 for 57.
    expect(subagentCount(ready({ rows: [row()], agents: 57, hasMore: true }))).toBe(57)
    expect(subagentCount(ready())).toBe(0)
  })

  /**
   * A FORK IS NOT A SUBAGENT, and the badge is where that had gone on being wrong.
   *
   * The row was already labelled `fork`; the NUMBER above it kept summing them, because it read
   * the route's `total` and the rows are paged, so this side could not recount. The server now
   * sends the split and this reads the half that means "dispatched".
   */
  it('leaves forks out of the badge — nothing dispatched them', () => {
    expect(subagentCount(ready({ rows: [row({ isFork: true })], agents: 0, forks: 1 }))).toBe(0)
    expect(subagentCount(ready({ agents: 3, forks: 2 }))).toBe(3)
    // The list still holds both — the badge is the only place they are separated.
    expect(forkCount(ready({ agents: 3, forks: 2 }))).toBe(2)
  })

  it('answers null wherever a count would be a claim', () => {
    expect(subagentCount({ phase: 'unsupported', message: 'x' })).toBe(null)
    expect(subagentCount({ phase: 'failed', message: 'x' })).toBe(null)
    expect(subagentCount({ phase: 'loading' })).toBe(null)
    expect(subagentCount(null)).toBe(null)
    expect(forkCount({ phase: 'loading' })).toBe(null)
    expect(forkCount(null)).toBe(null)
  })
})

describe('subagentsPollMs — only what can still change', () => {
  it('polls while an agent is running', () => {
    expect(subagentsPollMs(ready({ rows: [row({ status: 'running' }), row()] }))).toBe(SUBAGENT_POLL_MS)
    expect(runningCount(ready({ rows: [row({ status: 'running' })] }))).toBe(1)
  })

  /**
   * A running FORK used to light the dot on the Subagents tab — "counted under the wrong heading",
   * which is the badge's own bug one pixel smaller. The POLL still watches both: either kind still
   * running is a reason to read again.
   */
  it('counts the running rows of ONE kind when asked, and of both when not', () => {
    const state = ready({
      rows: [row({ agentId: 'a', status: 'running' }), row({ agentId: 'f', status: 'running', isFork: true })],
      agents: 1, forks: 1,
    })
    expect(runningCount(state, 'agent')).toBe(1)
    expect(runningCount(state, 'fork')).toBe(1)
    expect(runningCount(state)).toBe(2)
    expect(subagentsPollMs(state)).toBe(SUBAGENT_POLL_MS)
  })

  it('a running fork alone does not light the agents tab, and still polls', () => {
    const state = ready({ rows: [row({ status: 'running', isFork: true })], agents: 0, forks: 1 })
    expect(runningCount(state, 'agent')).toBe(0)
    expect(runningCount(state, 'fork')).toBe(1)
    expect(subagentsPollMs(state)).toBe(SUBAGENT_POLL_MS)
  })

  it('stops once everything has stopped — the list costs a full read of the parent', () => {
    expect(subagentsPollMs(ready({ rows: [row(), row({ status: 'failed' })] }))).toBe(null)
    expect(subagentsPollMs({ phase: 'unsupported', message: 'x' })).toBe(null)
    expect(subagentsPollMs(null)).toBe(null)
  })
})

describe('the words', () => {
  it('gives stopped its own word and colour', () => {
    expect(subagentStatusText('stopped', false).text).toBe('stopped')
    expect(subagentStatusText('stopped', false).color).not.toBe(subagentStatusText('failed', false).color)
  })

  it('says why a number is missing instead of printing a zero', () => {
    // "It has not answered yet" and "it spent nothing" are different facts.
    expect(unmeasuredText(row({ totalTokens: null, status: 'running' }), false)).toBe('has not answered yet')
    expect(unmeasuredText(row({ totalTokens: null, status: 'finished' }), false)).toBe('no transcript to measure')
    expect(unmeasuredText(row(), false)).toBe(null)
  })

  it('says why a cost is missing when the tokens are not', () => {
    expect(unpricedText(row({ costUSD: null }), false)).toBe('no price for this model')
    expect(unpricedText(row({ costUSD: null, totalTokens: null }), false)).toBe(null)
    expect(unpricedText(row(), false)).toBe(null)
  })
})

describe('appendPage — a page is merged, not stacked', () => {
  it('adds new agents and keeps the order pages arrived in', () => {
    const have = [row({ agentId: 'a' }), row({ agentId: 'b' })]
    expect(appendPage(have, [row({ agentId: 'c' })]).map(r => r.agentId)).toEqual(['a', 'b', 'c'])
  })

  it('REPLACES a row that came back with newer numbers instead of drawing it twice', () => {
    // The list is ordered by last activity, so a running agent moves between polls.
    const have = [row({ agentId: 'a', totalTokens: 1 }), row({ agentId: 'b' })]
    const merged = appendPage(have, [row({ agentId: 'a', totalTokens: 999 })])
    expect(merged).toHaveLength(2)
    expect(merged.find(r => r.agentId === 'a')!.totalTokens).toBe(999)
  })

  it('never throws away pages already asked for', () => {
    const have = [row({ agentId: 'a' }), row({ agentId: 'b' }), row({ agentId: 'c' })]
    expect(appendPage(have, [row({ agentId: 'd' })])).toHaveLength(4)
  })
})
