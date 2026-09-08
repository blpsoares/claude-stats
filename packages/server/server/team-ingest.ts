import type { SessionMeta } from '@agentistics/core'
import { getTeamCollection } from './mongo'
import { parseIngestBody, toTeamDoc, stampCiSessions } from './team-store'
import { TEAM_INGEST_TOKEN, TEAM_PASSWORD } from './config'
import { validateIngestToken, hasAnyTokens } from './team-tokens'
import { constantTimeEqual } from './auth'

// CORS headers are defined in index.ts; this module returns plain JSON and the
// caller in index.ts spreads CORS_HEADERS, so we only set Content-Type here.
const JSON_HEADERS = { 'Content-Type': 'application/json' }

/**
 * Upsert every session as a team doc keyed by org:memberId:harness:sessionId.
 * Idempotent: re-posting an identical session is a no-op write. Returns count.
 *
 * @param memberId - Stable member identity key (token hash from `validateIngestToken`,
 *   or `legacy:<user>` for unauthenticated ingests which cannot benefit from rename-safety).
 * @param user - Display name cached in the doc; read-time resolution via getMemberNameMap()
 *   always takes precedence for minted-token members.
 */
export async function ingestSessions(org: string, memberId: string, user: string, sessions: SessionMeta[]): Promise<number> {
  if (sessions.length === 0) return 0
  const col = await getTeamCollection()
  const ops = sessions.map(s => {
    const doc = toTeamDoc(s, org, memberId, user)
    return { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } }
  })
  await col.bulkWrite(ops, { ordered: false })
  return ops.length
}

/** Route handler for POST /api/team/ingest.
 *
 *  Authorization order (Phase 3):
 *  1. Bearer matches a minted token in Mongo → authorized (lastSeenAt updated).
 *  2. Legacy TEAM_INGEST_TOKEN set AND bearer matches (constant-time) → authorized.
 *  3. Open fallback (Phase-2a behavior): no TEAM_PASSWORD, no TEAM_INGEST_TOKEN, and
 *     no minted tokens in DB → authorized (open, as Phase 2a).
 *  4. Otherwise → 401.
 */
export async function handleTeamIngest(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  // 0. GitHub Actions OIDC (keyless) — preferred for CI. The bearer is a short-lived,
  //    GitHub-signed JWT (three dotted segments; our static tokens are hex, so no collision).
  //    We verify it against GitHub's JWKS, require the `repository` to be a registered repo
  //    (admin allowlist), and stamp git_remote + ci + user authoritatively from the VERIFIED
  //    claim — no secret is ever stored. A JWT that fails OIDC falls through to the token paths.
  const { oidcEnabled, looksLikeJwt } = await import('./team-oidc')
  if (oidcEnabled() && looksLikeJwt(bearer)) {
    const { verifyCiOidc, ciMemberId } = await import('./team-oidc')
    const oidc = await verifyCiOidc(bearer!)
    if (oidc.ok) {
      const { normalizeGitRemote } = await import('@agentistics/core')
      const remote = normalizeGitRemote(`github.com/${oidc.claims.repository}`)
      const { isRepoRegistered } = await import('./team-repos')
      if (remote && await isRepoRegistered(remote)) {
        return handleIngestBody(req, ciMemberId(remote), 'github-actions', remote, true)
      }
      return new Response(JSON.stringify({ error: 'repository not registered on this central' }), { status: 403, headers: JSON_HEADERS })
    }
    // else: fall through — a dotted bearer that isn't a valid OIDC token won't match a hex token
    // either, so the tiers below will return 401.
  }

  // 1. Try minted token lookup (hashes bearer, looks up in Mongo, updates lastSeenAt).
  //    The token's memberId (hash) + user are AUTHORITATIVE — sessions are keyed by the
  //    stable memberId, and the authoritative user name prevents one member impersonating
  //    another. Renaming via PUT /api/team/members updates only the token doc; session
  //    docs are resolved at read time by getMemberNameMap(), so no re-ingest is needed.
  const mintedResult = await validateIngestToken(bearer)
  if (mintedResult.ok) {
    return handleIngestBody(req, mintedResult.memberId, mintedResult.user, mintedResult.repo, mintedResult.ci)
  }

  // 2. Legacy shared-secret fallback (constant-time compare).
  if (TEAM_INGEST_TOKEN && bearer !== null && constantTimeEqual(bearer, TEAM_INGEST_TOKEN)) {
    return handleIngestBody(req)
  }

  // 3. Phase-2a open fallback: only for a central that was NEVER set up (no IAM owner, no password,
  //    no legacy token, no minted tokens). Once IAM is bootstrapped, a valid minted token is ALWAYS
  //    required — so deleting a machine's token makes its next push 401, and the member auto-resets
  //    to solo instead of continuing to push anonymously into the open central.
  if (!TEAM_PASSWORD && !TEAM_INGEST_TOKEN) {
    try {
      const { hasAnyOwner } = await import('./accounts')
      const [hasTokens, bootstrapped] = await Promise.all([hasAnyTokens(), hasAnyOwner()])
      if (!hasTokens && !bootstrapped) {
        return handleIngestBody(req)
      }
    } catch {
      // If Mongo is unreachable for the checks, fall through to 401 (safe default).
    }
  }

  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: JSON_HEADERS,
  })
}

/** Route handler for POST /api/team/leave — a member removes ITS OWN data from the central.
 *
 *  Auth mirrors ingest:
 *  1. Minted token → delete by the stable memberId (authoritative — a member can only ever
 *     delete its own sessions, regardless of what the body claims).
 *  2. Legacy shared secret OR open fallback → delete by the self-declared {org, user} from
 *     the body (shared-secret trust model: the caller already holds the shared token).
 */
export async function handleTeamLeave(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  let body: { org?: unknown; user?: unknown } = {}
  try { body = (await req.json()) as { org?: unknown; user?: unknown } } catch { /* empty body ok */ }
  const col = await getTeamCollection()

  // 1. Minted token → memberId is authoritative.
  const { deleteMemberStats } = await import('./team-stats')
  const { deleteMemberWorkflows } = await import('./team-workflows')
  // Leaving takes the DELIVERIES with it. A board left behind on a central the machine has
  // disconnected from is the text its owner shared with a place they have just left.
  const { deleteMemberTasks } = await import('./team-tasks')
  const minted = await validateIngestToken(bearer)
  if (minted.ok) {
    const res = await col.deleteMany({ memberId: minted.memberId })
    await deleteMemberStats(minted.memberId)
    await deleteMemberWorkflows(minted.memberId)
    await deleteMemberTasks(minted.memberId).catch(() => 0)
    return new Response(JSON.stringify({ ok: true, deleted: res.deletedCount ?? 0 }), { status: 200, headers: JSON_HEADERS })
  }

  // 2. Legacy shared secret or open fallback → identify the member by {org, user}.
  const org = typeof body.org === 'string' ? body.org.trim() : ''
  const user = typeof body.user === 'string' ? body.user.trim() : ''
  const legacyAuthed = TEAM_INGEST_TOKEN && bearer !== null && constantTimeEqual(bearer, TEAM_INGEST_TOKEN)
  let open = false
  if (!TEAM_PASSWORD && !TEAM_INGEST_TOKEN) {
    try {
      // Same condition as the ingest fallback, INCLUDING the owner check: a central is "never
      // set up" only while it has no IAM owner either. Without that clause a bootstrapped
      // central that simply has not minted a machine token yet would accept an anonymous,
      // self-declared {org,user} delete. (Before accounts, TEAM_PASSWORD was always generated
      // and closed this by accident; it no longer is.)
      const { hasAnyOwner } = await import('./accounts')
      const [hasTokens, bootstrapped] = await Promise.all([hasAnyTokens(), hasAnyOwner()])
      open = !hasTokens && !bootstrapped
    } catch { /* DB down → not open */ }
  }
  if (!legacyAuthed && !open) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_HEADERS })
  }
  if (!org || !user) {
    return new Response(JSON.stringify({ error: 'org and user are required' }), { status: 400, headers: JSON_HEADERS })
  }
  const res = await col.deleteMany({ org, user })
  await deleteMemberStats(`legacy:${user}`)
  await deleteMemberWorkflows(`legacy:${user}`)
  await deleteMemberTasks(`legacy:${user}`).catch(() => 0)
  return new Response(JSON.stringify({ ok: true, deleted: res.deletedCount ?? 0 }), { status: 200, headers: JSON_HEADERS })
}

/**
 * Parse and upsert the ingest body after authorization has been verified.
 *
 * @param overrideMemberId - Stable token hash from `validateIngestToken`. When absent (legacy
 *   shared-secret or open fallback), a synthetic `legacy:<user>` memberId is used. Note:
 *   legacy sessions keyed by `legacy:<user>` cannot benefit from rename-safety — changing the
 *   self-declared user name in the uploader config creates a new identity in Mongo.
 * @param overrideUser - Authoritative display name from the minted token. When absent, the
 *   self-declared `body.user` is used (legacy/open paths only).
 */
async function handleIngestBody(req: Request, overrideMemberId?: string, overrideUser?: string, overrideRepo?: string, overrideCi?: boolean): Promise<Response> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: JSON_HEADERS })
  }
  const parsed = parseIngestBody(raw)
  if (!parsed.ok) {
    return new Response(JSON.stringify({ error: parsed.error }), { status: 400, headers: JSON_HEADERS })
  }
  try {
    const user = (overrideUser && overrideUser.trim()) || parsed.body.user
    // For legacy/open ingest (no minted token), use a synthetic memberId so the session
    // document is still structured consistently. These sessions cannot benefit from
    // rename-safety: a different self-declared user creates a new memberId → new docs.
    const memberId = overrideMemberId ?? `legacy:${user}`
    // Repo-bound (CI) token → stamp git_remote + ci authoritatively on every pushed session,
    // so a repo's GitHub Actions usage is attributed correctly no matter what the runner sent.
    const sessions = (overrideRepo || overrideCi)
      ? stampCiSessions(parsed.body.sessions, overrideRepo, overrideCi ?? false)
      : parsed.body.sessions
    const count = await ingestSessions(parsed.body.org, memberId, user, sessions)
    // Store the member's own statsCache (aggregated Claude history) so the central can
    // reproduce its exact totals — the deep history is never present as individual sessions.
    if (parsed.body.statsCache) {
      const { upsertMemberStats } = await import('./team-stats')
      await upsertMemberStats(parsed.body.org, memberId, user, parsed.body.statsCache).catch(() => {})
    }
    // Store the member's local workflow runs (computed metrics only — no chat/prompt text,
    // same privacy contract as sessions) so the central can surface them per-member.
    if (parsed.body.workflows && parsed.body.workflows.length > 0) {
      const { ingestWorkflows } = await import('./team-workflows')
      await ingestWorkflows(parsed.body.org, memberId, user, parsed.body.workflows).catch(() => {})
    }
    // Store the deliveries whose owner opted in. `toTeamTaskDoc` scrubs the free text AGAIN here:
    // a central cannot assume its members run current code, and in a mixed-version fleet the
    // machine still on the old build is exactly the one that leaks.
    if (parsed.body.tasks && parsed.body.tasks.length > 0) {
      const { ingestTasks } = await import('./team-tasks')
      await ingestTasks(parsed.body.org, memberId, user, parsed.body.tasks).catch(() => {})
    }
    // Real-time central: a member push changed the aggregate → nudge the central's dashboards
    // via SSE (debounced) so they refresh live, without the viewer polling. This is what makes
    // the "Live" toggle unnecessary on a central.
    try { (await import('./sse')).triggerSseNotification() } catch { /* best-effort */ }
    return new Response(JSON.stringify({ ok: true, count }), { status: 200, headers: JSON_HEADERS })
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSON_HEADERS })
  }
}
