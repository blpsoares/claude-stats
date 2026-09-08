import { test, expect } from 'bun:test'
import { extractAgentMetrics } from './agent-metrics'

/** The `Agent` tool_use as the session transcript records it. */
function agentCall(id: string, description: string, subagentType = 'general-purpose') {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: subagentType } }] },
  })
}

/** The result Claude Code writes TODAY: the agent is launched async and carries no numbers. */
function asyncResult(id: string, agentId: string, description: string) {
  return JSON.stringify({
    type: 'user',
    toolUseResult: {
      agentId, description, isAsync: true, status: 'async_launched',
      resolvedModel: 'claude-haiku-4-5-20251001',
      outputFile: `/tmp/tasks/${agentId}.output`, canReadOutputFile: true,
    },
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  })
}

/** The result Claude Code wrote until 2026-08-13, with the numbers inline. */
function legacyResult(id: string) {
  return JSON.stringify({
    type: 'user',
    toolUseResult: {
      status: 'completed', agentType: 'explorer',
      totalTokens: 900, totalDurationMs: 4200, totalToolUseCount: 6,
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 30 },
      toolStats: { readCount: 2, searchCount: 1, bashCount: 3, editFileCount: 0, linesAdded: 9, linesRemoved: 1, otherToolCount: 0 },
    },
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
  })
}

test('the async shape is recorded as UNMEASURED and NAMES its transcript, never priced at zero', () => {
  const m = extractAgentMetrics([
    agentCall('toolu_1', 'Task 1: backup-plan.ts'),
    asyncResult('toolu_1', 'a23c974fb8aab9fbf', 'Task 1: backup-plan.ts'),
  ], 'claude-opus-5')

  expect(m.invocations).toHaveLength(1)
  const inv = m.invocations[0]!
  expect(inv.unmeasured).toBe(true)
  expect(inv.agentId).toBe('a23c974fb8aab9fbf')
  expect(inv.description).toBe('Task 1: backup-plan.ts')
  expect(inv.agentType).toBe('general-purpose')
})

test('an unmeasured invocation is counted, and counted SEPARATELY', () => {
  const m = extractAgentMetrics([
    agentCall('toolu_1', 'one'), asyncResult('toolu_1', 'aOne', 'one'),
    agentCall('toolu_2', 'two'), legacyResult('toolu_2'),
  ], 'claude-opus-5')

  expect(m.totalInvocations).toBe(2)
  expect(m.unmeasuredInvocations).toBe(1)
})

test('an unmeasured invocation adds nothing to the totals — it is not a zero, it is an absence', () => {
  const m = extractAgentMetrics([
    agentCall('toolu_1', 'one'), asyncResult('toolu_1', 'aOne', 'one'),
  ], 'claude-opus-5')

  expect(m.totalTokens).toBe(0)
  expect(m.totalCostUSD).toBe(0)
  expect(m.unmeasuredInvocations).toBe(1)
})

test('the legacy shape is read exactly as it always was', () => {
  const m = extractAgentMetrics([
    agentCall('toolu_2', 'legacy one'), legacyResult('toolu_2'),
  ], 'claude-opus-5')

  const inv = m.invocations[0]!
  expect(inv.unmeasured).toBeUndefined()
  expect(inv.agentType).toBe('explorer')
  expect(inv.totalTokens).toBe(900)
  expect(inv.totalDurationMs).toBe(4200)
  expect(inv.totalToolUseCount).toBe(6)
  expect(inv.inputTokens).toBe(100)
  expect(inv.cacheReadTokens).toBe(5000)
  expect(inv.toolStats.bashCount).toBe(3)
  expect(inv.costUSD).toBeGreaterThan(0)
  expect(m.unmeasuredInvocations).toBe(0)
})

/** A skill launched in the BACKGROUND. The tool is `Skill`, and the result names the agent. */
function skillCall(id: string, name: string) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }] },
  })
}
function forkedSkillResult(id: string, agentId: string, commandName: string) {
  return JSON.stringify({
    type: 'user',
    toolUseResult: {
      success: true, commandName, status: 'forked', background: true, agentId,
      result: `Running in the background as @${commandName}`,
    },
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
  })
}

test('a BACKGROUND forked skill is an agent — the launching tool is not what makes it one', () => {
  // Measured 2026-09-06: `/code-review` run in the background produces a `Skill` tool_use whose
  // result carries `{status:'forked', background:true, agentId}`. The parent names the agent; only
  // the tool differs, and keying on `Agent` alone made the whole run vanish from the dashboard.
  const m = extractAgentMetrics([
    skillCall('toolu_1', 'code-review'),
    forkedSkillResult('toolu_1', 'af78d79cddebfe710', 'code-review'),
  ], 'claude-opus-5')

  expect(m.invocations).toHaveLength(1)
  const inv = m.invocations[0]!
  expect(inv.toolUseId).toBe('toolu_1')
  expect(inv.agentId).toBe('af78d79cddebfe710')
  expect(inv.unmeasured).toBe(true)
  expect(m.unmeasuredInvocations).toBe(1)
})

test('an Agent launched and never resolved is still an invocation', () => {
  // The plain background agent: the parent gets no `tool_result` at all, so the launch used to sit
  // in the pending map to the end of the file and be dropped. It ran; it has a transcript.
  const m = extractAgentMetrics([agentCall('toolu_1', 'P2 Task 8: attach from the TUI')], 'claude-opus-5')

  expect(m.invocations).toHaveLength(1)
  const inv = m.invocations[0]!
  expect(inv.toolUseId).toBe('toolu_1')
  expect(inv.unmeasured).toBe(true)
  expect(inv.description).toBe('P2 Task 8: attach from the TUI')
  expect(inv.agentType).toBe('general-purpose')
  expect(inv.agentId).toBeUndefined()
})

test('an unresolved launch is appended AFTER the ones the parent answered', () => {
  const m = extractAgentMetrics([
    agentCall('toolu_1', 'launched'),
    agentCall('toolu_2', 'answered'), legacyResult('toolu_2'),
  ], 'claude-opus-5')

  expect(m.invocations.map(i => i.toolUseId)).toEqual(['toolu_2', 'toolu_1'])
})

test('a result that names an agent already recorded never opens a SECOND row', () => {
  const m = extractAgentMetrics([
    agentCall('toolu_1', 'one'), asyncResult('toolu_1', 'aOne', 'one'),
    // A later tool reporting on the same agent — a status read, an output fetch — is not a launch.
    JSON.stringify({
      type: 'user',
      toolUseResult: { agentId: 'aOne', status: 'completed' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_99' }] },
    }),
  ], 'claude-opus-5')

  expect(m.invocations).toHaveLength(1)
  expect(m.invocations[0]!.toolUseId).toBe('toolu_1')
})

test('a tool_result carrying no agentId and answering no Agent call is not an invocation', () => {
  const m = extractAgentMetrics([
    JSON.stringify({
      type: 'user',
      toolUseResult: { stdout: 'ok' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_7' }] },
    }),
  ], 'claude-opus-5')

  expect(m.invocations).toEqual([])
})
