/**
 * What state a Dynamic Workflow run is ACTUALLY in.
 *
 * `extractWorkflowRuns` used to decide this with `usage ? … : 'completed'`. The `<usage>` block
 * only exists once the run has reported back, so a workflow still in flight — which by definition
 * has not reported — fell through to the literal `'completed'`. Measured on a synthesised launch
 * with no completion notification: `status=completed duration=0ms`, for a run that had not
 * finished anything. That is why workflows never appeared as something HAPPENING: the reader had
 * no state to report them in, so it reported them as over.
 *
 * The evidence available, and what each part of it can honestly settle:
 *
 * - The completion `<usage>` block. Present = the run reported back, and its own arithmetic
 *   (errors vs done) decides completed / partial / failed. That arithmetic is preserved here
 *   EXACTLY as it was, so a finished run keeps the status it has always had.
 * - Whether the owning SESSION is alive. A workflow is a background task of one session; when
 *   that process is gone the run cannot be running, whatever the files look like. This mirrors
 *   `subagentStatus`, which takes the same signal for the same reason. It is deliberately
 *   THREE-valued: a caller that cannot see processes says so, and movement decides instead.
 * - MOVEMENT. A run writes its agents' transcripts as they work, so the newest write is the
 *   floor under "still going". The LAUNCH timestamp counts too: a run started ten seconds ago
 *   has no transcripts yet and is not therefore dead.
 *
 * There is deliberately no fourth rule guessing at the rest. A launched run that stopped moving
 * with the session still up is `abandoned` — SAID, not folded into `completed`. Measured on this
 * machine: of 18 runs on disk, one had no tombstone and had last been touched 630 hours earlier.
 * Reporting that as `running` would be the confident-zero this repo refuses; reporting it as
 * `completed` is what the old reader did, and it is the same lie in the other direction.
 */

/** How long a launched run may go without a write before it stops counting as running.
 *  Generous on purpose: the cost of being early is a live run labelled `abandoned` while its
 *  agents are plainly still listed under it, which reads as a fault in the reader. The cost of
 *  being late is a dead run showing `running` for a few minutes, which the next poll corrects. */
export const RUN_STALE_MS = 5 * 60_000

export interface WorkflowUsageCounts {
  agentsError: number
  agentsDone: number
}

export interface RunEvidence {
  /** The status the run recorded for ITSELF, from `<session>/workflows/<runId>.json`. Written only
   *  once the run is over, and it is the run's own account of how it ended — the one thing here
   *  that is a record rather than an inference, so it outranks everything below. It is also the
   *  only source that can say `killed`: a killed run reported no usage, and inferring from files
   *  alone it is indistinguishable from one that simply stopped. Null when absent or unrecognised;
   *  an unrecognised word is never passed through, or a future status would leak into the type. */
  recorded: WorkflowRunState | null
  /** Parsed from the completion notification; null while the run has not reported back. */
  usage: WorkflowUsageCounts | null
  /** Is the session that launched this run still alive? `'unknown'` is a real answer, not a
   *  default: the dashboard's data build has no process view, and turning "we did not look" into
   *  "the session is gone" would report every genuinely running workflow as abandoned. Only a
   *  measured `false` settles it; otherwise movement decides. */
  sessionLive: boolean | 'unknown'
  /** mtime of the newest per-agent transcript in the run dir; 0 when the run has none yet. */
  lastTouchedMs: number
  /** When the run was launched; the floor under freshness before any agent has written. */
  launchedMs: number
  now: number
}

export type WorkflowRunState = 'running' | 'completed' | 'partial' | 'failed' | 'abandoned' | 'killed'

/** The words a run's own record may use, mapped to the states above. Anything else is not
 *  translated into a guess — it returns null and the inference rules decide. */
export function recordedRunState(raw: unknown): WorkflowRunState | null {
  return raw === 'completed' || raw === 'failed' || raw === 'killed' || raw === 'partial'
    ? raw
    : null
}

/** True while the run is one a viewer should expect to change under them. */
export function workflowRunLive(state: WorkflowRunState): boolean {
  return state === 'running'
}

export function workflowRunState(e: RunEvidence): WorkflowRunState {
  // The run's own record of how it ended. A fact, not an inference, so nothing below may override
  // it — and it is what turns a `killed` run from a guess into the word the run itself used.
  if (e.recorded) return e.recorded
  // The run reported back. Its own counts decide, exactly as they always have.
  if (e.usage) {
    if (e.usage.agentsError > 0) return e.usage.agentsDone > 0 ? 'partial' : 'failed'
    return 'completed'
  }
  // No report. Nothing that follows may return 'completed' — that is the bug this module exists
  // to have fixed, and an unfinished run has produced no evidence that it finished.
  if (e.sessionLive === false) return 'abandoned'
  const moved = Math.max(e.lastTouchedMs, e.launchedMs)
  if (moved <= 0) return 'abandoned'
  // A clock a little ahead of ours yields a negative age, which is still fresh.
  return e.now - moved <= RUN_STALE_MS ? 'running' : 'abandoned'
}
