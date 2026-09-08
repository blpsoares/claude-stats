import { describe, expect, it } from 'bun:test'
import { centralMachineList, pickCentralMachine } from './centralMachines'

const ME = 'acct-me'
const granted = { sessions: true, screens: true, atMs: 1 }
const grantedNoScreen = { sessions: true, screens: false, atMs: 1 }

describe('centralMachineList', () => {
  it('offers a machine that ANNOUNCED it allows session management', () => {
    const l = centralMachineList(
      [{ id: 'm1', machineName: 'Alienware', online: true, accountIds: [ME], remoteConsent: granted }],
      ME, 'en')
    expect(l.reachable).toEqual([{ id: 'm1', name: 'Alienware', online: true, screens: true }])
    expect(l.blocked).toEqual([])
  })

  it('never infers consent from ownership or from being online', () => {
    // The central cannot read a machine's preferences and never asks. A machine that has not
    // spoken is not reachable — it is listed with the reason.
    const l = centralMachineList(
      [{ id: 'm1', machineName: 'Quiet', online: true, accountIds: [ME], remoteConsent: null }],
      ME, 'en')
    expect(l.reachable).toEqual([])
    expect(l.blocked[0]!.text).toMatch(/has not said/)
  })

  it('a machine the viewer does not own is blocked for THAT reason, not silence', () => {
    const l = centralMachineList(
      [{ id: 'm1', machineName: 'Someone else’s', online: true, accountIds: ['other'] }],
      ME, 'en')
    expect(l.blocked[0]!.text).toMatch(/only by the accounts it is linked to/)
  })

  it('says nothing about a machine the caller could not judge', () => {
    // `remoteConsent` absent AND owned → the caller cannot tell; a row with nothing to say is not
    // given an invented sentence.
    const l = centralMachineList([{ id: 'm1', machineName: 'X', accountIds: [ME] }], ME, 'en')
    expect(l.reachable).toEqual([])
    expect(l.blocked).toEqual([])
  })

  it('offers the machine that can answer right now first', () => {
    const l = centralMachineList([
      { id: 'a', machineName: 'Zeta', online: false, accountIds: [ME], remoteConsent: grantedNoScreen },
      { id: 'b', machineName: 'Alpha', online: true, accountIds: [ME], remoteConsent: granted },
    ], ME, 'en')
    expect(l.reachable.map(m => m.name)).toEqual(['Alpha', 'Zeta'])
    expect(l.reachable[1]!.screens).toBe(false)
  })
})

describe('pickCentralMachine', () => {
  const list = centralMachineList([
    { id: 'a', machineName: 'A', online: true, accountIds: [ME], remoteConsent: granted },
    { id: 'b', machineName: 'B', online: true, accountIds: [ME], remoteConsent: granted },
  ], ME, 'en')

  it('keeps the remembered machine while it is still reachable', () => {
    expect(pickCentralMachine(list, 'b')).toBe('b')
  })

  it('never points at a machine that has gone quiet', () => {
    // Otherwise the page opens on a picker entry that is no longer in the picker.
    expect(pickCentralMachine(list, 'gone')).toBe('a')
  })

  it('is null when nothing can be reached', () => {
    expect(pickCentralMachine({ reachable: [], blocked: [] }, 'a')).toBeNull()
  })
})
