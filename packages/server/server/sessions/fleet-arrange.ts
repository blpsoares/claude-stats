/**
 * fleet-arrange.ts — the fleet, ARRANGED, for a client that has no `ControlSession`.
 *
 * The cockpit's arrangement is `filterSessions` → `sessionKept` → `sortSessions` → `groupSessions`,
 * and all four are pure and already exist. They take a whole `ControlSession`, though, and what
 * crosses the wire is a `FleetRow` — a deliberate subset. That leaves three ways to give an editor
 * client the same arrangement, and only one of them is right:
 *
 * 1. Re-implement grouping and ordering in the client. That is a second set of rules, which is the
 *    defect this repository is built against — and it would drift the day a dimension is added.
 * 2. Widen `FleetRow` until it IS a `ControlSession` and make the pure functions generic. That
 *    couples the wire to an internal shape and rewrites modules three other surfaces depend on.
 * 3. **Arrange it HERE**, where the real `ControlSession`s already are and where these functions
 *    are already imported, and put the result on the wire.
 *
 * So the client sends what the person chose — group by, sort by, direction, search, filters — and
 * receives bands with labels. It renders; it decides nothing. A dimension added to
 * `SESSION_DIMENSIONS` appears in this response without a line changing here, because the table is
 * what is enumerated.
 */

import {
  DIMENSION_ORDER, GROUPINGS, bucketKey, dimensionValueLabel, sessionKept, sessionNamed,
  sessionRunning,
  type SessionDimensionId, type SessionFilters, type SessionGroupingId,
} from '@agentistics/tui/control/session-dimensions'
import { SESSION_SORTS, type SessionOrder, type SessionSort } from '@agentistics/tui/control/session-order'
import { filterSessions, groupSessions } from '@agentistics/tui/control/sessions'
import { sessionWordBook, type ControlStrings } from '@agentistics/tui/control/i18n'
import type { ControlSession } from '@agentistics/tui/control'
import { SEARCH_SCOPES, type SearchScope } from '@agentistics/tui/control/search-scope'
import { fleetRow, type FleetRow } from './fleet-row'

/** What the client asked for. Every field optional: an absent one is "no opinion", never "none". */
export interface FleetViewRequest {
  grouping?: string
  sort?: string
  dir?: string
  query?: string
  /** Per dimension, the values to keep. Values inside one dimension are OR, dimensions are AND. */
  filters?: Record<string, string[]>
  /** The scopes the search looks in. Absent means every scope. */
  scopes?: string[]
  /** Session ids the user marked, for the `marked` dimension. */
  marked?: string[]
  /** Show only sessions that are running. */
  onlyActive?: boolean
}

export interface FleetGroup {
  key: string
  /** Already localized, from the same word book the cockpit's bands and chips use. */
  label: string
  /** True for a TASK the user marked finished. Only ever set while grouping by task. */
  done?: boolean
  rows: FleetRow[]
}

/** One value a dimension can be filtered by, with how many rows carry it. */
export interface FacetValue {
  key: string
  label: string
  count: number
}

export interface Facet {
  id: SessionDimensionId
  label: string
  values: FacetValue[]
}

export interface FleetArrangement {
  groups: FleetGroup[]
  /** How many rows survived, and how many exist — so "6 of 40" can be said. */
  shown: number
  total: number
  /** What was actually applied, echoed back: a client that asked for junk sees what it got. */
  applied: { grouping: SessionGroupingId; sort: SessionSort; dir: 'asc' | 'desc' }
  /** The dimensions, their values and their counts — the filter menu, as data. */
  facets: Facet[]
  /** Every grouping and sort this build offers, so the client's menus are never a stale copy. */
  groupings: { id: SessionGroupingId; label: string }[]
  sorts: { id: SessionSort; label: string }[]
  scopes: { id: SearchScope; label: string }[]
}

function one<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback
}

/**
 * Arrange one fleet.
 *
 * The order is the cockpit's, and it matters: SEARCH first (it is what the person just typed), then
 * the dimension filters, then the sort, then the grouping — grouping last because a band's contents
 * are ordered, not the other way round.
 *
 * `showNamed` is passed to `sessionKept` exactly as the cockpit passes it: a row the user NAMED is
 * never withheld by the history switches, because a reboot makes every managed session `lost` and
 * the list would otherwise come back empty, taking the session you renamed with it.
 */
export function arrangeFleet(
  sessions: readonly ControlSession[],
  req: FleetViewRequest,
  s: ControlStrings,
  doneTasks: readonly string[] = [],
): FleetArrangement {
  const words = sessionWordBook(s)
  const marked = new Set(req.marked ?? [])
  const ctx = { marked }

  const grouping = one<SessionGroupingId>(req.grouping, GROUPINGS, 'project')
  const sort = one<SessionSort>(req.sort, SESSION_SORTS, 'state')
  const dir: 'asc' | 'desc' = req.dir === 'asc' ? 'asc' : 'desc'
  const order: SessionOrder = { by: sort, dir }

  const scopes = req.scopes?.length
    ? new Set(req.scopes.filter((v): v is SearchScope => SEARCH_SCOPES.includes(v as SearchScope)))
    : undefined

  const filters: SessionFilters = {}
  for (const id of DIMENSION_ORDER) {
    const values = req.filters?.[id]
    if (values?.length) filters[id] = values
  }

  let kept = filterSessions(sessions, req.query ?? '', undefined, scopes)
  kept = kept.filter(row => sessionKept(row, { filters, showNamed: true, ctx }))
  if (req.onlyActive) {
    // A row the user NAMED survives the switch, exactly as it does in the cockpit — see the header.
    kept = kept.filter(row => sessionRunning(row) || sessionNamed(row))
  }

  const grouped = groupSessions(kept, grouping, words, doneTasks, order, ctx)

  return {
    groups: grouped.map(g => ({
      key: g.key,
      label: g.label,
      ...(g.done ? { done: true } : {}),
      rows: g.sessions.map(row => fleetRow(row, s)),
    })),
    shown: kept.length,
    total: sessions.length,
    applied: { grouping, sort, dir },
    facets: facetsOf(sessions, words, ctx),
    groupings: GROUPINGS.map(id => ({ id, label: groupingLabel(id, s) })),
    sorts: SESSION_SORTS.map(id => ({ id, label: s.sessionsSorts[id] })),
    scopes: SEARCH_SCOPES.map(id => ({ id, label: s.searchScope[id] })),
  }
}

function groupingLabel(id: SessionGroupingId, s: ControlStrings): string {
  return id === 'none' ? s.sessionsGroupings.none : s.sessionsGroupings[id]
}

/**
 * What the filter menu can offer, counted over the WHOLE fleet rather than the filtered one.
 *
 * Counting the survivors would make every unselected value read zero the moment one filter is on,
 * which turns the menu into a dead end: you could never widen a selection, only narrow it.
 */
function facetsOf(
  sessions: readonly ControlSession[],
  words: ReturnType<typeof sessionWordBook>,
  ctx: { marked: ReadonlySet<string> },
): Facet[] {
  return DIMENSION_ORDER.map(id => {
    const counts = new Map<string, number>()
    for (const row of sessions) {
      const key = bucketKey(row, id, ctx)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return {
      id,
      label: words[id].label,
      values: [...counts.entries()]
        .map(([key, count]) => ({ key, label: dimensionValueLabel(words[id], key), count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    }
  }).filter(f => f.values.length > 1)
}
