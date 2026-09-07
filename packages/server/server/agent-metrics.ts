import { readFile } from 'fs/promises'
import { basename } from 'path'
import { calcCost } from '@agentistics/core'
import { totalsOf } from './subagent-parse'
import { enrichFromSubagentTranscripts } from './subagent-metrics'
import type { AgentInvocation, SessionAgentMetrics } from '@agentistics/core'

interface ToolUseRecord {
  id: string
  input: {
    description?: string
    subagent_type?: string
    prompt?: string
  }
}

interface ToolUseResult {
  status?: string
  agentType?: string
  agentId?: string
  totalDurationMs?: number
  totalTokens?: number
  totalToolUseCount?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  toolStats?: {
    readCount?: number
    searchCount?: number
    bashCount?: number
    editFileCount?: number
    linesAdded?: number
    linesRemoved?: number
    otherToolCount?: number
  }
}

/**
 * Parse JSONL lines from a session file and extract agent invocation metrics.
 *
 * Key JSONL structure:
 * - Assistant messages have `content` items with `type: "tool_use"` and `name: "Agent"`
 * - The input has: `{ description, subagent_type, prompt }`
 * - Correlating user messages have `toolUseResult` at the message level with usage/timing info
 * - Correlation: match by `tool_use_id` in the tool_result content array
 *
 * **An agent is not defined by the tool that launched it.** Three shapes reach this reader, and for
 * a release only the first of them produced a row (measured 2026-09-06, one machine, 541 subagent
 * transcripts on disk):
 *
 * 1. An `Agent` tool_use answered by a `tool_result` — 528 of them, and all this used to read.
 * 2. A `tool_result` naming an agent with NO `Agent` call before it. A skill run in the BACKGROUND
 *    is a `Skill` tool_use whose result is `{status:'forked', background:true, agentId}` — the
 *    parent names the agent perfectly well, and keying on the tool name made the whole run vanish.
 * 3. An `Agent` tool_use the parent NEVER answered — launched and left running. It used to sit in
 *    the pending map to the end of the file and be dropped, although it had a full transcript.
 *
 * Shapes 2 and 3 are recorded UNMEASURED here and measured from the subagent's own transcript by
 * `subagent-metrics.ts`, which joins the two sides through `subagent-join.ts`. An agent already
 * recorded never opens a second row: a later tool reporting ON an agent is not another launch.
 */
export function extractAgentMetrics(lines: Iterable<string>, modelId: string): SessionAgentMetrics {
  // Map of tool_use_id → ToolUseRecord for pending Agent invocations
  const pendingAgents = new Map<string, ToolUseRecord>()
  const invocations: AgentInvocation[] = []
  /** Every agent already given a row, so a later report ON one cannot open a second. */
  const recordedAgentIds = new Set<string>()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }

    // Scan assistant messages for Agent tool_use items
    if (e.type === 'assistant') {
      const msg = e.message as Record<string, unknown> | undefined
      if (!Array.isArray(msg?.content)) continue

      for (const item of msg!.content as Record<string, unknown>[]) {
        if (
          item.type === 'tool_use' &&
          item.name === 'Agent' &&
          typeof item.id === 'string'
        ) {
          const input = (item.input ?? {}) as ToolUseRecord['input']
          pendingAgents.set(item.id as string, {
            id: item.id as string,
            input,
          })
        }
      }
      continue
    }

    // Scan user messages for toolUseResult + tool_result content correlation
    if (e.type === 'user') {
      // The toolUseResult is at message envelope level (not inside content)
      const toolUseResult = e.toolUseResult as ToolUseResult | undefined
      if (!toolUseResult) continue

      const msg = e.message as Record<string, unknown> | undefined
      const contentArr = Array.isArray(msg?.content)
        ? (msg!.content as Record<string, unknown>[])
        : []

      // Find the tool_result item(s) in this message content — they carry the tool_use_id
      for (const item of contentArr) {
        if (item.type !== 'tool_result') continue
        const toolUseId = item.tool_use_id as string | undefined
        if (!toolUseId) continue

        const pending = pendingAgents.get(toolUseId)
        // A result that NAMES an agent is a launch whatever tool produced it — that is the
        // background forked skill, whose `Skill` call left nothing pending here. It is not a launch
        // when the agent already has a row: a later tool reporting on one is a report, not a spawn.
        const named = typeof toolUseResult.agentId === 'string' ? toolUseResult.agentId : ''
        if (!pending && (!named || recordedAgentIds.has(named))) continue

        // We have a match — build the AgentInvocation
        pendingAgents.delete(toolUseId)
        if (named) recordedAgentIds.add(named)
        const input = pending?.input ?? {}

        /**
         * Did this result carry NUMBERS at all?
         *
         * Since Claude Code made the `Agent` tool asynchronous (measured: the shape changed on
         * 2026-08-14) the result is only `{ agentId, description, isAsync, outputFile,
         * resolvedModel, status: 'async_launched' }` — no `usage`, no totals, no `toolStats`. Every
         * `?? 0` below then fired at once and the invocation was published priced at nothing, which
         * is exactly the confident zero this repository forbids: the panel kept rendering rows and
         * only the values were gone, which is why it went unnoticed for three weeks.
         *
         * So a result with no numbers is marked UNMEASURED here and enriched from the subagent's own
         * transcript by `subagent-metrics.ts`. What cannot be found there stays unmeasured, and the
         * surface renders N/A.
         */
        const measured =
          toolUseResult.usage !== undefined ||
          toolUseResult.totalTokens !== undefined ||
          toolUseResult.totalDurationMs !== undefined ||
          toolUseResult.totalToolUseCount !== undefined ||
          toolUseResult.toolStats !== undefined

        const usage = toolUseResult.usage ?? {}
        const toolStats = toolUseResult.toolStats ?? {}

        const inputTokens = usage.input_tokens ?? 0
        const outputTokens = usage.output_tokens ?? 0
        const cacheReadTokens = usage.cache_read_input_tokens ?? 0
        const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0

        const costUSD = calcCost(
          {
            inputTokens,
            outputTokens,
            cacheReadInputTokens: cacheReadTokens,
            cacheCreationInputTokens: cacheWriteTokens,
            webSearchRequests: 0,
            costUSD: 0,
          },
          modelId
        )

        invocations.push({
          toolUseId,
          ...(toolUseResult.agentId ? { agentId: toolUseResult.agentId } : {}),
          ...(measured ? {} : { unmeasured: true as const }),
          agentType: toolUseResult.agentType ?? input.subagent_type ?? 'unknown',
          description: input.description ?? '',
          status: (toolUseResult.status === 'failed') ? 'failed' : 'completed',
          totalTokens: toolUseResult.totalTokens ?? (inputTokens + outputTokens),
          totalDurationMs: toolUseResult.totalDurationMs ?? 0,
          totalToolUseCount: toolUseResult.totalToolUseCount ?? 0,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          toolStats: {
            readCount: toolStats.readCount ?? 0,
            searchCount: toolStats.searchCount ?? 0,
            bashCount: toolStats.bashCount ?? 0,
            editFileCount: toolStats.editFileCount ?? 0,
            linesAdded: toolStats.linesAdded ?? 0,
            linesRemoved: toolStats.linesRemoved ?? 0,
            otherToolCount: toolStats.otherToolCount ?? 0,
          },
          costUSD,
        })
      }
    }
  }

  /**
   * Every launch the parent never answered — the plain background agent.
   *
   * Appended after the answered ones rather than woven back into their place: the transcript gives
   * no moment at which they finished, and any position chosen for them would be invented. They
   * carry no numbers here; the transcript beside the session does.
   */
  for (const [toolUseId, pending] of pendingAgents) {
    invocations.push({
      toolUseId,
      unmeasured: true as const,
      agentType: pending.input.subagent_type ?? 'unknown',
      description: pending.input.description ?? '',
      status: 'completed',
      totalTokens: 0,
      totalDurationMs: 0,
      totalToolUseCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolStats: {
        readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0,
        linesAdded: 0, linesRemoved: 0, otherToolCount: 0,
      },
      costUSD: 0,
    })
  }

  return totalsOf(invocations)
}

/**
 * Read a JSONL file and extract agent metrics from it.
 * Used for meta-sourced sessions that have agent tool usage.
 */
export async function extractAgentMetricsFromFile(filePath: string): Promise<SessionAgentMetrics> {
  const empty: SessionAgentMetrics = { invocations: [], totalInvocations: 0, unmeasuredInvocations: 0, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0 }
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return empty
  }

  const lines = content.split('\n')

  // Extract model ID from first assistant message
  let modelId = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    try {
      const e = JSON.parse(line) as Record<string, unknown>
      if (e.type === 'assistant') {
        const msg = e.message as Record<string, unknown> | undefined
        if (typeof msg?.model === 'string') { modelId = msg.model; break }
      }
    } catch { continue }
  }

  // The session id is the file's own name — which is exactly what names the `subagents/` directory
  // holding each subagent's transcript.
  const sessionId = basename(filePath).replace(/\.jsonl$/, '')
  return enrichFromSubagentTranscripts(extractAgentMetrics(lines, modelId), filePath, sessionId)
}
