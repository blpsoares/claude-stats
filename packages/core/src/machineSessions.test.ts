import { describe, expect, it } from 'bun:test'
import {
  canGrantMachineSessions, machineSessionAccounts, machineSessionsAllowed, resolveSessionGrant,
} from './machineSessions'

const OWNER = 'acct-owner'
const LATER = 'acct-later'
const OTHER = 'acct-other'

describe('machineSessionsAllowed', () => {
  it('the account a machine was created for reaches its sessions', () => {
    const m = { accountIds: [OWNER], sessionAccountIds: [OWNER] }
    expect(machineSessionsAllowed({ accountId: OWNER }, m)).toBe(true)
  })

  it('an account LINKED LATER does not — that is the whole point', () => {
    // Linking is administration and metrics. Reaching into the machine's terminal work is a
    // separate decision the owner has to make on purpose.
    const m = { accountIds: [OWNER, LATER], sessionAccountIds: [OWNER] }
    expect(machineSessionsAllowed({ accountId: LATER }, m)).toBe(false)
  })

  it('until it is granted', () => {
    const m = { accountIds: [OWNER, LATER], sessionAccountIds: [OWNER, LATER] }
    expect(machineSessionsAllowed({ accountId: LATER }, m)).toBe(true)
  })

  it('an unrelated account never does', () => {
    const m = { accountIds: [OWNER], sessionAccountIds: [OWNER] }
    expect(machineSessionsAllowed({ accountId: OTHER }, m)).toBe(false)
  })

  it('an unknown machine answers exactly like one you do not own', () => {
    expect(machineSessionsAllowed({ accountId: OWNER }, {})).toBe(false)
  })

  it('a grant for an account that is no longer linked is ignored on READ too', () => {
    // Unlinking must not be able to leave a live grant behind.
    const m = { accountIds: [OWNER], sessionAccountIds: [OWNER, LATER] }
    expect(machineSessionsAllowed({ accountId: LATER }, m)).toBe(false)
  })
})

describe('the migration reading — an ABSENT list', () => {
  it('is the FIRST linked account, not everyone linked', () => {
    // "Everyone linked" would preserve exactly the hole this exists to close.
    const m = { accountIds: [OWNER, LATER] }
    expect(machineSessionAccounts(m)).toEqual([OWNER])
    expect(machineSessionsAllowed({ accountId: OWNER }, m)).toBe(true)
    expect(machineSessionsAllowed({ accountId: LATER }, m)).toBe(false)
  })

  it('is not NOBODY — a machine is never taken from its own owner', () => {
    expect(machineSessionAccounts({ accountIds: [OWNER] })).toEqual([OWNER])
  })

  it('reads the legacy single link', () => {
    expect(machineSessionAccounts({ accountId: OWNER })).toEqual([OWNER])
  })

  it('a machine linked to nobody grants nobody', () => {
    expect(machineSessionAccounts({})).toEqual([])
    expect(machineSessionAccounts({ accountIds: [] })).toEqual([])
  })

  it('an EMPTY stored list is a real answer, not an absent one', () => {
    // `[]` means the owner explicitly holds it alone; it must not fall back to the migration.
    expect(machineSessionAccounts({ accountIds: [OWNER, LATER], sessionAccountIds: [] })).toEqual([])
  })
})

describe('canGrantMachineSessions', () => {
  it('is the machine owner, and nobody else', () => {
    const m = { accountIds: [OWNER, LATER] }
    expect(canGrantMachineSessions({ accountId: OWNER }, m)).toBe(true)
    // A linked account may not pass its own access on.
    expect(canGrantMachineSessions({ accountId: LATER }, m)).toBe(false)
    // An instance owner administers the installation and does not hand out other people's
    // terminals — this function takes no role and cannot be told about one.
    expect(canGrantMachineSessions({ accountId: OTHER }, m)).toBe(false)
  })

  it('a machine with no owner has nobody who can grant', () => {
    expect(canGrantMachineSessions({ accountId: OWNER }, {})).toBe(false)
  })
})

describe('resolveSessionGrant', () => {
  it('keeps only accounts that are actually linked', () => {
    expect(resolveSessionGrant([OWNER, LATER], [OWNER, LATER, OTHER])).toEqual([OWNER, LATER])
  })

  it('always keeps the OWNER — a machine cannot be locked out of its own sessions', () => {
    // Otherwise an edit leaves a machine nobody is allowed to grant on.
    expect(resolveSessionGrant([OWNER, LATER], [])).toEqual([OWNER])
    expect(resolveSessionGrant([OWNER, LATER], [LATER])).toEqual([OWNER, LATER])
  })

  it('dedupes and preserves the linked order', () => {
    expect(resolveSessionGrant([OWNER, LATER, OWNER], [LATER])).toEqual([OWNER, LATER])
  })
})
