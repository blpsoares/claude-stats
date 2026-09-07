import { describe, it, expect } from 'bun:test'
import { resolveMachineFleet, resolveMachineAction, type MachineFleetRouteDeps } from './machine-fleet-route'

const owner = { accountId: 'o1', role: 'owner', memberships: [] }
const bob = { accountId: 'bob', role: 'member', memberships: [] }
const carol = { accountId: 'carol', role: 'member', memberships: [] }

const reply = { rows: [], attention: 2, withheld: 1 }

function deps(over: Partial<MachineFleetRouteDeps> = {}): MachineFleetRouteDeps {
  return {
    listMachines: async () => [{ id: 'm1', accountIds: ['bob'] }],
    isOnline: () => true,
    consentOf: () => ({ sessions: true, screens: false }),
    request: async () => reply,
    ...over,
  }
}

describe('resolveMachineFleet', () => {
  it('the owning account gets the fleet', async () => {
    expect(await resolveMachineFleet(bob, 'm1', deps())).toEqual({ reply })
  })

  it('the INSTANCE OWNER is refused — administering a machine is not reaching into its sessions', async () => {
    // The whole point of machineOwnedBy existing beside canManageMachine, asserted at the route.
    expect(await resolveMachineFleet(owner, 'm1', deps())).toEqual({ reply: null, reason: 'not-owner' })
  })

  it('another account is refused', async () => {
    expect(await resolveMachineFleet(carol, 'm1', deps())).toEqual({ reply: null, reason: 'not-owner' })
  })

  it('an UNKNOWN machine answers exactly like one you do not own — never an existence oracle', async () => {
    // Distinguishing them would tell a caller whether a machine id exists on this central.
    expect(await resolveMachineFleet(bob, 'nope', deps())).toEqual({ reply: null, reason: 'not-owner' })
  })

  it('a machine that says no is REFUSED, not empty', async () => {
    const r = await resolveMachineFleet(bob, 'm1', deps({ consentOf: () => ({ sessions: false, screens: false }) }))
    expect(r).toEqual({ reply: null, reason: 'refused' })
  })

  it('a machine that says no while OFFLINE reports offline — the more actionable half', async () => {
    // A machine that has never spoken has no consent recorded and no socket. Calling that
    // "refused" sends its owner to a switch that is already off.
    const r = await resolveMachineFleet(bob, 'm1', deps({
      consentOf: () => ({ sessions: false, screens: false }),
      isOnline: () => false,
    }))
    expect(r).toEqual({ reply: null, reason: 'offline' })
  })

  it('a consenting machine with no socket is OFFLINE', async () => {
    const r = await resolveMachineFleet(bob, 'm1', deps({ isOnline: () => false }))
    expect(r).toEqual({ reply: null, reason: 'offline' })
  })

  it('a consenting, connected machine that does not answer is SILENT', async () => {
    // An older build with no handler, or a wedged one. Three silences, three sentences.
    const r = await resolveMachineFleet(bob, 'm1', deps({ request: async () => null }))
    expect(r).toEqual({ reply: null, reason: 'silent' })
  })

  it('the four reasons are all distinct — an empty list never stands in for any of them', async () => {
    const seen = new Set<string>()
    seen.add((await resolveMachineFleet(owner, 'm1', deps())).reason!)
    seen.add((await resolveMachineFleet(bob, 'm1', deps({ consentOf: () => ({ sessions: false, screens: false }) }))).reason!)
    seen.add((await resolveMachineFleet(bob, 'm1', deps({ isOnline: () => false }))).reason!)
    seen.add((await resolveMachineFleet(bob, 'm1', deps({ request: async () => null }))).reason!)
    expect(seen).toEqual(new Set(['not-owner', 'refused', 'offline', 'silent']))
  })

  it('the legacy single accountId field still identifies an owner', async () => {
    const r = await resolveMachineFleet(bob, 'm1', deps({
      listMachines: async () => [{ id: 'm1', accountId: 'bob' }],
    }))
    expect(r).toEqual({ reply: reply })
  })

  it('a machine owned by nobody is reachable by nobody, the instance owner included', async () => {
    const loose = deps({ listMachines: async () => [{ id: 'm1' }] })
    expect((await resolveMachineFleet(owner, 'm1', loose)).reason).toBe('not-owner')
    expect((await resolveMachineFleet(bob, 'm1', loose)).reason).toBe('not-owner')
  })
})

describe('resolveMachineAction', () => {
  const done = { ok: true, message: 'renamed' }
  const rename = { action: 'rename', id: 's1', text: 'x' }
  function adeps(over: Partial<MachineFleetRouteDeps & { act: unknown }> = {}) {
    return {
      ...deps(),
      act: async () => done,
      ...over,
    } as never
  }

  it('the owning account may perform a screenless verb', async () => {
    expect(await resolveMachineAction(bob, 'm1', rename, adeps())).toEqual({ reply: done })
  })

  it('the instance owner may not — the same refusal as the read', async () => {
    expect((await resolveMachineAction(owner, 'm1', rename, adeps())).reason).toBe('not-owner')
  })

  it('refuses approve and prompt BEFORE the round trip', async () => {
    // The machine refuses them too; this check only spares the member a pointless trip and gives
    // the user an instant answer.
    let asked = 0
    for (const action of ['approve', 'prompt']) {
      const r = await resolveMachineAction(bob, 'm1', { action, id: 's1' },
        adeps({ act: async () => { asked++; return done } }))
      expect(r.reason).toBe('refused')
    }
    expect(asked).toBe(0)
  })

  it('refuses an unknown verb without asking the machine', async () => {
    let asked = 0
    const r = await resolveMachineAction(bob, 'm1', { action: 'wipe', id: 's1' },
      adeps({ act: async () => { asked++; return done } }))
    expect(r.reason).toBe('refused')
    expect(asked).toBe(0)
  })

  it('a withdrawn consent refuses, and never asks', async () => {
    let asked = 0
    const r = await resolveMachineAction(bob, 'm1', rename, adeps({
      consentOf: () => ({ sessions: false, screens: false }),
      act: async () => { asked++; return done },
    }))
    expect(r.reason).toBe('refused')
    expect(asked).toBe(0)
  })

  it('an offline machine is offline, not silent', async () => {
    expect((await resolveMachineAction(bob, 'm1', rename, adeps({ isOnline: () => false }))).reason).toBe('offline')
  })

  it('a machine that does not answer is SILENT — the verb may or may not have run', async () => {
    expect((await resolveMachineAction(bob, 'm1', rename, adeps({ act: async () => null }))).reason).toBe('silent')
  })

  it("passes the machine's own refusal through untouched", async () => {
    // The central composes no wording of its own: the machine owns every refusal it makes.
    const refusal = { ok: false, message: 'esta sessão não está rodando' }
    const r = await resolveMachineAction(bob, 'm1', rename, adeps({ act: async () => refusal }))
    expect(r).toEqual({ reply: refusal })
  })
})
