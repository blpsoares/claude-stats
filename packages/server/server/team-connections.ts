/**
 * team-connections.ts — HTTP handlers for the multi-central connection lifecycle: add/rotate,
 * rename, delete, probe, and the aggregated status the browser polls.
 *
 * Pure decisions (`validateConnectionBody`, `validatePatchBody`, `decideConnectionUpsert`) are
 * unit-tested directly in team-connections.test.ts. Everything else here is I/O glue: read/mutate
 * preferences through `updateTeamConfig` (whose mutator runs INSIDE preferences.ts's single write
 * chain — see its docstring; the two uniqueness decisions below are made from the array current
 * AT WRITE TIME, never from a snapshot read outside the chain), talk to the central over HTTP,
 * and nudge team-uploader/team-agent-client to react immediately instead of waiting out their own
 * ~5s reconciliation poll.
 *
 * Never logs a token, a TeamConnection, or a whole preferences object.
 */

import type { TeamConnection, TeamConfig, ShareSource, ShareSourceType } from '@agentistics/core'
import { connectionId, defaultTeam, normalizeTeamConfig, normalizeEndpointKey, normalizeGitRemote, NO_REPO_KEY, resolveRemoteConsent } from '@agentistics/core'
import { readPreferences, updateTeamConfig, PreferencesLockTimeoutError } from './preferences'
import { safeConnId, AGENTISTICS_DATA_DIR } from './config'
import { readJsonLimited, LIMITS } from './limits'
import {
  removeConnection, getUploaderStatus, emptyStatusFor, reconcileUploaderNow, pushNow,
  getResyncProgress, connectionCanForget, peekPushContext, type UploaderStatus,
} from './team-uploader'
import type { ForgetProgress } from './team-forget-client'
import { loadRulesState } from './team-rules'
import { getElsewhere, scheduleElsewhereCheck, checkElsewhereNow } from './team-elsewhere'
import { announceRestrictionNow, scheduleEnvelopeSync } from './envelope-client'
import { announceRemoteConsentNow } from './team-agent-client'
import type { ElsewhereRepo } from './account-repos'
import {
  sourcesRestrict, withUnresolvedSources, rulesSignature, emptyRulesSignature, normalizeSources,
  attributionBoundary, prehistoryCount, canonicalRepoKey,
} from './share-rules'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** R4 (round-2 review of Task 5): a `PreferencesLockTimeoutError` means another process is
 *  mid-write, not that this request is malformed — 503 + Retry-After tells the caller to try
 *  again shortly, instead of a 400/500 that reads as "this will never work". */
function lockTimeoutResponse(): Response {
  return new Response(JSON.stringify({ error: 'another process is writing preferences — retry shortly' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
  })
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// Pure decisions — the substance of this module. Unit-tested.
// ---------------------------------------------------------------------------

export interface ConnectionBody {
  endpoint: string
  token: string
  org?: string
  label?: string
  /** The data directory the CALLER resolved for itself. `agentop member connect` sends it so this
   *  server can refuse a request meant for a DIFFERENT machine profile — see
   *  `handleAddConnection`. Absent for a browser (same origin, same profile by construction). */
  dataDir?: string
  /** 'denylist' (share everything except `sources`) | 'allowlist' (share only `sources`).
   *  Absent means "not specified in this request" — NOT "denylist": on an update, absence keeps
   *  whatever mode the connection already has (see `resolveShareRules`). */
  shareMode?: 'denylist' | 'allowlist'
  /** The typed rule list. A legacy `deniedRepos: string[]` body is accepted too (an older client)
   *  and converted into this shape by `parseRulesFromBody` — downstream code never sees
   *  `deniedRepos` again. */
  sources?: ShareSource[]
}

/** Pure: is `v` an array of strings? Used to validate a legacy `deniedRepos` body — junk (a bare
 *  string, a number, an object, a mixed-type array) is rejected outright rather than filtered down
 *  to whatever happened to be a string, which would silently accept a malformed request instead of
 *  400ing it. */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

const SHARE_SOURCE_TYPES = new Set<ShareSourceType>(['repo', 'project', 'none'])
/** Generous but bounded — a rule list this size already indicates a malformed or adversarial
 *  request; a real picker never approaches it (mirrors `team-forget.ts`'s `MAX_FORGET_IDS`). */
const MAX_SOURCES = 2000

/** TOTAL validator for a `ShareSource[]`: every entry must be `{type, value}` with a known type
 *  and a string value, the value must be one ENFORCEMENT can key (see below), and the list must
 *  not exceed `MAX_SOURCES`. ANY invalid entry — a bad type, a non-string value, a bare string
 *  instead of an object — rejects the WHOLE list rather than silently dropping it: a rules body is
 *  a privacy control, and a partial application of it is a fail-open, not a best-effort parse.
 *
 *  The per-type value checks mirror `share-rules.ts`'s `sourceKey` exactly, and exist because
 *  anything it returns `null` for is DROPPED from the enforcement set while remaining PERSISTED —
 *  so `GET /api/preferences` reports the rule, the picker renders it checked, and the session it
 *  claims to hide is pushed anyway. Rejecting here is what makes `sourceKey`'s "the API boundary
 *  has already rejected it" a true statement instead of an assumption.
 *
 *  Errors name the source TYPE and never the value: an unresolvable repo value is typically a
 *  local path, i.e. user data that must not be echoed back into a response or a log. */
function validateShareSources(v: unknown): ShareSource[] | { error: string } {
  if (!Array.isArray(v)) return { error: 'sources must be an array' }
  if (v.length > MAX_SOURCES) return { error: `sources must not exceed ${MAX_SOURCES} entries` }
  const out: ShareSource[] = []
  for (const entry of v) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'each source must be an object with type and value' }
    }
    const e = entry as Record<string, unknown>
    if (typeof e.type !== 'string' || !SHARE_SOURCE_TYPES.has(e.type as ShareSourceType)) {
      return { error: `unknown source type ${JSON.stringify(e.type)}` }
    }
    if (typeof e.value !== 'string') return { error: 'source value must be a string' }
    const type = e.type as ShareSourceType
    if (type === 'repo' && !canonicalRepoKey(normalizeGitRemote(e.value))) {
      return { error: 'a repo source must be a resolvable git remote' }
    }
    if (type === 'project' && !e.value) return { error: 'a project source must name a project path' }
    // The `none` bucket is a fixed dimension, not a value — a non-empty one means the caller
    // believes it is naming something, and honouring it as `none:` would apply a rule they did
    // not ask for.
    if (type === 'none' && e.value !== '') return { error: 'a none source must carry an empty value' }
    out.push({ type, value: e.value })
  }
  return out
}

/** Convert a legacy `deniedRepos: string[]` body into typed sources — the request-boundary
 *  counterpart of `@agentistics/core`'s `migrateSources` (which does the same conversion in the
 *  read path for a connection already on disk). Duplicated rather than imported because that
 *  function is private to the shape migration and this is a different one-shot conversion.
 *
 *  `''` folds to the `none` bucket alongside `NO_REPO_KEY`, exactly as `normalizeDenied` has
 *  always folded it: an older client can legitimately send `''` for the unattributed bucket, and
 *  mapping it to `{type:'repo', value:''}` would produce a source `sourceKey` drops — the bucket
 *  would stop being blocked while the picker still showed it checked. */
function legacyDeniedReposToSources(deniedRepos: readonly string[]): ShareSource[] {
  return deniedRepos.map(v => (v === NO_REPO_KEY || v === '')
    ? { type: 'none' as const, value: '' }
    : { type: 'repo' as const, value: v })
}

/** The rules half of a POST/PATCH body — `{shareMode?, sources?}`, or the legacy `{deniedRepos?}`
 *  shape converted into it. Pure. Total: any junk in EITHER shape is a 400, never a partial
 *  application. Accepting `shareMode` alone (no `sources`) is legitimate — a pure mode switch that
 *  keeps whatever the connection already has (see `resolveShareRules`). */
function parseRulesFromBody(r: Record<string, unknown>): { shareMode?: 'denylist' | 'allowlist'; sources?: ShareSource[] } | { error: string } {
  let shareMode: 'denylist' | 'allowlist' | undefined
  if ('shareMode' in r && r.shareMode !== undefined) {
    if (r.shareMode !== 'denylist' && r.shareMode !== 'allowlist') {
      return { error: 'shareMode must be "denylist" or "allowlist"' }
    }
    shareMode = r.shareMode
  }

  if ('sources' in r && r.sources !== undefined) {
    const sources = validateShareSources(r.sources)
    if ('error' in sources) return sources
    return { shareMode, sources }
  }

  if ('deniedRepos' in r && r.deniedRepos !== undefined) {
    if (!isStringArray(r.deniedRepos)) return { error: 'deniedRepos must be an array of strings' }
    // Through the SAME validator as a typed body: a legacy client naming an unresolvable repo
    // would otherwise persist a rule enforcement drops, which is the whole of Important 2 reached
    // by the other door. The shipped picker cannot hit this — it builds its draft through
    // `normalizeDenied`, which already discards anything unresolvable.
    const sources = validateShareSources(legacyDeniedReposToSources(r.deniedRepos))
    if ('error' in sources) return sources
    return { shareMode, sources }
  }

  return { shareMode }
}

/** Validate + normalize the POST /api/team/connections body. Pure. */
export function validateConnectionBody(raw: unknown): ConnectionBody | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid JSON body' }
  const r = raw as Record<string, unknown>
  const endpoint = trimSlashes(typeof r.endpoint === 'string' ? r.endpoint.trim() : '')
  if (!endpoint) return { error: 'endpoint is required' }
  try {
    const u = new URL(endpoint)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'endpoint must be http(s)' }
  } catch {
    return { error: 'endpoint must be a valid URL' }
  }
  const token = typeof r.token === 'string' ? r.token : ''
  const org = typeof r.org === 'string' && r.org.trim() ? r.org.trim() : undefined
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : undefined
  const rules = parseRulesFromBody(r)
  if ('error' in rules) return rules
  const dataDir = typeof r.dataDir === 'string' && r.dataDir.trim() ? r.dataDir.trim() : undefined
  return { endpoint, token, org, label, dataDir, shareMode: rules.shareMode, sources: rules.sources }
}

export interface PatchBody {
  label?: string
  shareMode?: 'denylist' | 'allowlist'
  sources?: ShareSource[]
  /** This machine's consent for THIS central to manage its sessions — see `remoteSessions.ts`. */
  allowRemoteSessions?: boolean
  allowRemoteScreens?: boolean
}

/** Validate the PATCH /api/team/connections/:id body. Pure. An empty string label is a
 *  legitimate "clear the label" — the card then falls back to the endpoint host for display. An
 *  empty `sources` array is likewise legitimate — the explicit "un-block everything" shape in
 *  denylist mode (in allowlist mode it is the explicit "share nothing" shape). At least one of
 *  label/shareMode/sources must be present, or there is nothing to update. */
export function validatePatchBody(raw: unknown): PatchBody | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid JSON body' }
  const r = raw as Record<string, unknown>
  const out: PatchBody = {}
  if ('label' in r) {
    if (typeof r.label !== 'string') return { error: 'label must be a string' }
    out.label = r.label.trim()
  }
  const rules = parseRulesFromBody(r)
  if ('error' in rules) return rules
  if (rules.shareMode !== undefined) out.shareMode = rules.shareMode
  if (rules.sources !== undefined) out.sources = rules.sources

  // The consent switches. Only a real boolean is accepted — a truthy string arriving from a
  // hand-rolled client must not read as an agreement nobody made, which is the same reason
  // `resolveRemoteConsent` tests for a literal `true` rather than truthiness.
  for (const key of ['allowRemoteSessions', 'allowRemoteScreens'] as const) {
    if (key in r && r[key] !== undefined) {
      if (typeof r[key] !== 'boolean') return { error: `${key} must be a boolean` }
      out[key] = r[key] as boolean
    }
  }

  if (out.label === undefined && out.shareMode === undefined && out.sources === undefined
      && out.allowRemoteSessions === undefined && out.allowRemoteScreens === undefined) {
    return { error: 'nothing to update — provide label, shareMode, sources and/or the remote-session switches' }
  }
  return out
}

/**
 * The zero→non-zero transition rule (§4.2), applied HERE and nowhere else — the result is what
 * gets PERSISTED, so the `none` bucket lands in the stored list and the picker renders it
 * pre-blocked; only an explicit later edit removes it, and ONLY in denylist mode (Task 4: in
 * allowlist mode the unattributed bucket is already hidden by default like everything not
 * explicitly listed, so `withUnresolvedSources` is a no-op there). An already-restricted
 * connection's edit is honoured AS-IS (no forced re-add of the sentinel), which is also what makes
 * repeated application from the same starting point idempotent: `previous` reflects what is
 * already persisted, so applying the rule twice against an unchanged `previous` yields the same
 * `requested` handling both times.
 *
 * `requested.mode`/`requested.sources` are each independently optional — a PATCH may change only
 * the mode (keep the list) or only the list (keep the mode), exactly like a body that specifies
 * only one of `shareMode`/`sources`.
 */
export function resolveShareRules(
  previous: { mode: 'denylist' | 'allowlist'; sources: readonly ShareSource[] } | undefined,
  requested: { mode?: 'denylist' | 'allowlist'; sources?: readonly ShareSource[] },
): { mode: 'denylist' | 'allowlist'; sources: ShareSource[] } {
  const prevMode = previous?.mode ?? 'denylist'
  const prevSources = previous?.sources ?? []
  const mode = requested.mode ?? prevMode
  const sources = requested.sources ?? prevSources

  const wasRestricted = sourcesRestrict(prevMode, prevSources)
  const willBeRestricted = sourcesRestrict(mode, sources)
  const finalSources = (!wasRestricted && willBeRestricted)
    ? withUnresolvedSources(mode, [...sources])
    : [...sources]
  return { mode, sources: finalSources }
}

export type ConnectionUpsertDecision =
  | { action: 'insert' }
  | { action: 'update'; existing: TeamConnection }
  | { action: 'conflict'; existing: TeamConnection }

/**
 * The two uniqueness rules, decided together so a token rotation on a known endpoint is
 * distinguished from a genuine token collision:
 *  - a KNOWN normalized endpoint always updates in place, whatever the new token is — token
 *    rotation is a documented admin action and is exactly when a user re-runs connect. Appending
 *    a second connection there would double-count the machine on the central under two
 *    `memberId`s, since the central keys members by `sha256(token)`. Endpoint identity uses
 *    `normalizeEndpointKey` (lower-cased host, default port folded — see its docstring), not a
 *    plain string compare: `https://Central.example.com` and `https://central.example.com` are
 *    the same central, and comparing case-sensitively would insert a second connection for it.
 *  - a token that already belongs to a DIFFERENT connection is refused — two connections sharing
 *    one token collapse onto one `memberId` and would alternately `replaceOne` the same stats
 *    document, flipping the machine's reported totals on every push.
 * An empty token never triggers the conflict branch: it is the legitimate shape for a
 * token-less member against an open/legacy central, and several such connections may coexist.
 * In practice `handleAddConnection` never reaches this function with an empty token today —
 * `whoamiVerify` requires a bearer this central's `validateIngestToken` accepts, and it rejects a
 * missing one before `decideConnectionUpsert` runs — but the branch stays correct standalone
 * (this function's own contract, and what its unit tests exercise) for a central that one day
 * accepts anonymous whoami, or a future caller that skips verification.
 * The endpoint match is checked first and wins even when the new token happens to collide with
 * some OTHER connection's token — that combination is still refused (see below): a token owned
 * by a connection other than the one being updated is a conflict regardless of which branch found
 * it first. Pure.
 */
export function decideConnectionUpsert(
  connections: TeamConnection[],
  endpoint: string,
  token: string,
): ConnectionUpsertDecision {
  const norm = normalizeEndpointKey(endpoint)
  const byEndpoint = connections.find(c => normalizeEndpointKey(c.endpoint) === norm)
  const byToken = token ? connections.find(c => c.token === token) : undefined
  if (byToken && (!byEndpoint || byToken.id !== byEndpoint.id)) {
    return { action: 'conflict', existing: byToken }
  }
  if (byEndpoint) return { action: 'update', existing: byEndpoint }
  return { action: 'insert' }
}

// ---------------------------------------------------------------------------
// I/O glue
// ---------------------------------------------------------------------------

interface WhoamiResult {
  ok: boolean
  user?: string
  org?: string
  /** The token's own label, i.e. the name the CENTRAL gave this machine when the token was minted
   *  — distinct from `user`, the account this token authenticates as. */
  machineName?: string
  error?: string
}

/**
 * whoami-verify a candidate endpoint/token pair. Deliberately asserts on the response BODY
 * (`json.ok === true`), never on `res.ok` — this central answers HTTP 200 with `{ ok: false }`
 * for a revoked or unknown token, which reading `res.ok` alone would misreport as success.
 */
async function whoamiVerify(endpoint: string, token: string): Promise<WhoamiResult> {
  try {
    const res = await fetch(`${endpoint}/api/team/whoami`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(8_000),
    })
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { ok: false, error: `central returned an invalid response (HTTP ${res.status})` }
    }
    const b = body as { ok?: unknown; user?: unknown; org?: unknown; machineName?: unknown }
    if (b && b.ok === true && typeof b.user === 'string') {
      return {
        ok: true,
        user: b.user,
        org: typeof b.org === 'string' ? b.org : undefined,
        machineName: typeof b.machineName === 'string' ? b.machineName : undefined,
      }
    }
    return { ok: false, error: 'the central rejected this token' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' }
  }
}

/** Best-effort, fire-and-forget socket reconciliation — never throws, never delays the HTTP
 *  response. `team-agent-client`'s own diff is fingerprint-based (endpoint+token), so this is
 *  correct for BOTH a brand-new connection and a rotated token: either way the stored fingerprint
 *  changed and the client will (re)connect. */
function nudgeSocket(): void {
  void import('./team-agent-client').then(m => m.reconcileNow()).catch(() => { /* best-effort */ })
}

/**
 * Best-effort nudge after a successful insert: starts this connection's push chain right now
 * instead of waiting out `supervisorTick`'s ~5s poll. Never throws, never delays the response.
 */
function nudgeAfterInsert(): void {
  void reconcileUploaderNow().catch(() => { /* best-effort */ })
  nudgeSocket()
}

/**
 * Best-effort nudge after a successful update (token rotation on a known endpoint): fires an
 * IMMEDIATE push for this connection rather than relying on `reconcileUploaderNow`/
 * `supervisorTick`, which only starts chains for ids NOT already in `_activeChains` — an existing
 * connection's chain is already active, so the supervisor is a no-op for it and the new token
 * would otherwise sit unused until the connection's current interval elapses (up to an hour on a
 * non-express central). `pushNow` also reschedules that connection's recurring timer relative to
 * now, so the cadence doesn't drift. The socket needs a separate nudge regardless — a rotated
 * token changes its fingerprint too. Never throws, never delays the response.
 */
function nudgeAfterUpdate(connId: string): void {
  void pushNow(connId).catch(() => { /* best-effort */ })
  nudgeSocket()
}

/** Unambiguous wrapper around `readJsonLimited` — unlike stashing the error inside the parsed
 *  value, this never collides with a legitimately-shaped body that happens to carry an `error`
 *  key of its own. */
async function readBody<T>(req: Request): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const parsed = await readJsonLimited<T>(req, LIMITS.bodyBytes)
  if (!parsed.ok) return { ok: false, error: parsed.error === 'too_large' ? 'body too large' : 'invalid JSON body' }
  return { ok: true, value: parsed.value }
}

export type AddConnectionOutcome =
  | { ok: true; action: 'insert' | 'update'; connId: string }
  // `ownerEndpoint` is set only for `reason: 'conflict'` — the endpoint of the DIFFERENT
  // connection that already holds this token, not the endpoint the caller tried to connect to.
  // Review finding N4: the message built from this must name the owner, or it asserts something
  // false (a caller retrying against a second central saw "that token already belongs to
  // <the central they were JUST talking to>", which is backwards).
  | { ok: false; reason: 'verify-failed' | 'conflict' | 'lock-timeout'; error: string; ownerEndpoint?: string }

/**
 * Core logic behind POST /api/team/connections — whoami-verifies BEFORE storing anything (see
 * whoamiVerify), then a known normalized endpoint updates in place (token/org/user refreshed; id
 * and label preserved — label changes go through PATCH); a token already owned by another
 * connection is refused; otherwise a fresh connection is minted and appended.
 *
 * Deliberately HTTP-agnostic (no `Request`/`Response`) so `cli-member.ts`'s no-local-server
 * fallback path (Task 6, spec §8) can call the EXACT SAME decision the route uses instead of
 * re-implementing whoami-verify + decideConnectionUpsert by hand and risking drift between the
 * two. Never returns a token.
 *
 * `deps` is injectable for tests — the defaults hit the real network (`whoamiVerify`) and the
 * developer's real `~/.agentistics/preferences.json` (`updateTeamConfig`), neither of which a test
 * may do.
 */
export async function addOrUpdateConnection(
  body: ConnectionBody,
  deps: { updateTeamConfig?: typeof updateTeamConfig; whoamiVerify?: typeof whoamiVerify } = {},
): Promise<AddConnectionOutcome> {
  const _updateTeamConfig = deps.updateTeamConfig ?? updateTeamConfig
  const _whoamiVerify = deps.whoamiVerify ?? whoamiVerify
  const who = await _whoamiVerify(body.endpoint, body.token)
  if (!who.ok) return { ok: false, reason: 'verify-failed', error: who.error ?? 'connection could not be verified' }

  let outcome: { action: 'insert' | 'update' | 'conflict'; connId?: string; ownerEndpoint?: string } = { action: 'insert' }
  try {
    await _updateTeamConfig((current: TeamConfig) => {
      const decision = decideConnectionUpsert(current.connections, body.endpoint, body.token)
      if (decision.action === 'conflict') {
        outcome = { action: 'conflict', ownerEndpoint: decision.existing.endpoint }
        return undefined
      }
      if (decision.action === 'update') {
        const existing = decision.existing
        // Drop `authFailedAt` explicitly rather than carry it forward via `...existing` — this
        // branch is only reached once `whoamiVerify` above has ALREADY proven the new token good,
        // which is strictly stronger proof than the push cycle's own recovery probe. A user who
        // rotates the token on the central and reconnects (exactly the advice the mark's own log
        // line gives) must not still see "unauthorized" on a token that demonstrably works.
        const { authFailedAt: _cleared, ...prev } = existing
        const updated: TeamConnection = {
          ...prev,
          endpoint: body.endpoint,
          token: body.token,
          // Same precedence as the insert branch below — an explicit body value wins, else the
          // fresh whoami reading, else what's already stored: an explicit caller-supplied org must
          // never be silently overridden by whoami on every reconnect.
          org: body.org ?? who.org ?? existing.org,
          user: who.user ?? existing.user,
          // id, label, shareMode AND sources are preserved on an update (a reconnect/token-
          // rotation), never overwritten from the body — the rules editor is the only writer of
          // an EXISTING connection's rules (PATCH), so a body.shareMode/sources here is silently
          // ignored rather than reset to it.
        }
        outcome = { action: 'update', connId: existing.id }
        const connections = current.connections.map(c => (c.id === existing.id ? updated : c))
        return normalizeTeamConfig({ ...defaultTeam(), mode: 'member', connections })
      }
      const id = connectionId()
      // R10: the rules travel in the SAME create as the rest of the connection, committed inside
      // this one updateTeamConfig transaction — nudgeAfterInsert() below only runs once it
      // resolves, so the uploader can never see this connection before its rules exist and push
      // the entire unfiltered history first. The zero→non-zero transition (§4.2) applies here
      // too: `previous` is undefined (a brand-new connection has no prior state).
      const rules = resolveShareRules(undefined, { mode: body.shareMode, sources: body.sources ?? [] })
      const created: TeamConnection = {
        id,
        endpoint: body.endpoint,
        token: body.token,
        org: body.org ?? who.org ?? 'default',
        user: who.user ?? '',
        // LEGACY, never written meaningfully from this version onward — see `TeamConnection`'s
        // own docstring. The field stays required by the type, so it is initialized empty here.
        deniedRepos: [],
        shareMode: rules.mode,
        sources: rules.sources,
        addedAt: new Date().toISOString(),
        ...(body.label !== undefined ? { label: body.label } : {}),
      }
      outcome = { action: 'insert', connId: id }
      return normalizeTeamConfig({ ...defaultTeam(), mode: 'member', connections: [...current.connections, created] })
    })
  } catch (err) {
    if (err instanceof PreferencesLockTimeoutError) {
      return { ok: false, reason: 'lock-timeout', error: 'another process is writing preferences — retry shortly' }
    }
    throw err
  }

  if (outcome.action === 'conflict') {
    return {
      ok: false, reason: 'conflict',
      error: `this token is already used by the connection to ${outcome.ownerEndpoint}`,
      ownerEndpoint: outcome.ownerEndpoint,
    }
  }
  if (outcome.action === 'update' && outcome.connId) {
    nudgeAfterUpdate(outcome.connId)
  } else if (outcome.connId) {
    nudgeAfterInsert()
  }
  return { ok: true, action: outcome.action as 'insert' | 'update', connId: outcome.connId! }
}

/**
 * POST /api/team/connections — { endpoint, token, org?, label? }. Thin HTTP wrapper around
 * `addOrUpdateConnection` (see its docstring for the decision itself).
 */
export async function handleAddConnection(req: Request): Promise<Response> {
  const parsed = await readBody<unknown>(req)
  if (!parsed.ok) return json({ error: parsed.error }, 400)
  const body = validateConnectionBody(parsed.value)
  if ('error' in body) return json({ error: body.error }, 400)

  // `agentop member connect` prefers this route over writing preferences itself, so that a
  // running server picks the new connection up without a restart. But it finds the server by
  // PORT alone, and a machine profile is identified by its DATA DIR: with a second profile
  // running (AGENTISTICS_DIR / an isolated HOME, or the Docker machine beside the native one),
  // that lands one machine's connection — token and all — in another machine's config, silently,
  // while the CLI reports the count of the profile it did NOT write to. A caller that states
  // which profile it meant is answered only by that profile; everyone else falls back to writing
  // its own preferences directly, under the cross-process lock.
  if (body.dataDir && body.dataDir !== AGENTISTICS_DATA_DIR) {
    return json({ error: 'data_dir_mismatch', dataDir: AGENTISTICS_DATA_DIR }, 409)
  }

  const result = await addOrUpdateConnection(body)
  if (!result.ok) {
    if (result.reason === 'lock-timeout') return lockTimeoutResponse()
    return json(
      { error: result.error, ...(result.reason === 'conflict' ? { ownerEndpoint: result.ownerEndpoint } : {}) },
      result.reason === 'conflict' ? 409 : 400,
    )
  }
  return json({ ok: true, id: result.connId, action: result.action })
}

/** Best-effort nudge after a rules change (§6.1): the route only PERSISTS the new denylist and
 *  kicks this connection's next cycle off immediately (instead of waiting out its own interval).
 *  Everything past that — the shrink detector, the journal, the batched forget, the rebuilt cache
 *  push — runs SERVER-SIDE inside `runConnectionCycle`. Never orchestrated from the browser: a tab
 *  closing mid-sequence must not leave the journal open with no client left to resume it. Never
 *  throws, never delays the response. */
function nudgeAfterRulesChange(connId: string): void {
  void pushNow(connId).catch(() => { /* best-effort */ })
}

/** Best-effort, fire-and-forget local dashboard refresh (§ live-refresh): tells every connected
 *  SSE client on THIS machine to re-fetch, so the Settings panel reflects a sharing-rules edit or
 *  a label rename immediately instead of on the next poll. Dynamic import mirrors the rest of this
 *  file's fire-and-forget nudges (`nudgeSocket`, `nudgeAfterInsert`) — `sse.ts` is a heavier,
 *  request-handling module and this keeps it out of the load path of every other route. Never
 *  throws, never delays the response. */
function notifyLocalDashboards(): void {
  void import('./sse').then(m => m.triggerSseNotification()).catch(() => { /* best-effort */ })
}

/** PATCH /api/team/connections/:id — { label?, shareMode?, sources? } (a legacy { deniedRepos? }
 *  body is still accepted and converted — see `parseRulesFromBody`) — read-modify-write that entry
 *  only. A rules change (either field present) applies `resolveShareRules`'s zero→non-zero
 *  transition against the entry's OWN previous mode/sources (never a global default) and, once
 *  persisted, triggers the §6.1 reconcile cycle for this connection — switching denylist↔allowlist
 *  goes through the exact same path as editing the list, because `resolveShareRules` treats a mode
 *  change and a sources change identically (Task 4: no special-cased shrink path). Returns
 *  `{ ok, queued: true }` when a rules change was accepted, so the caller knows the removal (if
 *  any) is now running server-side rather than applied synchronously.
 *
 *  Live-refresh: `deps.notify` fires ONLY when the write actually changed something the machine's
 *  own dashboards show — the resolved rules signature differs from what was stored (`rulesActuallyChanged`,
 *  via `rulesSignature` — not merely "a rules field was present in the body", which
 *  `resolveShareRules` accepts even when it resolves back to the same set), or the label's value
 *  actually differs. A request that re-sends the same label or the same source list is a no-op and
 *  must not wake every dashboard watching this machine. It fires AFTER `_updateTeamConfig` has
 *  resolved (the write is committed), never before — a client that refetches on receiving it must
 *  see the new state, not the old one.
 *
 *  `deps` is injectable for tests — the defaults write the developer's real
 *  `~/.agentistics/preferences.json`, kick a real push cycle, and notify real SSE clients, none of
 *  which a test may do. */
export async function handlePatchConnection(
  req: Request,
  rawId: string,
  deps: {
    updateTeamConfig?: typeof updateTeamConfig
    nudge?: (connId: string) => void
    notify?: () => void
    checkElsewhere?: (connId: string) => void
    announce?: (connId: string) => void
    announceConsent?: (connId: string) => void
  } = {},
): Promise<Response> {
  const _updateTeamConfig = deps.updateTeamConfig ?? updateTeamConfig
  const _nudge = deps.nudge ?? nudgeAfterRulesChange
  const _notify = deps.notify ?? notifyLocalDashboards
  const _checkElsewhere = deps.checkElsewhere ?? checkElsewhereNow
  const _announce = deps.announce ?? announceRestrictionNow
  const _announceConsent = deps.announceConsent ?? announceRemoteConsentNow
  let id: string
  try {
    id = safeConnId(rawId)
  } catch {
    return json({ error: 'invalid connection id' }, 400)
  }

  const parsed = await readBody<unknown>(req)
  if (!parsed.ok) return json({ error: parsed.error }, 400)
  const body = validatePatchBody(parsed.value)
  if ('error' in body) return json({ error: body.error }, 400)

  let found = false
  let rulesChanged = false
  let somethingChanged = false
  let consentChanged = false
  try {
    await _updateTeamConfig((current: TeamConfig) => {
      const existing = current.connections.find(c => c.id === id)
      if (!existing) return undefined
      found = true
      let shareMode = existing.shareMode
      let sources = existing.sources
      if (body.shareMode !== undefined || body.sources !== undefined) {
        const resolved = resolveShareRules(
          { mode: existing.shareMode ?? 'denylist', sources: existing.sources ?? [] },
          { mode: body.shareMode, sources: body.sources },
        )
        shareMode = resolved.mode
        sources = resolved.sources
        rulesChanged = true
        // The route always runs the §6.1 reconcile cycle when a rules field was PRESENT (safe —
        // an extra no-op cycle is harmless), but a live-refresh notification is a different cost
        // (it wakes every open dashboard on this machine) and must be gated on a REAL difference.
        if (rulesSignature(shareMode, sources) !== rulesSignature(existing.shareMode, existing.sources)) {
          somethingChanged = true
        }
      }
      const newLabel = body.label !== undefined ? (body.label || undefined) : existing.label
      if (body.label !== undefined && newLabel !== existing.label) somethingChanged = true
      // The consent switches. Written independently of each other — the UI can turn screens off
      // without touching sessions — but `resolveRemoteConsent` is what READS them, so a stored
      // `{sessions:false, screens:true}` is never in force whatever order the two writes arrive in.
      const allowRemoteSessions = body.allowRemoteSessions !== undefined ? body.allowRemoteSessions : existing.allowRemoteSessions
      // Withdrawing the fleet consent CLEARS the screen consent too, rather than leaving it stored
      // and inert. `resolveRemoteConsent` would already refuse to act on it, so this is not about
      // enforcement — it is about what happens LATER: a stored `screens:true` under a switched-off
      // `sessions` comes back the moment sessions is switched on again, and a grant nobody
      // re-made is the thing a withdrawal is supposed to prevent. Turning it back on is one click;
      // discovering your terminal is being read again because of a decision you reversed months
      // ago is not recoverable.
      const requestedScreens = body.allowRemoteScreens !== undefined ? body.allowRemoteScreens : existing.allowRemoteScreens
      // Only a GRANT is cleared. An absent field stays absent: rewriting `undefined` to `false` on
      // every unrelated PATCH would mark the connection as changed and wake every open dashboard
      // for a no-op, which is exactly what `somethingChanged` exists to avoid.
      const allowRemoteScreens = allowRemoteSessions === true
        ? requestedScreens
        : (requestedScreens === true ? false : requestedScreens)
      if (allowRemoteSessions !== existing.allowRemoteSessions || allowRemoteScreens !== existing.allowRemoteScreens) {
        somethingChanged = true
        consentChanged = true
      }
      const connections = current.connections.map(c => c.id === id
        ? {
            ...c,
            ...(body.label !== undefined ? { label: newLabel } : {}),
            shareMode,
            sources,
            ...(allowRemoteSessions !== undefined ? { allowRemoteSessions } : {}),
            ...(allowRemoteScreens !== undefined ? { allowRemoteScreens } : {}),
          }
        : c)
      return normalizeTeamConfig({ ...defaultTeam(), mode: 'member', connections })
    })
  } catch (err) {
    if (err instanceof PreferencesLockTimeoutError) return lockTimeoutResponse()
    throw err
  }

  if (!found) return json({ error: 'unknown connection' }, 404)
  // Notify only once the write above has resolved — the client's refetch must observe it.
  if (somethingChanged) _notify()
  // Tell the central at once. A consent that only reached it at the next reconnect would leave the
  // owning account looking at a switch they just turned OFF while the central still believed it was
  // on — and "off" is the half of this that has to be immediate.
  if (consentChanged) _announceConsent(id)
  if (rulesChanged) {
    // The moment the answer matters: the user has just restricted something, so ask the central
    // (question unchanged, see account-repos.ts) and recompute the warning without waiting out
    // the status route's TTL.
    _checkElsewhere(id)
    // Tell this account's OTHER machines, sealed to each of them (Part 2). Fire-and-forget and
    // entirely optional: an older central has no mailbox, and the local warning above covers the
    // case regardless.
    _announce(id)
    _nudge(id)
    return json({ ok: true, queued: true })
  }
  return json({ ok: true })
}

export type LeaveConnectionOutcome =
  | { ok: true; endpoint: string }
  | { ok: false; error: string }

/**
 * Core logic behind DELETE /api/team/connections/:id — whoami is implicit (the stored token is
 * used as-is): best-effort POST to the central's /api/team/leave with that connection's token (an
 * offline or already-revoked central must not block local removal), then removes the entry and
 * its state files via `removeConnection` (team-uploader.ts), which runs the removal inside the
 * same preferences write chain and tears down this connection's timers/socket immediately.
 *
 * HTTP-agnostic for the same reason `addOrUpdateConnection` is — `cli-member.ts`'s no-server
 * fallback path calls this directly instead of duplicating it.
 *
 * `deps` is injectable for tests (mirrors `removeConnection`'s own `deps.updateTeamConfig`/
 * `deps.log` seams) — the defaults touch the developer's real preferences file, which a test must
 * never do. `deps.log` is forwarded verbatim to `removeConnection` — see its docstring for why
 * `cli-member.ts`'s no-server fallback is the one production caller that overrides it.
 */
export async function leaveConnectionById(
  rawId: string,
  deps: {
    readPreferences?: typeof readPreferences
    removeConnection?: typeof removeConnection
    log?: { info: (msg: string) => void; warn: (msg: string) => void }
  } = {},
): Promise<LeaveConnectionOutcome> {
  const _readPreferences = deps.readPreferences ?? readPreferences
  const _removeConnection = deps.removeConnection ?? removeConnection

  let id: string
  try {
    id = safeConnId(rawId)
  } catch {
    return { ok: false, error: 'invalid connection id' }
  }

  const prefs = await _readPreferences()
  const conn = (prefs.team?.connections ?? []).find(c => c.id === id)
  if (!conn) return { ok: false, error: 'unknown connection' }

  try {
    const endpoint = trimSlashes(conn.endpoint)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (conn.token) headers['Authorization'] = `Bearer ${conn.token}`
    await fetch(`${endpoint}/api/team/leave`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ org: conn.org, user: conn.user }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    // Best-effort — the central may be offline or the token already revoked; the connection is
    // still removed locally below.
  }

  // Check the actual removal result (I1) — a lock-timeout write failure must NOT be reported as
  // a successful leave; the previous version ignored removeConnection's outcome entirely.
  const result = await _removeConnection(id, 'manual', deps.log ? { log: deps.log } : {})
  if (!result.removed) return { ok: false, error: result.error }
  return { ok: true, endpoint: conn.endpoint }
}

/** DELETE /api/team/connections/:id — thin HTTP wrapper around `leaveConnectionById`. */
export async function handleDeleteConnection(_req: Request, rawId: string): Promise<Response> {
  const result = await leaveConnectionById(rawId)
  if (!result.ok) {
    return json({ error: result.error }, result.error === 'unknown connection' ? 404 : 400)
  }
  return json({ ok: true })
}

interface ProbeResult {
  ok: boolean
  latencyMs: number
  user?: string
  org?: string
  /** Forwarded from `whoamiVerify` — the central's own name for this machine (the token's
   *  `label`), so the connection card can show it instead of misreading `user` (the account name)
   *  as the machine's identity. */
  machineName?: string
  error?: string
}

/** POST /api/team/connections/:id/probe — server-side identity/latency probe using the STORED
 *  token (never one supplied by the caller). Never returns the token. */
export async function handleProbeConnection(_req: Request, rawId: string): Promise<Response> {
  let id: string
  try {
    id = safeConnId(rawId)
  } catch {
    return json({ error: 'invalid connection id' }, 400)
  }

  const prefs = await readPreferences()
  const conn = (prefs.team?.connections ?? []).find(c => c.id === id)
  if (!conn) return json({ error: 'unknown connection' }, 404)

  const endpoint = trimSlashes(conn.endpoint)
  const t0 = Date.now()
  const who = await whoamiVerify(endpoint, conn.token)
  const latencyMs = Date.now() - t0
  const result: ProbeResult = who.ok
    ? { ok: true, latencyMs, user: who.user, org: who.org, machineName: who.machineName }
    : { ok: false, latencyMs, error: who.error }
  return json(result)
}

/** `shareMode` + a per-dimension COUNT — never the source values themselves (§6.4: the full list
 *  is same-origin-only, via `GET /api/preferences`). Denylist reports the two dimensions
 *  separately (`deniedRepos` folds in the `none` bucket, same as the legacy `deniedCount`);
 *  allowlist reports one combined `allowedCount`, because there the two dimensions are simply
 *  "what's on the list" rather than "what's blocked, by kind". */
export interface RuleCounts {
  shareMode: 'denylist' | 'allowlist'
  deniedRepos: number
  deniedProjects: number
  allowedCount: number
}

/** Build `RuleCounts` from a connection's stored mode + typed sources. Pure. `mode` absent/junk
 *  reads as `'denylist'`, the same default `shareRulesOf` applies. Counts are of the NORMALIZED
 *  (canonicalized, deduped) source set — junk entries never inflate a count. */
export function ruleCountsOf(mode: 'denylist' | 'allowlist' | undefined, sources: readonly ShareSource[] | undefined): RuleCounts {
  const shareMode: 'denylist' | 'allowlist' = mode === 'allowlist' ? 'allowlist' : 'denylist'
  const keys = normalizeSources(sources)
  if (shareMode === 'allowlist') return { shareMode, deniedRepos: 0, deniedProjects: 0, allowedCount: keys.size }
  let deniedRepos = 0
  let deniedProjects = 0
  for (const k of keys) {
    if (k.startsWith('project:')) deniedProjects++
    else deniedRepos++ // 'repo:*' and the fixed 'none:' bucket both count as the repo dimension
  }
  return { shareMode, deniedRepos, deniedProjects, allowedCount: 0 }
}

export interface ConnectionStatusEntry {
  id: string
  endpoint: string
  org: string
  user: string
  label?: string
  lastSuccessAt: number | null
  errKind: 'auth' | 'net' | null
  latencyMs: number | null
  /** 'denylist' (share everything except the sources below) | 'allowlist' (share only them).
   *  Never absent on the wire — `ruleCountsOf`'s same default as `shareRulesOf`. */
  shareMode: 'denylist' | 'allowlist'
  /** Denylist-mode counts (repo+none sources, project sources). Always 0 in allowlist mode —
   *  see `allowedCount` there instead. NEVER the values themselves. */
  deniedRepos: number
  deniedProjects: number
  /** Allowlist-mode count of everything listed. Always 0 in denylist mode. */
  allowedCount: number
  /** LEGACY, kept for existing clients: the total normalized source count regardless of mode —
   *  `deniedRepos + deniedProjects` in denylist mode, `allowedCount` in allowlist mode. */
  deniedCount: number
  /** From the STORED mode + sources (`sourcesRestrict`), never from uploader/push-cycle state — a
   *  connection whose rules were just saved is restricted immediately, even before its first
   *  cycle has run. Allowlist mode is ALWAYS restricted, even with an empty source list. */
  restricted: boolean
  /**
   * This machine's consent for THIS central to manage its sessions — the RESOLVED pair, never the
   * two raw fields, so `resolveRemoteConsent` stays the only interpretation of them.
   *
   * Same-origin only, like every other field on this route. It is on the wire here for the machine's
   * OWN dashboard to render its switches; the central learns it by announcement over the reverse
   * channel (`remote-consent`), not from this.
   */
  remoteSessions: boolean
  remoteScreens: boolean
  /** The day after Claude's own rollup watermark — the local honesty marker from §4.4/§5.9.
   *  Shared across every connection (it describes THIS machine's stats-cache, not a connection),
   *  and lives on this route only: never sent to a central. `null` = unknowable this cycle
   *  (no context could be built), NOT the same fact as `''` (nothing rolled up yet). */
  boundary: string | null
  /** How many stored sessions fall before `boundary` — the size of the block no rule can split.
   *  `null` = unknowable, distinct from a real `0`. Never coerce one into the other. */
  prehistorySessions: number | null
  /** Whether this connection's central has ever advertised `forget.sessions`. Absence reads as
   *  `false` (fail closed) — a network flap must never flip a previously-learned `true`. */
  canForget: boolean
  /** The complement of `canForget` — kept as its own field (rather than inferred client-side) so
   *  the UI never has to invert the polarity itself. */
  centralTooOld: boolean
  /** Live progress of an in-flight retroactive removal for this connection, or `null` when none
   *  is running. */
  resync: ForgetProgress | null
  /** True while this connection's declared rules are not yet enforced on its central — a forget
   *  sequence has not completed successfully since the denylist last changed. The UI must never
   *  report success while this is true. */
  pendingRules: boolean
  /** Repositories THIS machine hides that a DIFFERENT machine of the same account still sends to
   *  this central, computed locally by intersecting the central's account-scoped repository list
   *  against these rules (`account-repos.ts`). Same-origin only, like the rest of this route: it
   *  names the sibling machines, which is exactly what makes the warning actionable. Empty when
   *  there is nothing to warn about, when the central is too old to answer, or before the first
   *  check has run — all three are "no warning", and none is an error. */
  elsewhere: ElsewhereRepo[]
}

/** The local facts `buildConnectionStatusEntry` cannot derive from `conn`/`uploaderStatus` alone —
 *  gathered once per status build (boundary/prehistorySessions are shared across every
 *  connection) and threaded in, so the entry-building itself stays pure and unit-testable without
 *  touching the filesystem or the uploader's module-level state. */
export interface ConnectionLocalFacts {
  boundary: string | null
  prehistorySessions: number | null
  canForget: boolean
  resync: ForgetProgress | null
  /** The cached still-shared-elsewhere warning for this connection (`team-elsewhere.ts`). */
  elsewhere: ElsewhereRepo[]
  /** This connection's persisted `RulesState.rulesHash` (team-rules.ts) — `''` when no rules
   *  cycle has ever run for it, which reads as `emptyRulesSignature()` (never as "changed"), the
   *  same rule `planRulesReconcile` itself follows. */
  rulesHash: string
}

/**
 * Build one connection's `/api/team/status` entry from already-resolved local facts. PURE — the
 * whole point of the split is that "restricted comes from the stored list, not uploader state"
 * (and the rest of §5.9's honesty markers) can be asserted directly, without `readPreferences()`,
 * `getPushContext()` or any of `team-uploader.ts`'s per-connection singletons in the test.
 *
 * Never includes `token` or the rule VALUES — only counts (`ruleCountsOf`, `deniedCount`). See the
 * class docstring above `handleTeamStatus`.
 */
export function buildConnectionStatusEntry(
  conn: TeamConnection,
  uploaderStatus: UploaderStatus,
  local: ConnectionLocalFacts,
): ConnectionStatusEntry {
  const prevHash = local.rulesHash ? local.rulesHash : emptyRulesSignature()
  // Covers mode AND sources (Task 4) — a mode switch alone must read as pending exactly like an
  // edited list, since `rulesSignature` folds the mode in.
  const pendingRules = rulesSignature(conn.shareMode, conn.sources) !== prevHash
  const counts = ruleCountsOf(conn.shareMode, conn.sources)
  // `conn.authFailedAt` is the DURABLE mark (survives a server restart; team-uploader.ts's
  // in-memory `_pushErrKind` does not) — it must win over the in-memory uploader status so a
  // freshly-restarted process still reports "unauthorized" for a connection marked before the
  // restart, instead of reading as healthy until its first cycle runs again.
  const errKind: 'auth' | 'net' | null = conn.authFailedAt ? 'auth' : uploaderStatus.errKind
  return {
    id: conn.id,
    endpoint: conn.endpoint,
    org: conn.org,
    user: conn.user,
    // The name the CENTRAL gave this machine. Already resolved from `whoami` and already stored on
    // the connection; it simply had no way out of this process. The cockpit's header draws it so
    // two SSH'd terminals running identical cockpits can be told apart — which was reported as
    // impossible, and was.
    ...(conn.machineName ? { machineName: conn.machineName } : {}),
    ...(conn.label ? { label: conn.label } : {}),
    lastSuccessAt: uploaderStatus.lastSuccessAt,
    errKind,
    latencyMs: uploaderStatus.latencyMs,
    shareMode: counts.shareMode,
    deniedRepos: counts.deniedRepos,
    deniedProjects: counts.deniedProjects,
    allowedCount: counts.allowedCount,
    deniedCount: counts.shareMode === 'allowlist' ? counts.allowedCount : counts.deniedRepos + counts.deniedProjects,
    restricted: sourcesRestrict(conn.shareMode, conn.sources),
    ...(() => {
      const consent = resolveRemoteConsent(conn.allowRemoteSessions, conn.allowRemoteScreens)
      return { remoteSessions: consent.sessions, remoteScreens: consent.screens }
    })(),
    boundary: local.boundary,
    prehistorySessions: local.prehistorySessions,
    canForget: local.canForget,
    centralTooOld: !local.canForget,
    resync: local.resync,
    pendingRules,
    elsewhere: local.elsewhere,
  }
}

export interface AggregatedConnectionStatus {
  lastSuccessAt: number | null
  errKind: 'auth' | 'net' | null
  latencyMs: number | null
}

/**
 * Aggregate several connections' statuses into the single top-level status the member-side pill
 * (`MemberConnectionStatus.tsx`) has always read — `{lastSuccessAt, errKind, latencyMs}` at the
 * TOP of the response, not nested under `connections[]`. `lastSuccessAt` is the MOST RECENT
 * success across connections; `errKind` is the WORST currently in force ('auth' outranks 'net',
 * since a revoked token is the more actionable state) — 'auth' if any connection has it, else
 * 'net' if any does, else null only when every connection is clean; `latencyMs` is the one
 * measured on the connection that produced the chosen `lastSuccessAt` (the freshest sample, and
 * the one most representative of "how things stand right now" — an average across connections to
 * unrelated centrals with unrelated RTTs would not mean anything). Pure.
 */
export function aggregateConnectionStatuses(entries: ConnectionStatusEntry[]): AggregatedConnectionStatus {
  let lastSuccessAt: number | null = null
  let latencyMs: number | null = null
  for (const e of entries) {
    if (e.lastSuccessAt != null && (lastSuccessAt === null || e.lastSuccessAt > lastSuccessAt)) {
      lastSuccessAt = e.lastSuccessAt
      latencyMs = e.latencyMs
    }
  }
  const errKind: 'auth' | 'net' | null =
    entries.some(e => e.errKind === 'auth') ? 'auth' :
    entries.some(e => e.errKind === 'net') ? 'net' :
    null
  return { lastSuccessAt, errKind, latencyMs }
}

/**
 * Whether OTel metrics export is configured on THIS machine — the same gate `otel-watcher.ts`
 * uses for its own exporter (`OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ''`,
 * exporting only when non-empty). Read directly here, as a plain env check, rather than importing
 * `otel-watcher.ts` — that module runs its OWN watcher (chokidar + `setInterval` + `process.on`
 * signal handlers) as an IMPORT-TIME side effect (its trailing `main().catch(...)` call), so
 * pulling it into a request-handling module would start a second, unwanted watcher on every
 * `/api/team/status` request. Machine-wide, not per-connection — OTel export sends the whole
 * machine's unfiltered totals regardless of which central a session belongs to.
 */
export function otelExportEnabled(): boolean {
  return Boolean((process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim())
}

/**
 * GET /api/team/status — the per-connection shape (spec §9.5) PLUS the aggregated
 * `{lastSuccessAt, errKind, latencyMs}` at the top level, for `MemberConnectionStatus.tsx` (the
 * status pill), which does not yet read `connections[]`. Reads CACHED values only
 * (`getUploaderStatus`, populated by the uploader's own push cycle, latency included) — never
 * makes its own blocking network call. The previous single-connection handler did a fresh
 * ~4s-timeout probe on every call while the frontend polls every 5s, which with two offline
 * centrals alone exceeds its own poll interval. Never returns a token, and never the rule VALUES
 * — only `shareMode` and per-dimension counts (`deniedRepos`/`deniedProjects`/`allowedCount`;
 * `deniedCount` kept for existing clients) (§6.4: the full list is same-origin-only, via
 * `GET /api/preferences`). `boundary`/`prehistorySessions` are local honesty markers (§4.4) that
 * exist on this route and nowhere on the wire to a central. `otelExportEnabled` is likewise
 * local-only and machine-wide (never per-connection) — the repository picker's `otelWarn` reads
 * it to say the rule does not cover OTel's unfiltered export.
 *
 * `deps` is injectable for tests — the default reads the developer's real preferences file.
 */
export async function handleTeamStatus(
  _req: Request,
  deps: {
    readPreferences?: typeof readPreferences
    scheduleElsewhere?: (conn: TeamConnection) => void
    scheduleEnvelopes?: (conn: TeamConnection) => void
  } = {},
): Promise<Response> {
  const prefs = await (deps.readPreferences ?? readPreferences)()
  const team = prefs.team
  const connections = team?.connections ?? []
  const byConn = getUploaderStatus()

  // The local honesty markers (§4.4/§5.9) describe THIS MACHINE's own Claude rollup — the same
  // fact for every connection — so they are computed ONCE and reused per entry, never derived per
  // connection and never put on the wire to any central.
  //
  // Read from the LAST-BUILT push context (`peekPushContext`, stale-tolerant), never
  // `getPushContext()`, which BUILDS one. The browser polls this route every ~5s while
  // `notifyDataChanged()` invalidates the context on every local file change, so during active
  // coding the TTL protects nothing and building here ran `buildApiResponse()` — which also
  // WRITES the consolidate store — plus `loadConsolidated()` at the poll cadence instead of the
  // connection's push interval. These two fields are display-only: serving them one push cycle
  // stale is correct, and `null` ("unknowable", already distinct from `0` on this route and in
  // the UI) is correct before the first cycle has run. Never coerce it to 0.
  const ctx = connections.length > 0 ? peekPushContext() : null
  const boundary = ctx?.realStatsCache ? attributionBoundary(ctx.realStatsCache) : null
  const prehistorySessions = ctx?.realStatsCache ? prehistoryCount(ctx.realStatsCache, boundary) : null

  const entries: ConnectionStatusEntry[] = await Promise.all(connections.map(async c => {
    // A connection that has not run a single cycle yet has no entry at all in
    // `getUploaderStatus()` (it only reports ids that pushed or failed) — `emptyStatusFor` is the
    // one definition of what that state looks like, so the shape can never drift between the
    // "never ran" and "ran" branches of this response.
    const uploaderStatus = byConn[c.id] ?? emptyStatusFor(c.id)
    // Background, TTL-throttled (`ELSEWHERE_TTL_MS`) and never awaited: the poller must not block
    // on a central, and a stale answer is the correct thing to render while a fresh one lands.
    ;(deps.scheduleElsewhere ?? scheduleElsewhereCheck)(c)
    // Collect sealed mail on the same background, TTL-throttled principle (ENVELOPE_POLL_MS).
    ;(deps.scheduleEnvelopes ?? scheduleEnvelopeSync)(c)
    const rules = await loadRulesState(c.id)
    return buildConnectionStatusEntry(c, uploaderStatus, {
      boundary,
      prehistorySessions,
      canForget: connectionCanForget(c.id),
      resync: getResyncProgress(c.id),
      elsewhere: getElsewhere(c.id),
      rulesHash: rules.rulesHash,
    })
  }))
  const aggregated = aggregateConnectionStatuses(entries)
  return json({ mode: team?.mode ?? 'solo', ...aggregated, otelExportEnabled: otelExportEnabled(), connections: entries })
}
