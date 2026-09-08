/**
 * profile-lines.ts — PURE. The behaviour profile as lines, for the empty sessions list.
 *
 * A metric no session could answer (`n === 0`) is DROPPED, never printed as a zero: a row reading
 * "cost: 0" would claim every session was free. Same rule the dashboard applies to a harness
 * capability it does not have.
 */
import type { Baseline, ProfileMetric } from '@agentistics/core'
import type { ControlStrings } from './i18n'

/**
 * The metrics worth a row, most-recognisable first. Order is the reading order.
 *
 * EXPORTED because the web panel draws the same profile (`web/src/components/sessions/
 * ProfilePanel.tsx`), and it held its own copy of this list and of `roundProfile` below — so a
 * seventh metric added here would have reached the cockpit and silently not the dashboard. Same
 * precedent as `session-table.ts` consuming the cockpit's own arithmetic for `agentop session ls`.
 */
export const SHOWN: ProfileMetric[] = ['messages', 'activeMinutes', 'compacts', 'skills', 'mcpServers', 'subagents']

/** A median rendered for a person: whole above 10 or when it is one, two decimals otherwise. */
export function roundProfile(n: number): string {
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
    out.push(`  ${s.profileMetric(key)}: ${roundProfile(m.median)}  (n=${m.n})`)
  }
  return out.map(l => (l.length > width ? l.slice(0, width) : l))
}
