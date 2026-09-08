import type { SessionMeta, SharedTask, StatsCache, WorkflowRun } from '@agentistics/core'
import { tagUser, redactSessionText } from '@agentistics/core'
import { toBsonDate, fromBsonDate, toBsonDates, fromBsonDates, type StoredDate } from './mongo-dates'

/**
 * A team session as stored in Mongo: the SessionMeta plus identity fields and a stable _id.
 *
 * `memberId` is the SHA-256 hash of the member's ingest token (the token doc's `_id`).
 * Keying by `memberId` (not `user`) makes the document stable across member renames:
 * changing the display name never creates a duplicate session in the collection.
 *
 * TIMESTAMPS: `SessionMeta` carries ISO strings because that is the WIRE shape (JSON has no
 * date type and the frontend parses strings). In Mongo they are BSON `Date`s — the three fields
 * below are deliberately re-typed, and `toTeamDoc`/`fromTeamDoc` are the only places that
 * convert. `start_time` is nullable here on purpose: an adapter that could not read a start time
 * reports `''`, and `''` is not a date — storing it as one is the bug this replaced.
 *
 * MIGRATION NOTE: The `_id` scheme changed from `org:user:harness:sessionId` (name-based)
 * to `org:memberId:harness:sessionId` (token-hash-based). Operators must clear stale data
 * once after upgrading: `db.sessions.deleteMany({})`. Legacy sessions are re-ingested on the
 * next uploader push.
 */
export type TeamSessionDoc = Omit<SessionMeta, 'start_time' | 'end_time' | 'user_message_timestamps'> & {
  _id: string
  org: string
  /** Stable token identity key (SHA-256 hash of the bearer token, or `legacy:<user>`). */
  memberId: string
  /** Cached display name as of the last ingest; overridden at read time by getMemberNameMap(). */
  user: string
  start_time: Date | null
  end_time?: Date | null
  user_message_timestamps: Date[]
}

export interface IngestBody {
  org: string
  user: string
  sessions: SessionMeta[]
  /** Optional: the member's own raw statsCache (aggregated Claude history). Stored per
   *  member so the central can reproduce the member's exact totals. */
  statsCache?: StatsCache
  /** Optional: the member's local workflow runs (computed metrics only — no chat/prompt
   *  text, same privacy contract as sessions). Upserted per (org, memberId, runId). */
  workflows?: WorkflowRun[]
  /**
   * Optional: the deliveries whose owner opted IN (`Task.shared`, absent reading as not shared).
   *
   * This is the one thing a member pushes that is free text by design — a title, a description,
   * comments — which is why it travels only per task, is scrubbed by `redactSharedTask` on both
   * sides, and carries no file bytes. Its SESSIONS are still decided by this connection's sharing
   * rules: the field cannot widen them, only name what already travels.
   */
  tasks?: SharedTask[]
}

/**
 * Stable, collision-safe Mongo _id keyed by `memberId` (token hash) rather than by the
 * display name. This means member renames never create duplicate documents.
 */
export function teamDocId(org: string, memberId: string, harness: string, sessionId: string): string {
  return `${org}:${memberId}:${harness}:${sessionId}`
}

/**
 * Map a SessionMeta + identity to a Mongo doc. Pure — does not mutate the input.
 *
 * @param memberId - Stable member identity key (token hash or `legacy:<user>` for unauthenticated ingests).
 * @param user - Display name cached in the doc; overridden at read time by getMemberNameMap().
 */
export function toTeamDoc(session: SessionMeta, org: string, memberId: string, user: string): TeamSessionDoc {
  // Second line of defence. The member already scrubs before sending (team-uploader), but a
  // central cannot assume its members run current code — and in a mixed-version fleet the one
  // machine still on an old build is exactly the one that leaks. Redacting here means a
  // credential never reaches the collection regardless of what the client sent.
  const tagged = tagUser(redactSessionText(session), user)
  const { start_time, end_time, user_message_timestamps, ...rest } = tagged
  return {
    ...rest,
    user,      // always string — overrides the optional user field from tagUser
    org,
    memberId,
    _id: teamDocId(org, memberId, tagged.harness ?? 'claude', tagged.session_id),
    // ISO strings in → BSON Dates out. `end_time` stays ABSENT when the session has none,
    // rather than being written as an explicit null on every document.
    start_time: toBsonDate(start_time),
    ...(end_time !== undefined ? { end_time: toBsonDate(end_time) } : {}),
    user_message_timestamps: toBsonDates(user_message_timestamps),
  }
}

/**
 * Map a Mongo doc back to a plain SessionMeta (drops _id/org/memberId, keeps user). Pure.
 *
 * Timestamps come back as ISO strings — the wire shape every consumer expects. Legacy documents
 * that still hold strings (written before the date migration, or by an older central in a
 * mixed-version fleet) read identically: `fromBsonDate` accepts both.
 *
 * The input is typed loosely on the date fields because this also serves PROJECTED reads
 * (`loadTagSessionsFromMongo`), where a field may simply be absent.
 */
export function fromTeamDoc(
  doc: Omit<TeamSessionDoc, 'start_time' | 'end_time' | 'user_message_timestamps'> & {
    start_time?: StoredDate
    end_time?: StoredDate
    user_message_timestamps?: readonly StoredDate[]
  },
): SessionMeta {
  const { _id, org, memberId, start_time, end_time, user_message_timestamps, ...rest } = doc
  void _id; void org; void memberId
  return {
    ...rest,
    start_time: fromBsonDate(start_time),
    ...(end_time !== undefined && end_time !== null ? { end_time: fromBsonDate(end_time) } : {}),
    user_message_timestamps: fromBsonDates(user_message_timestamps),
  }
}

/**
 * Stamp CI/repo attribution onto sessions pushed by a repo-bound token. Pure — returns new
 * objects, does not mutate the input. Sets `git_remote` to the token's registered remote and
 * `ci: true` on every session, so a repo's GitHub Actions usage is attributed authoritatively
 * regardless of what the ephemeral runner reported. A falsy `repo` leaves `git_remote` as-is.
 */
export function stampCiSessions(sessions: SessionMeta[], repo: string | undefined, ci: boolean): SessionMeta[] {
  if (!ci && !repo) return sessions
  return sessions.map(s => ({
    ...s,
    ...(repo ? { git_remote: repo } : {}),
    ...(ci ? { ci: true } : {}),
  }))
}

/** Validate an untrusted ingest request body. Pure. */
export function parseIngestBody(raw: unknown):
  | { ok: true; body: IngestBody }
  | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body must be an object' }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.sessions)) return { ok: false, error: 'sessions must be an array' }
  for (const s of r.sessions) {
    if (typeof s !== 'object' || s === null || typeof (s as Record<string, unknown>).session_id !== 'string') {
      return { ok: false, error: 'each session must have a session_id' }
    }
  }
  const org = typeof r.org === 'string' ? r.org : ''
  const user = typeof r.user === 'string' ? r.user : ''
  // A body with no sessions is a connectivity ping — nothing is stored, so identity is not
  // required. Real pushes (≥1 session) must carry both org and user.
  if (r.sessions.length > 0) {
    if (!org) return { ok: false, error: 'org is required' }
    if (!user) return { ok: false, error: 'user is required' }
  }
  // statsCache is optional and passed through as-is (stored verbatim, not re-validated here).
  const statsCache = (typeof r.statsCache === 'object' && r.statsCache !== null)
    ? (r.statsCache as StatsCache)
    : undefined
  // workflows is optional; each entry must at least carry a runId (same shallow validation
  // level as sessions' session_id check above — full shape is trusted, not re-validated).
  let workflows: WorkflowRun[] | undefined
  if (Array.isArray(r.workflows)) {
    for (const w of r.workflows) {
      if (typeof w !== 'object' || w === null || typeof (w as Record<string, unknown>).runId !== 'string') {
        return { ok: false, error: 'each workflow must have a runId' }
      }
    }
    workflows = r.workflows as WorkflowRun[]
  }
  // tasks is optional; each entry must carry a `task.id` — the same shallow level as the two
  // above. A body whose `tasks` this parser did not COPY is a field that type-checks on both
  // sides and is silently dropped at the boundary, which is how the shared board reached a live
  // central as nothing at all for one afternoon.
  let tasks: SharedTask[] | undefined
  if (Array.isArray(r.tasks)) {
    for (const t of r.tasks) {
      const rec = (t as { task?: unknown })?.task as Record<string, unknown> | undefined
      if (typeof t !== 'object' || t === null || !rec || typeof rec.id !== 'string') {
        return { ok: false, error: 'each task must carry a task.id' }
      }
    }
    tasks = r.tasks as SharedTask[]
  }
  return { ok: true, body: { org, user, sessions: r.sessions as SessionMeta[], statsCache, workflows, tasks } }
}
