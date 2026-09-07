/**
 * A workflow run's OWN record of which agent belonged to which phase.
 *
 * `workflow-match.ts` exists because the per-agent transcripts are named `agent-<hash>.jsonl` and
 * the hash carries no order, so pairing them with the script's `agent()` calls by position handed
 * every agent a label belonging to some other one. It solves that by matching PROMPTS, and it is
 * deliberately conservative: no match yields the file name and no phase.
 *
 * It turns out the run writes the pairing down. `<session>/workflows/<runId>.json` carries a
 * `workflowProgress` array whose `workflow_agent` entries name the `agentId`, its `label` and its
 * `phaseTitle` outright. Measured across this machine: **340 agent transcripts, 340 with an exact
 * entry — 100 %**. The heuristic was approximating something already recorded, and on at least one
 * real run it approximated it to nothing: 12 agents that all rendered as `agent-<hash>` with no
 * phase, while the record beside them said `contract:fleet-first-data · Contract`.
 *
 * So this is preferred wherever it exists, and `matchTranscriptsToCalls` stays as the fallback for
 * the case that has no record at all — a run still going, which has not written one yet.
 *
 * The PHASE ORDER comes from the same array's `workflow_phase` entries, in their recorded order,
 * because the order phases ran in is the order somebody watched them run in.
 */

export interface AgentPlacement {
  label: string
  phase: string
}

export interface WorkflowProgress {
  /** Phase titles in the order the run declared them. Empty when the record carries none. */
  phases: string[]
  /** agentId → where it belongs. Empty when the record carries no agent entries. */
  byAgent: Map<string, AgentPlacement>
}

const EMPTY: WorkflowProgress = { phases: [], byAgent: new Map() }

/** Reads the `workflowProgress` array off a run record. Total: anything unexpected yields empty,
 *  and empty means the caller falls back to the heuristic rather than showing nothing. */
export function parseWorkflowProgress(record: unknown): WorkflowProgress {
  if (!record || typeof record !== 'object') return EMPTY
  const raw = (record as Record<string, unknown>).workflowProgress
  if (!Array.isArray(raw)) return EMPTY
  const phases: string[] = []
  const byAgent = new Map<string, AgentPlacement>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (e.type === 'workflow_phase') {
      const title = typeof e.title === 'string' ? e.title : ''
      // A phase declared twice is one phase; the recorded order is kept.
      if (title !== '' && !phases.includes(title)) phases.push(title)
      continue
    }
    if (e.type !== 'workflow_agent') continue
    const agentId = typeof e.agentId === 'string' ? e.agentId : ''
    if (agentId === '') continue
    const label = typeof e.label === 'string' ? e.label : ''
    const phase = typeof e.phaseTitle === 'string' ? e.phaseTitle : ''
    // A label is the whole point of the entry — an entry without one settles nothing that the
    // file name does not already say, so it is not recorded as a placement.
    if (label === '') continue
    byAgent.set(agentId, { label, phase })
    // A phase named only by an agent entry still ran; keep it, after the declared ones.
    if (phase !== '' && !phases.includes(phase)) phases.push(phase)
  }
  return { phases, byAgent }
}

/** `agent-<id>.jsonl` → `<id>`, the key `workflowProgress` uses. Null when the name is not one. */
export function agentIdOfFile(file: string): string | null {
  const m = file.match(/^agent-([A-Za-z0-9_-]+)\.jsonl$/)
  return m ? m[1]! : null
}
