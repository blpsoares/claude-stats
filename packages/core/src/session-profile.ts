/**
 * session-profile.ts — PURE. What this machine's sessions USUALLY look like.
 *
 * The baselines a suggestion is read against. `2 compacts` is a threshold somebody invented;
 * `2 compacts — 6 of your 700 sessions ever reached that` is a measurement, and only the second
 * earns a card. See docs/superpowers/specs/2026-09-08-session-suggestions-design.md.
 *
 * Pure and total: it receives `now` rather than reading a clock, so a test can place a session on
 * either side of the window without touching the machine's time.
 */
import { sessionTokens, totalTokens } from './tokens'
import type { SessionMeta } from './types'

/**
 * `costUSD` is deliberately ABSENT. Cost is not a field on `SessionMeta` — it is computed by
 * `calcCost` from the model and the four counters — and reaching for it here would make this pure
 * module depend on the pricing table. The suggestions plan adds it there if it needs it.
 */
export type ProfileMetric =
  | 'compacts' | 'messages' | 'activeMinutes' | 'tokens'
  | 'toolErrors' | 'skills' | 'mcpServers' | 'subagents'

export interface MetricBaseline {
  /** What a typical session looks like. The headline, because these distributions are skewed. */
  median: number
  /** Kept beside it because a rate question ("compacts per session") legitimately wants it. */
  mean: number
  /** How many sessions in the window could have carried THIS metric — see below. */
  n: number
  /** Of those, how many were above zero. The only honest denominator for a rare event. */
  nonZero: number
}

export interface Baseline {
  windowDays: number
  /** Sessions inside the window, whatever they carry. */
  sessions: number
  metrics: Record<ProfileMetric, MetricBaseline>
}

export const PROFILE_WINDOW_DAYS = 30

/**
 * The day a session belongs to — UTC, from `start_time`.
 *
 * The same rule `tagSessionDay` and the billing basis use. The repo has two day rules and the other
 * one is the local clock; at UTC-3 they disagree, which would move a session in or out of the
 * window depending on the machine reading it.
 */
function dayMs(s: SessionMeta): number {
  const day = (s.start_time ?? '').slice(0, 10)
  const t = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(t) ? Number.NaN : t
}

/**
 * `n` IS PER METRIC, NEVER THE SAMPLE SIZE.
 *
 * `skill_uses`, the subagent counts and the compaction figures exist only for sessions whose raw
 * transcript survived Claude's cleanup. One shared `n` would compute the skills average over
 * sessions that could not possibly have carried one — a denominator that is quietly wrong in the
 * direction of "you use fewer skills than you think".
 *
 * A reader returning `undefined` means "this session cannot answer"; `0` means "it answered zero".
 */
type Reader = (s: SessionMeta) => number | undefined

const READERS: Record<ProfileMetric, Reader> = {
  compacts: s => s.compact_count,
  messages: s => s.user_message_count,
  activeMinutes: s => s.active_minutes,
  tokens: s => totalTokens(sessionTokens(s)),
  toolErrors: s => s.tool_errors,
  skills: s => (s.skill_uses ? Object.keys(s.skill_uses).length : undefined),
  mcpServers: s => {
    const names = Object.keys(s.tool_counts ?? {}).filter(t => t.startsWith('mcp__'))
    return new Set(names.map(t => t.split('__')[1] ?? t)).size
  },
  subagents: s => s.agentMetrics?.totalInvocations,
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function baselineOf(values: number[]): MetricBaseline {
  if (values.length === 0) return { median: 0, mean: 0, n: 0, nonZero: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((t, v) => t + v, 0)
  return {
    median: median(sorted),
    mean: sum / sorted.length,
    n: sorted.length,
    nonZero: sorted.filter(v => v > 0).length,
  }
}

export function profileOf(
  sessions: readonly SessionMeta[],
  nowMs: number,
  windowDays: number = PROFILE_WINDOW_DAYS,
): Baseline {
  const floor = nowMs - windowDays * 86_400_000
  const inWindow = sessions.filter(s => {
    const d = dayMs(s)
    return !Number.isNaN(d) && d >= floor && d <= nowMs
  })

  const metrics = {} as Record<ProfileMetric, MetricBaseline>
  for (const key of Object.keys(READERS) as ProfileMetric[]) {
    const read = READERS[key]
    const values: number[] = []
    for (const s of inWindow) {
      const v = read(s)
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v)
    }
    metrics[key] = baselineOf(values)
  }

  return { windowDays, sessions: inWindow.length, metrics }
}
