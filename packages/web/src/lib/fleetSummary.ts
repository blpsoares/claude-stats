/**
 * fleetSummary.ts — PURE. What the sessions workspace shows when no session is selected.
 *
 * Counts and sums only, over the rows the fleet already sent. Nothing here fetches, and nothing
 * here invents: a figure the fleet cannot produce comes back `undefined` and the surface says so in
 * words rather than drawing a zero. That is the same rule `HARNESS_CAPABILITIES` applies to a
 * metric no harness can compute, and the reason is the same — an absent number is visible, a wrong
 * one is not.
 */

import type { ControlSession } from '@agentistics/tui/control/session-fleet'

export interface HarnessSlice {
  harness: string
  count: number
  /** Of those, how many are running right now. */
  running: number
}

export interface FleetSummary {
  total: number
  running: number
  /** Waiting on a person — the count the workspace switch badges. */
  waiting: number
  /** Not running: exited, lost, or a closed conversation. */
  off: number
  harnesses: HarnessSlice[]
  /**
   * Total time the RUNNING sessions have been up, in ms.
   *
   * `undefined` when no running session records a start — an absence, never a zero, because "no
   * session has been up for any time" and "nothing here records when they started" are different
   * statements and only one of them is true.
   */
  activeMs?: number
  /** How many running sessions could not say when they started, so the figure can be qualified. */
  activeUnknown: number
  /** Distinct projects the fleet is spread across. */
  projects: number
  /**
   * How many of those projects are REPOSITORIES — the ones a git remote could be resolved for.
   *
   * Counted per PROJECT, never per session, so it can be read as a fraction of `projects` and can
   * never exceed it. A project counts as a repository if ANY of its rows knows the remote:
   * `repo` is resolved per row and a `lost` row whose directory is gone carries none
   * (`resolveRepoFacts` reports `missing`), so one row knowing it is the fact while the others
   * not knowing it is an absence — and an absence must not unmake a fact.
   */
  projectRepos: number
}

const RUNNING = new Set(['working', 'waiting', 'waiting-approval'])
const WAITING = new Set(['waiting', 'waiting-approval'])

export function summarizeFleet(rows: readonly ControlSession[], now: number): FleetSummary {
  const byHarness = new Map<string, HarnessSlice>()
  const projects = new Set<string>()
  /** The subset of `projects` that at least one row could name a remote for. See `projectRepos`. */
  const repoProjects = new Set<string>()
  let running = 0
  let waiting = 0
  let activeMs = 0
  let activeKnown = 0
  let activeUnknown = 0

  for (const s of rows) {
    const isRunning = RUNNING.has(s.state)
    if (isRunning) running++
    if (WAITING.has(s.state)) waiting++
    if (s.project) {
      // The GROUP is the key on both sets, so a worktree and its main checkout stay one project on
      // both counts — keying the repo set differently would let the card read "2 of 1".
      const key = s.projectGroup || s.project
      projects.add(key)
      if (s.repo) repoProjects.add(key)
    }

    const slice = byHarness.get(s.harness) ?? { harness: s.harness, count: 0, running: 0 }
    slice.count++
    if (isRunning) slice.running++
    byHarness.set(s.harness, slice)

    if (isRunning) {
      // Clamped at zero: a clock skew between the recorded start and this render would otherwise
      // subtract from the total, and a fleet uptime that goes DOWN when a session starts is worse
      // than one that is slightly short.
      if (s.startedAt !== undefined) { activeMs += Math.max(0, now - s.startedAt); activeKnown++ }
      else activeUnknown++
    }
  }

  return {
    total: rows.length,
    running,
    waiting,
    off: rows.length - running,
    // Busiest first, and the name breaks ties so the order does not shuffle between polls.
    harnesses: [...byHarness.values()].sort((a, b) => b.count - a.count || a.harness.localeCompare(b.harness)),
    ...(activeKnown > 0 ? { activeMs } : {}),
    activeUnknown,
    projects: projects.size,
    projectRepos: repoProjects.size,
  }
}

/**
 * A duration as `3h 12m`, or `12m`, or `48s`.
 *
 * Two units at most: a fleet total reaching days makes `2d 3h 12m 09s` a number nobody reads, and
 * the second unit is what stops `2h` and `2h 59m` looking the same.
 */
export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
