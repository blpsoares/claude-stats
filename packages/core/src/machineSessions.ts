/**
 * machineSessions.ts — PURE: which accounts may reach a machine's SESSIONS.
 *
 * Linking an account to a machine used to grant everything, sessions included — so an act performed
 * for administration or for metrics silently handed over the machine's terminal work. Reading a
 * fleet, renaming, interrupting, killing and reopening are a different decision from "this machine
 * belongs to my account", and this module is where the narrower one lives.
 *
 * THE RULE. Session access belongs to the account(s) the machine was CREATED for, automatically,
 * and to any account EXPLICITLY GRANTED it afterwards. Nothing else. Being an instance owner grants
 * metrics on every machine and sessions on none — `machineOwnedBy` already has no role
 * short-circuit, and this is narrower still.
 *
 * `machineOwnedBy` (iam-view.ts) is NOT replaced. It stays the right predicate for "is this my
 * machine" wherever that is genuinely the question; what changes is that the SESSION surface may
 * only ever ask the function below.
 *
 * MIGRATION. No stored machine records who was linked at creation, so an ABSENT `sessionAccountIds`
 * reads as the FIRST linked account — `accountIds[0]`, which the product already treats as the
 * machine's identity (it is the name a machine displays under, `nextUser = accountIds[0]`). That is
 * deliberately neither of the two easy answers: "everyone currently linked" would preserve exactly
 * the hole this exists to close, and "nobody" would take a working machine away from its own owner
 * with no way back except an administrator who, by this very rule, may not grant it.
 */

export interface MachineSessionFacts {
  /** Every account linked to the machine — administration, metrics, the machine list. */
  accountIds?: string[]
  /** Legacy single link, still written alongside `accountIds`. */
  accountId?: string
  /**
   * The accounts allowed to reach the SESSIONS. A subset of `accountIds`, never wider.
   * Absent means "not recorded yet" — see MIGRATION above — never "nobody".
   */
  sessionAccountIds?: string[]
}

/** Every account linked to the machine, in order; `accountIds[0]` is its identity. */
export function machineLinkedAccounts(m: MachineSessionFacts): string[] {
  if (m.accountIds && m.accountIds.length) return m.accountIds
  return m.accountId ? [m.accountId] : []
}

/**
 * The accounts that may reach this machine's sessions, RESOLVED — the stored list where there is
 * one, and the migration reading where there is not.
 *
 * Always a subset of the linked accounts: a grant for an account that is no longer linked is
 * ignored on READ as well as refused on write, so unlinking can never leave one behind.
 */
export function machineSessionAccounts(m: MachineSessionFacts): string[] {
  const linked = machineLinkedAccounts(m)
  if (m.sessionAccountIds === undefined) {
    const first = linked[0]
    return first ? [first] : []
  }
  const granted = new Set(m.sessionAccountIds)
  return linked.filter(id => granted.has(id))
}

/**
 * May this principal reach the machine's sessions?
 *
 * The ONLY predicate the session surface may ask. An account without the grant is answered exactly
 * as an unknown machine is, so the route never becomes an oracle for which machines exist.
 */
export function machineSessionsAllowed(
  p: { accountId: string },
  machine: MachineSessionFacts,
): boolean {
  return machineSessionAccounts(machine).includes(p.accountId)
}

/**
 * May this principal GRANT session access on this machine?
 *
 * The machine's own owner account, and no one else — not an instance owner, who administers the
 * installation and is deliberately not given the ability to hand out other people's terminals. The
 * owner is `accountIds[0]`, the same account the machine is named after.
 */
export function canGrantMachineSessions(
  p: { accountId: string },
  machine: MachineSessionFacts,
): boolean {
  const owner = machineLinkedAccounts(machine)[0]
  return owner !== undefined && owner === p.accountId
}

/**
 * What to STORE when the grant list is edited.
 *
 * Intersected with the linked accounts, so a grant can never name an account that is not linked,
 * and the machine's OWNER is always in it: the account a machine is named after cannot be locked
 * out of its own sessions by an edit, which would leave a machine nobody may grant on.
 */
export function resolveSessionGrant(
  linkedAccountIds: readonly string[],
  requested: readonly string[],
): string[] {
  const linked = [...new Set(linkedAccountIds.filter(Boolean))]
  const want = new Set(requested)
  const owner = linked[0]
  return linked.filter(id => id === owner || want.has(id))
}
