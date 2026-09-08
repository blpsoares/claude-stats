/**
 * fell-selection.ts — PURE: WHICH of the sessions that fell to reopen.
 *
 * `planCrashGroup` decides which sessions the machine took, and `planFellOffer` reduces those to
 * rows somebody can read. This is the third question, and it did not exist: reopening was
 * ALL OR NOTHING. The cockpit's `R` and the fleet's `reopenFell` both took the whole group, so a
 * laptop that died with eight sessions open offered one button that started eight assistants.
 *
 * Asked for: a list where everything is ticked and any of them can be unticked. That is a better
 * default than the reverse — the common case really is "put my machine back" — and the point is
 * that it is a default rather than the only answer.
 *
 * ## The rules, and why each is a refusal rather than a repair
 *
 * - **An EMPTY selection reopens nothing.** It is never read as "all". Unticking every row is a
 *   decision, and the one thing this must not do is start eight assistants because a list came
 *   back empty for a reason nobody anticipated.
 * - **`null` IS "all"**, and is what a caller that has no selection to make passes — the cockpit's
 *   `R`, which is a single keypress on a group that was already named. The distinction between
 *   `null` and `[]` is the whole safety of this module and is the first thing its tests pin.
 * - **An unknown id is REPORTED, never silently dropped.** It means the caller is acting on a list
 *   that has moved — the session ended on its own, or another window reopened it already — and a
 *   count that quietly shrinks is how somebody concludes a button half-worked.
 * - **A duplicate id is one session.** Ids arrive from a browser; the same row ticked twice must
 *   not spawn twice.
 */

import type { ManagedSession } from './types'

export interface FellSelection {
  /** The entries to reopen, in the order they were offered. */
  chosen: ManagedSession[]
  /** Ids the caller asked for that are not in the group at all. */
  unknown: string[]
}

/**
 * `ids === null` reopens everything; `[]` reopens nothing. See the header — those two are
 * deliberately different, and nothing here may collapse them.
 */
export function selectFell(
  entries: readonly ManagedSession[], ids: readonly string[] | null,
): FellSelection {
  if (ids === null) return { chosen: [...entries], unknown: [] }
  const known = new Map(entries.map(e => [e.id, e]))
  const seen = new Set<string>()
  const chosen: ManagedSession[] = []
  const unknown: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const entry = known.get(id)
    if (entry) chosen.push(entry)
    else unknown.push(id)
  }
  // Back into the order they were OFFERED in: the group is ordered newest-first for a reason, and a
  // caller's array order is whatever the DOM happened to hand back.
  const rank = new Map(entries.map((e, i) => [e.id, i]))
  chosen.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  return { chosen, unknown }
}
