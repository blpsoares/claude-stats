import { join, dirname } from 'path'
import { readFile } from 'fs/promises'
import type { WorkflowRun, WorkflowAgent } from '@agentistics/core'
import { safeReadDir, safeStat } from './utils'
import { parseWorkflowScript } from './workflow-script'
import { parseWorkflowUsage } from './workflow-usage'
import { aggregateWorkflowAgent } from './workflow-agent'
import { matchTranscriptsToCalls } from './workflow-match'
import { workflowRunState, recordedRunState } from './workflow-live'
import { parseWorkflowProgress, agentIdOfFile } from './workflow-progress'

export interface DiscoveredRun {
  runId: string
  name: string
  scriptPath?: string
  startedAt: string
  notificationText: string
}


/**
 * One agent transcript's aggregate, memoized on the file's own mtime + size.
 *
 * A run here holds 72 agent transcripts; without this, every read of a run re-parsed all of them,
 * and the live view polls. A FINISHED agent's transcript never changes, so it is parsed once and
 * only the ones still writing are parsed again. Key is mtime AND size because an append can move
 * either alone. Same rule, and the same reason, as `summaryMemo` in subagents-web.ts.
 */
const agentMemo = new Map<string, { mtimeMs: number; size: number; agg: ReturnType<typeof aggregateWorkflowAgent> }>()

/** Tests reach in here; nothing else should. */
export function forgetWorkflowAgentSummaries(): void {
  agentMemo.clear()
}


/** A run's own end-of-run record, or null when it never wrote one (still running, or lost).
 *  The WHOLE document is returned: besides the status it carries `workflowProgress`, which places
 *  every agent in its phase exactly — see workflow-progress.ts. */
async function readRunRecord(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(path, 'utf-8').catch(() => '')
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as unknown
    return d && typeof d === 'object' ? d as Record<string, unknown> : null
  } catch { return null }
}

/** Scan the main session JSONL for workflow launches and their task-notifications. */
export function discoverWorkflowLaunches(lines: string[]): DiscoveredRun[] {
  const byRunId = new Map<string, DiscoveredRun>()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }

    // Launch: user message envelope with toolUseResult.taskType === 'local_workflow'
    const tur = e.toolUseResult as Record<string, unknown> | undefined
    if (tur && tur.taskType === 'local_workflow' && typeof tur.runId === 'string') {
      byRunId.set(tur.runId, {
        runId: tur.runId,
        name: (tur.workflowName as string) ?? '',
        scriptPath: tur.scriptPath as string | undefined,
        startedAt: (e.timestamp as string) ?? '',
        notificationText: '',
      })
    }

    // NOTE: when a session launches >=2 workflows concurrently and a
    // task-notification lacks a parseable runId, we cannot safely attribute it,
    // so its usage is left empty for that run. Single-workflow sessions use the
    // unambiguous fallback below. This is an accepted limitation (rare case).
    // Completion notification: a message whose text contains <task-notification> with a runId.
    const text = extractText(e)
    if (text && text.includes('<task-notification>')) {
      const runId = text.match(/<run-?id>\s*([^<\s]+)\s*<\/run-?id>/)?.[1]
        ?? text.match(/runId["']?\s*[:=]\s*["']?(wf_[a-z0-9-]+)/i)?.[1]
      if (runId && byRunId.has(runId)) byRunId.get(runId)!.notificationText = text
      else if (!runId && byRunId.size === 1) {
        // Single workflow in the session — attach unambiguously.
        const only = [...byRunId.values()][0]!
        only.notificationText = text
      }
    }
  }
  return [...byRunId.values()]
}

/** Sort agent-<n>.jsonl files by their numeric index so agent-2 precedes agent-10.
 *  Files without a parseable index sort last, stably, by name. */
export function sortAgentFiles(files: string[]): string[] {
  const idx = (f: string): number => {
    const m = f.match(/agent-(\d+)/)
    return m ? parseInt(m[1]!, 10) : Number.POSITIVE_INFINITY
  }
  return [...files].sort((a, b) => {
    const d = idx(a) - idx(b)
    return d !== 0 ? d : a.localeCompare(b)
  })
}

function extractText(e: Record<string, unknown>): string {
  const msg = e.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(c => {
      const item = c as Record<string, unknown>
      return typeof item.text === 'string' ? item.text : (typeof item.content === 'string' ? item.content : '')
    }).join('\n')
  }
  return ''
}

/** Assemble WorkflowRun[] for a session given its main JSONL lines and the workflows dir. */
export interface WorkflowRunsOptions {
  /** Whether the session that owns these runs is alive. `'unknown'` when the caller cannot see
   *  processes — the dashboard's data build cannot, and must not therefore call a live run dead. */
  sessionLive?: boolean | 'unknown'
  now?: number
}

export async function extractWorkflowRuns(
  sessionLines: string[],
  sessionId: string,
  workflowsDir: string,
  opts: WorkflowRunsOptions = {},
): Promise<WorkflowRun[]> {
  return assembleWorkflowRuns(discoverWorkflowLaunches(sessionLines), sessionId, workflowsDir, opts)
}

/**
 * The assembly half, given launches already discovered.
 *
 * Split out because DISCOVERY costs a full read of the parent transcript (39 MB on a real one
 * here) and only changes when that file changes, while ASSEMBLY must run on every poll — a run's
 * state lives in its agents' files, which move while the transcript sits still. The live reader
 * memoizes the launches on the transcript's stamp and calls this each time.
 */
export async function assembleWorkflowRuns(
  launches: DiscoveredRun[],
  sessionId: string,
  workflowsDir: string,
  opts: WorkflowRunsOptions = {},
): Promise<WorkflowRun[]> {
  const sessionLive = opts.sessionLive ?? 'unknown'
  const now = opts.now ?? Date.now()
  const runs: WorkflowRun[] = []

  for (const launch of launches) {
    const runDir = join(workflowsDir, launch.runId)
    const files = await safeReadDir(runDir)

    // Script: prefer scriptPath, else a *.js inside scripts/ or the runDir.
    let scriptText = ''
    if (launch.scriptPath) scriptText = await readFile(launch.scriptPath, 'utf-8').catch(() => '')
    if (!scriptText) {
      const scriptsDir = join(workflowsDir, 'scripts')
      const scriptFiles = (await safeReadDir(scriptsDir)).filter(f => f.includes(launch.runId) && f.endsWith('.js'))
      if (scriptFiles[0]) scriptText = await readFile(join(scriptsDir, scriptFiles[0]), 'utf-8').catch(() => '')
    }
    const parsed = parseWorkflowScript(scriptText)

    const launchedMs = launch.startedAt ? Date.parse(launch.startedAt) || 0 : 0
    // The run's own record, written when it ended: `<session>/workflows/<runId>.json`, a sibling
    // of the `subagents/workflows` dir holding the transcripts. It is the only source that can say
    // a run was KILLED — from the files alone that is indistinguishable from one that stopped —
    // and it also places every agent in its phase exactly.
    const record = await readRunRecord(join(dirname(dirname(workflowsDir)), 'workflows', `${launch.runId}.json`))

    // Per-agent transcripts: agent-*.jsonl in the run dir.
    const agentFiles = sortAgentFiles(files.filter(f => /^agent-.*\.jsonl$/.test(f)))
    const aggregated = []
    // The newest write under the run dir is the floor under "still going" — a run reports nothing
    // while it works, so movement is the only live signal it emits.
    let lastTouchedMs = 0
    for (const file of agentFiles) {
      const full = join(runDir, file)
      const st = await safeStat(full)
      if (st) lastTouchedMs = Math.max(lastTouchedMs, st.mtimeMs)
      const hit = st ? agentMemo.get(full) : undefined
      if (hit && st && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        aggregated.push({ file, ...hit.agg })
        continue
      }
      const content = await readFile(full, 'utf-8').catch(() => '')
      const agg = aggregateWorkflowAgent(content.split('\n'))
      if (st) agentMemo.set(full, { mtimeMs: st.mtimeMs, size: st.size, agg })
      aggregated.push({ file, ...agg })
    }
    // Pair each transcript with the `agent()` call that produced it BY PROMPT. The files are named
    // agent-<hash>.jsonl: the hash carries no order, so pairing by position (the old behaviour)
    // handed every agent a label belonging to some other agent — labels and metrics from different
    // runs of the workflow, rendered as if they matched. See workflow-match.ts.
    // The run's OWN placement first: `workflowProgress` names each agentId's label and phase
    // outright (100 % of the 340 transcripts on one machine). `matchTranscriptsToCalls` stays as
    // the fallback for a run that has not written a record yet — and for one whose record predates
    // this field. A guessed label and a recorded one look identical on screen, so which it was
    // travels with it as `labelSource`.
    const progress = parseWorkflowProgress(record)
    const matched = matchTranscriptsToCalls(aggregated, parsed.agents)
    // Chronological, because that is the order the user watched them run in.
    const order = aggregated
      .map((a, i) => ({ a, meta: matched[i] }))
      .sort((x, y) => (x.a.startedAt || '').localeCompare(y.a.startedAt || '') || x.a.file.localeCompare(y.a.file))

    const agents: WorkflowAgent[] = []
    for (const { a: agg, meta } of order) {
      const agentId = agentIdOfFile(agg.file)
      const placed = agentId ? progress.byAgent.get(agentId) : undefined
      const labelSource: NonNullable<WorkflowAgent['labelSource']> =
        placed ? 'record' : meta?.label ? 'matched' : 'none'
      agents.push({
        label: placed?.label || meta?.label || agg.file.replace(/\.jsonl$/, ''),
        phase: placed?.phase ?? meta?.phase ?? '',
        ...(agentId ? { agentId } : {}),
        labelSource,
        toolCalls: agg.toolCalls,
        model: agg.model || (meta?.model ?? ''),
        // NOTE: per-agent status is a best-effort 'completed'. The available data
        // (journal.jsonl + the task-notification <usage> counts) reports how many
        // agents errored/were skipped, but not WHICH agent — so a specific agent's
        // failure cannot be reliably attributed here. Top-level run status still
        // reflects errors via parseWorkflowUsage.
        status: 'completed',
        tokensIn: agg.tokensIn, tokensOut: agg.tokensOut,
        cacheRead: agg.cacheRead, cacheWrite: agg.cacheWrite,
        costUSD: agg.costUSD,
      })
    }

    const usage = parseWorkflowUsage(launch.notificationText)
    // The phase list, in the order the run recorded them — the order somebody watched them run in.
    // The script's declared list is the fallback for a run with no record. Any phase that agents
    // actually landed in is kept even if neither source named it, or its agents would have nowhere
    // to be counted.
    const phaseTitles = progress.phases.length > 0 ? [...progress.phases] : [...parsed.phases]
    for (const a of agents) if (a.phase !== '' && !phaseTitles.includes(a.phase)) phaseTitles.push(a.phase)
    const phases = phaseTitles.map(title => ({ title, agentCount: agents.filter(a => a.phase === title).length }))
    const status: WorkflowRun['status'] = workflowRunState({
      recorded: recordedRunState(record?.status), usage, sessionLive, lastTouchedMs, launchedMs, now,
    })

    runs.push({
      runId: launch.runId,
      name: parsed.name || launch.name || launch.runId,
      sessionId,
      status,
      startedAt: launch.startedAt,
      // A run in flight has no final duration, but the time it has been going IS measurable and is
      // the thing a viewer is watching. Everything else keeps the reported duration (0 = unknown).
      durationMs: status === 'running' && launchedMs
        ? Math.max(0, now - launchedMs)
        : (usage?.durationMs ?? (typeof record?.durationMs === 'number' ? record.durationMs : 0)),
      phases,
      agents,
      totals: {
        // The real agent transcripts are the source of truth; the <usage> count can be
        // missing/0 for some runs, so never let it under-report the agents we actually found.
        agentCount: Math.max(agents.length, usage?.agentCount ?? 0),
        tokensIn: agents.reduce((s, a) => s + a.tokensIn, 0),
        tokensOut: agents.reduce((s, a) => s + a.tokensOut, 0),
        cacheRead: agents.reduce((s, a) => s + a.cacheRead, 0),
        cacheWrite: agents.reduce((s, a) => s + a.cacheWrite, 0),
        costUSD: agents.reduce((s, a) => s + a.costUSD, 0),
        durationMs: usage?.durationMs ?? 0,
        toolUses: usage?.toolUses ?? 0,
      },
    })
  }
  // Drop empty runs: a workflow whose per-agent transcripts are missing (never captured, or
  // cleaned) yields only the declared phase skeleton with zero agents — no tokens, no cost,
  // "nothing ran" everywhere. These carry no information, so don't surface them.
  // A RUNNING run is the exception: one that launched seconds ago has no agent transcripts yet,
  // and "it has started" is precisely the information the live view exists to show. Hiding it
  // would make a workflow appear only once it was already well under way.
  return runs.filter(r => r.agents.length > 0 || r.status === 'running')
}
