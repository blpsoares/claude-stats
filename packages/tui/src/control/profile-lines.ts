/**
 * profile-lines.ts — PURE. The behaviour profile as lines, for the empty sessions list.
 *
 * A metric no session could answer (`n === 0`) is DROPPED, never printed as a zero: a row reading
 * "cost: 0" would claim every session was free. Same rule the dashboard applies to a harness
 * capability it does not have.
 */
import type { Baseline, ProfileMetric } from '@agentistics/core'
import type { ControlStrings } from './i18n'

/** The metrics worth a row, most-recognisable first. Order is the reading order. */
const SHOWN: ProfileMetric[] = ['messages', 'activeMinutes', 'compacts', 'skills', 'mcpServers', 'subagents']

function round(n: number): string {
  return n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2)
}

export function profileLines(
  baseline: Baseline | undefined,
  width: number,
  s: ControlStrings,
): string[] {
  if (!baseline) return []
  const out: string[] = [s.profileHeading(baseline.windowDays, baseline.sessions)]
  for (const key of SHOWN) {
    const m = baseline.metrics[key]
    if (!m || m.n === 0) continue
    out.push(`  ${s.profileMetric(key)}: ${round(m.median)}  (n=${m.n})`)
  }
  return out.map(l => (l.length > width ? l.slice(0, width) : l))
}
