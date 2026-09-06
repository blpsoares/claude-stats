import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionAgentMetrics } from '@agentistics/core'
import { enrichFromSubagentTranscripts } from './subagent-metrics'

/** A real directory tree, because the thing under test is the file layout itself. */
async function machine(sessionId: string, files: Record<string, string[]>) {
  const root = await mkdtemp(join(tmpdir(), 'agentistics-subagents-'))
  const dir = join(root, sessionId, 'subagents')
  await mkdir(dir, { recursive: true })
  for (const [agentId, lines] of Object.entries(files)) {
    await writeFile(join(dir, `agent-${agentId}.jsonl`), lines.join('\n'))
  }
  return { transcriptPath: join(root, `${sessionId}.jsonl`) }
}

function turn(model: string, out: number, at = '2026-09-01T10:00:00.000Z', content: unknown[] = []) {
  return JSON.stringify({ type: 'assistant', timestamp: at, message: { model, usage: { output_tokens: out }, content } })
}

function unmeasured(toolUseId: string, agentId: string): SessionAgentMetrics['invocations'][number] {
  return {
    toolUseId, agentId, unmeasured: true, agentType: 'general-purpose', description: 'd',
    status: 'completed', totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    toolStats: { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 },
    costUSD: 0,
  }
}

function metrics(...invocations: SessionAgentMetrics['invocations']): SessionAgentMetrics {
  return { invocations, totalInvocations: invocations.length, unmeasuredInvocations: invocations.length, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0 }
}

test('an unmeasured invocation is filled in from the subagent’s own transcript', async () => {
  const { transcriptPath } = await machine('s1', {
    aOne: [turn('claude-sonnet-5', 500, '2026-09-01T10:00:00.000Z'), turn('claude-sonnet-5', 300, '2026-09-01T10:00:30.000Z')],
  })

  const out = await enrichFromSubagentTranscripts(metrics(unmeasured('toolu_1', 'aOne')), transcriptPath, 's1')

  const inv = out.invocations[0]!
  expect(inv.unmeasured).toBeUndefined()
  expect(inv.outputTokens).toBe(800)
  expect(inv.totalTokens).toBe(800)
  expect(inv.totalDurationMs).toBe(30_000)
  expect(inv.costUSD).toBeGreaterThan(0)
  expect(out.unmeasuredInvocations).toBe(0)
  expect(out.totalTokens).toBe(800)
})

test('a missing subagent transcript leaves the invocation unmeasured — never a zero', async () => {
  const { transcriptPath } = await machine('s2', {})

  const out = await enrichFromSubagentTranscripts(metrics(unmeasured('toolu_1', 'aGone')), transcriptPath, 's2')

  expect(out.invocations[0]!.unmeasured).toBe(true)
  expect(out.unmeasuredInvocations).toBe(1)
})

test('a nested subagent counts inside the invocation that spawned it', async () => {
  const { transcriptPath } = await machine('s3', {
    aParent: [
      turn('claude-sonnet-5', 100),
      JSON.stringify({ type: 'user', timestamp: '2026-09-01T10:00:05.000Z', toolUseResult: { agentId: 'aChild', isAsync: true } }),
    ],
    aChild: [turn('claude-sonnet-5', 900)],
  })

  const out = await enrichFromSubagentTranscripts(metrics(unmeasured('toolu_1', 'aParent')), transcriptPath, 's3')

  expect(out.invocations[0]!.outputTokens).toBe(1000)
})

test('subagents that name each other cannot loop forever', async () => {
  const { transcriptPath } = await machine('s4', {
    aA: [turn('claude-sonnet-5', 10), JSON.stringify({ type: 'user', toolUseResult: { agentId: 'aB' } })],
    aB: [turn('claude-sonnet-5', 20), JSON.stringify({ type: 'user', toolUseResult: { agentId: 'aA' } })],
  })

  const out = await enrichFromSubagentTranscripts(metrics(unmeasured('toolu_1', 'aA')), transcriptPath, 's4')

  expect(out.invocations[0]!.outputTokens).toBe(30)
})

test('an invocation that already has numbers is left exactly as it is', async () => {
  const { transcriptPath } = await machine('s5', { aOne: [turn('claude-sonnet-5', 9999)] })
  const legacy = { ...unmeasured('toolu_1', 'aOne'), unmeasured: undefined, outputTokens: 42, totalTokens: 42 }
  delete (legacy as Record<string, unknown>).unmeasured

  const out = await enrichFromSubagentTranscripts(metrics(legacy), transcriptPath, 's5')

  expect(out.invocations[0]!.outputTokens).toBe(42)
})
