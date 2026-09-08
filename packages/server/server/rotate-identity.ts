/**
 * rotate-identity.ts — PURE decisions taken when a machine's token is rotated.
 *
 * A machine's identity on a central IS the hash of its token (`memberId = sha256(token)`), so
 * rotating the token renames the machine in every collection keyed by that id. `rotateToken`
 * (team-tokens.ts) carries those keys across; this module holds the two decisions that are not
 * mechanical, so they can be tested without Mongo.
 *
 * WHAT IS KEYED BY THE MACHINE ID, and what rotation does with each:
 *
 *   tokens        `_id`                                  MIGRATED — the token doc itself
 *   sessions      `memberId` + `_id` (teamDocId)         MIGRATED
 *   memberStats   `_id`                                  MIGRATED
 *   workflows     `memberId` + `_id` (teamWorkflowDocId) MIGRATED
 *   tasks         `memberId` + `_id` (teamTaskDocId)     MIGRATED — the shared delivery board
 *   machineKeys   `_id`                                  MIGRATED — the machine's own published key
 *   tags          `sources[]`/`filters[]` of type        RETARGETED — a tag pinned to the machine
 *                 `machine`, whose `value` is the id
 *   envelopes     `senderMachineId` / `recipientMachineId`  see `planEnvelopeRotation` below
 *   audit         `targetId`                             LEFT AS WRITTEN — an audit log records
 *                 what was true at the time; rewriting history is the opposite of its purpose
 *
 * NOT keyed by it, and therefore untouched — stated because each one looks like it might be:
 *   - CI sessions are keyed by `ciMemberId(remote)` = `repo:<remote>`, derived from the repository,
 *     not from the token. Rotating a repo's CI token does not move a single CI session.
 *   - The member side's per-connection state (sent-state, envelope pins, inbox) is named by the
 *     LOCAL connection id, never by the central's memberId. A rotation is picked up there by the
 *     sync fingerprint `sha256(endpoint \0 token \0 instanceId)` changing, which re-pushes the
 *     full history — already the designed behaviour.
 *
 * SIBLING PINS ARE DELIBERATELY NOT CARRIED ACROSS. To a sibling the rotated machine is a machine
 * it has never seen: it pins the key on first sight and says so (`member.peer_pinned`). Carrying
 * continuity would mean a sibling believing "this new id is the machine you already trust", and
 * every carrier of that claim crosses the central:
 *   - a "formerly <oldId>" field is a central assertion, i.e. exactly the forgery the channel
 *     exists to refuse;
 *   - "the key is the same, so the machine is the same" is no better — a public key is public, so
 *     a central can list an INVENTED machine carrying a key it copied from a real one. Treating a
 *     familiar key as proof of continuity would let it suppress the announcement, converting the
 *     one control against a fabricated peer into something the central can switch off.
 * A sound proof exists in principle — the OLD private key signing the NEW id — but rotation is
 * initiated on the central and the machine learns its new id only afterwards, so it cannot sign
 * it in advance. The identity really did change; the honest outcome is that the rotation SAYS so.
 */

/** The routing metadata of one stored envelope — everything the plan needs, nothing more. */
export interface EnvelopeRouting {
  id: string
  senderMachineId: string
  recipientMachineId: string
}

/**
 * What becomes of the mailbox when `oldId` stops existing.
 *
 * There is deliberately no third option: an envelope is never RE-ADDRESSED. The whole header —
 * sender, recipient, central and date — is the GCM additional-authenticated data, so the routing
 * cannot be rewritten without destroying the seal, and `open` compares each of those fields
 * against what the transport claimed before any key agreement happens. Concretely
 * (`rotate-identity.test.ts` proves both against the real cipher):
 *
 *   - mail addressed TO the old id yields `recipient_mismatch` when the machine, now known by the
 *     new id, states its own identity honestly. It is undeliverable to anyone, forever, so it is
 *     DROPPED rather than left to rot until retention — the same reasoning `revokeToken` applies
 *     to a mailbox nobody will collect. The loss is bounded and recoverable: every message is a
 *     full snapshot which its sender re-announces on its next rules change, and the FACTS the
 *     machine has already collected live in its own inbox and survive the rotation untouched.
 *   - mail SENT by the old id still opens exactly as sealed: the recipient's pin is for the old
 *     id, the sealed header names the old id, and the transport still says the old id. It is a
 *     true announcement that is still deliverable, so it is KEPT. Re-stamping the sender would
 *     turn it into `sender_mismatch` — a good message destroyed to make a field look tidy.
 */
export interface EnvelopeRotationPlan {
  /** Envelope ids to delete. */
  drop: string[]
  /** Envelope ids to leave exactly as they are. */
  keep: string[]
}

export function planEnvelopeRotation(oldId: string, envelopes: readonly EnvelopeRouting[]): EnvelopeRotationPlan {
  const drop: string[] = []
  const keep: string[] = []
  for (const e of envelopes) {
    // Inbound first: a self-addressed envelope (which should not exist) is inbound before it is
    // anything else, and inbound is the undeliverable case.
    if (e.recipientMachineId === oldId) drop.push(e.id)
    else keep.push(e.id)
  }
  return { drop, keep }
}

/** The shape `tags-resolve.ts`'s `TagSource` has, kept structural so this module imports nothing. */
interface MachineSource {
  type: string
  value: string
}

/**
 * Re-point every source that names the rotating MACHINE, and nothing else.
 *
 * The type check is load-bearing rather than defensive: a tag's sources are a union of five kinds
 * of id in one `value` field, and matching on the string alone would silently re-point an
 * `account` or `team` source that happened to carry the same characters — a tag quietly changing
 * what it measures. Returns the input array unchanged (same reference) when nothing matches, so a
 * caller can skip the write.
 */
export function retargetMachineSources<T extends MachineSource>(sources: readonly T[], oldId: string, newId: string): T[] {
  const hit = sources.some(s => s.type === 'machine' && s.value === oldId)
  if (!hit) return sources as T[]
  return sources.map(s => (s.type === 'machine' && s.value === oldId ? { ...s, value: newId } : s))
}
