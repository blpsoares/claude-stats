/**
 * session-order.ts — PURE. What a fleet is ordered BY, and the ranking every surface breaks ties on.
 *
 * Split out of `sessions.ts` for the reason its own header gives for `session-dimensions.ts`: the
 * dependency has to run ONE way. `session-tree.ts` builds the cascade and needs exactly this
 * arithmetic — a node's sessions sorted, and its branches ordered by their most urgent member —
 * while `sessions.ts` needs `buildSessionTree` to serve the `tree` arrangement. Left where it was,
 * those two modules would import each other, and a value cycle between them would be a real one.
 *
 * Nothing moved and nothing changed: `sessions.ts` re-exports every name here, so the rest of the
 * control center still imports them from the one module it already names.
 */

import type { ControlSession, SessionState } from './types'

/**
 * What is waiting on a person first, then what is running, then what is done, then what cannot be
 * acted on at all. The same ranking the server-side view uses, restated here because the screen
 * re-sorts within a group.
 */
const RANK: Record<SessionState, number> = {
  'waiting-approval': 0,
  waiting: 1,
  working: 2,
  exited: 3,
  lost: 4,
  unknown: 5,
  closed: 6,
}

/**
 * Takes the STATE and nothing else, and says so in its signature.
 *
 * Widened from `ControlSession` so the surfaces that hold a reduced row can rank it through this
 * very function instead of restating the table: the VS Code extension is handed `FleetRow` over
 * HTTP — a strict subset — and a ranking copied into an editor client would be a third answer to
 * "what is most urgent", after the cockpit's and the browser's. Every existing caller passes a
 * `ControlSession` and is unaffected.
 */
export function sessionRank(s: Pick<ControlSession, 'state'>): number {
  return RANK[s.state]
}

/**
 * What a list can be ordered BY.
 *
 * `state` is the default and is not merely one option among the others: it puts what is blocked on
 * you at the top, which is the reason this screen exists. Every other order is a way of ANSWERING a
 * question ("what is costing me", "where was I an hour ago"), and each keeps state as its tiebreak
 * so a run of equal values still surfaces the blocked one first.
 */
export type SessionSort = 'state' | 'name' | 'started' | 'recent' | 'usage' | 'project'

export const SESSION_SORTS: readonly SessionSort[] =
  ['state', 'name', 'started', 'recent', 'usage', 'project'] as const

export interface SessionOrder {
  by: SessionSort
  /** `desc` is newest / largest / most-urgent first — the direction each key is useful in. */
  dir: 'asc' | 'desc'
}

export const DEFAULT_ORDER: SessionOrder = { by: 'state', dir: 'desc' }

/**
 * The last time anything HAPPENED on this row — the `recent` sort's key, exported so the `day`
 * dimension can band on the very same expression.
 *
 * They must agree or the screen contradicts itself: a list ordered by "what was I just doing" whose
 * bands are cut on when each session STARTED puts a row used ten minutes ago under Monday, at the
 * top of the list, under the wrong heading. `undefined` where the row records neither — an absence,
 * not epoch zero, which would file it under 1970.
 */
export function recencyOf(s: ControlSession): number | undefined {
  return s.endedAt ?? s.startedAt
}

/**
 * Tokens as a NUMBER for ordering, from the already-formatted string the host sent.
 *
 * The host formats `51.7k` because every other surface wants it formatted, and re-deriving the
 * number here beats asking it to send both — but it must parse the SUFFIX, or `9.9k` sorts above
 * `1.2M` and the column that exists to show what is expensive points at the cheapest row.
 */
export function usageOf(s: ControlSession): number {
  const raw = (s.tokens ?? '').trim()
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return 0
  const unit = raw.replace(/[\d.,\s]/g, '').toUpperCase()
  return n * (unit.startsWith('M') ? 1e6 : unit.startsWith('K') ? 1e3 : 1)
}

/**
 * Order a list — PURE.
 *
 * STATE is every key's tiebreak, not only its own: a screen sorted by name that buries a session
 * waiting on approval among nine idle ones has lost the thing it is for. The direction flips the
 * primary key only, so `asc` by name still puts the blocked session first among equal names.
 */
export function sortSessions(
  list: readonly ControlSession[],
  order: SessionOrder = DEFAULT_ORDER,
): ControlSession[] {
  // `primary` returns negative when `a` belongs FIRST in the direction the key is useful in, which
  // `desc` names: most urgent, A to Z, largest, newest. `asc` is that flipped. One convention for
  // every key, rather than a per-key argument about which way round its "descending" runs.
  const primary = (a: ControlSession, b: ControlSession): number => {
    switch (order.by) {
      case 'state': return sessionRank(a) - sessionRank(b)
      case 'name': return a.title.localeCompare(b.title)
      case 'project': return (a.projectGroup || a.project).localeCompare(b.projectGroup || b.project)
      case 'usage': return usageOf(b) - usageOf(a)
      case 'started': return (b.startedAt ?? 0) - (a.startedAt ?? 0)
      // The last time anything HAPPENED, which on a finished conversation is when it went off and
      // on a live one is now. `started` cannot answer it: a session opened on Monday and used until
      // ten minutes ago sorts three days old under that key, which is the wrong answer to "what was
      // I just doing".
      case 'recent':
        return (recencyOf(b) ?? 0) - (recencyOf(a) ?? 0)
    }
  }
  const sign = order.dir === 'asc' ? -1 : 1
  return [...list].sort((a, b) => {
    const byPrimary = primary(a, b) * sign
    if (byPrimary !== 0) return byPrimary
    const byRank = sessionRank(a) - sessionRank(b)
    if (byRank !== 0) return byRank
    return (b.startedAt ?? 0) - (a.startedAt ?? 0)
  })
}
