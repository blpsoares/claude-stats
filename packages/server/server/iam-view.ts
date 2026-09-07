/**
 * iam-view.ts — pure helpers for the IAM API: safe account serialization (never leaks
 * passwordHash) + account/team visibility & management capability checks.
 */
import type { AccountDoc, Principal, Membership, Role } from './iam-types'
import { canCreateAccountWith } from '@agentistics/core'
import { fromBsonDate, fromBsonDateOrNull } from './mongo-dates'

export interface PublicAccount {
  id: string
  name: string
  email: string
  role: Role
  memberships: Membership[]
  createdAt: string
  lastLoginAt?: string | null
  mustChangePassword: boolean
}

/** Client-safe view of an account — drops passwordHash/emailLower/sessionVersion, and renders
 *  the stored BSON dates as ISO strings (the wire shape the frontend parses). */
export function publicAccount(a: AccountDoc): PublicAccount {
  return {
    id: a._id,
    name: a.name,
    email: a.email,
    role: a.role,
    memberships: a.memberships,
    createdAt: fromBsonDate(a.createdAt),
    lastLoginAt: fromBsonDateOrNull(a.lastLoginAt),
    mustChangePassword: a.mustChangePassword ?? false,
  }
}

function managedTeams(p: Principal): Set<string> {
  return new Set(p.memberships.filter(m => m.role === 'manager').map(m => m.teamId))
}

/** Owner sees all; a principal always sees itself; a manager sees accounts holding a
 *  membership in a team they manage. */
export function accountVisibleTo(principal: Principal, account: AccountDoc): boolean {
  if (principal.role === 'owner') return true
  if (principal.accountId === account._id) return true
  const managed = managedTeams(principal)
  return account.memberships.some(m => managed.has(m.teamId))
}

/** Membership-scope check for creating/editing a MEMBER account: owner may assign any memberships
 *  (including NONE); a manager may assign only user-role memberships in teams they manage (≥1).
 *
 *  The rule itself lives in `@agentistics/core` because the create FORM has to reach the same
 *  answer before it sends — `packages/web` cannot import this module, and a second copy over there
 *  is exactly what drifted (it demanded a team of everyone, owner included). This stays the
 *  authority; it is now a delegation rather than a duplicate. */
export function canCreateAccount(p: Principal, memberships: Membership[]): boolean {
  return canCreateAccountWith(p, memberships)
}

/** Deletion: owner may delete anyone (the last-owner guard lives in the handler); a manager may
 *  delete a member whose every membership is a user-role in a team they manage. */
export function canDeleteAccount(p: Principal, target: AccountDoc): boolean {
  if (target.role === 'owner') return p.role === 'owner'
  // target is a member:
  if (p.role === 'owner') return true
  const managed = managedTeams(p)
  return target.memberships.length > 0 && target.memberships.every(m => m.role === 'user' && managed.has(m.teamId))
}

/** Which membership sets a principal may assign to another account.
 *
 *  Owner: anything. Manager: any role — `user` OR `manager` — but only inside teams they manage.
 *  Promoting a peer to manager of a team you already manage is delegation *within* your own scope,
 *  not escalation beyond it, so it is allowed. Assigning a membership in a team you do not manage
 *  never is. A plain user may assign nothing.
 *
 *  Note the one-way door this creates for a manager: once the target holds a manager membership,
 *  `canDeleteAccount` no longer matches them, so the promoter can no longer edit that account.
 */
export function canAssignMemberships(p: Principal, memberships: Membership[]): boolean {
  if (p.role === 'owner') return true
  const managed = new Set(p.memberships.filter(m => m.role === 'manager').map(m => m.teamId))
  if (managed.size === 0) return false
  return memberships.every(m => managed.has(m.teamId))
}

/** The only fields a PATCH to /api/iam/accounts may carry. Deliberately has NO `role` field —
 *  role escalation through this path is not merely checked against, it is structurally absent. */
export interface AccountPatchRequest {
  name?: string
  memberships?: Membership[]
  resetPassword?: boolean
}

/**
 * Authorization gate for editing OR resetting an account — the single place both the account-info
 * edit and the admin password reset go through, so they can never drift apart on who may act on
 * whom. Reuses canDeleteAccount (the same scope that already governs deletion: a manager may act
 * only on user-role members of teams they manage) and canAssignMemberships (a manager may only
 * assign memberships inside teams they manage). Decides authorization ONLY — the caller still
 * builds and applies the actual database patch.
 *
 *  - self: a rename is fine; touching your own memberships or resetting your own password through
 *    the ADMIN path is refused (self-service password change is a separate endpoint).
 *  - owner: may edit anyone, but may not touch an OTHER owner's memberships (owner has none to
 *    scope, and there is no "manage this owner" relationship to encode).
 *  - manager (or anyone else): must satisfy canDeleteAccount(target) — same scope as deletion —
 *    and, if reassigning memberships, canAssignMemberships too.
 */
export function authorizeAccountPatch(
  p: Principal,
  target: AccountDoc,
  req: AccountPatchRequest,
): { ok: true } | { ok: false; error: 'forbidden' } {
  const isOwner = p.role === 'owner'
  const isSelf = target._id === p.accountId

  if (isSelf) {
    if (req.memberships !== undefined || req.resetPassword === true) return { ok: false, error: 'forbidden' }
    return { ok: true }
  }
  if (isOwner) {
    if (target.role === 'owner' && req.memberships !== undefined) return { ok: false, error: 'forbidden' }
    return { ok: true }
  }
  if (!canDeleteAccount(p, target)) return { ok: false, error: 'forbidden' }
  if (req.memberships !== undefined && req.memberships.length > 0 && !canAssignMemberships(p, req.memberships)) {
    return { ok: false, error: 'forbidden' }
  }
  return { ok: true }
}

/** Owner sees every team; a member sees only teams they belong to. */
export function teamVisibleTo(p: Principal, teamId: string): boolean {
  if (p.role === 'owner') return true
  return p.memberships.some(m => m.teamId === teamId)
}

/** Owner may manage machines in any team; a manager may manage only in teams they manage;
 *  users cannot manage machines. Undefined teamId → false for non-owner. */
export function canManageMachineTeam(p: Principal, teamId: string | undefined): boolean {
  if (p.role === 'owner') return true
  if (!teamId) return false
  return p.memberships.some(m => m.teamId === teamId && m.role === 'manager')
}

/**
 * Whether a principal may see OTHER PEOPLE'S names: the instance owner, or a manager of any team.
 *
 * This is the server-side twin of the frontend's `canFilterMembers` (App.tsx) — the same condition
 * that gates the members panel and the member filter. Anything that reveals who else uses the
 * instance must sit behind it, or a plain user learns their colleagues' names through whichever
 * surface forgot the check.
 */
export function canSeeMemberNames(p: Principal): boolean {
  return p.role === 'owner' || p.memberships.some(m => m.role === 'manager')
}

/**
 * Whether DELETE /api/iam/mfa may proceed for an account of this role.
 *
 * An owner reaches every team's data and every admin route, and — since account recovery is now
 * self-service through the second factor (see `exposure.ts`'s `requireMfaForOwner`) — an owner
 * with no second factor has no way back in except the host. So an owner may never turn MFA off,
 * full stop: not with a valid TOTP code, not with a recovery code. The two ways back in an owner
 * still has (a single-use recovery code, or `./central.sh reset-password --clear-mfa` from the
 * host) both stay open — neither goes through this route. A non-owner keeps today's behaviour.
 */
export function mfaDisableAllowed(role: Role): boolean {
  return role !== 'owner'
}

/**
 * Whether a principal is one of a machine's OWN accounts — and nothing else.
 *
 * Deliberately narrower than `canManageMachine`, which an instance owner and any manager of the
 * machine's teams both pass. That width is right for ADMINISTERING a machine: renaming it, rotating
 * its token, re-assigning it, all of which are about the token document and belong to whoever runs
 * the instance. It is wrong for reaching INTO the machine — typing into a live session, killing
 * one, reading what it is doing — which is the user's own work and nobody else's business.
 *
 * So this is a second predicate rather than a flag on the first. Narrowing `canManageMachine` in
 * place would lock owners out of exactly the machines that need them (see its own comment about
 * orphaned machines), and every existing caller wants the wide reading.
 *
 * The limit, stated rather than implied: an instance owner can already read the token store, mint a
 * token and re-assign this machine's owning account, so this is not a barrier against a hostile
 * operator and no UI may suggest that it is. What it does buy is the ordinary case — an admin with
 * legitimate access who is simply not this machine's user — on top of the machine's own consent
 * switch (`resolveRemoteConsent`), which is what actually has to be true for anything to be
 * relayed at all.
 */
export function machineOwnedBy(p: Principal, machine: { accountId?: string; accountIds?: string[] }): boolean {
  const owners = machine.accountIds && machine.accountIds.length
    ? machine.accountIds
    : (machine.accountId ? [machine.accountId] : [])
  return owners.includes(p.accountId)
}

/** Whether a principal may view/manage a specific machine: owner, a manager of ANY of the machine's
 *  teams, OR one of the machine's owner accounts (a user managing a machine they own). A machine may
 *  have several owner accounts AND belong to several teams. */
export function canManageMachine(p: Principal, machine: { teamId?: string; teamIds?: string[]; accountId?: string; accountIds?: string[] }): boolean {
  // An owner manages every machine, including a LOOSE one (no teams, no owner accounts). Without
  // this the team check below (`[].some(...)` → false) locked owners out of exactly the machines
  // that need re-linking — the ones orphaned when their owning account was deleted.
  if (p.role === 'owner') return true
  const owners = machine.accountIds && machine.accountIds.length ? machine.accountIds : (machine.accountId ? [machine.accountId] : [])
  if (owners.includes(p.accountId)) return true
  const teams = machine.teamIds && machine.teamIds.length ? machine.teamIds : (machine.teamId ? [machine.teamId] : [])
  return teams.some(t => canManageMachineTeam(p, t))
}
