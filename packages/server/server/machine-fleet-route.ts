/**
 * machine-fleet-route.ts — GET /api/team/machine-fleet?machineId=…
 *
 * The central's side of the question, and the place every refusal is decided. It does NO host work
 * of its own: `readFleet` reads the tmux server and `/proc` of the box serving the request, so a
 * central answering from its own machine would serve its own processes under a member's name —
 * which is exactly what the `TEAM_CENTRAL` block on `/api/fleet*` exists to prevent. That block,
 * and `capability-guard.ts`'s `localShell` on the same paths, are untouched: this is a different
 * route with a different job, and it only ever RELAYS.
 *
 * It is deliberately NOT registered in `capability-guard.ts`. The guard maps a path to the local
 * capability it needs, and this path needs none — it spawns nothing, reads no transcript and
 * touches no dotfile. The decision is written down here rather than left as an omission, because
 * the guard's own rule is that an unregistered route is assumed harmless and a missed registration
 * is a vulnerability; `capability-guard.test.ts` pins that this path resolves to `null` on purpose.
 *
 * THREE GATES, in this order, and the order is the point:
 *   1. a signed-in principal;
 *   2. `machineSessionsAllowed` — the accounts the machine was CREATED for plus any EXPLICITLY
 *      granted session management (`@agentistics/core/machineSessions`), deliberately narrower
 *      than `machineOwnedBy`, which is itself narrower than the
 *      `canManageMachine` that governs renaming and re-assigning it. An instance owner who is not
 *      this machine's user is refused here, and gets the same `not-owner` answer as a stranger;
 *   3. the MACHINE's own consent, as it last announced it.
 *
 * And three silences, kept apart because they send a person to three different places:
 * `offline` (no socket), `refused` (the machine says no), `silent` (connected, did not answer).
 * An empty list is never allowed to stand in for any of them.
 */

import type { MachineActionReply, MachineFleetAnswer } from '@agentistics/core'
import { remoteActionAllowed } from '@agentistics/core'

export interface MachineFleetRouteDeps {
  /** The machines this central knows, already loaded. */
  listMachines: () => Promise<{ id: string; accountId?: string; accountIds?: string[] }[]>
  /** Is a socket live for this machine right now? */
  isOnline: (machineId: string) => boolean
  /** What the machine last announced it permits. */
  consentOf: (machineId: string) => { sessions: boolean; screens: boolean }
  /** Ask it, and wait. `null` = it did not answer. */
  request: (machineId: string) => Promise<import('@agentistics/core').MachineFleetReply | null>
}

/**
 * Resolve one request into an answer. Pure of HTTP, so every refusal is a table of unit tests
 * rather than a live socket and a signed-in browser.
 *
 * An unknown machine and a machine somebody else owns both answer `not-owner`. That is deliberate:
 * distinguishing them would tell a caller whether a machine id EXISTS on this central, which is
 * the same oracle `tags-handlers.ts` avoids by answering 404 for a tag the viewer cannot see.
 */
export async function resolveMachineFleet(
  principal: { accountId: string; role: string },
  machineId: string,
  deps: MachineFleetRouteDeps,
): Promise<MachineFleetAnswer> {
  const { machineSessionsAllowed } = await import('@agentistics/core')
  const machine = (await deps.listMachines()).find(m => m.id === machineId)
  if (!machine) return { reply: null, reason: 'not-owner' }
  if (!machineSessionsAllowed(principal as never, machine)) return { reply: null, reason: 'not-owner' }

  // Consent is checked BEFORE presence, so a machine that has said no is reported as refusing even
  // while it happens to be offline. The switch is the durable fact; being offline is a moment.
  const consent = deps.consentOf(machineId)
  if (!consent.sessions) {
    // A machine that has never spoken has no consent recorded and no socket either — reporting
    // that as `refused` would send its owner to a switch that is already off, so an OFFLINE
    // machine with nothing recorded is reported as offline, which is the more actionable half.
    return { reply: null, reason: deps.isOnline(machineId) ? 'refused' : 'offline' }
  }
  if (!deps.isOnline(machineId)) return { reply: null, reason: 'offline' }

  const reply = await deps.request(machineId)
  if (!reply) return { reply: null, reason: 'silent' }
  return { reply }
}

export interface MachineActionAnswer {
  reply: MachineActionReply | null
  reason?: import('@agentistics/core').MachineFleetUnavailable
}

/**
 * Resolve one VERB on one of another machine's sessions.
 *
 * The same three gates as the read, in the same order, plus the verb allowlist. That allowlist runs
 * here as well as on the machine, and neither check is redundant: this one spares a member a
 * pointless round trip and gives the user an instant answer, while the machine's is the one that
 * actually decides — a central is the party whose behaviour a machine cannot verify.
 *
 * A refused verb answers `refused`, the same code a withdrawn consent gets, because from the
 * caller's side they are one fact: this machine will not do it. The MACHINE's own sentence is what
 * the UI shows whenever there is one; the central composes no wording of its own.
 */
export async function resolveMachineAction(
  principal: { accountId: string; role: string },
  machineId: string,
  action: { action: string; id: string; text?: string; choice?: number },
  deps: MachineFleetRouteDeps & { act: (machineId: string, a: { action: string; id: string; text?: string; choice?: number }) => Promise<MachineActionReply | null> },
): Promise<MachineActionAnswer> {
  const { machineSessionsAllowed } = await import('@agentistics/core')
  const machine = (await deps.listMachines()).find(m => m.id === machineId)
  if (!machine) return { reply: null, reason: 'not-owner' }
  if (!machineSessionsAllowed(principal as never, machine)) return { reply: null, reason: 'not-owner' }

  const consent = deps.consentOf(machineId)
  if (!consent.sessions) return { reply: null, reason: deps.isOnline(machineId) ? 'refused' : 'offline' }
  if (!remoteActionAllowed(action.action, consent)) return { reply: null, reason: 'refused' }
  if (!deps.isOnline(machineId)) return { reply: null, reason: 'offline' }

  const reply = await deps.act(machineId, action)
  if (!reply) return { reply: null, reason: 'silent' }
  return { reply }
}
