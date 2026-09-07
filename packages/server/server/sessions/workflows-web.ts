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
import { readFile } from 'node:fs/promises'

export interface WorkflowAgentRow {
  label: string
  phase: string
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
          label: a.label, phase: a.phase, model: a.model,
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
