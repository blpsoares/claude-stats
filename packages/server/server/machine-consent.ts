/**
 * machine-consent.ts — central-side registry of what each MACHINE has agreed a central may do with
 * its sessions.
 *
 * The same shape as `team-live.ts`, and for the same reasons. A central cannot read a member's
 * preferences and must never ask: the member ANNOUNCES its consent over the reverse channel
 * (`remote-consent`, `team-agent-client.ts`), on connect and again the instant a switch moves. The
 * central only records what arrived.
 *
 * NOTHING IS PERSISTED, and the lifetime is the socket's. A consent is a statement the machine is
 * making right now; a machine that is gone is not making it. Keeping the last known answer would
 * make the central say "this machine allows session management" about a laptop that has been shut
 * for a week — an answer that reads as current and is not. So `forgetMachineConsent` is called from
 * the same place `clearMemberLive` is (`unregisterAgent`, once a machine's last socket closes), and
 * an absent record means exactly one thing: **this machine has not said**. That is deliberately the
 * same answer for "offline", "older version with no announcement" and "connected but silent" — the
 * central cannot tell those apart, and `team-agent.ts`'s presence signal is what separates offline
 * from the rest for the UI.
 *
 * Keyed by `memberId` (the token hash), never by display name — `team-live.ts` records what keying
 * by name cost: two machines of one person overwrote each other.
 *
 * The registry stores the RESOLVED pair, never the two raw switches. `resolveRemoteConsent`
 * (`@agentistics/core`) is the only place the rule that screens require sessions lives, and it runs
 * on the machine that owns the answer.
 */

import type { RemoteSessionConsent } from '@agentistics/core'
import { NO_REMOTE_CONSENT } from '@agentistics/core'

export interface MachineConsentRecord extends RemoteSessionConsent {
  /** ms epoch of the announcement this record came from. Reported so a UI can say how fresh the
   *  statement is; never used to expire it — the socket's lifetime does that. */
  atMs: number
}

const consents = new Map<string, MachineConsentRecord>()

/**
 * Record one machine's announcement.
 *
 * `machineId` comes from the AUTHENTICATED SOCKET and never from the frame — the same rule
 * `recordMemberLive` follows, and the reason is the same: a member must not be able to speak for
 * another machine. Both flags are read as literal booleans, so a malformed frame that reached here
 * with a truthy string agrees to nothing.
 */
export function recordMachineConsent(
  machineId: string,
  sessions: unknown,
  screens: unknown,
  atMs: number = Date.now(),
): void {
  if (!machineId) return
  const ok = sessions === true
  consents.set(machineId, { sessions: ok, screens: ok && screens === true, atMs })
}

/** Drop a machine's record — its last socket closed, so it is no longer stating anything. */
export function forgetMachineConsent(machineId: string): void {
  consents.delete(machineId)
}

/**
 * What this machine has agreed to, or `null` if it has not said.
 *
 * `null` and `{sessions:false}` are DIFFERENT answers and both are needed: "this machine has not
 * told us" sends the owner to check whether it is running, and "this machine says no" sends them to
 * the switch. Collapsing them into one falsy value is how a feature ends up telling somebody their
 * machine refuses when it is merely off.
 */
export function machineConsent(machineId: string): MachineConsentRecord | null {
  return consents.get(machineId) ?? null
}

/** The consent to ACT on, for a machine that may not have said anything. Nothing agreed is the
 *  answer for silence — the enforcement side never has to handle `null`. */
export function effectiveConsent(machineId: string): RemoteSessionConsent {
  const rec = consents.get(machineId)
  return rec ? { sessions: rec.sessions, screens: rec.screens } : NO_REMOTE_CONSENT
}

/** Test seam — the registry is process-global, like `team-live`'s. */
export function resetMachineConsent(): void {
  consents.clear()
}
