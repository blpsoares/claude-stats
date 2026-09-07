/**
 * machine-fleet-relay.ts — the CENTRAL side of asking one machine for its fleet.
 *
 * Everything on the reverse channel before this was one-directional and uncorrelated:
 * `notifyMember` pushes and forgets, and the member's own frames (`live-sessions`,
 * `remote-consent`) are unsolicited statements about the machine that sent them. A relay needs a
 * QUESTION and an answer that can be matched to it, which is the one piece of new mechanism this
 * feature adds — so it is deliberately the narrowest thing that works, and not a general RPC.
 *
 * The rules, each mirroring one this channel already follows:
 *
 *  - **One in flight per machine.** A central that can queue work on a member is a central that
 *    can wedge it. A second request while one is open joins the SAME promise rather than opening
 *    another: two dashboards polling the same machine is the normal case, not an abuse.
 *  - **A timeout, always.** A member that never answers (an older build with no handler, a wedged
 *    process) must resolve to a SENTENCE and not to a hung request. That timeout is the only
 *    signal distinguishing "silent" from "refused", so it is the reason `silent` exists as its own
 *    reason code.
 *  - **A reply with no matching in-flight request is DROPPED.** An unsolicited `fleet-reply` is
 *    not a fact about anything, and accepting one would let a member push a fleet nobody asked for
 *    into whatever read next.
 *  - **The machine id comes from the AUTHENTICATED SOCKET**, never from the frame — the same rule
 *    `recordMemberLive` and `recordMachineConsent` follow, so a member cannot answer for another
 *    machine. This module therefore keys pending requests by machine AND rid, and a reply is only
 *    accepted from the machine the question was sent to.
 *
 * Nothing here is persisted. A fleet is true for the next few seconds, exactly like `team-live`'s
 * snapshots, and a cached one would be a confident answer about a machine that has since gone.
 */

import type { MachineFleetReply, MachineActionReply } from '@agentistics/core'

/** How long a machine has to answer before the central reports it as silent. Generous next to the
 *  5s poll a cockpit runs, because the member builds a real fleet (a tmux round trip per session)
 *  and a timeout that fires while the answer is still coming would report a healthy machine as
 *  broken — the failure this whole reason code exists to avoid making. */
export const FLEET_REPLY_TIMEOUT_MS = 12_000

/**
 * A question's kind. Reads and actions are tracked SEPARATELY, and that separation is load-bearing:
 * they share a machine but not a slot. Keying "one in flight" by machine alone would have a
 * dashboard's background read block the button the user just pressed, or the reverse — the read is
 * the frequent one and the action is the one somebody is waiting on.
 */
type Kind = 'read' | 'act'

interface Pending<T> {
  rid: string
  resolve: (reply: T | null) => void
  timer: ReturnType<typeof setTimeout>
  /** Everyone waiting on THIS question. A second asker joins rather than opening a second one. */
  promise: Promise<T | null>
  /** How to read the raw frame. Per KIND, because a fleet and an action answer different shapes,
   *  and because the member is authenticated rather than verified: a malformed reply must degrade
   *  to something renderable, never crash the route that is trying to explain itself. */
  normalize: (raw: unknown) => T | null
}

/** Keyed `<kind>:<machineId>` — one read and one action may be open at once for one machine. */
const pending = new Map<string, Pending<unknown>>()
let ridSeq = 0

function slot(kind: Kind, machineId: string): string {
  return `${kind}:${machineId}`
}

function nextRid(): string {
  ridSeq += 1
  return `f${Date.now().toString(36)}${ridSeq.toString(36)}`
}

/**
 * Ask one machine for its fleet and wait for the answer.
 *
 * Resolves to `null` on a timeout — "this machine did not answer" — which the route turns into the
 * `silent` reason. It never throws: a relay that rejects would surface as a 500 on a route whose
 * whole job is to say, in words, why there is nothing to show.
 */
export function requestMachineFleet(
  machineId: string,
  send: (payload: Record<string, unknown>) => void,
  timeoutMs: number = FLEET_REPLY_TIMEOUT_MS,
): Promise<MachineFleetReply | null> {
  // Two dashboards polling one machine is the normal case, and the question is IDENTICAL, so a
  // second asker joins the open one. Opening a second asks the member to build the same fleet
  // twice for the same answer.
  return ask<MachineFleetReply>('read', machineId, { type: 'fleet-request', op: 'read' }, send, timeoutMs, true, normalizeFleetReply)
}

/**
 * Perform one verb on one of that machine's sessions, and wait for its answer.
 *
 * NEVER joins an open request, unlike the read: two actions are two different acts even when they
 * name the same verb, and collapsing them would report one person's result to somebody who asked
 * for something else. A second action while one is in flight is REFUSED (`null` → the caller says
 * the machine did not answer) rather than queued: a central that can stack work on a member is a
 * central that can wedge it, and a queued keystroke arriving a minute late is worse than one that
 * plainly did not happen.
 *
 * The member re-checks its own consent and the verb allowlist; nothing decided here is trusted
 * there.
 */
export function requestMachineAction(
  machineId: string,
  /** `choice` is the option the person picked off the relayed dialog — see `machineFleet.ts`. */
  action: { action: string; id: string; text?: string; choice?: number },
  send: (payload: Record<string, unknown>) => void,
  timeoutMs: number = FLEET_REPLY_TIMEOUT_MS,
): Promise<MachineActionReply | null> {
  return ask<MachineActionReply>('act', machineId, { type: 'fleet-request', op: 'act', ...action }, send, timeoutMs, false, normalizeActionReply)
}

function ask<T>(
  kind: Kind,
  machineId: string,
  body: Record<string, unknown>,
  send: (payload: Record<string, unknown>) => void,
  timeoutMs: number,
  join: boolean,
  normalize: (raw: unknown) => T | null,
): Promise<T | null> {
  const key = slot(kind, machineId)
  const existing = pending.get(key)
  if (existing) return join ? (existing.promise as Promise<T | null>) : Promise.resolve(null)

  const rid = nextRid()
  let settle: (reply: T | null) => void = () => {}
  const promise = new Promise<T | null>(res => { settle = res })

  const finish = (reply: T | null) => {
    const p = pending.get(key)
    if (!p || p.rid !== rid) return
    clearTimeout(p.timer)
    pending.delete(key)
    ;(p.resolve as (r: T | null) => void)(reply)
  }

  const timer = setTimeout(() => finish(null), timeoutMs)
  timer.unref?.()
  pending.set(key, {
    rid, resolve: settle as (r: unknown) => void, timer, promise,
    normalize: normalize as (raw: unknown) => unknown,
  } as Pending<unknown>)

  try {
    send({ ...body, rid })
  } catch {
    // The socket died between the presence check and the send. Resolve as silence rather than
    // leaving the caller on the timeout — the answer is the same, sooner.
    finish(null)
  }
  return promise
}

/**
 * A machine answered. `machineId` MUST come from the authenticated socket.
 *
 * Returns whether the reply was matched, so the caller can tell an answer from noise; an unmatched
 * one is dropped rather than stored, because a reply nobody asked for is not a fact about anything.
 */
export function acceptMachineFleetReply(machineId: string, rid: unknown, reply: unknown): boolean {
  if (typeof rid !== 'string' || !rid) return false
  // Searched across this machine's OWN slots only. The rid alone would be enough to find the
  // question, and that is exactly why it is not the key: a member must not be able to answer one
  // the central asked of a different machine, and the id here comes from the authenticated socket.
  for (const kind of ['read', 'act'] as const) {
    const key = slot(kind, machineId)
    const p = pending.get(key)
    if (!p || p.rid !== rid) continue
    clearTimeout(p.timer)
    pending.delete(key)
    p.resolve(p.normalize(reply))
    return true
  }
  return false
}

/**
 * Trust nothing about the shape. The member is authenticated, not verified: a malformed reply must
 * degrade to an empty fleet with the counts it could establish, never crash the route or render as
 * `undefined` cells. A row list that is not an array is not "no sessions" — but there is nothing
 * else it can be reported as here, so `withheld` and `attention` are still carried through when
 * they are numbers, and the reason is the machine's own `unavailable` sentence when it sent one.
 */
function normalizeFleetReply(raw: unknown): MachineFleetReply | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  return {
    rows: Array.isArray(r.rows) ? (r.rows as MachineFleetReply['rows']) : [],
    attention: typeof r.attention === 'number' && r.attention >= 0 ? r.attention : 0,
    withheld: typeof r.withheld === 'number' && r.withheld >= 0 ? r.withheld : 0,
    ...(typeof r.unavailable === 'string' && r.unavailable ? { unavailable: r.unavailable } : {}),
  }
}

/** A machine's socket dropped — nobody is going to answer. Resolves any open question at once
 *  instead of making its asker wait out the timeout for an answer that cannot come. */
export function abandonMachineFleet(machineId: string): void {
  for (const kind of ['read', 'act'] as const) {
    const key = slot(kind, machineId)
    const p = pending.get(key)
    if (!p) continue
    clearTimeout(p.timer)
    pending.delete(key)
    p.resolve(null)
  }
}

/**
 * Read an action's answer. `ok` is trusted only as a literal boolean, and `message` must be a real
 * sentence: the machine owns the wording of every refusal it makes, so an answer with no words is
 * an answer this central cannot render — reported as a failure with a sentence of its own rather
 * than as a silent success.
 */
function normalizeActionReply(raw: unknown): MachineActionReply | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.message !== 'string' || !r.message) return null
  return { ok: r.ok === true, message: r.message }
}

/** Test seam — the map is process-global, like every other registry on this channel. */
export function resetMachineFleetRelay(): void {
  for (const p of pending.values()) { clearTimeout(p.timer); p.resolve(null) }
  pending.clear()
}
