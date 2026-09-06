/**
 * subagent-metrics.ts — the I/O half: find each subagent's own transcript and read it.
 *
 * Claude Code made the `Agent` tool asynchronous on 2026-08-14. The parent's `toolUseResult` stopped
 * carrying the agent's numbers and now names it instead — `agentId` — while the numbers moved into
 * `<project>/<session-id>/subagents/agent-<agentId>.jsonl`. `agent-metrics.ts` marks those
 * invocations UNMEASURED; this module is what makes almost all of them measured again (on the
 * machine this was written against: 440 of 442 async invocations had their transcript on disk).
 *
 * **The `outputFile` the result also names is deliberately NOT used.** It points into the run's
 * scratch directory under `/tmp`, which is cleared on reboot and by the OS — it is the agent's text
 * answer, not its accounting, and it was already gone for every invocation measured here. The
 * durable file is the one this module opens.
 *
 * What cannot be found stays unmeasured. A transcript deleted by Claude's own 30-day cleanup is a
 * fact nobody can recover, and reporting it as zero would be the very defect this fixes.
 */

import { readFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import type { AgentInvocation, SessionAgentMetrics } from '@agentistics/core'
import { agentNumbers, summarizeSubagentTranscript, totalsOf, type SubagentSummary } from './subagent-parse'

/**
 * Parsed subagent transcripts, keyed by path + mtime + size.
 *
 * A finished subagent's transcript never changes, and the data walk runs on a 30s cache over a
 * machine that can hold hundreds of them — re-parsing half a megabyte per invocation per build is
 * the storm `git.ts` had to be rescued from. The key carries mtime and size so a transcript still
 * being written is re-read rather than frozen at its first reading.
 */
const CACHE = new Map<string, SubagentSummary>()

async function summaryFor(file: string): Promise<SubagentSummary | null> {
  let key: string
  try {
    const st = await stat(file)
    key = `${file}\0${st.mtimeMs}\0${st.size}`
  } catch {
    return null
  }
  const hit = CACHE.get(key)
  if (hit) return hit

  let content: string
  try { content = await readFile(file, 'utf-8') } catch { return null }

  const summary = summarizeSubagentTranscript(content.split('\n'))
  CACHE.set(key, summary)
  return summary
}

/** Every summary under one agent, the agent itself excluded. Cycle-safe by construction. */
async function descendantsOf(
  dir: string,
  root: SubagentSummary,
  seen: Set<string>,
): Promise<SubagentSummary[]> {
  const out: SubagentSummary[] = []
  const queue = [...root.childAgentIds]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const summary = await summaryFor(join(dir, `agent-${id}.jsonl`))
    if (!summary) continue
    out.push(summary)
    queue.push(...summary.childAgentIds)
  }
  return out
}

/**
 * Fill in every UNMEASURED invocation that names a transcript this machine still has.
 *
 * Total: a session with no `subagents/` directory, an unreadable file or an invocation with no
 * `agentId` comes back exactly as it went in.
 */
export async function enrichFromSubagentTranscripts(
  metrics: SessionAgentMetrics,
  transcriptPath: string,
  sessionId: string,
): Promise<SessionAgentMetrics> {
  if (!metrics.invocations.some(i => i.unmeasured && i.agentId)) return metrics

  const dir = join(dirname(transcriptPath), sessionId, 'subagents')
  const invocations: AgentInvocation[] = []
  let changed = false

  for (const inv of metrics.invocations) {
    if (!inv.unmeasured || !inv.agentId) { invocations.push(inv); continue }

    const root = await summaryFor(join(dir, `agent-${inv.agentId}.jsonl`))
    if (!root) { invocations.push(inv); continue }

    const descendants = await descendantsOf(dir, root, new Set([inv.agentId]))
    const { unmeasured: _dropped, ...rest } = inv
    invocations.push({ ...rest, ...agentNumbers(root, descendants) })
    changed = true
  }

  return changed ? totalsOf(invocations) : metrics
}
