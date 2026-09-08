/**
 * rowMenu.ts — PURE: what the right-click menu on a session row offers.
 *
 * It COMPOSES NOTHING. Every entry is one of the row's own `verbs`, which the server already
 * resolved through the same `sessionActions` the cockpit resolves every keypress against, and
 * which arrive already localized with their `enabled` flag and their `reason`. A second table here
 * would be a second set of rules for one gesture — the defect `task-reopen.ts` exists to have
 * fixed once.
 *
 * A verb the row cannot take stays in the menu, DISABLED, with its reason. A menu that silently
 * loses half its entries reads as a broken feature, and an absence explains nothing — the same
 * call `fleet-row.ts` makes for a verb it refuses.
 *
 * ONE entry is not a server verb: `link-task`. It opens a picker rather than acting, so there is
 * nothing for the server to have resolved — no `enabled`, no `reason`, no refusal sentence. It is
 * passed IN by the caller rather than composed here, so this module still holds no table of its
 * own, and it is always last: the verbs that act on the session come first.
 *
 * "Stop" is two different verbs. On a row that is mid-turn it is `interrupt` (stop what it is
 * doing, keep the session); everywhere else it is `kill` (end it). Offering both would ask the
 * reader to know the difference before they have read the row.
 */

export interface RowVerb {
  action: string
  label: string
  enabled: boolean
  reason?: string
}

export type MenuEntry = RowVerb

/** States where the session is mid-turn, so "stop" means the TURN and not the session. */
const MID_TURN = new Set(['working'])

export function rowMenuEntries(
  verbs: readonly RowVerb[],
  state: string,
  /** Client-side entries appended after the verbs — see the note above. */
  extra: readonly MenuEntry[] = [],
): MenuEntry[] {
  const find = (a: string) => verbs.find(v => v.action === a)
  const stop = MID_TURN.has(state) ? find('interrupt') : find('kill')
  const fleet = [find('rename'), stop, find('resume')].filter((v): v is RowVerb => v !== undefined)
  return [...fleet, ...extra]
}
