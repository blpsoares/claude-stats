/**
 * sessionStats.ts — PURE: the numbers behind ONE session, and which of them this harness can
 * actually produce.
 *
 * The dashboard has a stats strip for the whole machine; this is the same idea for the conversation
 * you have open — how full its context is, what it has spent, how much of the talking was yours,
 * how many subagents it ran, what it changed in the repository.
 *
 * TWO RULES CARRY THE WHOLE FILE, and both come from `HARNESS_CAPABILITIES`:
 *
 * 1. A METRIC THIS HARNESS CANNOT PRODUCE IS `null`, NEVER 0. Gemini reports no tokens; Codex
 *    reports no agents. A confident `0` beside real figures is read as "it did nothing", which is a
 *    different and false statement from "this cannot be measured here". The panel renders `null` as
 *    N/A with the harness's own reason.
 * 2. A CONVERSATION THE STORE HAS NOT SEEN YET IS `null` TOO — not zero. A session started ten
 *    seconds ago has no record; saying it has spent nothing would be true only by accident, and
 *    wrong a minute later.
 *
 * The context gauge is `contextFraction` from `@agentistics/core` and inherits its rule unchanged:
 * a fraction exists only when BOTH the measurement and the window are known, the window is never
 * guessed from a model id that is not in the table, and the value is NOT clamped — a session really
 * can exceed the documented window, so the bar saturates while the label keeps saying 106%.
 */

import {
  HARNESS_CAPABILITIES, calcCost, contextFraction, resolveContextWindow, sessionTokens,
  type HarnessId, type SessionMeta, type TokenBreakdown,
} from '@agentistics/core'

export interface SessionStats {
  /** The conversation these numbers are FOR, so a stale panel can be spotted. */
  sessionId: string
  harness: HarnessId
  /** All four counters. `null` when the harness reports none. */
  tokens: TokenBreakdown | null
  /** The conversational pair alone — what "sem cache" means on screen. */
  conversation: { input: number; output: number } | null
  /** USD. Converted for display by the caller, which is where the rate lives. */
  costUSD: number | null
  /** 0..n, unclamped — see the header. `null` when either half is unknown. */
  context: { fraction: number; used: number; window: number } | null
  messages: { user: number; assistant: number } | null
  /** How many subagent invocations ran, and what they cost. `null` when the harness has no agents. */
  subagents: { count: number; tokens: number; costUSD: number } | null
  git: { commits: number; added: number; removed: number; files: number } | null
  activeMinutes: number | null
  model: string | null
}

/** Why a metric is absent, in the words the panel prints. Absent when the metric IS available. */
export type StatReason = 'harness' | 'unrecorded'

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * The panel's numbers for one session.
 *
 * `meta` is the store's record, or `undefined` when the conversation is not in it yet — a live
 * session the poller has not caught up with, or one whose harness writes no transcript this
 * product can read. That case is NOT an error and NOT zero: every field comes back `null`, and the
 * caller says which of the two it is.
 */
export function sessionStats(
  harness: HarnessId,
  sessionId: string,
  meta: SessionMeta | undefined,
): SessionStats {
  const caps = HARNESS_CAPABILITIES[harness]
  const base: SessionStats = {
    sessionId,
    harness,
    tokens: null,
    conversation: null,
    costUSD: null,
    context: null,
    messages: null,
    subagents: null,
    git: null,
    activeMinutes: null,
    model: null,
  }
  if (!meta) return base

  const tokens = caps?.tokens ? sessionTokens(meta) : null
  const model = typeof meta.model === 'string' && meta.model !== '' ? meta.model : null

  // The window the HARNESS declared outranks the table — it knows the deployment and any per-session
  // cap, which a model id cannot express. Same order `SessionMeta.context_window` is given
  // everywhere else.
  const declared = num((meta as { context_window?: number }).context_window)
  const window = declared > 0
    ? declared
    : (model ? resolveContextWindow(model)?.tokens ?? 0 : 0)
  const used = num((meta as { context_tokens?: number }).context_tokens)
  const fraction = caps?.contextWindow ? contextFraction(used, window) : null

  /**
   * ABSENT `agentMetrics` IS NOT AN EMPTY LIST, and reading it as one is rule 2 of this file broken
   * in the one place it was written down.
   *
   * `?? []` made a record with no `agentMetrics` at all report `None ran` — a confident zero about
   * something the reader could not see. Measured on a live 39 MB transcript that dispatched several
   * subagents: NO `Agent` tool_use is written into the parent at all (tool names present: Bash,
   * Read, Write, Edit, AskUserQuestion, Skill, ToolSearch, one MCP call), and no
   * `toolUseResult.agentType` either — a background agent leaves the parent transcript no record,
   * so `extractAgentMetrics` has nothing to find and the field is never written. "None ran" was
   * therefore false on exactly the conversations that ran the most of them.
   *
   * An EMPTY array is still a real zero: the parser looked and found none. The distinction is the
   * whole point — one is an answer, the other is the absence of one.
   */
  const invocations = meta.agentMetrics?.invocations
  const subagents = caps?.agents && invocations !== undefined
    ? {
      count: invocations.length,
      tokens: invocations.reduce((n, i) => n + num(i.totalTokens), 0),
      costUSD: invocations.reduce((n, i) => n + num(i.costUSD), 0),
    }
    : null

  return {
    sessionId,
    harness,
    tokens,
    conversation: caps?.tokens ? { input: num(meta.input_tokens), output: num(meta.output_tokens) } : null,
    // Priced through `calcCost` with the REAL cache counters — pricing cache as fresh input is
    // roughly tenfold too high, and zeroing it prices the cheap 4% of the volume.
    costUSD: caps?.cost && tokens
      ? calcCost({
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadInputTokens: tokens.cacheRead,
        cacheCreationInputTokens: tokens.cacheWrite,
        webSearchRequests: 0,
        costUSD: 0,
      }, model ?? '')
      : null,
    context: fraction === null ? null : { fraction, used, window },
    messages: {
      user: num(meta.user_message_count),
      assistant: num(meta.assistant_message_count),
    },
    subagents,
    git: caps?.gitLines
      ? {
        commits: num(meta.git_commits),
        added: num(meta.lines_added),
        removed: num(meta.lines_removed),
        files: num(meta.files_modified),
      }
      : null,
    activeMinutes: caps?.activeTime ? num(meta.active_minutes) : null,
    model,
  }
}

/**
 * Why a figure is missing — the sentence's INPUT, not the sentence.
 *
 * `harness` means this assistant cannot produce it at all; `unrecorded` means the conversation is
 * not in the store yet. They send a reader to two different places, so they must not collapse into
 * one "—".
 */
export function statReason(
  harness: HarnessId,
  metric: keyof (typeof HARNESS_CAPABILITIES)[HarnessId],
): StatReason {
  return HARNESS_CAPABILITIES[harness]?.[metric] ? 'unrecorded' : 'harness'
}
