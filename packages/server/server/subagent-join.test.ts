import { test, expect } from 'bun:test'
import type { AgentInvocation } from '@agentistics/core'
import { parseAgentMeta, isNestedAgent, describedFrom, planAgentJoin } from './subagent-join'

function inv(toolUseId: string, over: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    toolUseId, agentType: 'general-purpose', description: 'd', status: 'completed',
    totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    toolStats: { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 },
    costUSD: 0, ...over,
  }
}

// ---------------------------------------------------------------- parseAgentMeta

test('parseAgentMeta reads the fields the harness writes, and nothing else', () => {
  const m = parseAgentMeta(JSON.stringify({
    agentType: 'Explore', description: 'Map i18n wiring', toolUseId: 'toolu_1',
    parentAgentId: 'aRoot', spawnDepth: 2, isFork: true, name: 'code-review', model: 'haiku',
    somethingNew: 42,
  }))
  expect(m).toEqual({
    agentType: 'Explore', description: 'Map i18n wiring', toolUseId: 'toolu_1',
    parentAgentId: 'aRoot', spawnDepth: 2, isFork: true, name: 'code-review', model: 'haiku',
  })
})

test('parseAgentMeta is total — junk, a non-object and an empty file all yield null', () => {
  expect(parseAgentMeta('not json')).toBeNull()
  expect(parseAgentMeta('[1,2]')).toBeNull()
  expect(parseAgentMeta('"x"')).toBeNull()
  expect(parseAgentMeta('')).toBeNull()
})

test('parseAgentMeta drops a field of the wrong type rather than carrying it', () => {
  expect(parseAgentMeta('{"agentType":7,"spawnDepth":"2","toolUseId":null}')).toEqual({})
})

// ---------------------------------------------------------------- isNestedAgent

test('a transcript with a parentAgentId or a depth past the first is NESTED', () => {
  expect(isNestedAgent({ parentAgentId: 'aRoot', spawnDepth: 2 })).toBe(true)
  expect(isNestedAgent({ spawnDepth: 2 })).toBe(true)
  expect(isNestedAgent({ parentAgentId: 'aRoot' })).toBe(true)
})

test('a top-level transcript, and one whose meta could not be read, are not nested', () => {
  expect(isNestedAgent({ spawnDepth: 1 })).toBe(false)
  expect(isNestedAgent({})).toBe(false)
  expect(isNestedAgent(null)).toBe(false)
})

// ---------------------------------------------------------------- describedFrom

test('the meta names an invocation the parent could not', () => {
  const out = describedFrom(inv('toolu_1', { agentType: 'unknown', description: '' }),
    { agentType: 'general-purpose', description: '/code-review PR #276' })
  expect(out.agentType).toBe('general-purpose')
  expect(out.description).toBe('/code-review PR #276')
})

test('what the PARENT said is never overwritten by the meta', () => {
  const out = describedFrom(inv('toolu_1', { agentType: 'Explore', description: 'Map i18n' }),
    { agentType: 'general-purpose', description: 'something else' })
  expect(out.agentType).toBe('Explore')
  expect(out.description).toBe('Map i18n')
})

test('describedFrom returns the invocation itself when the meta adds nothing', () => {
  const one = inv('toolu_1', { agentType: 'unknown', description: '' })
  expect(describedFrom(one, null)).toBe(one)
  expect(describedFrom(one, {})).toBe(one)
})

// ---------------------------------------------------------------- planAgentJoin

test('an invocation is paired with the transcript its agentId names', () => {
  const plan = planAgentJoin([inv('toolu_1', { agentId: 'aOne' })], [{ agentId: 'aOne', meta: {} }])
  expect(plan.reads).toEqual([{ invocation: expect.objectContaining({ toolUseId: 'toolu_1' }), agentId: 'aOne' }])
  expect(plan.unclaimed).toEqual([])
})

test('an invocation with NO agentId is paired through the meta’s own toolUseId', () => {
  // C — the parent's result was the string "[Request interrupted by user for tool use]", so it
  // carries no agentId at all. The meta beside the transcript is the only link left.
  const plan = planAgentJoin([inv('toolu_1')], [{ agentId: 'aOne', meta: { toolUseId: 'toolu_1' } }])
  expect(plan.reads[0]!.agentId).toBe('aOne')
  expect(plan.unclaimed).toEqual([])
})

test('an agentId match is never stolen by a toolUseId match', () => {
  const plan = planAgentJoin(
    [inv('toolu_1', { agentId: 'aTwo' }), inv('toolu_2')],
    [{ agentId: 'aTwo', meta: { toolUseId: 'toolu_2' } }, { agentId: 'aThree', meta: { toolUseId: 'toolu_2' } }],
  )
  expect(plan.reads[0]!.agentId).toBe('aTwo')
})

test('a toolUseId that names TWO transcripts pairs neither of them', () => {
  // A half-read link is worse than none: it gets published as a measurement. The exact link
  // (`agentId`) is unaffected — only the fallback refuses.
  const plan = planAgentJoin(
    [inv('toolu_1')],
    [{ agentId: 'aOne', meta: { toolUseId: 'toolu_1' } }, { agentId: 'aTwo', meta: { toolUseId: 'toolu_1' } }],
  )
  expect(plan.reads[0]!.agentId).toBeNull()
  expect(plan.unclaimed.map(e => e.agentId)).toEqual(['aOne', 'aTwo'])
})

test('a NESTED transcript is never paired and never reported unclaimed — it is counted inside its root', () => {
  const plan = planAgentJoin(
    [inv('toolu_1', { agentId: 'aRoot' })],
    [{ agentId: 'aRoot', meta: { toolUseId: 'toolu_1' } },
     { agentId: 'aChild', meta: { toolUseId: 'toolu_9', parentAgentId: 'aRoot', spawnDepth: 2 } }],
  )
  expect(plan.reads).toHaveLength(1)
  expect(plan.reads[0]!.agentId).toBe('aRoot')
  expect(plan.unclaimed).toEqual([])
})

test('a nested transcript is not paired even when its toolUseId matches an invocation', () => {
  // It really happens: a nested agent's meta carries the toolUseId of the `Agent` call its PARENT
  // made, which no entry in the session transcript ever matches — but nothing may rely on that.
  const plan = planAgentJoin(
    [inv('toolu_9')],
    [{ agentId: 'aChild', meta: { toolUseId: 'toolu_9', spawnDepth: 2 } }],
  )
  expect(plan.reads[0]!.agentId).toBeNull()
  expect(plan.unclaimed).toEqual([])
})

test('an invocation no transcript can serve reads nothing, and stays in the list', () => {
  const plan = planAgentJoin([inv('toolu_1', { agentId: 'aGone' })], [])
  expect(plan.reads).toEqual([{ invocation: expect.objectContaining({ toolUseId: 'toolu_1' }), agentId: null }])
})

test('a top-level transcript no invocation claims is reported, never silently dropped', () => {
  const plan = planAgentJoin([], [{ agentId: 'aFork', meta: { isFork: true, spawnDepth: 1 } }])
  expect(plan.reads).toEqual([])
  expect(plan.unclaimed).toEqual([{ agentId: 'aFork', meta: { isFork: true, spawnDepth: 1 } }])
})

test('one transcript serves at most one invocation', () => {
  const plan = planAgentJoin(
    [inv('toolu_1', { agentId: 'aOne' }), inv('toolu_2', { agentId: 'aOne' })],
    [{ agentId: 'aOne', meta: {} }],
  )
  expect(plan.reads[0]!.agentId).toBe('aOne')
  expect(plan.reads[1]!.agentId).toBeNull()
})

test('the reads keep the parent’s order', () => {
  const plan = planAgentJoin(
    [inv('toolu_1', { agentId: 'aOne' }), inv('toolu_2', { agentId: 'aTwo' })],
    [{ agentId: 'aTwo', meta: {} }, { agentId: 'aOne', meta: {} }],
  )
  expect(plan.reads.map(r => r.invocation.toolUseId)).toEqual(['toolu_1', 'toolu_2'])
})
