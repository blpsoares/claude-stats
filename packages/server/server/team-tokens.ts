/**
 * team-tokens.ts — Mongo-backed ingest token store for Team Mode Phase 3.
 *
 * Only SHA-256 hashes of tokens are stored; the plaintext is returned once
 * at mint time and never persisted or logged.
 *
 * Collection: `tokens` (separate from `sessions`).
 * Document schema:
 *   { _id: <sha256(token) hex>,  // the hash IS the lookup key
 *     user: string,
 *     label: string,
 *     createdAt: Date,           // BSON Date — see mongo-dates.ts
 *     lastSeenAt: Date | null    // updated on every valid ingest request
 *   }
 *
 * The `MemberInfo` / `MachineInfo` records returned to callers keep ISO STRINGS: they are API
 * shapes rendered by the frontend, and the conversion happens here at the read.
 *
 * Pure helper: hashToken (unit-tested in team-tokens.test.ts, no Mongo needed).
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Collection } from 'mongodb'
import { getMongoDb } from './mongo'
import { fromBsonDate, fromBsonDateOrNull } from './mongo-dates'
import { teamDocId, type TeamSessionDoc } from './team-store'
import { claimRotation } from './rotate-claim'
import { accountTeamsMap, resolveMachineTeams, machineSessionAccounts, resolveSessionGrant } from '@agentistics/core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenDoc {
  _id: string
  user: string
  label: string
  createdAt: Date
  lastSeenAt: Date | null
  /** Normalized git remote (`host/org/repo`) this token is bound to, for repo/CI tokens.
   *  When set, ingest stamps every pushed session's `git_remote` with this value authoritatively. */
  repo?: string
  /** True for GitHub Actions / CI tokens — ingest stamps `ci: true` on every pushed session. */
  ci?: boolean
  /** Primary team (teamIds[0]) — kept for back-compat / read-time single-value consumers. */
  teamId?: string
  /** All teams a machine belongs to — a machine can be in several teams (visible to any of them). */
  teamIds?: string[]
  /** Primary owning account (accountIds[0]) — kept for whoami/back-compat. */
  accountId?: string
  /** All owning accounts for machine tokens — a machine can be owned/managed by several accounts. */
  accountIds?: string[]
  /**
   * The accounts allowed to reach this machine's SESSIONS — a subset of `accountIds`, never wider.
   *
   * Seeded at MINT with the creation accounts, so a machine created for your account is one you
   * manage sessions on with nothing to click. A LATER link does not join it: that is the whole
   * separation. Absent means "not recorded yet" and is read by `machineSessionAccounts` as the
   * first linked account — never as everyone linked. See `@agentistics/core/machineSessions`.
   */
  sessionAccountIds?: string[]
  /** Teams this machine is held OUT of even though it would otherwise inherit them from an owner
   *  account (or carry them directly). This is what makes UNCHECKING an inherited team stick:
   *  without a stored exclusion the machine would re-inherit the team on the very next read. */
  excludedTeamIds?: string[]
}

/** Canonical owner-account id list for a token (handles legacy single-accountId docs). */
export function ownerIdsOf(doc: Pick<TokenDoc, 'accountId' | 'accountIds'>): string[] {
  if (doc.accountIds && doc.accountIds.length) return doc.accountIds
  return doc.accountId ? [doc.accountId] : []
}

/** Canonical team-id list for a token (handles legacy single-teamId docs). */
export function teamIdsOf(doc: Pick<TokenDoc, 'teamId' | 'teamIds'>): string[] {
  if (doc.teamIds && doc.teamIds.length) return doc.teamIds
  return doc.teamId ? [doc.teamId] : []
}

export type MemberInfo = {
  id: string
  user: string
  label: string
  createdAt: string
  lastSeenAt: string | null
  /** Live status — populated by the members endpoint from the presence snapshot. */
  online?: boolean
  latencyMs?: number | null
}

export type MachineInfo = {
  id: string
  accountId?: string        // primary owner (accountIds[0]) — kept for compatibility
  accountIds: string[]      // all owner accounts
  machineName: string
  user: string
  teamId?: string           // primary team (teamIds[0]) — kept for compatibility
  teamIds: string[]         // teams attached DIRECTLY to the machine (authority reads this)
  /** Teams the machine effectively belongs to: own ∪ inherited-from-owner-accounts − excluded.
   *  This is the set every filter / aggregate / cache scope must use. */
  effectiveTeamIds: string[]
  /** The subset of `effectiveTeamIds` that came from an owner account. Already members — the UI
   *  must not offer them as "add", only as an unchecked-able row. */
  inheritedTeamIds: string[]
  /** Teams deliberately unchecked. Stored so the removal survives a reload. */
  excludedTeamIds: string[]
  createdAt: string
  lastSeenAt: string | null
}

// ---------------------------------------------------------------------------
// PURE helper (no side effects — unit-tested without Mongo)
// ---------------------------------------------------------------------------

/**
 * Deterministic SHA-256 hash of a token, returned as a 64-character hex string.
 * This is the `_id` stored in Mongo; the plaintext is never persisted.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The push-identity `user` for a machine, given its (resolved) owner account name, if any.
 *
 * A machine with no owner account has no person to name. Every ingested session is stamped with
 * this `user` and it is the ONLY field the member/user dimension (`distinctUsers` / `filterByUsers`
 * in `@agentistics/core`) reads — those already treat a falsy `user` as "no owner" and exclude the
 * session from that dimension, folding it instead into the machine dimension it belongs to
 * (`listMachines`, `machineStatsCaches`). Falling back to the machine's own name/label here — as
 * both `mintMachine`'s caller and `setMachineOwners` used to — is what made an ownerless machine
 * surface as a "member" under its own name (filters, MembersPage's "by member" view, the
 * `MachinesSettings` table). Must NEVER be `ownerName ?? machineName`.
 */
export function machineUserFor(ownerName: string | undefined | null): string {
  return ownerName ?? ''
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function getTokensCollection(): Promise<Collection<TokenDoc>> {
  const db = await getMongoDb()
  return db.collection<TokenDoc>('tokens')
}

// ---------------------------------------------------------------------------
// Public async API
// ---------------------------------------------------------------------------

/**
 * Mint a new random ingest token. Stores only the SHA-256 hash in Mongo.
 * Returns the plaintext token (shown once; never stored or logged here).
 */
export async function mintToken(user: string, label: string, opts?: { repo?: string; ci?: boolean; accountId?: string; teamId?: string }): Promise<string> {
  // 32 random bytes → 64-char hex string (256 bits of entropy). Repo/CI tokens use 48 bytes
  // (96-char) — longer since they live as a GitHub Actions secret with broader blast radius.
  const token = randomBytes(opts?.ci ? 48 : 32).toString('hex')
  const id = hashToken(token)
  const doc: TokenDoc = {
    _id: id,
    user,
    label,
    createdAt: new Date(),
    lastSeenAt: null,
    // No forced Default team — a token with no team is "loose" (visible only to an owner until
    // assigned). teamIds mirrors teamId when set.
    ...(opts?.teamId ? { teamId: opts.teamId, teamIds: [opts.teamId] } : {}),
    ...(opts?.repo ? { repo: opts.repo } : {}),
    ...(opts?.ci ? { ci: true } : {}),
    ...(opts?.accountId ? { accountId: opts.accountId, accountIds: [opts.accountId] } : {}),
  }
  const col = await getTokensCollection()
  await col.insertOne(doc)
  return token
}

/**
 * Revoke a token by its hash id. Returns true if a document was deleted.
 */
export async function revokeToken(id: string): Promise<boolean> {
  const col = await getTokensCollection()
  const result = await col.deleteOne({ _id: id })
  // A revoked machine must also leave the sealed-envelope directory. `listSiblingMachines` already
  // stops naming it as a peer (it reads this collection), so it can no longer be sealed TO — but
  // an orphan public key and an undeliverable mailbox would otherwise sit there forever, and a key
  // row nobody owns is a key row nobody would notice being reused.
  if (result.deletedCount > 0) {
    const { forgetMachineKeys } = await import('./envelope-store')
    await forgetMachineKeys(id).catch(() => { /* best-effort: revocation itself has succeeded */ })
  }
  return result.deletedCount > 0
}

/** What a rotation actually moved. Reported so the audit event can be truthful about it — in
 *  particular about the one thing a rotation DESTROYS (see `envelopesDropped`). */
export interface RotationResult {
  /** The new plaintext token, shown once. */
  token: string
  sessions: number
  statsMoved: boolean
  workflows: number
  tags: number
  keyMoved: boolean
  /** Sealed envelopes addressed to the old id, deleted because no id can ever open them again.
   *  See `rotate-identity.ts` — the recipient is inside the seal, so this is a loss, not a move. */
  envelopesDropped: number
}

/**
 * Rotate a member's token: mint a fresh token while preserving all of the member's
 * history. Returns what moved (and the new plaintext token, shown once), or `null` if no
 * token with `oldId` exists.
 *
 * The member's identity key is the token hash (`memberId`), so rotating the token
 * changes that key. To keep history, every doc keyed by the old id is migrated to the
 * new id:
 *   - `sessions`     — each TeamSessionDoc is re-inserted with the new memberId and a
 *                      recomputed _id (teamDocId), then the old docs are removed.
 *   - `memberStats`  — the per-member aggregate (keyed by _id = memberId) is copied.
 *   - `workflows`    — same shape as sessions (`teamWorkflowDocId` embeds the memberId).
 *   - `tags`         — a `machine` source stores this id; re-pointed, or the tag empties.
 *   - `machineKeys`  — the machine's published envelope key moves with it.
 *   - `envelopes`    — inbound mail is dropped (undeliverable), outbound is left sealed.
 *   - `tokens`       — the token doc is replaced (new hash id, same metadata). This happens
 *                      FIRST, as an atomic claim (`rotate-claim.ts`), not last: it is what makes
 *                      concurrent rotations of one machine settle into one machine instead of
 *                      several, and `null` therefore also means "another rotation got here first".
 *
 * `rotate-identity.ts` holds the full enumeration of what is keyed by the machine id, what is
 * only keyed by something that LOOKS like it, and why sibling pins are deliberately not carried.
 */
export async function rotateToken(oldId: string): Promise<RotationResult | null> {
  const col = await getTokensCollection()

  const token = randomBytes(32).toString('hex')
  const newId = hashToken(token)

  // CLAIM FIRST, migrate after. Two overlapping rotations of one machine used to both read the old
  // doc and both write a replacement, so a double-clicked Rotate button turned one machine into
  // several — see rotate-claim.ts. Exactly one caller can win this; a loser wrote nothing and is
  // answered like a machine that no longer exists, because by the time it looked, it did not.
  const claim = await claimRotation<TokenDoc>({
    findOne: id => col.findOne({ _id: id }),
    insert: async d => { await col.insertOne(d) },
    takeIfPresent: id => col.findOneAndDelete({ _id: id }),
    remove: async id => { await col.deleteOne({ _id: id }) },
  }, oldId, newId)
  if (!claim.won) return null

  const db = await getMongoDb()

  // Migrate sessions: rebuild each doc under the new memberId + _id.
  const sessions = db.collection<TeamSessionDoc>('sessions')
  const oldSessions = await sessions.find({ memberId: oldId }).toArray()
  if (oldSessions.length > 0) {
    const migrated = oldSessions.map(d => ({
      ...d,
      memberId: newId,
      _id: teamDocId(d.org, newId, d.harness ?? 'claude', d.session_id),
    }))
    await sessions.insertMany(migrated, { ordered: false }).catch(() => {})
    await sessions.deleteMany({ memberId: oldId })
  }

  // Migrate memberStats: keyed by _id = memberId.
  const memberStats = db.collection<{ _id: string }>('memberStats')
  const statsDoc = await memberStats.findOne({ _id: oldId })
  if (statsDoc) {
    await memberStats.insertOne({ ...statsDoc, _id: newId }).catch(() => {})
    await memberStats.deleteOne({ _id: oldId })
  }

  // Migrate the collections that were added AFTER this function and never taught about it.
  // Best-effort each: a rotation that has already re-keyed the sessions must not be abandoned
  // half-done because one later collection is unavailable.
  const [workflows, tags, envelopes] = await Promise.all([
    import('./team-workflows').then(m => m.rekeyMemberWorkflows(oldId, newId)).catch(() => 0),
    import('./tags-store').then(m => m.retargetMachineTagSources(oldId, newId)).catch(() => 0),
    import('./envelope-store').then(m => m.rekeyMachineEnvelopes(oldId, newId))
      .catch(() => ({ keyMoved: false, envelopesDropped: 0 })),
  ])

  // The token doc itself moved at the top, in the claim: it carries the same metadata under the
  // new hash id, so a rotation keeps the machine's teams and owners (they used to be dropped).

  return {
    token,
    sessions: oldSessions.length,
    statsMoved: !!statsDoc,
    workflows,
    tags,
    keyMoved: envelopes.keyMoved,
    envelopesDropped: envelopes.envelopesDropped,
  }
}

/**
 * List all minted tokens as safe member records (hash id only; no plaintext).
 */
export async function listMembers(): Promise<MemberInfo[]> {
  const col = await getTokensCollection()
  const docs = await col.find({}).sort({ createdAt: 1 }).toArray()
  return docs.map(d => ({
    id: d._id,
    user: d.user,
    label: d.label,
    createdAt: fromBsonDate(d.createdAt),
    lastSeenAt: fromBsonDateOrNull(d.lastSeenAt),
  }))
}

/**
 * Returns whether any tokens are stored in the collection.
 * Used by team-ingest.ts to decide whether the "open" Phase-2a fallback applies.
 */
export async function hasAnyTokens(): Promise<boolean> {
  const col = await getTokensCollection()
  const count = await col.estimatedDocumentCount()
  return count > 0
}

/**
 * Validate a bearer token from an ingest request:
 *   - Hashes the bearer, looks up the hash in Mongo.
 *   - If found, updates `lastSeenAt` and returns `{ ok: true, user, memberId }`.
 *   - `memberId` is the token's hash `_id` — the stable identity key used in Mongo docs.
 *   - If not found, returns `{ ok: false }`.
 * Never logs the raw bearer string.
 */
export async function validateIngestToken(
  bearer: string | null,
): Promise<{ ok: true; user: string; memberId: string; repo?: string; ci?: boolean; label?: string; teamId?: string; accountId?: string } | { ok: false }> {
  if (!bearer) return { ok: false }
  const id = hashToken(bearer)
  const col = await getTokensCollection()
  const doc = await col.findOne({ _id: id })
  if (!doc) return { ok: false }
  // Update last-seen — fire and forget (non-critical, must not block the caller).
  void col.updateOne({ _id: id }, { $set: { lastSeenAt: new Date() } }).catch(() => {})
  return { ok: true, user: doc.user, memberId: id, repo: doc.repo, ci: doc.ci, label: doc.label, teamId: doc.teamId, accountId: doc.accountId }
}

/**
 * Rename a member by updating the `user` field on their token doc.
 * Returns `true` if a document was matched (and updated), `false` if no token with that id exists.
 * Subsequent ingests by that member will carry the new name automatically; existing session docs
 * in the `sessions` collection are resolved at read time via `getMemberNameMap()`.
 */
export async function setMemberName(id: string, user: string): Promise<boolean> {
  const col = await getTokensCollection()
  const result = await col.updateOne({ _id: id }, { $set: { user } })
  return result.matchedCount > 0
}

/**
 * Returns a map of `{ [tokenId]: user }` for every token in the collection.
 * Used by `loadTeamSessionsFromMongo` to resolve the current display name for each session
 * at read time, so a member rename is reflected immediately without re-ingesting sessions.
 */
export async function getMemberNameMap(): Promise<Record<string, string>> {
  const col = await getTokensCollection()
  const docs = await col.find({}, { projection: { _id: 1, user: 1 } }).toArray()
  const map: Record<string, string> = {}
  for (const doc of docs) {
    map[doc._id] = doc.user
  }
  return map
}

/** memberId (token hash) → primary teamId (or '' when the machine has no team — loose). */
export async function getMemberTeamMap(): Promise<Record<string, string>> {
  const col = await getTokensCollection()
  const docs = await col.find({}, { projection: { _id: 1, teamId: 1, teamIds: 1 } }).toArray()
  const map: Record<string, string> = {}
  for (const d of docs) map[d._id] = teamIdsOf(d)[0] ?? ''
  return map
}

/** memberId (token hash) → ALL teams the machine belongs to (empty when loose — no Default fallback).
 *  Used for read-time multi-team tagging + scoping (a session is visible to any of its teams;
 *  a loose session with no team is visible only to an owner).
 *
 *  EFFECTIVE teams, not just the ones stored on the machine: a machine also belongs to every team
 *  its OWNER ACCOUNTS belong to, minus anything explicitly excluded (see resolveMachineTeams in
 *  @agentistics/core). Reading only the machine's own `teamIds` here is what made filtering by a
 *  team skip the machines that joined through their account — the team reported a fraction of
 *  itself. Both this map and `listMachines()` go through the same resolver so they cannot drift. */
export async function getMemberTeamsMap(): Promise<Record<string, string[]>> {
  const col = await getTokensCollection()
  const [docs, accountTeams] = await Promise.all([
    col.find({}, { projection: { _id: 1, teamId: 1, teamIds: 1, accountId: 1, accountIds: 1, excludedTeamIds: 1 } }).toArray(),
    accountTeamsForMachines(),
  ])
  const map: Record<string, string[]> = {}
  for (const d of docs) map[d._id] = resolveMachineTeams(d, accountTeams).teams
  return map
}

/** accountId → teams, read from the accounts collection. A failure degrades to "no inheritance"
 *  (the pre-existing behavior) rather than blanking every machine's teams. */
async function accountTeamsForMachines(): Promise<Record<string, string[]>> {
  try {
    const { listAccounts } = await import('./accounts')
    return accountTeamsMap(await listAccounts())
  } catch {
    return {}
  }
}

/**
 * Mint a machine token bound to an accountId and team.
 * Returns the token hash (id) and plaintext token.
 */
export async function mintMachineToken(input: { accountId: string; user: string; machineName: string; teamId: string }): Promise<{ id: string; token: string }> {
  const token = await mintToken(input.user, input.machineName, { accountId: input.accountId, teamId: input.teamId })
  const id = hashToken(token)
  return { id, token }
}

/**
 * Mint a flexible machine token with optional owner(s) and team.
 * A machine can be:
 *   - loose (no owner + no team): accountIds empty/undefined, teamId undefined
 *   - team-only: accountIds empty/undefined, teamId set
 *   - owner(s)-only: accountIds set, teamId undefined
 *   - both: accountIds set, teamId set
 * Returns the token hash (id) and plaintext token.
 */
export async function mintMachine(input: { machineName: string; user: string; accountIds?: string[]; teamId?: string; teamIds?: string[] }): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString('hex')
  const id = hashToken(token)
  const unique = input.accountIds && input.accountIds.length ? [...new Set(input.accountIds.filter(Boolean))] : []
  // teams: accept teamIds[] (+ single teamId alias); dedupe. Empty = loose (no team → owner-only visible).
  const teams = [...new Set([...(input.teamIds ?? []), ...(input.teamId ? [input.teamId] : [])].filter(Boolean))]
  const doc: TokenDoc = {
    _id: id,
    user: input.user,
    label: input.machineName,
    createdAt: new Date(),
    lastSeenAt: null,
    // The creation accounts get session access automatically — the machine is being made FOR
    // them. Every later link starts without it.
    ...(unique.length > 0 ? { accountId: unique[0], accountIds: unique, sessionAccountIds: unique } : {}),
    ...(teams.length > 0 ? { teamId: teams[0], teamIds: teams } : {}),
  }
  const col = await getTokensCollection()
  await col.insertOne(doc)
  return { id, token }
}

/**
 * The machines that share at least one owner ACCOUNT with `memberId`, itself included.
 *
 * This is the reach of every account-scoped machine-to-machine feature (the still-shared warning
 * and the sealed-envelope mailbox), and it is deliberately by ACCOUNT and not by team: a team is a
 * grouping of people, and telling a colleague's machine what this user restricts — or letting it
 * read an envelope — is a different decision than telling the user's own second laptop.
 *
 * A token with no owner account (a loose/legacy machine) reaches nothing but itself: it cannot be
 * proven to belong to anyone, and guessing in the permissive direction here would hand one
 * stranger's machine the list of another's repositories.
 *
 * CI and repo tokens are excluded — an ephemeral runner is not a machine a person owns.
 */
export async function listSiblingMachines(memberId: string): Promise<{ id: string; name: string }[]> {
  const col = await getTokensCollection()
  const self = await col.findOne({ _id: memberId })
  if (!self) return []
  const owners = ownerIdsOf(self)
  if (owners.length === 0) return [{ id: self._id, name: self.label || self.user || self._id }]
  const docs = await col
    .find({ accountIds: { $in: owners }, ci: { $ne: true }, repo: { $exists: false } })
    .toArray()
  const byId = new Map<string, { id: string; name: string }>()
  for (const d of docs) byId.set(d._id, { id: d._id, name: d.label || d.user || d._id })
  byId.set(self._id, { id: self._id, name: self.label || self.user || self._id })
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/**
 * List all machine tokens (excludes CI and repo tokens).
 * Returns machine records with the token hash as id (no plaintext).
 */
export async function listMachines(): Promise<MachineInfo[]> {
  const col = await getTokensCollection()
  const [docs, accountTeams] = await Promise.all([
    col.find({ ci: { $ne: true }, repo: { $exists: false } }).toArray(),
    accountTeamsForMachines(),
  ])
  return docs.map(d => {
    const accountIds = ownerIdsOf(d)
    const teamIds = teamIdsOf(d)
    const resolved = resolveMachineTeams(d, accountTeams)
    return {
      id: d._id,
      accountId: accountIds[0],
      accountIds,
      machineName: d.label || d.user,
      user: d.user,
      // `teamId` / `teamIds` stay the STORED values: `canManageMachine` reads them, and quietly
      // swapping in the inherited set would widen every team manager's authority to every machine
      // of every account in their teams. Scoping/UI use the effective fields below.
      teamId: teamIds[0],
      teamIds,
      effectiveTeamIds: resolved.teams,
      inheritedTeamIds: resolved.inherited,
      excludedTeamIds: resolved.excluded,
      createdAt: fromBsonDate(d.createdAt),
      lastSeenAt: fromBsonDateOrNull(d.lastSeenAt),
    }
  })
}

/** Purge any team ids no longer present (deleted teams) from ALL machine tokens — retroactive
 *  cleanup for refs orphaned before the delete-cascade existed. Idempotent; runs at boot. */
export async function purgeUnknownTeamsFromMachines(validTeamIds: string[]): Promise<void> {
  const valid = new Set(validTeamIds)
  const col = await getTokensCollection()
  const docs = await col.find({ $or: [{ teamId: { $exists: true } }, { teamIds: { $exists: true } }] }).toArray()
  for (const d of docs) {
    const kept = teamIdsOf(d).filter(t => valid.has(t))
    const before = teamIdsOf(d)
    if (kept.length === before.length) continue // nothing orphaned
    await col.updateOne({ _id: d._id }, kept.length
      ? { $set: { teamIds: kept, teamId: kept[0] } }
      : { $unset: { teamIds: '', teamId: '' } })
  }
}

/** Remove a deleted team from every machine token (pull from teamIds + clear a stale primary
 *  teamId). Machines are NOT deleted — they just lose the dead team relation. */
export async function detachTeamFromAllMachines(teamId: string): Promise<void> {
  const col = await getTokensCollection()
  await col.updateMany({ teamIds: teamId }, { $pull: { teamIds: teamId } })
  // Re-point the legacy primary teamId to the first remaining team (or unset it if none left).
  const affected = await col.find({ teamId }).toArray()
  for (const d of affected) {
    const remaining = (d.teamIds ?? []).filter(t => t !== teamId)
    await col.updateOne({ _id: d._id }, remaining.length
      ? { $set: { teamId: remaining[0] } }
      : { $unset: { teamId: '' } })
  }
}

/** Remove a deleted account from every machine token (pull from accountIds + clear a stale primary
 *  accountId). Machines are NOT deleted — they just lose the dead owner relation. */
export async function detachAccountFromAllMachines(accountId: string): Promise<void> {
  const col = await getTokensCollection()
  await col.updateMany({ accountIds: accountId }, { $pull: { accountIds: accountId } })
  const affected = await col.find({ accountId }).toArray()
  for (const d of affected) {
    const remaining = (d.accountIds ?? []).filter(a => a !== accountId)
    await col.updateOne({ _id: d._id }, remaining.length
      ? { $set: { accountId: remaining[0] } }
      // Last owner gone: fall back to the machine's own label, mirroring how mint derives `user`
      // for an ownerless machine. Otherwise the list shows "no account" beside the dead account's
      // name. Safe — history is keyed by the token hash, not by this display string.
      : { $unset: { accountId: '' }, $set: { user: d.label ?? d.user } })
  }
}

/** Set of every live token id (hash). Central reads filter team data by this so a revoked
 *  member's orphaned sessions/stats/workflows never keep showing after the token is gone. */
export async function getLiveTokenIds(): Promise<Set<string>> {
  const col = await getTokensCollection()
  const docs = await col.find({}, { projection: { _id: 1 } }).toArray()
  return new Set(docs.map(d => d._id))
}

/** Replace a machine's set of teams. teamIds[0] becomes the primary (teamId). Empty clears teams
 *  (loose → owner-only visibility). */
export async function setMachineTeams(id: string, teamIds: string[]): Promise<boolean> {
  const col = await getTokensCollection()
  const unique = [...new Set(teamIds.filter(Boolean))]
  const res = await col.updateOne({ _id: id }, { $set: { teamIds: unique, teamId: unique[0] } })
  return res.matchedCount > 0
}

/**
 * Set a machine's teams AND its exclusion list in one write — the pair that makes membership
 * derivable. `setMachineTeams` alone cannot express "not in team T even though the owner is".
 */
export async function setMachineTeamsAndExclusions(
  id: string,
  teamIds: string[],
  excludedTeamIds: string[],
): Promise<boolean> {
  const col = await getTokensCollection()
  const unique = [...new Set(teamIds.filter(Boolean))]
  const excluded = [...new Set(excludedTeamIds.filter(Boolean))]
  const res = await col.updateOne({ _id: id }, {
    $set: { teamIds: unique, teamId: unique[0], excludedTeamIds: excluded },
  })
  return res.matchedCount > 0
}

/** Reassign a machine token to a single team (legacy helper). Returns true if a doc was matched. */
export async function setMachineTeam(id: string, teamId: string): Promise<boolean> {
  return setMachineTeams(id, teamId ? [teamId] : [])
}

/** Rename a machine (updates the token doc's `label`). Returns true if a doc was matched. The new
 *  name reflects on the machine on its next whoami handshake (machineName = label). */
export async function setMachineLabel(id: string, label: string): Promise<boolean> {
  const col = await getTokensCollection()
  const res = await col.updateOne({ _id: id }, { $set: { label } })
  return res.matchedCount > 0
}

/** Set a machine's owner accounts. `user` is the machine's display identity and must follow the
 *  owning account (mint derives it the same way), otherwise a re-assigned machine keeps showing the
 *  previous — possibly deleted — account's name. Pass `user` as the first owner's name; omit it to
 *  keep the previous owner's name when accounts are still assigned, or to CLEAR to '' when the last
 *  owner is removed. A machine is not a person: falling back to the machine's own `label` here (as
 *  this used to) is what made an unowned machine surface as a "member" — every session is tagged
 *  with this `user`, and the user/member dimension (`distinctUsers`/`filterByUsers` in
 *  @agentistics/core) reads an empty `user` as "no owner" and excludes it, while the machine
 *  dimension keeps naming the machine by its `label` regardless. History is keyed by the token hash
 *  (memberId), not by this string, so changing it never splits past sessions. */
export async function setMachineOwners(
  id: string,
  accountIds: string[],
  user?: string,
  /**
   * The accounts that may reach the SESSIONS, when the caller is allowed to decide it.
   *
   * Omitted leaves the stored grant alone — re-linking accounts for administration must not
   * silently widen or narrow who can drive the machine's terminals. What IS enforced on every
   * write is the intersection: an account that stops being linked stops being granted, so
   * unlinking can never leave a live grant behind.
   */
  sessionAccountIds?: string[],
): Promise<boolean> {
  const col = await getTokensCollection()
  const unique = [...new Set(accountIds.filter(Boolean))]
  const doc = await col.findOne({ _id: id })
  const nextUser = user !== undefined ? user : (unique.length > 0 ? machineUserFor(doc?.user) : '')
  const requested = sessionAccountIds ?? machineSessionAccounts({
    accountIds: doc?.accountIds, accountId: doc?.accountId, sessionAccountIds: doc?.sessionAccountIds,
  })
  const res = await col.updateOne({ _id: id }, {
    $set: {
      accountIds: unique, accountId: unique[0], user: nextUser,
      sessionAccountIds: resolveSessionGrant(unique, requested),
    },
  })
  return res.matchedCount > 0
}

/** Backfill the multi-team `teamIds[]` from the legacy single `teamId`. Tokens with no team stay
 *  loose (no forced Default). Idempotent. */
export async function backfillTokenTeamIds(): Promise<void> {
  const col = await getTokensCollection()
  // Legacy docs have teamId but no teamIds → seed teamIds from teamId (aggregation pipeline update).
  await col.updateMany(
    { teamId: { $exists: true }, teamIds: { $exists: false } },
    [{ $set: { teamIds: ['$teamId'] } }],
  )
}
