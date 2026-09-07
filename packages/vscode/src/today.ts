/**
 * today.ts — PURE. What today has cost, for the status bar.
 *
 * **The day rule is `start_time.slice(0, 10)` — UTC**, and the choice is deliberate. Two day rules
 * exist in this repo: the UTC slice (`tagSessionDay`, and the dashboard's own date presets, which
 * bound their ranges with `utcStartOfDay`) and a local-clock one used for the session-gap streak. A
 * status bar sitting beside a dashboard MUST agree with the dashboard, and at UTC-3 the two rules
 * disagree for three hours every night — which is exactly when someone would notice the two
 * surfaces contradicting each other and stop believing both.
 *
 * **Summed per session, and only for today.** `stats-cache.json` is Claude-only and holds the deep
 * history that no longer exists as session files; for TODAY the sessions are all still there, for
 * every harness, so the per-session sum is both complete and cross-harness. Reaching for the cache
 * here would report Claude's day under a label that says "today" without saying "Claude".
 *
 * **Tokens means all four counters** — `sessionTokenTotal` sums input, output, cache read and cache
 * write. On real data the conversational pair alone is under 1% of the volume, so a two-term sum is
 * not slightly low, it is off by roughly 300x while the cost beside it disagrees by 10x.
 */

import { sessionCostUSD, sessionTokenTotal, type SessionMeta } from '@agentistics/core'

export interface TodayTotals {
  costUSD: number
  tokens: number
  sessions: number
}

/** The UTC day key for an instant. Exported so the caller does not restate the rule. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function todayTotals(sessions: readonly SessionMeta[], now: Date): TodayTotals {
  const key = dayKey(now)
  let costUSD = 0
  let tokens = 0
  let count = 0
  for (const s of sessions) {
    if ((s.start_time ?? '').slice(0, 10) !== key) continue
    count += 1
    tokens += sessionTokenTotal(s)
    costUSD += sessionCostUSD(s) ?? 0
  }
  return { costUSD, tokens, sessions: count }
}

/**
 * A token count for a status bar: `1.2M`, `51.7k`, `812`.
 *
 * Rounds DOWN, like every other gauge in this product, so nothing reads as a round number it has
 * not reached.
 */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(Math.floor(n / 100_000) / 10).toFixed(1)}M`
  if (n >= 1_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}k`
  return String(Math.floor(n))
}
