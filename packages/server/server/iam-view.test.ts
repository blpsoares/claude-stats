// packages/server/server/iam-view.test.ts
import { test, expect, describe, it } from 'bun:test'
import { canSeeMemberNames, publicAccount, accountVisibleTo, canCreateAccount, canDeleteAccount, teamVisibleTo, canManageMachineTeam, canManageMachine, machineOwnedBy, canAssignMemberships, authorizeAccountPatch, mfaDisableAllowed } from './iam-view'
import type { AccountDoc, Principal } from './iam-types'

const owner: Principal = { accountId: 'o1', role: 'owner', memberships: [] }
const mgrA: Principal = { accountId: 'm1', role: 'member', memberships: [{ teamId: 'A', role: 'manager' }] }

test('mfaDisableAllowed: never for an owner, always for a member — MFA is mandatory for owners and not the UI\'s choice', () => {
  expect(mfaDisableAllowed('owner')).toBe(false)
  expect(mfaDisableAllowed('member')).toBe(true)
})

test('canManageMachine: owner any; manager if managing ANY of the machine teams; owner-account always', () => {
  expect(canManageMachine(owner, { teamIds: ['X', 'Y'] })).toBe(true)
  expect(canManageMachine(mgrA, { teamIds: ['A', 'B'] })).toBe(true)   // manages A
  expect(canManageMachine(mgrA, { teamIds: ['B', 'C'] })).toBe(false)  // manages none
  expect(canManageMachine(mgrA, { teamId: 'A' })).toBe(true)           // legacy single
  expect(canManageMachine(mgrA, { teamIds: ['B'], accountIds: ['m1'] })).toBe(true) // owns it
  expect(canManageMachine(mgrA, {})).toBe(false)                        // loose, not owned
})

test('machineOwnedBy: the machine\'s OWN accounts and nobody else — not the instance owner, not a team manager', () => {
  // The whole reason this exists beside canManageMachine: administering a machine (rename, rotate,
  // re-assign) is the instance owner's and the team manager's job, and reaching into its live
  // sessions is not. Every line here is a case canManageMachine answers the other way.
  expect(machineOwnedBy(owner, { accountIds: ['someone-else'] })).toBe(false)
  expect(machineOwnedBy(owner, {})).toBe(false)               // a loose machine belongs to nobody
  expect(machineOwnedBy(mgrA, { accountIds: ['m1'] })).toBe(true)   // owns it
  expect(machineOwnedBy(mgrA, { accountId: 'm1' })).toBe(true)      // legacy single field
  expect(machineOwnedBy(mgrA, { accountIds: ['x', 'm1'] })).toBe(true) // one of several owners
  expect(machineOwnedBy(mgrA, { accountIds: ['x'] })).toBe(false)
  // Managing the machine's team is emphatically not owning the machine.
  expect(canManageMachine(mgrA, { teamIds: ['A'] })).toBe(true)
  expect(machineOwnedBy(mgrA, { teamIds: ['A'] } as never)).toBe(false)
  // An empty accountIds array must not fall through to the legacy single field of someone else.
  expect(machineOwnedBy(mgrA, { accountIds: [], accountId: 'm1' })).toBe(true)
  expect(machineOwnedBy(mgrA, { accountIds: [], accountId: 'x' })).toBe(false)
})

test('canAssignMemberships: a manager may grant manager OR user inside a team they manage', () => {
  // Delegation within an already-managed team is not escalation — the manager already controls it.
  expect(canAssignMemberships(mgrA, [{ teamId: 'A', role: 'user' }])).toBe(true)
  expect(canAssignMemberships(mgrA, [{ teamId: 'A', role: 'manager' }])).toBe(true)
  // Outside their managed teams, nothing is assignable — that WOULD be escalation.
  expect(canAssignMemberships(mgrA, [{ teamId: 'B', role: 'user' }])).toBe(false)
  expect(canAssignMemberships(mgrA, [{ teamId: 'A', role: 'user' }, { teamId: 'B', role: 'user' }])).toBe(false)
  // Owner may assign anything; a plain user may assign nothing.
  expect(canAssignMemberships(owner, [{ teamId: 'Z', role: 'manager' }])).toBe(true)
  const plainUser: Principal = { accountId: 'u1', role: 'member', memberships: [{ teamId: 'A', role: 'user' }] }
  expect(canAssignMemberships(plainUser, [{ teamId: 'A', role: 'user' }])).toBe(false)
})

test('canManageMachine: an owner may manage a LOOSE machine (no teams, no owner accounts)', () => {
  // Regression: the team check is `teams.some(...)`, which is false for an empty team list, so a
  // global owner was refused (HTTP 403) on a machine with no team and no owner account — exactly
  // the state a machine lands in when its owning account is deleted, making it unrecoverable.
  expect(canManageMachine(owner, {})).toBe(true)
  expect(canManageMachine(owner, { teamIds: [], accountIds: [] })).toBe(true)
})

function acc(id: string, over: Partial<AccountDoc> = {}): AccountDoc {
  return { _id: id, name: 'N', email: `${id}@x.co`, emailLower: `${id}@x.co`, passwordHash: '$argon2id$secret', role: 'member', memberships: [], sessionVersion: 0, createdAt: new Date('2026-07-22T00:00:00.000Z'), updatedAt: new Date('2026-07-22T00:00:00.000Z'), lastLoginAt: null, ...over }
}

test('publicAccount strips passwordHash and maps _id → id', () => {
  const p = publicAccount(acc('u1', { memberships: [{ teamId: 'A', role: 'user' }] }))
  // createdAt crosses the boundary as an ISO STRING: the doc stores a BSON Date, the API shape
  // the frontend parses is a string.
  expect(p).toEqual({ id: 'u1', name: 'N', email: 'u1@x.co', role: 'member', memberships: [{ teamId: 'A', role: 'user' }], createdAt: '2026-07-22T00:00:00.000Z', lastLoginAt: null, mustChangePassword: false })
  expect((p as unknown as Record<string, unknown>).passwordHash).toBeUndefined()
})

test('publicAccount renders lastLoginAt as ISO, and keeps "never signed in" as null', () => {
  expect(publicAccount(acc('u1', { lastLoginAt: new Date('2026-07-25T09:00:00.000Z') })).lastLoginAt)
    .toBe('2026-07-25T09:00:00.000Z')
  expect(publicAccount(acc('u2', { lastLoginAt: null })).lastLoginAt).toBeNull()
})

test('accountVisibleTo: owner sees all; manager sees users in their team + self', () => {
  const uA = acc('u1', { memberships: [{ teamId: 'A', role: 'user' }] })
  const userB = acc('u2', { memberships: [{ teamId: 'B', role: 'user' }] })
  expect(accountVisibleTo(owner, userB)).toBe(true)
  expect(accountVisibleTo(mgrA, uA)).toBe(true)
  expect(accountVisibleTo(mgrA, userB)).toBe(false)
  expect(accountVisibleTo(mgrA, acc('m1'))).toBe(true) // self
})

test('canCreateAccount (member membership scope): owner any; manager only user-role in managed teams', () => {
  expect(canCreateAccount(owner, [{ teamId: 'Z', role: 'manager' }])).toBe(true)
  expect(canCreateAccount(mgrA, [{ teamId: 'A', role: 'user' }])).toBe(true)
  expect(canCreateAccount(mgrA, [{ teamId: 'A', role: 'manager' }])).toBe(false)
  expect(canCreateAccount(mgrA, [{ teamId: 'B', role: 'user' }])).toBe(false)
  expect(canCreateAccount(mgrA, [])).toBe(false)
})

test('canCreateAccount: an owner may create an account belonging to NO team', () => {
  // The server has always allowed this; the create form used to refuse it. Pinned here so the
  // authority cannot quietly grow the requirement the form has now dropped.
  expect(canCreateAccount(owner, [])).toBe(true)
})

test('canDeleteAccount: owner deletes anyone (last-owner guarded in handler); manager only managed user-members', () => {
  expect(canDeleteAccount(owner, acc('o2', { role: 'owner' }))).toBe(true)  // owner deletes owner
  expect(canDeleteAccount(owner, acc('u1', { memberships: [{ teamId: 'B', role: 'user' }] }))).toBe(true)
  expect(canDeleteAccount(mgrA, acc('u1', { memberships: [{ teamId: 'A', role: 'user' }] }))).toBe(true)
  expect(canDeleteAccount(mgrA, acc('u2', { memberships: [{ teamId: 'B', role: 'user' }] }))).toBe(false)
  expect(canDeleteAccount(mgrA, acc('x', { memberships: [{ teamId: 'A', role: 'manager' }] }))).toBe(false)
  expect(canDeleteAccount(mgrA, acc('o2', { role: 'owner' }))).toBe(false)  // manager never an owner
})

test('teamVisibleTo: owner all; member only their teams', () => {
  expect(teamVisibleTo(owner, 'Z')).toBe(true)
  expect(teamVisibleTo(mgrA, 'A')).toBe(true)
  expect(teamVisibleTo(mgrA, 'B')).toBe(false)
})

test('canManageMachineTeam: owner any team; manager own team only; user never', () => {
  const userA: Principal = { accountId: 'uu', role: 'member', memberships: [{ teamId: 'A', role: 'user' }] }
  expect(canManageMachineTeam(owner, 'Z')).toBe(true)
  expect(canManageMachineTeam(mgrA, 'A')).toBe(true)
  expect(canManageMachineTeam(mgrA, 'B')).toBe(false)
  expect(canManageMachineTeam(userA, 'A')).toBe(false)
  expect(canManageMachineTeam(mgrA, undefined)).toBe(false)
})

// authorizeAccountPatch is the single gate for editing/resetting an account (name, memberships,
// admin password reset) — it decides authorization only; the handler still parses/applies the
// resulting patch. It never accepts a `role` field at all, which is what makes role-escalation
// through this path structurally impossible rather than merely checked.
describe('authorizeAccountPatch', () => {
  const managedUser = acc('u1', { memberships: [{ teamId: 'A', role: 'user' }] })
  const otherOwner = acc('o2', { role: 'owner' })

  it('a manager can never escalate a target to owner — an owner target is always refused', () => {
    // Even a completely innocuous edit (renaming) is refused once the target is an owner: a
    // manager's authority is scoped to user-role members of teams they manage, full stop.
    expect(authorizeAccountPatch(mgrA, otherOwner, { name: 'New Name' })).toEqual({ ok: false, error: 'forbidden' })
    expect(authorizeAccountPatch(mgrA, otherOwner, { resetPassword: true })).toEqual({ ok: false, error: 'forbidden' })
  })

  it('a manager cannot assign memberships into a team they do not manage', () => {
    expect(authorizeAccountPatch(mgrA, managedUser, { memberships: [{ teamId: 'B', role: 'user' }] }))
      .toEqual({ ok: false, error: 'forbidden' })
    // Managing team A is fine — that is in scope.
    expect(authorizeAccountPatch(mgrA, managedUser, { memberships: [{ teamId: 'A', role: 'user' }] }))
      .toEqual({ ok: true })
  })

  it('a manager cannot edit their own role or memberships through this path', () => {
    const self = acc('m1', { memberships: [{ teamId: 'A', role: 'manager' }] })
    expect(authorizeAccountPatch(mgrA, self, { memberships: [{ teamId: 'A', role: 'user' }] }))
      .toEqual({ ok: false, error: 'forbidden' })
    expect(authorizeAccountPatch(mgrA, self, { resetPassword: true }))
      .toEqual({ ok: false, error: 'forbidden' })
    // A plain rename of yourself is fine — only role-shaped fields (memberships/resetPassword)
    // are refused on self.
    expect(authorizeAccountPatch(mgrA, self, { name: 'New Name' })).toEqual({ ok: true })
  })

  it('an owner may edit anyone, but memberships on ANOTHER owner are still refused', () => {
    expect(authorizeAccountPatch(owner, otherOwner, { name: 'New Name' })).toEqual({ ok: true })
    expect(authorizeAccountPatch(owner, otherOwner, { memberships: [{ teamId: 'Z', role: 'user' }] }))
      .toEqual({ ok: false, error: 'forbidden' })
    expect(authorizeAccountPatch(owner, managedUser, { resetPassword: true })).toEqual({ ok: true })
  })

  it('a manager may reset the password of a user they manage', () => {
    expect(authorizeAccountPatch(mgrA, managedUser, { resetPassword: true })).toEqual({ ok: true })
  })

  it('a manager may not touch an account outside every team they manage', () => {
    const outsider = acc('u2', { memberships: [{ teamId: 'B', role: 'user' }] })
    expect(authorizeAccountPatch(mgrA, outsider, { resetPassword: true })).toEqual({ ok: false, error: 'forbidden' })
  })
})

test('canSeeMemberNames: owner and any-team manager yes; a plain user never', () => {
  // Mirrors the frontend's canFilterMembers — the gate on anything revealing who else is here.
  const userA: Principal = { accountId: 'uu', role: 'member', memberships: [{ teamId: 'A', role: 'user' }] }
  const loose: Principal = { accountId: 'll', role: 'member', memberships: [] }
  expect(canSeeMemberNames(owner)).toBe(true)
  expect(canSeeMemberNames(mgrA)).toBe(true)
  expect(canSeeMemberNames(userA)).toBe(false)
  expect(canSeeMemberNames(loose)).toBe(false)
})
