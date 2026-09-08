/**
 * task-stats.ts — PURE. What a delivery looked like, beyond what it cost.
 *
 * `task-rollup.ts` answers the three headline questions (cost, rounds, sessions). This answers the
 * ones asked next: which models did the work, which harnesses, how many agents ran, and how long
 * the thing actually took in hours and days.
 *
 * The same rule governs all of it: **a distribution counts only what a session actually reported**.
 * A harness that records no model contributes no model row rather than an `unknown` bar, and a
 * delivery that has not been delivered has no duration rather than a duration up to now — "still
 * running" and "took N hours" are different sentences.
 */

import type { SessionMeta } from '@agentistics/core'
import { sessionTokens, type TokenBreakdown } from '@agentistics/core'

export interface Bucket {
  key: string
  sessions: number
  /** Null when no session in the bucket reported tokens at all. */
  tokens: number | null
}

export interface TaskStats {
  /** Ranked, biggest first. Only what was reported. */
  models: Bucket[]
  harnesses: Bucket[]
  /** The four counters, summed. Null when nothing reported any of them. */
  tokens: TokenBreakdown | null
  /** Agent (subagent) invocations across the task's sessions — claude only records these. */
  agentRuns: number | null
  filesModified: number | null
  linesAdded: number | null
  linesRemoved: number | null
  commits: number | null
  toolErrors: number | null
  /**
   * Wall time from the task's creation to its delivery, in ms.
   *
   * Null while it is still open: a duration "so far" put beside a delivered task's duration in a
   * comparison would be read as the same measurement, and it is not.
   */
  deliveryMs: number | null
  /** First and last session activity — what the work actually spanned. */
  firstSessionAt: string | null
  lastSessionAt: string | null
}

function rank(counts: Map<string, { sessions: number; tokens: number | null }>): Bucket[] {
  return [...counts.entries()]
    .map(([key, v]) => ({ key, sessions: v.sessions, tokens: v.tokens }))
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.sessions - a.sessions)
}

function bump(
  m: Map<string, { sessions: number; tokens: number | null }>,
  key: string,
  tokens: number | null,
) {
  const cur = m.get(key) ?? { sessions: 0, tokens: null }
  m.set(key, {
    sessions: cur.sessions + 1,
    // Absent stays absent: a bucket where nothing reported tokens must not read as zero tokens.
    tokens: tokens === null ? cur.tokens : (cur.tokens ?? 0) + tokens,
  })
}

function sumOrNull(values: readonly (number | null | undefined)[]): number | null {
  const real = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return real.length === 0 ? null : real.reduce((a, b) => a + b, 0)
}

export function taskStats(o: {
  metas: readonly SessionMeta[]
  createdAt: string
  deliveredAt?: string
}): TaskStats {
  const models = new Map<string, { sessions: number; tokens: number | null }>()
  const harnesses = new Map<string, { sessions: number; tokens: number | null }>()
  let totals: TokenBreakdown | null = null

  for (const m of o.metas) {
    const reported = m.input_tokens !== undefined || m.output_tokens !== undefined
      || m.cache_read_input_tokens !== undefined || m.cache_creation_input_tokens !== undefined
    const b = reported ? sessionTokens(m) : null
    const total = b === null ? null : b.input + b.output + b.cacheRead + b.cacheWrite

    if (b) {
      totals = totals === null ? { ...b } : {
        input: totals.input + b.input,
        output: totals.output + b.output,
        cacheRead: totals.cacheRead + b.cacheRead,
        cacheWrite: totals.cacheWrite + b.cacheWrite,
      }
    }
    // A session with no model contributes no model row. An `unknown` bar in a ranking is a
    // measurement of our ignorance dressed as a finding about the work.
    if (m.model) bump(models, m.model, total)
    bump(harnesses, m.harness ?? 'claude', total)
  }

  const starts = o.metas.map(m => m.start_time).filter((s): s is string => Boolean(s)).sort()
  const ends = o.metas
    .map(m => m.end_time || m.start_time)
    .filter((s): s is string => Boolean(s))
    .sort()

  const deliveredMs = o.deliveredAt ? Date.parse(o.deliveredAt) : NaN
  const createdMs = Date.parse(o.createdAt)

  return {
    models: rank(models),
    harnesses: rank(harnesses),
    tokens: totals,
    // `totalInvocations`, not the array's length: the array is the per-invocation detail and a
    // session can carry the count with the detail trimmed away.
    agentRuns: sumOrNull(o.metas.map(m => m.agentMetrics?.totalInvocations)),
    filesModified: sumOrNull(o.metas.map(m => m.files_modified)),
    linesAdded: sumOrNull(o.metas.map(m => m.lines_added)),
    linesRemoved: sumOrNull(o.metas.map(m => m.lines_removed)),
    commits: sumOrNull(o.metas.map(m => m.git_commits)),
    toolErrors: sumOrNull(o.metas.map(m => m.tool_errors)),
    deliveryMs: Number.isFinite(deliveredMs) && Number.isFinite(createdMs) && deliveredMs >= createdMs
      ? deliveredMs - createdMs
      : null,
    firstSessionAt: starts[0] ?? null,
    lastSessionAt: ends.at(-1) ?? null,
  }
}
