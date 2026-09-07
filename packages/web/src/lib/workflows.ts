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
  agentId?: string
  label: string
  /** Where the label and phase came from — `record` is the run's own, and exact. */
  labelSource?: 'record' | 'matched' | 'none'
  phase: string
  toolCalls: number | null
  /** Its transcript ends on an unanswered tool call. Only meaningful while the RUN is live. */
  pending?: boolean
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


/** One phase, and the agents that ran in it. */
export interface PhaseGroup {
  /** `''` is the group for agents no source could place — rendered in words, never as a blank. */
  title: string
  agents: WorkflowAgentRow[]
}

/**
 * A run's agents, grouped under the phase each ran in.
 *
 * A flat list of `contract:fleet-first-data`, `critique:fleet-first-data`, … is the run's shape
 * flattened away: the phases ARE the plan, and which agent ran in which is the thing somebody
 * opens a run to see. The order is the run's own recorded phase order, because that is the order
 * they ran in.
 *
 * **No agent is ever dropped.** One the sources could not place lands in a final `''` group, which
 * the view names in words — silently omitting it would make the phase counts disagree with the
 * agent count on the card above them.
 */
export function groupAgentsByPhase(run: WorkflowRunRow): PhaseGroup[] {
  const groups: PhaseGroup[] = []
  const index = new Map<string, PhaseGroup>()
  // Declared phases first, in their recorded order — an EMPTY phase is still a phase that was
  // planned, and saying it ran nothing is information.
  for (const p of run.phases) {
    if (index.has(p.title)) continue
    const g: PhaseGroup = { title: p.title, agents: [] }
    index.set(p.title, g)
    groups.push(g)
  }
  const unplaced: WorkflowAgentRow[] = []
  for (const a of run.agents) {
    if (a.phase === '') { unplaced.push(a); continue }
    let g = index.get(a.phase)
    if (!g) { g = { title: a.phase, agents: [] }; index.set(a.phase, g); groups.push(g) }
    g.agents.push(a)
  }
  if (unplaced.length > 0) groups.push({ title: '', agents: unplaced })
  return groups
}

/** The sentence for the group holding agents nothing could place. */
export function unplacedPhaseText(pt: boolean): string {
  return pt ? 'sem fase registrada' : 'no phase recorded'
}

/**
 * Whether a label is the run's own word for this agent, or a guess.
 *
 * They look identical on screen and only one is worth trusting: `matched` is `workflow-match.ts`
 * pairing transcripts to `agent()` calls by prompt, and `none` means the label IS the file name.
 * Returns null for `record`, which needs no caveat.
 */
export function labelCaveat(a: WorkflowAgentRow, pt: boolean): string | null {
  if (a.labelSource === 'matched') {
    return pt ? 'nome deduzido pelo prompt' : 'name inferred from the prompt'
  }
  if (a.labelSource === 'none') {
    return pt ? 'a run não registrou o nome deste agente' : 'the run did not record this agent’s name'
  }
  return null
}

// --- one agent, opened up ---------------------------------------------------

export type WorkflowAgentDetail =
  | {
      ok: true; agentId: string; label: string; phase: string; model: string; prompt: string
      toolCalls: number; tools: Record<string, number>; commands: string[]; commandsClipped: boolean
      pendingIndex: number | null
    }
  | { ok: false; message: string }

export type AgentDetailState =
  | { phase: 'loading' }
  | { phase: 'ready'; detail: Extract<WorkflowAgentDetail, { ok: true }> }
  | { phase: 'failed'; message: string }

export function agentDetailStateOf(payload: WorkflowAgentDetail): AgentDetailState {
  return payload.ok ? { phase: 'ready', detail: payload } : { phase: 'failed', message: payload.message }
}

export function agentDetailUrl(sessionId: string, runId: string, agentId: string, pt: boolean): string {
  return `/api/fleet/workflows?id=${encodeURIComponent(sessionId)}&run=${encodeURIComponent(runId)}&agent=${encodeURIComponent(agentId)}&lang=${pt ? 'pt' : 'en'}`
}

/** An agent whose transcript is gone cannot be opened; the row must not offer it. */
export function agentOpenable(a: WorkflowAgentRow): boolean {
  return typeof a.agentId === 'string' && a.agentId !== ''
}


// --- following a run while it happens ---------------------------------------

/**
 * Is this agent the one doing something RIGHT NOW?
 *
 * `pending` says its transcript ends on a tool call nobody answered — true of an agent that is
 * working AND of one whose run was killed mid-call, which leaves exactly the same file behind. So
 * the run's own liveness is required as well: a finished run has no live edge, whatever its
 * transcripts look like, and pulsing a line inside it would announce work that stopped hours ago.
 */
export function agentIsRunning(agent: WorkflowAgentRow, runLive: boolean): boolean {
  return runLive && agent.pending === true
}

/**
 * Which command line to highlight, or null for none.
 *
 * Null whenever the answer would be a guess: the run is not live, nothing is pending, or the live
 * edge is past the end of a clipped list — in that last case the line exists but is not on screen,
 * and highlighting the last visible one instead would point at the wrong command.
 */
export function runningCommandIndex(
  pendingIndex: number | null, commandCount: number, runLive: boolean,
): number | null {
  if (!runLive || pendingIndex === null) return null
  return pendingIndex >= 0 && pendingIndex < commandCount ? pendingIndex : null
}

/**
 * Does this run open by itself?
 *
 * A live run is one somebody is WATCHING — the whole reason the tab polls — so it opens without a
 * click. A finished one does not: the list would then be several expanded runs deep and the newest
 * would be off screen.
 */
export function runOpensByDefault(row: WorkflowRunRow): boolean {
  return row.live
}

/** The agent that opens by itself inside an open live run: the one actually working. */
export function agentOpensByDefault(agent: WorkflowAgentRow, runLive: boolean): boolean {
  return agentIsRunning(agent, runLive) && agentOpenable(agent)
}


/**
 * Could ANY agent be placed in a phase?
 *
 * False is the live case. A run's exact placement is written when it ENDS, and while it is going
 * the only fallback is `workflow-match.ts` pairing transcripts to `agent()` calls by prompt, which
 * is deliberately conservative and often matches nothing.
 *
 * It matters for the drawing. Grouping under phase headings when nothing is placed renders every
 * declared phase as "nothing ran" beside a pile of agents that plainly ARE running — three false
 * impressions from two true facts. When this is false the view should state the declared phases as
 * the PLAN and list the agents under it, which says both facts and implies neither.
 */
export function placementKnown(run: WorkflowRunRow): boolean {
  return run.agents.some(a => a.phase !== '')
}

/** The declared phases, as one line — what the run set out to do, when where each agent landed is
 *  not yet knowable. Empty when the script declared none. */
export function declaredPhases(run: WorkflowRunRow): string[] {
  return run.phases.map(p => p.title).filter(t => t !== '')
}
