/**
 * team-task-view.ts — PURE. The central's delivery board: what each machine shared, resolved.
 *
 * The wire carries FACTS and no numbers (see `SharedTask`), so the totals are computed HERE — by
 * the very `rollupAttempt` the machine's own board goes through, over the sessions the central
 * already holds. That is what stops a delivery costing one figure on the laptop and another on the
 * central: there is one implementation, not two.
 *
 * Grouped BY MACHINE, because a board belongs to the person whose machine it runs on and the
 * central is many people. **A machine that shares nothing is present and EMPTY** — "this machine
 * has no deliveries" and "this machine shares none of them" are different facts, and a machine
 * that simply vanished from the list would read as the first while being the second.
 *
 * Every rollup here is short by construction whenever the connection withholds sessions, which is
 * why `sessionsWithheld` travels and is carried through to the row: a figure that shrank with
 * nothing on screen explaining why is the same defect as a confident zero.
 */

import type { SessionMeta, SharedTask } from '@agentistics/core'
import { rollupAttempt, type AttemptRollup, type RollupSession } from './sessions/task-rollup'

export interface CentralTaskRow {
  /** The machine that shared it, and the name that machine is known by. */
  memberId: string
  user: string
  task: SharedTask['task']
  comments: SharedTask['comments']
  subtasks: SharedTask['subtasks']
  files: SharedTask['files']
  counts: { comments: number; subtasks: number; subtasksDone: number; files: number }
  /** Resolved through `task-rollup.ts`, over the sessions this central actually holds. */
  rollup: AttemptRollup
  harnesses: string[]
  repos: string[]
  /**
   * Sessions of this delivery that its machine does NOT share with this central, as that machine
   * reported. The number is stated in words on the board; it is the difference between "this
   * delivery cost that much" and "this is what it cost as far as you can see".
   */
  sessionsWithheld: number
  /**
   * Sessions this delivery names that the central does not hold — a push still in flight, or a
   * session removed from the central after the delivery named it. Distinct from `sessionsWithheld`:
   * one is a rule somebody set, the other is a gap in what arrived.
   */
  sessionsMissing: number
}

export interface CentralTaskMachine {
  memberId: string
  user: string
  rows: CentralTaskRow[]
}

export interface TeamTaskInput {
  memberId: string
  user: string
  shared: SharedTask
}

export function centralTaskRow(
  input: TeamTaskInput,
  metas: ReadonlyMap<string, SessionMeta>,
  costOf: (m: SessionMeta) => number,
): CentralTaskRow {
  const found: SessionMeta[] = []
  let missing = 0
  for (const id of input.shared.sessionIds) {
    const m = metas.get(id)
    // A delivery may only ever name ITS OWN MACHINE's sessions. `sessionIds` arrives from the
    // member, so without this a machine could list a session id belonging to somebody else and
    // have the central resolve that session's cost, tokens, harness and repository under its own
    // delivery — reading a neighbour's numbers back off its own board. The ids are UUIDs and so
    // not guessable, which makes this hard rather than impossible; the check makes it neither.
    // A session that is not this machine's counts as MISSING, exactly like one that has not
    // arrived: the row is measured short and says so, rather than quietly borrowing a figure.
    if (m && m.memberId === input.memberId) found.push(m)
    else missing++
  }
  // A named session the central does not hold is `meta: null` — a session USED that contributed no
  // numbers, exactly as an unlinked row is on the machine itself. It is never dropped: doing so
  // would report a smaller delivery as a complete one.
  const sessions: RollupSession[] = [
    ...found.map((m): RollupSession => ({
      rowId: m.session_id, provenance: 'assigned', meta: m, costUSD: costOf(m),
    })),
    ...Array.from({ length: missing }, (_, i): RollupSession => ({
      rowId: `missing-${i}`, provenance: 'assigned', meta: null, costUSD: null,
    })),
  ]
  const harnesses: string[] = []
  const repos: string[] = []
  for (const m of found) {
    const h = m.harness ?? 'claude'
    if (!harnesses.includes(h)) harnesses.push(h)
    const r = m.git_remote ?? ''
    if (!repos.includes(r)) repos.push(r)
  }
  return {
    memberId: input.memberId,
    user: input.user,
    task: input.shared.task,
    comments: input.shared.comments,
    subtasks: input.shared.subtasks,
    files: input.shared.files,
    counts: {
      comments: input.shared.comments.length,
      subtasks: input.shared.subtasks.length,
      subtasksDone: input.shared.subtasks.filter(s => s.done).length,
      files: input.shared.files.length,
    },
    rollup: rollupAttempt({ sessions }),
    harnesses,
    repos,
    sessionsWithheld: input.shared.sessionsWithheld,
    sessionsMissing: missing,
  }
}

/**
 * One band per machine, machines by name, deliveries most recently updated first.
 *
 * `machines` is every machine the central KNOWS, not only those that shared something — the caller
 * passes the roster, and a machine with nothing to show gets an empty band rather than being left
 * out. Ordering by name and not by volume: this is a roster, and a roster that reshuffles as work
 * accrues is one nobody can find a row in twice.
 */
/**
 * Which machines a viewer may see the board OF.
 *
 * A delivery carries a title, a description and comment bodies somebody wrote — free text, and the
 * whole reason this feature is gated per task. Handing every signed-in principal every machine's
 * board would cross the team boundary `/api/data` already draws for the SESSIONS those same
 * deliveries are measured from, and would do it with the most readable data in the product.
 *
 * So the rule is the one that already exists, applied unchanged: an OWNER sees everything; anyone
 * else sees the machines of the teams they MANAGE (`dataTeamIdsOf` — belonging is not reading) plus
 * the machines they own, so a loose machine with no team is still visible to its owner. Passing
 * `null` means "no scoping" and is only ever the owner case, decided by the caller.
 */
export interface MachineScope {
  /** Team ids the viewer may read. */
  teams: ReadonlySet<string>
  /** Machines the viewer owns outright. */
  owned: ReadonlySet<string>
}

export function machineVisible(
  m: { memberId: string; teamIds?: readonly string[] },
  scope: MachineScope | null,
): boolean {
  if (!scope) return true
  if (scope.owned.has(m.memberId)) return true
  return (m.teamIds ?? []).some(t => scope.teams.has(t))
}

export function centralTaskBoard(o: {
  tasks: readonly TeamTaskInput[]
  machines: readonly { memberId: string; user: string; teamIds?: readonly string[] }[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
  /**
   * Null for an owner. For anyone else, the machines outside it are not filtered from the list —
   * they are never built at all, tasks included, so a title cannot reach a viewer through a band
   * they were not meant to see.
   */
  scope?: MachineScope | null
}): CentralTaskMachine[] {
  const scope = o.scope ?? null
  const byMachine = new Map<string, CentralTaskMachine>()
  const roster = new Map<string, { memberId: string; user: string; teamIds?: readonly string[] }>()
  for (const m of o.machines) {
    roster.set(m.memberId, m)
    if (!machineVisible(m, scope)) continue
    byMachine.set(m.memberId, { memberId: m.memberId, user: m.user, rows: [] })
  }
  for (const t of o.tasks) {
    const known = roster.get(t.memberId)
    // A machine the roster does not list — its token was revoked, or it pushed under a legacy
    // identity — carries no team, so a SCOPED viewer cannot see it. That is the fail-closed
    // direction: an unattributable board is withheld rather than shown to everybody. An owner
    // (no scope) still sees it, under the name it arrived with, so revoking a token never hides
    // work from the person administering the central.
    if (!machineVisible({ memberId: t.memberId, ...(known?.teamIds ? { teamIds: known.teamIds } : {}) }, scope)) continue
    const row = centralTaskRow(t, o.metas, o.costOf)
    const band = byMachine.get(t.memberId)
      ?? { memberId: t.memberId, user: t.user, rows: [] }
    band.rows.push(row)
    byMachine.set(t.memberId, band)
  }
  const out = [...byMachine.values()]
  for (const band of out) {
    band.rows.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt))
  }
  return out.sort((a, b) => a.user.localeCompare(b.user) || a.memberId.localeCompare(b.memberId))
}
