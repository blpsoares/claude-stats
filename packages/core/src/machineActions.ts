/**
 * machineActions.ts — PURE: which verbs may be performed on ANOTHER machine's session.
 *
 * The list is short, and what is missing from it is the point.
 *
 * **`approve` and `prompt` are excluded, and not because they are dangerous in themselves.** They
 * are excluded because neither can be offered honestly without the SCREEN. The cockpit's own rule
 * is that the dialog being readable IS the safety: a permission prompt is `1. Yes / 2. Yes, always
 * / 3. No`, an `AskUserQuestion` can offer five answers that do different work, and the keystroke
 * that answers cannot know which option it is taking (`parseDialogOptions`). An approve button on a
 * dialog nobody can read is precisely the accident that machinery exists to prevent — one user was
 * offered a destructive key over a question they never asked. And `prompt` types free text into
 * somebody's live session, which is the same act as sitting at their keyboard.
 *
 * So they are gated on `allowRemoteScreens`, the SECOND consent switch, and even with it granted
 * they are not implemented yet: the screen does not travel in this phase, so the honest answer is
 * that they are unavailable, said in words, rather than a button that takes an unread choice.
 *
 * Everything on the list below is a verb whose meaning is fully carried by the row itself — a name,
 * a note, a task, or ending/reopening a session — and none of them needs to read a terminal.
 */

/**
 * Verbs that need no screen, and may cross to a central once the fleet consent is given.
 *
 * **`openTask` and `finishTask` were on this list and are gone with the verbs themselves.** They
 * acted on the piece of WORK a row was filed under rather than on the row — `openTask` expanded to
 * every session of that task over the whole registry — and `machine-fleet.ts` carried a dedicated
 * refusal so a restricted central could not reach a withheld directory through them. That guard is
 * gone too, and it is not a weakening: this list is CLOSED, so an action it does not name is
 * refused, and neither id exists as a `FleetActionId` any more. Finishing a delivery is now asked
 * when a session is stopped and written through the board's own API; reopening a whole task is
 * `agentop session open`, on the machine.
 */
export const REMOTE_SCREENLESS_ACTIONS = [
  'rename', 'note', 'task', 'interrupt', 'kill', 'resume',
] as const

export type RemoteScreenlessAction = typeof REMOTE_SCREENLESS_ACTIONS[number]

/**
 * Verbs that need the session's SCREEN to be offered honestly. Listed rather than merely absent, so
 * the UI can say WHY they are missing instead of leaving a hole a reader has to explain to
 * themselves — the same call `fleet-row.ts` makes for a verb a row cannot take.
 */
export const REMOTE_SCREEN_ACTIONS = ['approve', 'prompt'] as const

/**
 * May this action be performed remotely, given what the machine has agreed to?
 *
 * Total, and closed: an action this module does not know is REFUSED. A new `FleetActionId` added
 * upstream must be listed here on purpose before it can be driven from a central — the same
 * allowlist reasoning `reduceMachineFleetRow` uses for fields, applied to verbs.
 *
 * `screens` is what turns the second list on, and it was designed as a parameter precisely so that
 * enabling it would be a change in ONE predicate rather than a new gate scattered across the member
 * and the central. It is that change.
 *
 * The gate is `screens`, never `sessions`: answering a dialog needs the dialog to be READABLE,
 * because the keystroke that answers it cannot know which option it is taking — a claude permission
 * prompt is `1. Yes / 2. Yes, always / 3. No`, and a blind "approve" chooses for the person. So a
 * central that has the verbs but not the screen must not be able to press them, which is exactly
 * what `resolveRemoteConsent` already guarantees by refusing `screens` without `sessions`.
 */
export function remoteActionAllowed(
  action: string,
  consent: { sessions: boolean; screens: boolean },
): boolean {
  if (!consent.sessions) return false
  if ((REMOTE_SCREENLESS_ACTIONS as readonly string[]).includes(action)) return true
  return consent.screens && (REMOTE_SCREEN_ACTIONS as readonly string[]).includes(action)
}

/** Why an action is not offered, as a code the UI turns into a sentence. `null` = it is offered. */
export function remoteActionRefusal(
  action: string,
  consent: { sessions: boolean; screens: boolean },
): 'no-consent' | 'needs-screen' | 'unknown' | null {
  if (!consent.sessions) return 'no-consent'
  if ((REMOTE_SCREENLESS_ACTIONS as readonly string[]).includes(action)) return null
  // `needs-screen` is the reason only while the screen is actually withheld. Once the machine has
  // granted it, these verbs are offered like any other and this must agree with
  // `remoteActionAllowed` — a refusal code for an action that IS allowed would put a sentence
  // under a button that works.
  if ((REMOTE_SCREEN_ACTIONS as readonly string[]).includes(action)) {
    return consent.screens ? null : 'needs-screen'
  }
  return 'unknown'
}
