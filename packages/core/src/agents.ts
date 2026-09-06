/**
 * agents.ts — the READ MIGRATION for `SessionAgentMetrics` records written before `unmeasured`.
 *
 * PR #373 made the reader stop publishing an async agent's invocation priced at nothing: the
 * numbers moved into the agent's own transcript, and one that still cannot be measured is marked
 * `unmeasured` so a zero is never read as a measurement. That fixes what is parsed FROM NOW ON.
 *
 * It does not reach what is already STORED. `~/.agentistics/sessions/<harness>/<id>.json` holds
 * `SessionMeta` records written by earlier builds, `loadConsolidated` revives them for every
 * session whose transcript Claude Code has since deleted, and each of those carries invocations
 * with zeros and no `unmeasured` mark — which the new rule reads as "measured, and it cost
 * nothing". Measured here: 74 sessions in that state.
 *
 * So the shape is recovered from the CONTENT, and there is exactly one signature to look for: an
 * invocation whose tokens, cost AND duration are ALL zero. A real agent that read no tokens, cost
 * nothing and took no time does not exist. Anything else was genuinely reported by the harness and
 * is left exactly as written — including a row with zero LINES or zero tool calls, which are
 * ordinary measurements.
 *
 * Idempotent, so it can sit on a read path that sees both shapes for as long as old rows survive.
 */

import type { AgentInvocation, SessionAgentMetrics } from './types'

/** Is this the zero-filled launch record of a build that could not measure an async agent? */
export function looksUnmeasured(inv: AgentInvocation): boolean {
  return inv.unmeasured !== true
    && (inv.totalTokens ?? 0) === 0
    && (inv.costUSD ?? 0) === 0
    && (inv.totalDurationMs ?? 0) === 0
}

export function migrateAgentMetrics(m: SessionAgentMetrics): SessionAgentMetrics {
  if (!Array.isArray(m.invocations)) return m
  if (!m.invocations.some(looksUnmeasured)) return m
  const invocations = m.invocations.map(inv => (looksUnmeasured(inv) ? { ...inv, unmeasured: true as const } : inv))
  return {
    ...m,
    invocations,
    // Recomputed rather than trusted: the stored count was written by a build that had no word for
    // an unmeasured invocation.
    unmeasuredInvocations: invocations.filter(i => i.unmeasured === true).length,
  }
}
