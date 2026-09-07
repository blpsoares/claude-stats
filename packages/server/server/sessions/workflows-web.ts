/**
 * A session's Dynamic Workflow runs, as something HAPPENING.
 *
 * The runs themselves were already readable — that is what the repo-detail page shows — but only
 * ever as history, and `extractWorkflowRuns` reported an unfinished run as `completed` because the
 * absence of a completion report fell through to a literal. So there was nothing to surface live:
 * every run said it was over. `workflow-live.ts` is the state, this is the reader.
 *
 * Two memos, because the two halves change at different times. The LAUNCHES come from the parent
 * transcript and only change when it does; the STATE lives in the agents' own files, which move
 * while the transcript sits still. Keyed on mtime AND size, like every other reader here.
 */
import { HARNESS_CAPABILITIES, workflowTokens, type HarnessId, type TokenBreakdown, type WorkflowRun } from '@agentistics/core'
import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { safeStat } from '../utils'
import { resolveSessionTranscript } from './session-resolve'
import { discoverWorkflowLaunches, assembleWorkflowRuns, type DiscoveredRun } from '../workflow-metrics'
import { aggregateWorkflowAgent } from '../workflow-agent'
import { parseWorkflowProgress } from '../workflow-progress'
import { safeReadDir } from '../utils'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The shape an id from a client must have before it is allowed to name a file. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface WorkflowAgentRow {
  /** The id its transcript is named after — what the detail request asks for. */
  agentId?: string
  label: string
  /** Where the label and phase came from. `record` is exact; `matched` is a prompt-pairing guess;
   *  `none` means the label IS the file name. On screen they look identical, so the view says. */
  labelSource?: 'record' | 'matched' | 'none'
  phase: string
  /** How many tool calls it made. `null` when nothing could count them. */
  toolCalls: number | null
  /** Its transcript ends on an unanswered tool call. Only meaningful while the RUN is live. */
  pending?: boolean
  model: string
  /** The four counters. `null` when the agent has produced none — never a zeroed breakdown. */
  tokens: TokenBreakdown | null
  totalTokens: number | null
  costUSD: number | null
}

export interface WorkflowRunRow {
  runId: string
  name: string
  status: WorkflowRun['status']
  /** True only while the run is one the viewer should expect to change under them. */
  live: boolean
  startedAt: string
  /** How long it ran, or has been running. `null` when nothing can say — never a confident 0. */
  durationMs: number | null
  phases: { title: string; agentCount: number }[]
  agentCount: number
  tokens: TokenBreakdown | null
  totalTokens: number | null
  costUSD: number | null
  agents: WorkflowAgentRow[]
}

export type WorkflowsPayload =
  | { ok: true; supported: true; rows: WorkflowRunRow[]; anyLive: boolean }
  /** This harness runs no Dynamic Workflows at all — a sentence, NOT an empty list. */
  | { ok: true; supported: false; message: string }
  | { ok: false; message: string }

const launchMemo = new Map<string, { mtimeMs: number; size: number; launches: DiscoveredRun[] }>()

/** Tests reach in here; nothing else should. */
export function forgetWorkflowLaunches(): void {
  launchMemo.clear()
}

async function launchesOf(transcript: string): Promise<DiscoveredRun[]> {
  const st = await safeStat(transcript)
  const hit = launchMemo.get(transcript)
  if (hit && st && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.launches
  const content = await readFile(transcript, 'utf-8').catch(() => '')
  const launches = discoverWorkflowLaunches(content.split('\n'))
  if (st) launchMemo.set(transcript, { mtimeMs: st.mtimeMs, size: st.size, launches })
  return launches
}

/** The capability sentence — said in words, never as an empty list. */
function unsupported(harness: string | undefined, lang: CliLang): string {
  const name = harness ?? '?'
  return lang === 'pt'
    ? `${name} não executa Dynamic Workflows, então não há runs para listar aqui — isto é uma ausência de dados, não uma sessão que não rodou nenhuma.`
    : `${name} does not run Dynamic Workflows, so there is nothing to list here — that is missing data, not a session that ran none.`
}

function tokensOf(a: { tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number }): TokenBreakdown | null {
  const t: TokenBreakdown = {
    input: a.tokensIn, output: a.tokensOut,
    cacheRead: a.cacheRead ?? 0, cacheWrite: a.cacheWrite ?? 0,
  }
  return workflowTokens(a) > 0 ? t : null
}

function workflowsDirFor(transcript: string): string {
  return `${transcript.replace(/\.jsonl$/, '')}/subagents/workflows`
}

export async function readSessionWorkflows(
  host: StartHost, lang: CliLang, id: string,
): Promise<WorkflowsPayload> {
  const r = await resolveSessionTranscript(host, lang, id)
  if ('error' in r) return { ok: false, message: r.error }

  const harness = r.row.harness as HarnessId | undefined
  const caps = harness ? HARNESS_CAPABILITIES[harness] : undefined
  // The capability decides, exactly as it does for every metric on the dashboard. A harness that
  // runs no workflows must say so; an empty list would read as "this session ran none".
  if (!caps?.dynamicWorkflows) return { ok: true, supported: false, message: unsupported(harness, lang) }

  const launches = await launchesOf(r.transcript)
  const runs = await assembleWorkflowRuns(launches, id, workflowsDirFor(r.transcript), {
    sessionLive: r.live,
  })

  const rows: WorkflowRunRow[] = runs.map(run => {
    const tokens = tokensOf(run.totals)
    const cost = run.totals.costUSD
    return {
      runId: run.runId,
      name: run.name,
      status: run.status,
      live: run.status === 'running',
      startedAt: run.startedAt,
      // 0 from the reader means "nothing could say", and a duration of zero rendered beside a
      // finished run reads as a measurement. Keep the distinction the type already allows for.
      durationMs: run.durationMs > 0 ? run.durationMs : null,
      phases: run.phases,
      agentCount: run.totals.agentCount,
      tokens,
      totalTokens: tokens ? workflowTokens(run.totals) : null,
      costUSD: cost > 0 ? cost : null,
      agents: run.agents.map(a => {
        const at = tokensOf(a)
        return {
          ...(a.agentId ? { agentId: a.agentId } : {}),
          label: a.label,
          ...(a.labelSource ? { labelSource: a.labelSource } : {}),
          phase: a.phase, model: a.model,
          toolCalls: typeof a.toolCalls === 'number' ? a.toolCalls : null,
          ...(a.pending ? { pending: true } : {}),
          tokens: at,
          totalTokens: at ? workflowTokens(a) : null,
          costUSD: a.costUSD > 0 ? a.costUSD : null,
        }
      }),
    }
  })
  // Newest first: a live view is read from the top, and the run someone is watching is the last
  // one they launched.
  rows.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
  return { ok: true, supported: true, rows, anyLive: rows.some(x => x.live) }
}


export type WorkflowAgentDetail =
  | {
      ok: true
      agentId: string
      label: string
      phase: string
      model: string
      /** The agent's own opening prompt — what it was asked to do. */
      prompt: string
      /** Exact, even when the list below is clipped. */
      toolCalls: number
      tools: Record<string, number>
      commands: string[]
      /** The list was cut at the cap — said, so it never implies the agent stopped there. */
      commandsClipped: boolean
      /** Index, among ALL calls, of the one asked and not yet answered — the live edge. Null when
       *  every call came back. A fact about the file; the view decides whether to call it running. */
      pendingIndex: number | null
    }
  | { ok: false; message: string }

/**
 * ONE agent of one run, opened up: what it was asked, and every command it ran.
 *
 * A separate request on purpose. The LIST reads every agent of every run on every poll, and the
 * commands of a 72-agent run are megabytes of shell — the same reason `subagents-web.ts` splits
 * its list from its activity. The transcript is re-read here with `withCommands`, which costs one
 * file rather than all of them.
 */
export async function readWorkflowAgent(
  host: StartHost, lang: CliLang, id: string, runId: string, agentId: string,
): Promise<WorkflowAgentDetail> {
  const pt = lang === 'pt'
  // An id from a client is never allowed to name a path until it looks like one of ours.
  if (!RUN_ID.test(runId) || !AGENT_ID.test(agentId)) {
    return { ok: false, message: pt ? 'Identificador inválido.' : 'Invalid identifier.' }
  }
  const r = await resolveSessionTranscript(host, lang, id)
  if ('error' in r) return { ok: false, message: r.error }

  const harness = r.row.harness as HarnessId | undefined
  if (!harness || !HARNESS_CAPABILITIES[harness]?.dynamicWorkflows) {
    return { ok: false, message: unsupported(harness, lang) }
  }

  const runDir = join(workflowsDirFor(r.transcript), runId)
  const file = `agent-${agentId}.jsonl`
  const files = await safeReadDir(runDir)
  if (!files.includes(file)) {
    return {
      ok: false,
      message: pt
        ? 'A transcrição deste agente não está mais no disco.'
        : 'This agent’s transcript is no longer on disk.',
    }
  }
  const content = await readFile(join(runDir, file), 'utf-8').catch(() => '')
  const agg = aggregateWorkflowAgent(content.split('\n'), { withCommands: true })
  // The run's own record names it; without one the label is the file's id and the view says so.
  const sessionDir = r.transcript.replace(/\.jsonl$/, '')
  const record = await readFile(join(sessionDir, 'workflows', `${runId}.json`), 'utf-8')
    .then(t => JSON.parse(t) as unknown)
    .catch(() => null)
  const placed = parseWorkflowProgress(record).byAgent.get(agentId)
  return {
    ok: true,
    agentId,
    label: placed?.label ?? agentId,
    phase: placed?.phase ?? '',
    model: agg.model,
    prompt: agg.prompt,
    toolCalls: agg.toolCalls,
    tools: agg.tools,
    commands: agg.commands,
    commandsClipped: agg.commandsClipped,
    pendingIndex: agg.pendingToolIndex,
  }
}
