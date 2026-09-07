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

export function rowMenuEntries(verbs: readonly RowVerb[], state: string): MenuEntry[] {
  const find = (a: string) => verbs.find(v => v.action === a)
  const stop = MID_TURN.has(state) ? find('interrupt') : find('kill')
  return [find('rename'), stop, find('resume')].filter((v): v is RowVerb => v !== undefined)
}
