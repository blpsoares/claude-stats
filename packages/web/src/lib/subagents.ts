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
  /** This row is a conversation FORK, not an agent this conversation dispatched. */
  isFork: boolean
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  totalTokens: number | null
  costUSD: number | null
  toolCalls: number
  turns: number
  startedAt?: string
  lastAt?: string
}

export type SubagentsPayload =
  | {
      ok: true; supported: true; rows: SubagentRow[]
      /** Every row — agents AND forks, because the list shows both. */
      total: number
      /** The rows this conversation DISPATCHED. `agents + forks === total`. */
      agents: number
      /** The rows that are conversation FORKS. */
      forks: number
      hasMore: boolean
    }
  | { ok: true; supported: false; message: string }
  | { ok: false; message: string }

/** What the panel holds while the tab is open. */
export type SubagentsState =
  | { phase: 'loading' }
  | {
      phase: 'ready'; rows: SubagentRow[]
      total: number; agents: number; forks: number; hasMore: boolean
    }
  | { phase: 'unsupported'; message: string }
  | { phase: 'failed'; message: string }

export function subagentsStateOf(payload: SubagentsPayload): SubagentsState {
  if (!payload.ok) return { phase: 'failed', message: payload.message }
  if (!payload.supported) return { phase: 'unsupported', message: payload.message }
  return {
    phase: 'ready', rows: payload.rows,
    total: payload.total, agents: payload.agents, forks: payload.forks, hasMore: payload.hasMore,
  }
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
 *
 * It is `agents`, NOT `total`: a conversation FORK is listed here and is not a subagent, because
 * nothing dispatched it. The row was already labelled `fork` while the badge above it went on
 * counting it, so the aside said "Subagents 1" beside a metrics card that said none had run — the
 * two halves of one screen contradicting each other, which is the complaint this answers. The split
 * has to come from the server: the rows are PAGED, so this side can label what it holds and cannot
 * recount what it has never seen.
 */
export function subagentCount(state: SubagentsState | null): number | null {
  return state?.phase === 'ready' ? state.agents : null
}

/** How many rows are forks — 0 when there are none, `null` when nothing can be counted. */
export function forkCount(state: SubagentsState | null): number | null {
  return state?.phase === 'ready' ? state.forks : null
}

/**
 * The sentence that keeps the badge and the list from reading as a contradiction.
 *
 * The badge counts agents; the list shows forks too. With no line saying so, a badge reading 3 over
 * four rows is the same "two halves of one screen disagreeing" the count itself was fixed for — so
 * whenever a fork is in the list, the list says what it is holding. Absent when there are none.
 */
export function forkNote(state: SubagentsState | null, pt: boolean): string | null {
  if (state?.phase !== 'ready' || state.forks === 0) return null
  const n = state.forks
  if (pt) {
    return n === 1
      ? 'Um destes é um fork desta conversa, não um subagente: nada o despachou. Ele conta na lista e fora da contagem.'
      : `${n} destes são forks desta conversa, não subagentes: nada os despachou. Contam na lista e fora da contagem.`
  }
  return n === 1
    ? 'One of these is a fork of this conversation, not a subagent: nothing dispatched it. It is in the list and outside the count.'
    : `${n} of these are forks of this conversation, not subagents: nothing dispatched them. They are in the list and outside the count.`
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
