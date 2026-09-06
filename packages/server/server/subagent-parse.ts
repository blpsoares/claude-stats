/**
 * subagent-parse.ts — PURE: what one subagent's own transcript says it spent.
 *
 * Claude Code stopped putting a subagent's numbers in the parent's `toolUseResult`. Since the Agent
 * tool went ASYNCHRONOUS (measured here: the shape changed on 2026-08-14) the parent records only
 * `{ agentId, description, isAsync, outputFile, resolvedModel, status: 'async_launched' }` — no
 * usage, no tool stats, no duration. The numbers did not disappear: the subagent writes its own
 * transcript at `<project>/<session-id>/subagents/agent-<agentId>.jsonl`, and this module reads it.
 *
 * It is the parse half only. The file reading, the recursion into nested subagents and the memo
 * live in `subagent-metrics.ts`, so everything here stays a pure function of lines — the same split
 * every harness adapter makes.
 */

import { calcCost, totalTokens } from '@agentistics/core'
import type { AgentInvocation, SessionAgentMetrics } from '@agentistics/core'

/** What one MODEL cost inside a subagent. Per model, because a subagent may run a cheaper one. */
export interface SubagentUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Exactly the numeric half of `AgentInvocation` — what `agentNumbers` establishes. */
export interface AgentNumbers {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalDurationMs: number
  totalToolUseCount: number
  toolStats: SubagentToolStats
  costUSD: number
}

/** The same buckets `AgentInvocation.toolStats` has always carried. */
export interface SubagentToolStats {
  readCount: number
  searchCount: number
  bashCount: number
  editFileCount: number
  linesAdded: number
  linesRemoved: number
  otherToolCount: number
}

export interface SubagentSummary {
  /**
   * One entry per model the subagent used, in first-seen order.
   *
   * NEVER collapsed into a single figure here: a subagent commonly runs `haiku` under an `opus`
   * parent, and pricing its tokens at the parent's rate is how a cheap agent is billed as an
   * expensive one. The caller prices each entry with its own model id.
   */
  usage: SubagentUsage[]
  /** First and last timestamp seen, or `null` — an absent span is not a zero duration. */
  firstMs: number | null
  lastMs: number | null
  toolUseCount: number
  toolStats: SubagentToolStats
  /**
   * The subagents THIS subagent spawned, by `agentId`, deduped and in first-seen order.
   *
   * A nested agent's work appears in no other place the parent session can reach: only a top-level
   * `Agent` tool_use in the session transcript becomes an `AgentInvocation`, so without this the
   * whole subtree's tokens are missing from the session's agent totals. The caller resolves each id
   * to its own transcript in the same `subagents/` directory.
   */
  childAgentIds: string[]
}

interface UsageRecord {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * Which bucket a tool name falls in.
 *
 * A MAPPING, never a filter: a name nobody listed here is still counted, in `otherToolCount`, so a
 * tool added upstream shows up as work done rather than as work that never happened.
 */
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Sum one subagent transcript. Total: malformed input yields an empty summary, never a throw. */
export function summarizeSubagentTranscript(lines: Iterable<string>): SubagentSummary {
  const byModel = new Map<string, SubagentUsage>()
  let firstMs: number | null = null
  let lastMs: number | null = null
  let toolUseCount = 0
  const toolStats: SubagentToolStats = {
    readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0,
    linesAdded: 0, linesRemoved: 0, otherToolCount: 0,
  }
  const childAgentIds: string[] = []
  const seenChild = new Set<string>()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    let e: Record<string, unknown>
    try { e = JSON.parse(line) as Record<string, unknown> } catch { continue }

    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    if (Number.isFinite(ts)) {
      if (firstMs === null || ts < firstMs) firstMs = ts
      if (lastMs === null || ts > lastMs) lastMs = ts
    }

    const result = e.toolUseResult as Record<string, unknown> | undefined
    if (result && typeof result === 'object') {
      const childId = result.agentId
      if (typeof childId === 'string' && childId && !seenChild.has(childId)) {
        seenChild.add(childId)
        childAgentIds.push(childId)
      }
      // The edit patch the transcript already carries. `git diff` is not available here and would
      // answer about the working tree anyway, not about what this agent changed.
      const patch = result.structuredPatch
      if (Array.isArray(patch)) {
        for (const hunk of patch as Record<string, unknown>[]) {
          const hunkLines = hunk?.lines
          if (!Array.isArray(hunkLines)) continue
          for (const l of hunkLines as unknown[]) {
            if (typeof l !== 'string') continue
            if (l.startsWith('+')) toolStats.linesAdded++
            else if (l.startsWith('-')) toolStats.linesRemoved++
          }
        }
      }
    }

    if (e.type !== 'assistant') continue
    const msg = e.message as Record<string, unknown> | undefined

    if (Array.isArray(msg?.content)) {
      for (const item of msg!.content as Record<string, unknown>[]) {
        if (item?.type !== 'tool_use') continue
        toolUseCount++
        const name = typeof item.name === 'string' ? item.name : ''
        if (name === 'Read') toolStats.readCount++
        else if (SEARCH_TOOLS.has(name)) toolStats.searchCount++
        else if (name === 'Bash') toolStats.bashCount++
        else if (EDIT_TOOLS.has(name)) toolStats.editFileCount++
        else toolStats.otherToolCount++
      }
    }

    const usage = msg?.usage as UsageRecord | undefined
    if (!usage) continue

    const model = typeof msg?.model === 'string' ? msg.model : ''
    let entry = byModel.get(model)
    if (!entry) {
      entry = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      byModel.set(model, entry)
    }
    entry.inputTokens += num(usage.input_tokens)
    entry.outputTokens += num(usage.output_tokens)
    entry.cacheReadTokens += num(usage.cache_read_input_tokens)
    entry.cacheWriteTokens += num(usage.cache_creation_input_tokens)
  }

  return { usage: [...byModel.values()], firstMs, lastMs, toolUseCount, toolStats, childAgentIds }
}

/**
 * The numbers ONE invocation reports: its own transcript plus everything it spawned.
 *
 * Two rules the old reader could not follow, because the parent's `toolUseResult` gave it neither:
 *
 * - **Each model is priced at ITS OWN rate.** A subagent commonly runs `haiku` under an `opus`
 *   parent (measured on this machine: four different models across 440 subagent transcripts), so
 *   pricing the whole invocation with the parent's model id bills a cheap agent as an expensive one.
 * - **A nested subagent counts inside the invocation that spawned it.** Only a top-level `Agent`
 *   tool_use in the session transcript becomes an `AgentInvocation`, so a subtree left out here is
 *   left out of the session's agent totals entirely.
 *
 * The DURATION is the root's own span: a nested agent runs inside its parent, so adding the two
 * would count the same wall time twice.
 */
export function agentNumbers(root: SubagentSummary, descendants: readonly SubagentSummary[]): AgentNumbers {
  const toolStats: SubagentToolStats = {
    readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0,
    linesAdded: 0, linesRemoved: 0, otherToolCount: 0,
  }
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
  let totalToolUseCount = 0
  let costUSD = 0

  for (const s of [root, ...descendants]) {
    for (const u of s.usage) {
      inputTokens += u.inputTokens
      outputTokens += u.outputTokens
      cacheReadTokens += u.cacheReadTokens
      cacheWriteTokens += u.cacheWriteTokens
      costUSD += calcCost(
        {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadInputTokens: u.cacheReadTokens,
          cacheCreationInputTokens: u.cacheWriteTokens,
          webSearchRequests: 0,
          costUSD: 0,
        },
        u.model,
      )
    }
    totalToolUseCount += s.toolUseCount
    toolStats.readCount += s.toolStats.readCount
    toolStats.searchCount += s.toolStats.searchCount
    toolStats.bashCount += s.toolStats.bashCount
    toolStats.editFileCount += s.toolStats.editFileCount
    toolStats.linesAdded += s.toolStats.linesAdded
    toolStats.linesRemoved += s.toolStats.linesRemoved
    toolStats.otherToolCount += s.toolStats.otherToolCount
  }

  return {
    totalTokens: totalTokens({ input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens }),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalDurationMs: root.firstMs !== null && root.lastMs !== null ? root.lastMs - root.firstMs : 0,
    totalToolUseCount,
    toolStats,
    costUSD,
  }
}

/**
 * The session-level totals, over the invocations that HAVE numbers.
 *
 * An unmeasured invocation contributes nothing — it is an absence, not a zero — and is counted
 * separately so a surface can say how much of what it is showing the totals actually cover.
 */
export function totalsOf(invocations: AgentInvocation[]): SessionAgentMetrics {
  const measured = invocations.filter(i => !i.unmeasured)
  return {
    invocations,
    totalInvocations: invocations.length,
    unmeasuredInvocations: invocations.length - measured.length,
    totalTokens: measured.reduce((s, i) => s + i.totalTokens, 0),
    totalDurationMs: measured.reduce((s, i) => s + i.totalDurationMs, 0),
    totalCostUSD: measured.reduce((s, i) => s + i.costUSD, 0),
  }
}
