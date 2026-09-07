/**
 * audit.ts — append-only security event log in the `audit` collection.
 *
 * OWASP A09: authentication, authorization and administrative events must be recorded with
 * enough context to reconstruct an incident. Without this, a successful takeover leaves no
 * trace at all.
 *
 * The pure builder redacts secret-shaped fields BEFORE anything reaches the database — an audit
 * log that stores credentials is a liability, not a control — and truncates long values so one
 * call cannot bloat the collection.
 */
import { getMongoDb } from './mongo'

export type AuditAction =
  | 'login.success' | 'login.failure' | 'login.mfa_challenge' | 'login.mfa_failure'
  | 'logout' | 'password.change' | 'password.reset_cli'
  | 'mfa.enable' | 'mfa.disable' | 'mfa.disable_refused' | 'mfa.recovery_used' | 'mfa.recovery_regenerated'
  | 'password.recover' | 'password.recover_failure' | 'password.reset_requested'
  | 'account.create' | 'account.update' | 'account.delete'
  // An admin (owner OR manager) resetting SOMEONE ELSE's password — kept distinct from
  // 'password.change' (self-service) so an incident review can tell them apart at a glance.
  | 'password.reset_admin'
  | 'team.create' | 'team.update' | 'team.delete'
  | 'token.mint' | 'token.rotate' | 'token.revoke'
  // A machine's name, owner accounts, or team links changed — distinct from mint/rotate/revoke,
  // which touch the credential itself.
  | 'machine.update'
  // A verb performed on one of ANOTHER machine's live sessions, relayed from this central. Its own
  // action rather than a flavour of `machine.update`, which means the token document changed:
  // renaming a session and re-assigning a machine's owner account are not the same event, and an
  // audit that cannot tell them apart cannot answer "who killed my session".
  | 'machine.session_action'
  | 'repo.register' | 'repo.unregister'
  | 'config.update' | 'bootstrap.consume'
  | 'capability.denied' | 'authz.denied' | 'rate.blocked'
  | 'stepup.granted' | 'stepup.failure' | 'stepup.missing'
  // A live-terminal WRITE channel was opened (a keyboard attached to a session) or refused — ONE
  // entry per channel, never per keystroke. `fleet.input.denied` records a rejected WS upgrade
  // (e.g. a cross-origin attempt); the capability refusal is already `capability.denied`.
  | 'fleet.input.open' | 'fleet.input.denied'

export interface AuditEvent {
  action: AuditAction
  actorId?: string
  targetId?: string
  ip: string
  /** BSON Date, NOT an ISO string. The retention index below is a TTL index, and MongoDB's TTL
   *  monitor only expires documents whose indexed field is a Date — with a string here the index
   *  is created happily, reports no error, and nothing is ever deleted. See mongo-dates.ts. */
  at: Date
  meta?: Record<string, unknown>
}

export interface AuditInput {
  action: AuditAction
  actorId?: string
  targetId?: string
  ip: string
  meta?: Record<string, unknown>
}

/** Field names whose values must never be persisted, whatever the caller passes. */
const REDACT = new Set([
  'password', 'newPassword', 'currentPassword', 'confirm',
  'token', 'secret', 'code', 'challenge', 'hash', 'passwordHash', 'recoveryCodes',
])
const MAX_VALUE_LENGTH = 512

export function buildAuditEvent(input: AuditInput, now: Date): AuditEvent {
  let meta: Record<string, unknown> | undefined
  if (input.meta) {
    meta = {}
    for (const [k, v] of Object.entries(input.meta)) {
      if (REDACT.has(k)) continue
      meta[k] = typeof v === 'string' && v.length > MAX_VALUE_LENGTH ? v.slice(0, MAX_VALUE_LENGTH) : v
    }
  }
  return {
    action: input.action,
    actorId: input.actorId,
    targetId: input.targetId,
    ip: input.ip,
    at: now,
    meta,
  }
}

/** Fire-and-forget: an audit write must never break the request it is describing. */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    const db = await getMongoDb()
    await db.collection<AuditEvent>('audit').insertOne(buildAuditEvent(input, new Date()))
  } catch {
    // Swallowed on purpose. A failing audit sink is an operational problem, not a reason to
    // deny a legitimate login.
  }
}

/** Owner-only reader, newest first. */
export async function listAudit(opts: { limit?: number; action?: AuditAction } = {}): Promise<AuditEvent[]> {
  const db = await getMongoDb()
  const filter = opts.action ? { action: opts.action } : {}
  return db
    .collection<AuditEvent>('audit')
    .find(filter)
    .sort({ at: -1 })
    .limit(Math.min(opts.limit ?? 200, 1000))
    .toArray()
}

/** Index + a 180-day TTL. Idempotent; called at boot next to ensureAccountIndexes. */
export async function ensureAuditIndexes(): Promise<void> {
  const db = await getMongoDb()
  const col = db.collection<AuditEvent>('audit')
  await col.createIndex({ at: -1 })
  await col.createIndex({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 })
}
