/**
 * remoteSessions.ts — PURE: what a machine has agreed a central may do with its sessions.
 *
 * Managing a machine's sessions from a central is the most powerful thing a central can be asked
 * to relay, and until this module existed there was no way for the machine to agree to it — the
 * central refused `/api/fleet*` outright (`index.ts`, `TEAM_CENTRAL`) and `capability-guard.ts`
 * refused it again under `localShell`. Both refusals stay; this is the machine's own consent,
 * asked once, and it is the only thing that can lift them for a relay.
 *
 * TWO SWITCHES, NOT ONE — and the split is the security model, not a preference:
 *
 * - `allowRemoteSessions` grants the ROWS and the verbs that carry no screen (rename, note, task,
 *   interrupt, kill, resume, openTask, finishTask).
 * - `allowRemoteScreens` additionally grants `lastLines`, `approvalLines` and `dialogOptions` —
 *   the session's terminal and the dialog it is blocked on — and therefore `approve` and `prompt`.
 *
 * They are separate because they are different questions. `team-agent.ts` records that on-demand
 * chat retrieval was REMOVED from the reverse channel and that the central never requests or views
 * member chat (`GET /api/team/session-chat` is a 410). A session's screen is that transcript with
 * the formatting left on, so "let me rename a session from my phone" is not informed consent to
 * "stream my terminal to the central". And the approve verb cannot be offered without the screen:
 * the cockpit's own rule is that the dialog being READABLE is the safety, because the keystroke
 * that answers it cannot know which option it is taking (`parseDialogOptions`, and a claude
 * permission prompt that is `1. Yes / 2. Yes, always / 3. No`).
 *
 * ABSENT READS AS OFF, exactly as `chat-gate.ts` decided for the local chat shell and deliberately
 * NOT as `shareMode`'s migration decided for sharing rules. There, treating absence as anything but
 * the old default would silently invert live privacy rules; here, treating absence as ON would hand
 * every already-connected machine over to its central on upgrade, which is the thing being
 * prevented. The cost of the strict reading is a switch to find; the cost of the lenient one is
 * remote control nobody asked for.
 *
 * `chatTurns` is granted by NEITHER switch and has no switch of its own. The transcript stays where
 * the 410 put it.
 */

/** What a central may actually do with this machine's sessions, once every rule has been applied. */
export interface RemoteSessionConsent {
  /** The fleet may be relayed at all: rows, and the verbs that need no screen. */
  sessions: boolean
  /** The session SCREEN may travel: `lastLines`, `approvalLines`, `dialogOptions` — and with them
   *  `approve` and `prompt`. Never true while `sessions` is false. */
  screens: boolean
}

/** Nothing agreed — the answer for an absent config, an unknown connection, or a machine that has
 *  never been asked. Exported so no caller has to write the two `false`s and get one wrong. */
export const NO_REMOTE_CONSENT: RemoteSessionConsent = { sessions: false, screens: false }

/**
 * Resolve the two stored switches into what is actually permitted.
 *
 * `screens` is gated on `sessions` rather than read on its own: a config carrying
 * `{ sessions: false, screens: true }` is reachable by hand-editing `preferences.json` and by any
 * write order that sets one before the other, and the honest reading of it is "no" — a screen with
 * no fleet to attach it to is the transcript channel with nothing else around it. Same shape as
 * `chatAllowed`, where the preference may only ever NARROW what the profile already allows.
 */
export function resolveRemoteConsent(
  allowSessions: boolean | undefined,
  allowScreens: boolean | undefined,
): RemoteSessionConsent {
  const sessions = allowSessions === true
  return { sessions, screens: sessions && allowScreens === true }
}
