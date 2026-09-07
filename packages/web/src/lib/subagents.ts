/**
 * subagents.ts — PURE: the rules for the aside's SUBAGENTS tab.
 *
 * The tab lists every subagent this conversation ran — the ones still running and the ones that
 * already did — with what each one spent, and opens into what one of them is doing.
 *
 * Two of its three rules are the same rule this codebase keeps applying to metrics, and they are
 * here rather than in the JSX because that is what makes them testable:
 *
 * - **N/A IS NOT ZERO.** Only Claude Code records subagents at all (`HARNESS_CAPABILITIES.agents`),
 *   so on every other harness the tab carries no count and says why. And WITHIN a supported
 *   session, an agent that has been launched and has not answered yet has no tokens — reported as
 *   an absence, never as a spend of nothing.
 * - **TOKENS MEANS THE FOUR COUNTERS.** The server sums them through `tokens.ts`; this side only
 *   ever displays `totalTokens`, and the breakdown beside it exists so the number can be accounted
 *   for. A subagent measured here read 123.6 M cached tokens against 698 fresh ones: an in+out
 *   reading of that row is 0,03 % of what it cost.
 * - **RUNNING IS WHAT POLLS.** A finished agent's numbers cannot change, and the list costs a full
 *   read of the parent transcript, so nothing polls once everything has stopped.
 */

/** Mirrors `SubagentStatus` in `sessions/subagents.ts`. */
export type SubagentStatus = 'running' | 'finished' | 'failed' | 'stopped' | 'unknown'

export interface SubagentRow {
  agentId: string
  agentType?: string
  description?: string
  model?: string
  modelId?: string
  status: SubagentStatus
  toolUseId?: string
  spawnDepth?: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  totalTokens: number | null
  costUSD: number | null
  toolCalls: number
  turns: number
  startedAt?: string
  lastAt?: string
}

export type SubagentsPayload =
  | { ok: true; supported: true; rows: SubagentRow[]; total: number; hasMore: boolean }
  | { ok: true; supported: false; message: string }
  | { ok: false; message: string }

/** What the panel holds while the tab is open. */
export type SubagentsState =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: SubagentRow[]; total: number; hasMore: boolean }
  | { phase: 'unsupported'; message: string }
  | { phase: 'failed'; message: string }

export function subagentsStateOf(payload: SubagentsPayload): SubagentsState {
  if (!payload.ok) return { phase: 'failed', message: payload.message }
  if (!payload.supported) return { phase: 'unsupported', message: payload.message }
  return { phase: 'ready', rows: payload.rows, total: payload.total, hasMore: payload.hasMore }
}

/** How many are loaded at a time. Matches the server's own default. */
export const SUBAGENT_PAGE = 20

/**
 * One page appended to what is already on screen.
 *
 * By AGENT ID, because a poll can return a row that is already here with newer numbers — the list
 * is ordered by last activity, so a running agent MOVES. Appending blindly would draw it twice, and
 * replacing the whole list would throw away the pages somebody already asked for.
 */
export function appendPage(have: readonly SubagentRow[], page: readonly SubagentRow[]): SubagentRow[] {
  const merged = [...have]
  for (const row of page) {
    const at = merged.findIndex(r => r.agentId === row.agentId)
    if (at === -1) merged.push(row)
    else merged[at] = row
  }
  return merged
}

/**
 * The count on the tab, or `null` for "this cannot be counted here".
 *
 * `null` is what stops the tab reading `0` on a harness that simply does not record subagents —
 * the same N/A-versus-a-confident-0 rule the dashboard applies to every capability-gated metric.
 */
export function subagentCount(state: SubagentsState | null): number | null {
  return state?.phase === 'ready' ? state.total : null
}

/** How many are running right now — the number worth putting on the tab beside the total. */
export function runningCount(state: SubagentsState | null): number {
  return state?.phase === 'ready' ? state.rows.filter(r => r.status === 'running').length : 0
}

export const SUBAGENT_POLL_MS = 5000

/** Rule 3: the list re-reads only while something can still change. */
export function subagentsPollMs(state: SubagentsState | null): number | null {
  return runningCount(state) > 0 ? SUBAGENT_POLL_MS : null
}

/** The status word, and the colour it is said in. Never a glyph alone. */
export function subagentStatusText(s: SubagentStatus, pt: boolean): { text: string; color: string } {
  switch (s) {
    case 'running': return { text: pt ? 'rodando' : 'running', color: '#22c55e' }
    case 'finished': return { text: pt ? 'concluiu' : 'finished', color: 'var(--text-tertiary)' }
    case 'failed': return { text: pt ? 'falhou' : 'failed', color: '#ef4444' }
    // Somebody stopped it. Not a failure and not a completion, and folding it into either would be
    // wrong about whose decision it was.
    case 'stopped': return { text: pt ? 'interrompido' : 'stopped', color: '#f59e0b' }
    case 'unknown': return { text: pt ? 'sem registro' : 'not recorded', color: 'var(--text-tertiary)' }
  }
}

/**
 * The sentence for a row whose numbers do not exist.
 *
 * Returned instead of a figure, never beside a zero: "it has not answered yet" and "it spent
 * nothing" are different facts and only one of them is ever true here.
 */
export function unmeasuredText(row: SubagentRow, pt: boolean): string | null {
  if (row.totalTokens !== null) return null
  return row.status === 'running'
    ? (pt ? 'ainda não respondeu' : 'has not answered yet')
    : (pt ? 'sem transcrição para medir' : 'no transcript to measure')
}

/**
 * Why a cost is missing when the tokens are not.
 *
 * A model the pricing table cannot resolve yields no price, and the row says so rather than showing
 * a zero next to a hundred million tokens.
 */
export function unpricedText(row: SubagentRow, pt: boolean): string | null {
  if (row.costUSD !== null || row.totalTokens === null) return null
  return pt ? 'sem preço para este modelo' : 'no price for this model'
}
