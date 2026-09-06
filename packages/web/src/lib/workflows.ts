/**
 * workflows.ts — PURE: the rules for the aside's DYNAMIC WORKFLOWS tab.
 *
 * A Dynamic Workflow is a run of many agents that a session launches and then waits on. They were
 * already readable, but only as HISTORY on the repo page — and the reader reported an unfinished
 * run as `completed`, because the absence of a completion report fell through to a literal. So
 * there was never anything to show live: every run claimed to be over. Measured across this
 * machine's 17 runs, 4 carried the wrong status.
 *
 * The rules are here rather than in the JSX because that is what makes them testable, and they are
 * the same three the subagents tab keeps:
 *
 * - **N/A IS NOT ZERO.** Only Claude Code runs Dynamic Workflows at all
 *   (`HARNESS_CAPABILITIES.dynamicWorkflows`), so elsewhere the tab carries no count and says why.
 *   Within a supported session, a run that has spent nothing measurable reports an absence.
 * - **TOKENS MEANS THE FOUR COUNTERS.** The server sums them through `tokens.ts`; a run measured
 *   here read 245 M tokens, almost all of it cache. An in+out reading of that row is a rounding
 *   error of what it cost.
 * - **RUNNING IS WHAT POLLS.** A finished run's numbers cannot change, so nothing polls once
 *   everything has stopped.
 */

/** Mirrors `WorkflowRun['status']` in `@agentistics/core`. */
export type WorkflowStatus = 'running' | 'completed' | 'partial' | 'failed' | 'abandoned' | 'killed'

export interface WorkflowAgentRow {
  label: string
  phase: string
  model: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  totalTokens: number | null
  costUSD: number | null
}

export interface WorkflowRunRow {
  runId: string
  name: string
  status: WorkflowStatus
  live: boolean
  startedAt: string
  durationMs: number | null
  phases: { title: string; agentCount: number }[]
  agentCount: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  totalTokens: number | null
  costUSD: number | null
  agents: WorkflowAgentRow[]
}

export type WorkflowsPayload =
  | { ok: true; supported: true; rows: WorkflowRunRow[]; anyLive: boolean }
  | { ok: true; supported: false; message: string }
  | { ok: false; message: string }

export type WorkflowsState =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: WorkflowRunRow[]; anyLive: boolean }
  | { phase: 'unsupported'; message: string }
  | { phase: 'failed'; message: string }

export function workflowsStateOf(payload: WorkflowsPayload): WorkflowsState {
  if (!payload.ok) return { phase: 'failed', message: payload.message }
  if (!payload.supported) return { phase: 'unsupported', message: payload.message }
  return { phase: 'ready', rows: payload.rows, anyLive: payload.anyLive }
}

/**
 * The count on the tab, or `null` for "this cannot be counted here".
 *
 * `null` is what stops the tab reading `0` on a harness that runs no workflows at all — the same
 * N/A-versus-a-confident-0 rule the dashboard applies to every capability-gated metric.
 */
export function workflowCount(state: WorkflowsState | null): number | null {
  return state?.phase === 'ready' ? state.rows.length : null
}

/** How many are running right now — the number worth a dot on the tab. */
export function liveRunCount(state: WorkflowsState | null): number {
  return state?.phase === 'ready' ? state.rows.filter(r => r.live).length : 0
}

export const WORKFLOW_POLL_MS = 5000

/** The list re-reads only while something can still change. */
export function workflowsPollMs(state: WorkflowsState | null): number | null {
  return liveRunCount(state) > 0 ? WORKFLOW_POLL_MS : null
}

/** The status word, and the colour it is said in. Never a glyph alone. */
export function runStatusText(s: WorkflowStatus, pt: boolean): { text: string; color: string } {
  switch (s) {
    case 'running': return { text: pt ? 'rodando' : 'running', color: '#22c55e' }
    case 'completed': return { text: pt ? 'concluiu' : 'completed', color: 'var(--text-tertiary)' }
    // Some agents finished and some errored. Folding it into either would drop half the outcome.
    case 'partial': return { text: pt ? 'parcial' : 'partial', color: '#f59e0b' }
    case 'failed': return { text: pt ? 'falhou' : 'failed', color: '#ef4444' }
    // Somebody stopped it — the run's own record says so, and nothing else could have.
    case 'killed': return { text: pt ? 'interrompida' : 'killed', color: '#f59e0b' }
    // It launched and stopped reporting. NOT a completion: this is the state that used to be
    // published as `completed`, which is the whole reason this module exists.
    case 'abandoned': return { text: pt ? 'sem desfecho' : 'no outcome', color: '#f59e0b' }
  }
}

/** One sentence explaining a status a reader cannot be expected to infer. */
export function runStatusNote(s: WorkflowStatus, pt: boolean): string | null {
  if (s === 'abandoned') {
    return pt
      ? 'a run foi lançada e parou de dar sinal — não há registro de como terminou'
      : 'the run was launched and stopped reporting — there is no record of how it ended'
  }
  if (s === 'partial') {
    return pt ? 'parte dos agentes falhou' : 'some of its agents failed'
  }
  return null
}

/**
 * How long it ran, or has been running.
 *
 * `null` means nothing could say, and it is rendered as an absence rather than `0s` — a duration of
 * zero beside a run that plainly did work reads as a measurement.
 */
export function runDurationText(ms: number | null, live: boolean, pt: boolean): string | null {
  if (ms === null) return null
  const s = Math.round(ms / 1000)
  const body = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  if (!live) return body
  return pt ? `há ${body}` : `${body} so far`
}

/**
 * The sentence for a run whose numbers do not exist.
 *
 * Returned instead of a figure, never beside a zero: "it has not spent anything yet" and "nothing
 * was captured" are different facts and only one of them is ever true.
 */
export function unmeasuredRunText(row: WorkflowRunRow, pt: boolean): string | null {
  if (row.totalTokens !== null) return null
  return row.live
    ? (pt ? 'ainda não gastou nada mensurável' : 'nothing measurable spent yet')
    : (pt ? 'sem transcrições para medir' : 'no transcripts to measure')
}
