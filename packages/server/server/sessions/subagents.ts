/**
 * subagents.ts — PURE: the subagents one conversation ran, and what each of them cost.
 *
 * ## Where this data actually is, and why the old reader found none of it
 *
 * `agent-metrics.ts` reads a SYNCHRONOUS Agent call: a `tool_use`, and a `tool_result` beside it
 * carrying `totalTokens`, `usage` and `toolStats`. Claude Code now launches agents ASYNCHRONOUSLY,
 * and the result that comes back at launch carries none of that — `{isAsync: true, status:
 * "async_launched", agentId, outputFile}` and nothing else. Measured on this machine: 74 sessions
 * hold agent metrics and every async invocation in them reads `status: "completed", totalTokens: 0,
 * costUSD: 0`. A confident zero for 55 subagents that between them read a hundred thousand tokens
 * each — exactly the misleading-zero `HARNESS_CAPABILITIES` exists to prevent, produced from the
 * inside because the shape changed under a reader that still parsed cleanly.
 *
 * The real record is a DIRECTORY the harness writes beside the conversation:
 *
 *   ~/.claude/projects/<project>/<conversationId>/subagents/
 *     agent-<agentId>.meta.json   {agentType, description, toolUseId, spawnDepth, model}
 *     agent-<agentId>.jsonl       the subagent's own transcript — its turns, its tools, its usage
 *
 * So the list comes from the metas (which name the agent and link it back to the parent's
 * `tool_use`), the numbers come from summing the transcript's own usage records, and the ACTIVITY —
 * what it is doing right now — is that transcript read like any other conversation.
 *
 * ## Rules
 *
 * - **TOKENS ARE THE FOUR COUNTERS**, summed through `@agentistics/core`'s `tokens.ts` and never by
 *   hand. A subagent's cache read dwarfs its input; an in+out reading of the one measured here is
 *   0,3 % of the volume.
 * - **A NUMBER THAT CANNOT BE PRODUCED IS `null`, NEVER 0.** A meta with no transcript yet is an
 *   agent that has just been launched, and reporting it as having spent nothing is the same bug
 *   this file exists to have fixed.
 * - **STATUS IS RECORDED, NOT INFERRED.** The parent's `<task-notification>` states it (`<task-id>`
 *   is the agentId, `<status>` the outcome). With no notification the agent is still running IF the
 *   session is live; on a session that has ended it is `unknown` and says so — "we never saw how
 *   this one finished" is a different fact from "it finished".
 */

import { calcCost, sumTokens, type TokenBreakdown } from '@agentistics/core'

/** `agent-<id>.meta.json` → the agent's identity, as the harness recorded it. */
export interface SubagentMeta {
  agentId: string
  agentType?: string
  description?: string
  /** The parent's `tool_use` id — the exact link back to the row in the Live feed. */
  toolUseId?: string
  /** 1 for an agent the conversation itself started; deeper for an agent an agent started. */
  spawnDepth?: number
  /** The alias the call asked for (`haiku`), NOT the resolved model id. */
  model?: string
}

/** The agent id in `agent-<id>.jsonl` / `agent-<id>.meta.json`, or null for any other file. */
export function agentIdFromFile(name: string): string | null {
  const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name)
  return m ? m[1]! : null
}

/** Read a meta file. Someone else's format: every field checked, a bad one yields "not known". */
export function parseSubagentMeta(agentId: string, raw: string): SubagentMeta {
  const out: SubagentMeta = { agentId }
  let o: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
    o = v as Record<string, unknown>
  } catch { return out }
  const str = (k: string): string | undefined =>
    typeof o[k] === 'string' && o[k] !== '' ? o[k] as string : undefined
  return {
    agentId,
    ...(str('agentType') ? { agentType: str('agentType')! } : {}),
    ...(str('description') ? { description: str('description')! } : {}),
    ...(str('toolUseId') ? { toolUseId: str('toolUseId')! } : {}),
    ...(str('model') ? { model: str('model')! } : {}),
    ...(typeof o.spawnDepth === 'number' && Number.isFinite(o.spawnDepth)
      ? { spawnDepth: o.spawnDepth } : {}),
  }
}

/**
 * What the PARENT recorded about each agent's outcome.
 *
 * A `<task-notification>` names the agent (`<task-id>`) and its `<status>`. Read from the raw text
 * rather than from parsed turns: the same notification appears both as a `queue-operation` and as
 * a `user` entry, and a substring scan sees the file once instead of parsing 4 MB of JSON to reach
 * a hundred lines.
 */
export function parseTaskOutcomes(content: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (!line.includes('<task-notification>')) continue
    // The escaped form is what a JSONL line actually carries (`\n` inside a JSON string).
    const id = /<task-id>([^<\\]+)<\\?\/task-id>/.exec(line)?.[1]?.trim()
    const status = /<status>([^<\\]+)<\\?\/status>/.exec(line)?.[1]?.trim()
    if (!id || !status) continue
    // LAST one wins: an agent can stop, be resumed and stop again, and the newest line is the one
    // that describes it now.
    out.set(id, status)
  }
  return out
}

/**
 * WHICH AGENTS ONE PAGE HOLDS, and how many there are in all.
 *
 * Paging exists here for a reason that is not cosmetic: the expensive part of listing agents is
 * SUMMARISING each one's transcript, and a conversation here holds 57 of them over 35 MB. Reading
 * all of it to draw a list somebody scrolls is work nobody asked for, and it is what made the tab
 * take long enough to look broken.
 *
 * The order is BY LAST ACTIVITY, newest first — which is why it is decided from the file's mtime
 * rather than from `startedAt`. `startedAt` is inside the transcript, so ordering by it would mean
 * reading every transcript to decide which twenty to read. The mtime is one `stat`, it is what
 * "most recent" actually means for an agent (its last write), and it lets the page be chosen before
 * anything is opened.
 */
export interface AgentFile {
  agentId: string
  /** Last write, epoch ms. The sort key, and the only thing read before the page is chosen. */
  mtimeMs: number
}

export interface AgentPage {
  /** The agents this page holds, newest first. */
  files: AgentFile[]
  /** How many exist in all — so a partial list can say it is partial. */
  total: number
  /** True when there are older ones behind this page. */
  hasMore: boolean
}

export const DEFAULT_AGENT_PAGE = 20

export function pageOfAgents(files: readonly AgentFile[], limit: number, offset: number): AgentPage {
  const ordered = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)
  // A negative or absurd request is CLAMPED rather than refused: it comes from a query string, and
  // an empty page for a typo reads as "this session has no agents".
  const from = Math.max(0, Math.min(offset, ordered.length))
  const size = Math.max(1, Math.min(limit, 200))
  const page = ordered.slice(from, from + size)
  return { files: page, total: ordered.length, hasMore: from + page.length < ordered.length }
}

/**
 * What a subagent SPENT and DID, from its own transcript.
 *
 * `null` tokens mean the transcript carried no usage at all — an agent that has been launched and
 * has not answered yet. That is reported as an absence and never as a zero.
 */
export interface SubagentUsage {
  tokens: TokenBreakdown | null
  /** The resolved model id the transcript actually names — what `calcCost` can price. */
  model: string | null
  toolCalls: number
  turns: number
  startedAt?: string
  lastAt?: string
}

export function summarizeSubagent(content: string): SubagentUsage {
  const parts: TokenBreakdown[] = []
  let model: string | null = null
  let toolCalls = 0
  let turns = 0
  let startedAt: string | undefined
  let lastAt: string | undefined

  for (const line of content.split('\n')) {
    if (line === '') continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) as Record<string, unknown> } catch { continue }

    const at = typeof e.timestamp === 'string' ? e.timestamp : undefined
    if (at) { startedAt ??= at; lastAt = at }

    const m = e.message as Record<string, unknown> | undefined
    if (!m) continue
    if (e.type === 'assistant') turns++
    if (typeof m.model === 'string' && m.model !== '') model = m.model

    const u = m.usage as Record<string, unknown> | undefined
    if (u) {
      const n = (k: string): number => (typeof u[k] === 'number' ? u[k] as number : 0)
      parts.push({
        input: n('input_tokens'),
        output: n('output_tokens'),
        cacheRead: n('cache_read_input_tokens'),
        cacheWrite: n('cache_creation_input_tokens'),
      })
    }

    const c = m.content
    if (Array.isArray(c)) {
      for (const b of c as Record<string, unknown>[]) if (b.type === 'tool_use') toolCalls++
    }
  }

  return {
    // THE FOUR COUNTERS, summed by the shared helper. Never `input + output`.
    tokens: parts.length > 0 ? sumTokens(parts) : null,
    model,
    toolCalls,
    turns,
    ...(startedAt ? { startedAt } : {}),
    ...(lastAt ? { lastAt } : {}),
  }
}

/**
 * What this subagent is doing.
 *
 * `unknown` is a real answer and the reason this is not a boolean: a session that ended without
 * recording a notification tells us nothing about how its agent finished, and both "running" and
 * "finished" would be inventions.
 */
export type SubagentStatus = 'running' | 'finished' | 'failed' | 'stopped' | 'unknown'

/**
 * The three outcomes Claude Code actually writes, plus the two this reader derives.
 *
 * Measured on one live transcript: 116 `completed`, 4 `failed`, 4 `stopped`. `stopped` gets its own
 * word rather than being folded into either neighbour — an agent somebody stopped did not fail and
 * did not finish, and both of those would be wrong about whose decision it was.
 */
export function subagentStatus(recorded: string | undefined, sessionLive: boolean): SubagentStatus {
  if (recorded === undefined) return sessionLive ? 'running' : 'unknown'
  const s = recorded.toLowerCase()
  if (s === 'completed' || s === 'success' || s === 'done') return 'finished'
  if (s === 'failed' || s === 'error') return 'failed'
  if (s === 'stopped' || s === 'cancelled' || s === 'canceled' || s === 'interrupted') return 'stopped'
  // A status this reader has no word for is not silently mapped to success.
  return 'unknown'
}

/** The cost of what a subagent spent, or `null` when there is nothing to price. */
export function subagentCost(tokens: TokenBreakdown | null, model: string | null): number | null {
  if (!tokens || !model) return null
  return calcCost({
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    // The CACHE counters are passed for real. Zeroing them prices the cheap 4 % of the volume, which
    // `tokens.lint.test.ts` greps for precisely because it looks harmless.
    cacheReadInputTokens: tokens.cacheRead,
    cacheCreationInputTokens: tokens.cacheWrite,
    webSearchRequests: 0,
    costUSD: 0,
  }, model)
}
