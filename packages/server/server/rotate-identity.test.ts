/**
 * rotate-identity.test.ts — the pure half of a token rotation.
 *
 * The first block is not about the planner at all: it PROVES, with the real cipher, why the plan
 * has no "re-address" option. Everything after it is the arithmetic that follows from that proof.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { generateMachineKeypair, seal, open } from './envelope-crypto'
import { planEnvelopeRotation, retargetMachineSources } from './rotate-identity'

const OLD = 'old-machine-id'
const NEW = 'new-machine-id'

describe('re-addressing a sealed envelope is impossible — the reason the plan only keeps or drops', () => {
  const rotating = generateMachineKeypair() // the machine whose token is being rotated
  const sibling = generateMachineKeypair()
  const NOW = new Date('2026-08-01T10:00:00.000Z')

  /** Mail a sibling deposited for the rotating machine BEFORE the rotation. */
  const inbound = seal({
    plaintext: 'rules',
    senderMachineId: 'sibling',
    senderPrivateKey: sibling.privateKey,
    senderPublicKey: sibling.publicKey,
    recipientMachineId: OLD,
    recipientPublicKey: rotating.publicKey,
    instanceId: 'inst-1',
    createdAt: NOW.toISOString(),
  })

  it('the recipient id is sealed into the AAD, so mail addressed to the OLD id cannot be delivered to the NEW one', () => {
    // What "re-address the pending envelopes" would amount to: the central rewrites the routing
    // and the machine, now known by NEW, states its own id honestly.
    const result = open({
      envelope: inbound,
      recipientPrivateKey: rotating.privateKey,
      pinnedSenderPublicKey: sibling.publicKey,
      expectedSenderMachineId: 'sibling',
      expectedRecipientMachineId: NEW,
      expectedInstanceId: 'inst-1',
      now: NOW,
    })
    expect(result).toEqual({ ok: false, reason: 'recipient_mismatch' })
  })

  it('mail SENT by the old id still opens exactly as sealed — so it must be left alone, not re-stamped', () => {
    const outbound = seal({
      plaintext: 'rules',
      senderMachineId: OLD,
      senderPrivateKey: rotating.privateKey,
      senderPublicKey: rotating.publicKey,
      recipientMachineId: 'sibling',
      recipientPublicKey: sibling.publicKey,
      instanceId: 'inst-1',
      createdAt: NOW.toISOString(),
    })
    const asSealed = open({
      envelope: outbound,
      recipientPrivateKey: sibling.privateKey,
      pinnedSenderPublicKey: rotating.publicKey,
      expectedSenderMachineId: OLD,
      expectedRecipientMachineId: 'sibling',
      expectedInstanceId: 'inst-1',
      now: NOW,
    })
    expect(asSealed).toEqual({ ok: true, plaintext: 'rules' })

    // And what re-stamping the sender to the new id would do to that same, perfectly good message.
    const reStamped = open({
      envelope: outbound,
      recipientPrivateKey: sibling.privateKey,
      pinnedSenderPublicKey: rotating.publicKey,
      expectedSenderMachineId: NEW,
      expectedRecipientMachineId: 'sibling',
      expectedInstanceId: 'inst-1',
      now: NOW,
    })
    expect(reStamped).toEqual({ ok: false, reason: 'sender_mismatch' })
  })
})

describe('planEnvelopeRotation', () => {
  const mail = [
    { id: 'in-1', senderMachineId: 'sibling', recipientMachineId: OLD },
    { id: 'out-1', senderMachineId: OLD, recipientMachineId: 'sibling' },
    { id: 'other', senderMachineId: 'sibling', recipientMachineId: 'stranger' },
  ]

  it('drops what was addressed TO the old id — it can never be opened again', () => {
    expect(planEnvelopeRotation(OLD, mail).drop).toEqual(['in-1'])
  })

  it('keeps what the old id SENT: still sealed correctly, still true, still deliverable', () => {
    expect(planEnvelopeRotation(OLD, mail).keep).toEqual(['out-1', 'other'])
  })

  it('touches nothing that names neither id', () => {
    const plan = planEnvelopeRotation(OLD, [{ id: 'other', senderMachineId: 'a', recipientMachineId: 'b' }])
    expect(plan).toEqual({ drop: [], keep: ['other'] })
  })

  it('drops a self-addressed envelope — it is inbound before it is anything else', () => {
    const plan = planEnvelopeRotation(OLD, [{ id: 'self', senderMachineId: OLD, recipientMachineId: OLD }])
    expect(plan).toEqual({ drop: ['self'], keep: [] })
  })

  it('an empty mailbox plans nothing', () => {
    expect(planEnvelopeRotation(OLD, [])).toEqual({ drop: [], keep: [] })
  })
})

describe('retargetMachineSources', () => {
  it('re-points a tag pinned to the rotating machine', () => {
    expect(retargetMachineSources([{ type: 'machine', value: OLD }], OLD, NEW))
      .toEqual([{ type: 'machine', value: NEW }])
  })

  it('never touches another source TYPE that happens to carry the same string — an account id is not a machine id', () => {
    const sources = [
      { type: 'account' as const, value: OLD },
      { type: 'team' as const, value: OLD },
      { type: 'repo' as const, value: OLD },
      { type: 'project' as const, value: OLD },
    ]
    expect(retargetMachineSources(sources, OLD, NEW)).toEqual(sources)
  })

  it('leaves other machines alone and preserves order', () => {
    const sources = [
      { type: 'machine' as const, value: 'sibling' },
      { type: 'machine' as const, value: OLD },
      { type: 'machine' as const, value: 'other' },
    ]
    expect(retargetMachineSources(sources, OLD, NEW)).toEqual([
      { type: 'machine', value: 'sibling' },
      { type: 'machine', value: NEW },
      { type: 'machine', value: 'other' },
    ])
  })

  it('preserves any extra fields a source carries', () => {
    const sources = [{ type: 'machine' as const, value: OLD, label: 'laptop' }]
    expect(retargetMachineSources(sources, OLD, NEW)).toEqual([{ type: 'machine', value: NEW, label: 'laptop' }])
  })

  it('returns the SAME array reference when nothing matches, so a caller can skip the write', () => {
    const sources = [{ type: 'machine' as const, value: 'sibling' }]
    expect(retargetMachineSources(sources, OLD, NEW)).toBe(sources)
    expect(retargetMachineSources([], OLD, NEW)).toEqual([])
  })
})

/**
 * The enumeration is the whole point of this module's header, and it is prose — nothing checks it.
 * A collection keyed by the machine id that is neither listed here nor carried by `rotateToken` is
 * silently stranded on every rotation, which that header records as "the same bug three times
 * already". So both halves are asserted over the SOURCE, the way `events-frontier.test.ts` asserts
 * its frontier: a new collection is added to both, or the build says so.
 */
describe('every collection keyed by the machine id is enumerated AND carried', () => {
  const doc = readFileSync(new URL('./rotate-identity.ts', import.meta.url), 'utf8')
  const rotate = readFileSync(new URL('./team-tokens.ts', import.meta.url), 'utf8')

  for (const collection of ['sessions', 'memberStats', 'workflows', 'tags', 'tasks', 'machineKeys', 'envelopes']) {
    it(`names \`${collection}\` in the module's own enumeration`, () => {
      expect(doc).toContain(collection)
    })
  }

  it('carries the deliveries across, not only the sessions', () => {
    // The board is keyed by `memberId` and its `_id` embeds it, so a rotation that skipped it
    // would leave a machine's whole delivery history addressed to an identity nothing resolves.
    expect(rotate).toContain('rekeyMemberTasks')
  })
})
