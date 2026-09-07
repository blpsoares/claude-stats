// team-agent-client.ts — member-side WebSocket client for the reverse channel (Phase 7)
//
// Opens a PERSISTENT WEBSOCKET PER CONNECTION to each central's /api/team/agent endpoint. A
// machine can belong to several centrals at once (`preferences.team.connections[]`, see
// @agentistics/core's team.ts), and presence on the central is WS-authoritative — so a single
// shared socket would mean whichever connection reconciled first "owns" it and every OTHER
// central reads this machine as permanently offline while it is pushing fine. Every piece of
// mutable state that used to be a module-level singleton (the socket itself, the backoff index,
// the live-reporting timer) is therefore keyed by connection id.
//
// On-demand chat retrieval (the former 'fetch-chat' request / 'chat-result' reply) has been
// removed — the member never sends chat content to the central over this channel.
//
// Reconnects with exponential backoff on close/error, per connection.
// startAgentClient() is idempotent — safe to call multiple times.
// Never throws; all errors are swallowed internally.

import type { TeamConnection } from '@agentistics/core'
import { readTeamConnections, normalizeTeamConfig, resolveRemoteConsent } from '@agentistics/core'
import { readPreferences, updateTeamConfig } from './preferences'

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in team-agent-client.test.ts)
// ---------------------------------------------------------------------------

/** Reconnect backoff delays in milliseconds. */
export const BACKOFF_MS: number[] = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * Build the reverse-channel WS URL for a central's HTTP(S) base endpoint. Pure.
 *
 * MUST trim a trailing slash first: `http://host/` naively maps to `ws://host//api/team/agent`,
 * whose double slash misses the server's EXACT-MATCH upgrade route — the socket never connects,
 * and (since presence is WS-authoritative) that central sees this machine as offline forever,
 * silently, with no error surfaced anywhere.
 */
export function agentWsUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '').replace(/^https/, 'wss').replace(/^http/, 'ws') + '/api/team/agent'
}

/** Exponential backoff delay (ms) for the given attempt index (0-based, clamped both ends). Pure. */
export function backoffDelay(idx: number): number {
  const clamped = Math.min(Math.max(idx, 0), BACKOFF_MS.length - 1)
  return BACKOFF_MS[clamped] ?? 30_000
}

/** Display label for a connection in notifications — a nickname if set, else the endpoint host.
 *  NEVER the token. Deliberately duplicated (not imported) from team-uploader.ts's `hostOf`: that
 *  module dynamically imports THIS one (see `removeConnection`'s reconcileNow nudge), so importing
 *  it back statically would put both modules on the same load-order cycle for a 2-line helper. */
function hostOf(endpoint: string): string {
  try { return new URL(endpoint).host || endpoint } catch { return endpoint }
}

function labelOf(conn: TeamConnection): string {
  return conn.label ?? hostOf(conn.endpoint)
}

/** A connection is eligible to hold a reverse-channel socket once it has an endpoint. Whether a
 *  token is REQUIRED is the central's call, not this client's: an open/legacy central accepts a
 *  token-less member (see `keepStoredTokens` in preferences.ts), so gating on a non-empty token
 *  here would refuse to even try against one. This also drops the old `user` requirement — a
 *  connection added while its central was briefly unreachable never got a first whoami and, under
 *  the old gate, stayed unconnected forever with nothing left to retry it. */
function hasCredentials(conn: TeamConnection): boolean {
  return Boolean(conn.endpoint)
}

export function fingerprintOf(conn: TeamConnection): string {
  return `${conn.endpoint}\0${conn.token}`
}

/**
 * Whether the socket currently open under `storedFingerprint` (the endpoint+token it was opened
 * with — `undefined` if none is open) should be torn down for this connection. Pure — no I/O, no
 * map reads — so the fingerprint-triggered-rotation path (previously only reasoned through, not
 * exercised) is a one-line unit test instead of a live socket + a rotated token on a mock server.
 * True when: no socket is open for this id (nothing to tear down is harmless to report true —
 * the caller no-ops on a missing socket), the connection is gone (`undefined`), it lost its
 * endpoint, or its live fingerprint no longer matches (token rotated / endpoint changed).
 */
export function shouldTeardown(storedFingerprint: string | undefined, conn: TeamConnection | undefined): boolean {
  if (!conn || !hasCredentials(conn)) return true
  return storedFingerprint !== fingerprintOf(conn)
}

// ---------------------------------------------------------------------------
// Inbound admin frames — 'renamed' / 'reassigned' — decoded as a pure decision
// ---------------------------------------------------------------------------

export interface AgentFrameDecision {
  /** A notification to broadcast, or null for an unrecognized/malformed frame. */
  notification: { type: 'info'; code: 'machine.renamed' | 'machine.reassigned' | 'machine.session_acted'; meta: Record<string, unknown> } | null
  /** New value to write into this connection's `user`, or null for "no change". Note that ''
   *  (empty string) IS a valid update — it means "clear it", not "no change": a reassignment to
   *  no owner does not tell us what the machine's display name falls back to, so the existing
   *  empty-user whoami retry (`resolveMemberIdentity`) is the correct way to re-learn it, rather
   *  than leaving the pre-reassignment name displayed indefinitely. */
  userUpdate: string | null
  /** Nudge open dashboards to refetch (reassigned only — the "Connected as" panel needs the
   *  server round-trip regardless of what the local `user` becomes). */
  refreshDashboard: boolean
}

/**
 * Decode one inbound WebSocket frame from a central into a decision — pure, no I/O, so the
 * message handler (previously only reasoned through) is a table of unit tests instead of a live
 * socket sending crafted JSON.
 *
 * `meta` (connectionId + central label) is threaded in rather than looked up here — attribution
 * data lives on the connection, not in the frame the central sent, so with N centrals a "you were
 * renamed" notification names which one sent it.
 */
export function decodeAgentFrame(raw: string, meta: { connectionId: string; central: string }): AgentFrameDecision {
  const none: AgentFrameDecision = { notification: null, userUpdate: null, refreshDashboard: false }
  if (!raw) return none
  let data: { type?: string; name?: string; actor?: string; account?: string | null; verb?: string; sessionId?: string }
  try {
    data = JSON.parse(raw) as typeof data
  } catch {
    return none
  }
  if (data?.type === 'renamed') {
    const newName = data.name ?? ''
    return {
      notification: {
        type: 'info', code: 'machine.renamed',
        meta: { name: newName, actor: data.actor ?? '', ...meta },
      },
      userUpdate: newName || null,
      refreshDashboard: false,
    }
  }
  if (data?.type === 'session-acted') {
    // Somebody acted on one of THIS machine's sessions from a central. Announced here rather than
    // left to the central's audit log: an action that is invisible on the machine it happened to
    // is the failure the whole remote-session feature has to avoid, and the person sitting at this
    // keyboard should not have to read someone else's log to learn their session was killed.
    return {
      notification: {
        type: 'info', code: 'machine.session_acted',
        meta: { verb: data.verb ?? '', sessionId: data.sessionId ?? '', ...meta },
      },
      userUpdate: null,
      refreshDashboard: true,
    }
  }
  if (data?.type === 'reassigned') {
    // A non-empty account is the machine's new display identity (whoami's `user` follows the
    // owning account — see setMachineOwners in team-tokens.ts) and is persisted directly, same as
    // a rename. `null`/absent means ownership was cleared and the resulting fallback name lives
    // server-side only — cleared to '' here so the ordinary empty-user retry re-resolves it,
    // rather than leaving the pre-reassignment name displayed forever.
    const account = typeof data.account === 'string' && data.account ? data.account : ''
    return {
      notification: {
        type: 'info', code: 'machine.reassigned',
        meta: { account: data.account ?? '', actor: data.actor ?? '', ...meta },
      },
      userUpdate: account,
      refreshDashboard: true,
    }
  }
  return none
}

// ---------------------------------------------------------------------------
// Per-connection state — every singleton from the single-central era is now a Map keyed by
// connection id, so one central's socket lifecycle can never affect another's.
// ---------------------------------------------------------------------------

const activeWs = new Map<string, WebSocket>()
const backoffIdx = new Map<string, number>()
/** The endpoint+token this connection's CURRENT socket was opened with, so reconcileConnection
 *  can detect a rotated token / changed endpoint and force a fresh socket instead of leaving a
 *  stale one authenticated as the old identity. */
const credFingerprint = new Map<string, string>()
/** Connection ids with a whoami resolution currently in flight — never overlap two for the same id. */
const resolvingUser = new Set<string>()
/**
 * When each connection's identity was last ATTEMPTED (success or failure), so the reconcile
 * loop's 5s poll cannot retry more often than `IDENTITY_RETRY_COOLDOWN_MS`.
 *
 * Real incident: this loop calls `resolveMemberIdentity` every 5s while a connection is missing
 * `machineName`, gated only by `resolvingUser` — which clears the instant a FAILED call returns,
 * so nothing stopped the very next tick from trying again. A central that briefly 429s whoami got
 * hit again 5s later, and hit again 5s after that — which is exactly what RENEWS a soft
 * per-account rate-limit window (`rate-limit.ts`'s own design: "per-account lockout must stay
 * soft, or it becomes a DoS against a colleague"). Retried at 5s forever, THIS loop was the
 * colleague — a lockout that should have expired in under three minutes was kept alive
 * indefinitely by our own retries. `resolvingUser` answers "is one running right now"; this
 * answers the different question a cooldown needs: "did one run TOO RECENTLY".
 */
const lastIdentityAttemptMs = new Map<string, number>()
/** Floor between two whoami attempts for the SAME connection — comfortably above any rate-limit
 *  window this product's centrals are known to apply (measured: up to ~3 minutes), so a soft
 *  lockout gets the silence it needs to expire instead of being renewed by our own polling. */
const IDENTITY_RETRY_COOLDOWN_MS = 5 * 60_000

/**
 * How often the member reports its open assistants to the central. Must stay comfortably below
 * `LIVE_REPORT_TTL_MS` in team-live.ts, so one dropped frame never blinks the central's panel.
 */
const LIVE_REPORT_INTERVAL_MS = 8_000

/**
 * How old the METRICS CORPUS behind a live-session report may be before this loop asks data.ts
 * for a fresh one.
 *
 * The report itself keeps its `LIVE_REPORT_INTERVAL_MS` cadence — the /proc snapshot is the part
 * that has to be current. The `ApiResponse` beside it is used for exactly two reads: resolving a
 * live process to the session id it is writing, and building the share-rules path index. Both move
 * at the pace of a session STARTING, not of a turn, so a corpus a minute old answers them.
 *
 * It exists because `buildApiResponse()` is not the cheap read its name suggests on a machine
 * somebody is coding on. `sse.ts`'s watcher calls `invalidateCache()` on EVERY append to a live
 * transcript, which zeroes data.ts's stale-while-revalidate timestamp — so its 30s TTL is
 * permanently expired and every call KICKS A FULL REBUILD: a walk of every transcript on the
 * machine, `git log --numstat` per project, and a peak measured at 550-810 MB.
 *
 * MEASURED 2026-09-03 on the reporter's own machine (846 MB of transcripts across 1.328 files,
 * 6 live assistants, member mode, NO browser and no dashboard open):
 *   - `agentop server` read 1.457 MB of file data PER MINUTE (92,6 GB cumulative in 81 minutes,
 *     ~110 re-reads of a corpus that fits in RAM), burned 30% of one core continuously, spawned
 *     bursts of up to 220 concurrent `git` children, and oscillated between 1,28 GB and 2,20 GB
 *     of RSS with a 2,04 GB high-water mark.
 *   - The SAME build in solo mode — same store, same code, same file churn, but no reverse
 *     channel and therefore no live-report loop — idled at 188 MB, 1-2% CPU and 0 MB/min.
 *   - A solo server driven with an 8s `/api/data` poll (this loop's cadence, same code path)
 *     reproduced it: 188 MB -> 700 MB within four minutes.
 *
 * This is the same defect `peekPushContext()` in team-uploader.ts was added for, one module over:
 * a poller whose cadence is set by what it WATCHES ended up setting the cadence of the most
 * expensive computation in the process. The complete fix belongs in data.ts (a peek that never
 * revalidates, or a floor on how often a background revalidation may start); this constant is the
 * caller-side half, and it removes ~7 of the ~8 rebuild triggers this loop contributes per minute.
 */
export const LIVE_REPORT_DATA_MAX_AGE_MS = 60_000

/**
 * Whether the live-session report should ask for a fresh `ApiResponse`. PURE.
 *
 * `null` = this loop has never obtained one, which ALWAYS rebuilds: the first report has nothing
 * to reuse, and reporting no sessions because the corpus was not ready would be worse than the
 * one build. Thereafter it is a plain age test against `LIVE_REPORT_DATA_MAX_AGE_MS`.
 */
export function liveReportNeedsData(
  lastBuiltAtMs: number | null,
  nowMs: number,
  maxAgeMs: number = LIVE_REPORT_DATA_MAX_AGE_MS,
): boolean {
  return lastBuiltAtMs === null || nowMs - lastBuiltAtMs >= maxAgeMs
}

const liveTimers = new Map<string, ReturnType<typeof setInterval>>()
/** Per connection, the re-announce timer — cleared with the live timer it rides beside. */
const consentTimers = new Map<string, ReturnType<typeof setInterval>>()

/**
 * Report this machine's live sessions to ONE central over its reverse channel.
 *
 * The central detects open assistants by reading /proc, which only ever sees its OWN machine — so
 * without this a team dashboard could never show what members are working on right now. Metrics
 * only: session ids plus the cwd of a process too new to have written a transcript. Never chat,
 * matching the rule that members push computed data only.
 *
 * The snapshot goes through THIS connection's denylist (`filterLiveShared`) before it leaves the
 * machine — the reverse channel is an outbound path like the uploader, and a repo withheld from
 * one must not be announced by the other. The connection is re-read on every tick rather than
 * captured at socket-open, so editing the denylist takes effect within one interval instead of
 * waiting for a reconnect that may never come.
 *
 * Best-effort throughout: a failed snapshot or a dead socket skips a beat rather than throwing
 * into the connection's event handlers. Keyed by connId so tearing down one connection's timer
 * (`stopLiveReporting`) never touches another connection's.
 */
function startLiveReporting(connId: string, socket: WebSocket): void {
  stopLiveReporting(connId)

  // The corpus this loop reads, held across ticks. See LIVE_REPORT_DATA_MAX_AGE_MS: calling
  // buildApiResponse() every tick made THIS 8s timer the cadence of a full transcript walk.
  // Per socket, so a torn-down connection drops its copy with the timer.
  let heldData: Awaited<ReturnType<typeof import('./data').buildApiResponse>> | null = null
  let heldAt: number | null = null

  const send = async (): Promise<void> => {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      const [{ buildApiResponse }, { getLiveSnapshot }, shareRules] = await Promise.all([
        import('./data'),
        import('./live-sessions'),
        import('./share-rules'),
      ])
      if (liveReportNeedsData(heldAt, Date.now())) {
        heldData = await buildApiResponse()
        // Stamped AFTER the await: a build that took 30s must not be born half expired, or a
        // slow machine is exactly the one that goes back to rebuilding on every tick.
        heldAt = Date.now()
      }
      // Non-null after the block above: the `null` age always rebuilds, and a build that throws
      // leaves the catch below rather than reaching here.
      const data = heldData!
      const snap = await getLiveSnapshot(data.sessions)

      // A connection that vanished mid-flight reports nothing: there is no denylist left to
      // consult, and defaulting to "unrestricted" would leak precisely when the rule is gone.
      const conn = readTeamConnections(await readPreferences()).find(c => c.id === connId)
      if (!conn) return
      // The TYPED rules, never the legacy `deniedRepos` mirror: that mirror can only express
      // "these repo keys are blocked", so a project-only rule would not reach this channel at all
      // and an allowlist would be read as its own inverse. The live channel says what this machine
      // is working on RIGHT NOW — a leak here is the sharpest one the feature has.
      const rules = shareRules.shareRulesOf(conn.shareMode, conn.sources)
      // An allowlist ALWAYS restricts (an empty one shares nothing), so the index cannot be gated
      // on a non-empty source set the way a denylist's could.
      const restricted = rules.mode === 'allowlist' || rules.sources.size > 0
      const index = restricted
        ? shareRules.buildPathRepoIndex(data.sessions, data.projects)
        : undefined
      const shared = shareRules.filterLiveShared(snap, data.sessions, rules, index)

      if (socket.readyState !== WebSocket.OPEN) return
      // Every field comes off `shared` — nothing on this message is read from `snap` directly.
      // The activities used to be, and a withheld repo's session announced its id and its state
      // beside the two fields that were filtered.
      socket.send(JSON.stringify({
        type: 'live-sessions',
        sessionIds: shared.liveSessionIds,
        processes: shared.liveProcesses,
        sessionActivities: shared.liveSessionActivities,
      }))
    } catch { /* transient — the next tick retries */ }
  }

  void send()
  const timer = setInterval(() => { void send() }, LIVE_REPORT_INTERVAL_MS)
  timer.unref?.()
  liveTimers.set(connId, timer)

  // Its own timer rather than a counter on the one above: the two answer different questions at
  // different rates, and folding them together would tie a consent re-statement to whatever the
  // live report's cadence becomes next.
  const consentTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) announceRemoteConsentNow(connId)
  }, CONSENT_REANNOUNCE_MS)
  consentTimer.unref?.()
  consentTimers.set(connId, consentTimer)
}

function stopLiveReporting(connId: string): void {
  const timer = liveTimers.get(connId)
  if (timer) {
    clearInterval(timer)
    liveTimers.delete(connId)
  }
  // The consent re-announce is started by `startLiveReporting` and must be stopped here, or a
  // torn-down connection leaves a timer firing against a socket that is gone. It is cleared in
  // the same function for exactly that reason — two lifecycles to remember is one to forget.
  const consentTimer = consentTimers.get(connId)
  if (consentTimer) {
    clearInterval(consentTimer)
    consentTimers.delete(connId)
  }
}

/**
 * Best-effort: this connection's `user` (the display name, resolved from GET /api/team/whoami)
 * is still unresolved — try again. Fires on every reconcile cycle while `conn.user === ''` OR
 * `conn.machineName` is still unset — a connection whose USER resolved fine can still be missing
 * its machineName forever otherwise: made against a central release that predates the field, or
 * whose first whoami raced a central that had not minted one yet. That left the header's central
 * pill showing the ACCOUNT in the machine's place, with no cycle that would ever ask again — see
 * the header docs in CLAUDE.md's `packages/tui` section.
 *
 * A connection with BOTH already resolved never calls the central at all — this loop runs every
 * 5s, and the ordinary case (a healthy, fully-resolved connection) must cost nothing.
 *
 * Never overlaps two in-flight calls for the same connection id, and never retries the SAME
 * connection more than once per `IDENTITY_RETRY_COOLDOWN_MS` regardless of whether the previous
 * attempt succeeded, failed, or errored — a failure must cost the same silence a success would,
 * or every 5s reconcile tick re-triggers it and a central's rate limit never gets the chance to
 * expire. Never throws; updates preferences via `updateTeamConfig` so a concurrent writer (e.g.
 * the uploader resolving the SAME connection, or the user editing Settings) cannot be clobbered.
 *
 * `deps.updateTeamConfig` is injectable for tests — the default touches the developer's real
 * ~/.agentistics/preferences.json, which a test must never do. `deps.now` is injectable so the
 * cooldown can be tested without a real 5-minute wait.
 */
export async function resolveMemberIdentity(
  conn: TeamConnection,
  deps: { updateTeamConfig?: typeof updateTeamConfig; now?: () => number } = {},
): Promise<void> {
  if (conn.user && conn.machineName) return
  if (resolvingUser.has(conn.id)) return
  const now = deps.now ?? Date.now
  const last = lastIdentityAttemptMs.get(conn.id)
  if (last !== undefined && now() - last < IDENTITY_RETRY_COOLDOWN_MS) return
  resolvingUser.add(conn.id)
  lastIdentityAttemptMs.set(conn.id, now())
  try {
    const endpoint = conn.endpoint.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (conn.token) headers['Authorization'] = `Bearer ${conn.token}`
    const res = await fetch(`${endpoint}/api/team/whoami`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return
    const json = await res.json() as { ok?: boolean; user?: string; machineName?: unknown }
    if (!json.ok || typeof json.user !== 'string' || !json.user) return
    const machineName = typeof json.machineName === 'string' && json.machineName
      ? json.machineName
      : undefined
    await persistConnectionUser(conn.id, json.user, machineName, deps)
  } catch {
    // best-effort — retried on the next reconcile cycle
  } finally {
    resolvingUser.delete(conn.id)
  }
}

/** Read-modify-write THIS connection's `user` and, when resolved, its `machineName` — inside
 *  preferences.ts's single write chain (`updateTeamConfig`) so it can never race another writer
 *  (e.g. the connection being removed, or Settings saving a label edit) into a stale array.
 *  No-op (no write) once both values already match, or once the connection is gone from
 *  preferences. `machineName` is written only when resolved (`undefined` leaves the stored value
 *  untouched) — a central response that merely omits the field is never evidence it un-named the
 *  machine, the same non-destructive rule `applyProjectFacts` follows for `git_remote`. */
async function persistConnectionUser(
  connId: string,
  user: string,
  machineName: string | undefined,
  deps: { updateTeamConfig?: typeof updateTeamConfig } = {},
): Promise<void> {
  const _updateTeamConfig = deps.updateTeamConfig ?? updateTeamConfig
  try {
    await _updateTeamConfig(current => {
      const existing = current.connections ?? []
      const idx = existing.findIndex(c => c.id === connId)
      if (idx === -1) return undefined // removed meanwhile — nothing to update
      const userChanged = existing[idx]!.user !== user
      const nameChanged = machineName !== undefined && existing[idx]!.machineName !== machineName
      if (!userChanged && !nameChanged) return undefined // already current
      const next = existing.slice()
      next[idx] = { ...next[idx]!, user, ...(machineName !== undefined ? { machineName } : {}) }
      return normalizeTeamConfig({ ...current, connections: next })
    })
  } catch {
    // best-effort — the display name still resolves on a later cycle
  }
}

/**
 * Reconnect ONE connection with exponential backoff. Re-reads THAT connection by id from
 * preferences on every attempt (never captures a `conn` from the closure that scheduled it):
 *   - a connection the user removed in the meantime is simply absent from the fresh read, so the
 *     timer fires into a no-op instead of resurrecting a socket for a dead connection;
 *   - a rotated token is picked up automatically, because the fresh read carries it — a captured
 *     stale conn would keep authenticating with a revoked secret forever.
 */
function scheduleReconnect(connId: string): void {
  const idx = backoffIdx.get(connId) ?? 0
  const delay = backoffDelay(idx)
  backoffIdx.set(connId, idx + 1)
  setTimeout(() => {
    void (async () => {
      try {
        const prefs = await readPreferences()
        const conn = readTeamConnections(prefs).find(c => c.id === connId)
        if (!conn || !hasCredentials(conn)) return
        // Something else (e.g. reconcileConnection's next poll) may have already opened a live
        // socket for this id while this timer was pending — never open a second one.
        const existing = activeWs.get(connId)
        if (existing && existing.readyState <= WebSocket.OPEN) return
        openConnection(conn)
      } catch {
        // Preferences unavailable — stop reconnecting silently
      }
    })()
  }, delay)
}

/**
 * How often the consent is RE-STATED on an already-open socket.
 *
 * The announcement used to happen exactly once per connection, and that made it fragile in a way
 * that only shows up in a real deployment. A central holds the consent in memory for the socket's
 * lifetime (`machine-consent.ts`), so it forgets on restart — and it recovers only because the
 * socket drops and the machine announces again on reconnect. Put a reverse proxy in front of the
 * central, which is how one is normally exposed, and that assumption breaks: the backend can
 * restart while the member's TCP connection to the PROXY stays up, so the member never reconnects,
 * never re-announces, and the central sits with an empty registry believing this machine has said
 * nothing. The owner then reads "this machine has not said whether it allows session management" —
 * which is a true sentence about the central's memory and a false one about the machine.
 *
 * A single frame arriving is not something to depend on when re-stating it costs two booleans.
 * Slow on purpose: 60s is far below any human's patience for "why is it not showing" and far above
 * anything that could be called chatter.
 */
const CONSENT_REANNOUNCE_MS = 60_000

/**
 * Announce this machine's REMOTE-SESSION CONSENT to one central, now.
 *
 * Unsolicited and one-directional, exactly like `live-sessions` above and for the same reason: the
 * central asks this machine nothing. It is a statement about what the machine has agreed to, so it
 * is sent on connect (a central that restarted has forgotten) and again the moment the switch moves
 * — `handlePatchConnection` calls this, because a consent WITHDRAWN that took until the next
 * reconnect to arrive is a central acting on an agreement that no longer exists.
 *
 * The payload is two booleans. It carries no session, no screen and no rule.
 */
export function announceRemoteConsentNow(connId: string): void {
  const socket = activeWs.get(connId)
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  void (async () => {
    try {
      const conn = readTeamConnections(await readPreferences()).find(c => c.id === connId)
      if (!conn) return
      // Sent RESOLVED, never as the two raw fields: `resolveRemoteConsent` is the only place the
      // pair is interpreted, and a central re-deriving it would be a second implementation of the
      // rule that screens require sessions.
      const consent = resolveRemoteConsent(conn.allowRemoteSessions, conn.allowRemoteScreens)
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({ type: 'remote-consent', sessions: consent.sessions, screens: consent.screens }))
    } catch { /* best-effort — the next connect re-announces */ }
  })()
}

/**
 * Answer one central's `fleet-request`.
 *
 * Never throws and never answers on the wrong shape: a frame with no rid is dropped silently, and
 * the central's own timeout is what turns that into a sentence. Refusing to answer is also the
 * correct response to a withdrawn consent — the central distinguishes "did not answer" from
 * "says no" through `machine-consent.ts`, which the machine keeps up to date by announcement.
 */
async function answerFleetRequest(connId: string, socket: WebSocket, raw: string): Promise<void> {
  try {
    const msg = JSON.parse(raw) as {
      type?: string; rid?: unknown; op?: unknown; action?: unknown; id?: unknown
      text?: unknown; choice?: unknown
    }
    if (msg?.type !== 'fleet-request' || typeof msg.rid !== 'string' || !msg.rid) return
    const conn = readTeamConnections(await readPreferences()).find(c => c.id === connId)
    if (!conn) return

    const [{ buildMachineFleetReply, performMachineAction }, { readFleet, runFleetAction }, { buildApiResponse }, { resolveLang }] = await Promise.all([
      import('./sessions/machine-fleet'),
      import('./sessions/fleet-web'),
      import('./data'),
      import('./cli-lang'),
    ])
    const lang = await resolveLang()
    // ONE set of sources for both halves. The act half needs them too — it resolves the target
    // against the very fleet the read half filters, so that a verb can only reach a row this
    // connection was allowed to see — and building them twice is how the two halves came to
    // disagree about a directory in the first place.
    const fleetDeps = {
      readFleet: async (l: typeof lang) => {
        const payload = await readFleet(l)
        // The VERBS live on the presentation half (`sessions`, a FleetRow[]) and everything else on
        // the raw half (`rows`, a ControlSession[]); they are the same rows in the same order.
        // Merged by id rather than by position — an order that happens to match today is not a
        // guarantee, and pairing rows by index is exactly the defect `workflow-match.ts` exists to
        // have fixed once.
        const verbsById = new Map(payload.sessions.map(r => [r.id, r.verbs]))
        return {
          rows: payload.rows.map(r => ({
            ...(r as unknown as Record<string, unknown>),
            verbs: verbsById.get(r.id) ?? [],
          })),
          attention: payload.attention,
          ...(payload.unavailable ? { unavailable: payload.unavailable } : {}),
        }
      },
      readIndexSources: async () => {
        const data = await buildApiResponse()
        return { sessions: data.sessions, projects: data.projects.map(p => ({ path: p.path, gitRemote: p.gitRemote })) }
      },
    }

    // `op: 'act'` — perform one verb. The consent, the verb allowlist AND this connection's
    // sharing rules are re-checked by `performMachineAction` on THIS machine; nothing the central
    // decided is trusted here.
    if (msg.op === 'act') {
      const reply = await performMachineAction(conn, lang, {
        action: typeof msg.action === 'string' ? msg.action : '',
        id: typeof msg.id === 'string' ? msg.id : '',
        ...(typeof msg.text === 'string' ? { text: msg.text } : {}),
        // The option the person PICKED off the relayed dialog. Only a real number crosses:
        // `runFleetAction` reads an absent choice as "press the dialog's confirm key", which is
        // right where there is nothing to choose between and wrong on a `1. Yes / 2. Yes, always /
        // 3. No`. A junk value must become "no choice", never "option NaN".
        ...(typeof msg.choice === 'number' && Number.isFinite(msg.choice) ? { choice: msg.choice } : {}),
      }, {
        ...fleetDeps,
        // `runFleetAction` is the SAME path the machine's own web Sessions page calls, so every
        // refusal the cockpit makes is made here too — there is no second implementation of what a
        // row may take.
        runAction: (l, r) => runFleetAction(l, r as never),
      })
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({ type: 'fleet-reply', rid: msg.rid, reply }))
      return
    }

    const reply = await buildMachineFleetReply(conn, lang, fleetDeps)
    // A machine that has not agreed sends NOTHING. An empty reply would read as "no sessions",
    // which is a statement about the fleet rather than about consent.
    if (!reply) return
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'fleet-reply', rid: msg.rid, reply }))
  } catch { /* the central's timeout reports this as a machine that did not answer */ }
}

/** Open a socket for ONE connection. Self-guards against a duplicate open (an already
 *  OPEN/CONNECTING socket for this id short-circuits). Never throws. */
function openConnection(conn: TeamConnection): void {
  const existing = activeWs.get(conn.id)
  if (existing && existing.readyState <= WebSocket.OPEN) return

  const wsUrl = agentWsUrl(conn.endpoint)

  let socket: WebSocket
  try {
    // Bun extends the standard WebSocket constructor to accept a headers option object as the
    // second argument. The DOM lib type only allows string | string[], so we cast through unknown
    // to satisfy the compiler while using Bun's extension. A token-less connection (open/legacy
    // central) omits the header entirely rather than sending `Bearer `.
    socket = conn.token
      ? new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${conn.token}` } } as unknown as string)
      : new WebSocket(wsUrl)
  } catch {
    scheduleReconnect(conn.id)
    return
  }
  activeWs.set(conn.id, socket)
  credFingerprint.set(conn.id, fingerprintOf(conn))

  socket.addEventListener('open', () => {
    backoffIdx.set(conn.id, 0) // successful open — reset this connection's backoff
    startLiveReporting(conn.id, socket)
    // A central holds this in memory only (like every live fact on this channel), so a central
    // that restarted has forgotten it. Re-stating it on every open is what makes the absence of a
    // report mean "this machine is not here", never "it has not said yet".
    announceRemoteConsentNow(conn.id)
  })

  // Inbound admin actions from the central: 'renamed' (the central renamed this machine) and
  // 'reassigned' (its owner account changed). decodeAgentFrame (pure) is the only place that
  // interprets the raw frame; this listener just carries out its decision — notify, maybe
  // persist `user`, maybe nudge open dashboards to refetch.
  socket.addEventListener('message', (ev: MessageEvent) => {
    const raw = typeof ev.data === 'string' ? ev.data : ''
    // 'fleet-request' — this central is asking for the fleet. Answered only if THIS machine has
    // agreed, re-read from preferences on every frame rather than trusted from the asker: the
    // central asking is never the authority, and a switch turned off a moment ago must take effect
    // on this frame rather than at the next handshake. See sessions/machine-fleet.ts for the two
    // narrowings the answer goes through.
    if (raw.includes('"fleet-request"')) {
      void answerFleetRequest(conn.id, socket, raw)
      return
    }
    const decision = decodeAgentFrame(raw, { connectionId: conn.id, central: labelOf(conn) })
    if (decision.notification) {
      const notification = decision.notification
      void import('./sse').then(m => {
        m.broadcastNotification(notification)
        if (decision.refreshDashboard) m.notifySseClients()
      }).catch(() => { /* best-effort */ })
    }
    if (decision.userUpdate !== null) void persistConnectionUser(conn.id, decision.userUpdate, undefined)
  })

  socket.addEventListener('close', () => { handleSocketClose(conn.id, socket) })

  socket.addEventListener('error', () => {
    // 'close' fires immediately after 'error'; reconnect is handled there.
    if (activeWs.get(conn.id) === socket) activeWs.delete(conn.id)
  })
}

/**
 * What a socket's 'close' event does — ALL of it inside the ownership guard, deliberately.
 *
 * A token rotation tears the old socket down and `reconcileConnection` opens the replacement
 * synchronously in the same pass, so by the time this runs `activeWs` may already hold the NEW
 * socket for this id. Only the two map deletes used to be guarded: `stopLiveReporting(connId)`
 * ran unconditionally and cleared the *replacement* socket's reporting timer, which nothing
 * re-arms (`startLiveReporting` runs only on 'open') — that central's "what is this machine
 * working on now" panel went permanently blank while pushes and presence looked healthy.
 * `scheduleReconnect` outside the guard is the same class of mistake: a superseded socket must not
 * drive the surviving one's reconnect schedule.
 */
function handleSocketClose(connId: string, socket: WebSocket): void {
  if (activeWs.get(connId) !== socket) return
  activeWs.delete(connId)
  credFingerprint.delete(connId)
  stopLiveReporting(connId)
  scheduleReconnect(connId)
}

/**
 * Tear down ONE connection's socket + live-reporting timer right now (the caller —
 * reconcileConnection — is retiring this id on purpose: it is gone from `connections[]` or its
 * credentials changed). Deleting the map entries here first is what matters twice over: it stops
 * `openConnection`'s duplicate-guard from seeing this retiring socket as "still live", and it makes
 * the retiring socket's own 'close' listener a no-op (that listener does all its work inside an
 * `activeWs.get(id) === socket` ownership guard), so a teardown can neither clear the replacement
 * socket's live-reporting timer nor queue a reconnect against it. The replacement is opened by
 * `reconcileConnection`'s very next loop in the same pass; a connection that is simply GONE needs
 * no reconnect at all.
 *
 * `backoffIdx` is cleared too: a rotated connection would otherwise inherit the retired socket's
 * backoff index (up to the 30s cap) on its first failure, and an id removed for good would leave
 * an entry in the map forever.
 */
function teardownSocket(connId: string): void {
  const socket = activeWs.get(connId)
  activeWs.delete(connId)
  credFingerprint.delete(connId)
  backoffIdx.delete(connId)
  stopLiveReporting(connId)
  if (!socket) return
  try {
    socket.close()
  } catch {
    // already closed — ignore
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let started = false

/** How often the runtime poll re-checks preferences for connection changes. */
const POLL_INTERVAL_MS = 5_000

/**
 * Periodic reconciliation between current preferences and the socket state, fanned out across
 * every connection so one hanging endpoint can never stall another's. Runs every POLL_INTERVAL_MS
 * so adding/removing a central at runtime (Settings) is reflected promptly, instead of waiting for
 * the next uploader push + dashboard poll (~30s).
 *
 * - every connection lacking a live (OPEN/CONNECTING) socket, that has an endpoint → open one
 *   (openConnection self-guards against duplicates via activeWs.readyState).
 * - every socket whose connection id is no longer in `connections[]`, OR whose credentials
 *   (endpoint/token) changed since its socket was opened → torn down (no stale-identity socket
 *   survives a token rotation).
 * - every connection with an unresolved `user` → a best-effort whoami retry, in place.
 *
 * Complements the close/error reconnect-with-backoff path, which only fires once a connection has
 * already been attempted.
 */
async function reconcileConnection(): Promise<void> {
  let connections: TeamConnection[]
  try {
    const prefs = await readPreferences()
    connections = readTeamConnections(prefs)
  } catch {
    // Preferences unavailable — leave current state untouched.
    return
  }

  const byId = new Map(connections.map(c => [c.id, c]))

  // Close and delete every socket whose connection is gone or whose credentials changed.
  for (const connId of [...activeWs.keys()]) {
    if (shouldTeardown(credFingerprint.get(connId), byId.get(connId))) {
      teardownSocket(connId)
    }
  }

  // Open a socket for every connection that lacks a live one, and retry identity resolution for
  // any connection whose display name is still unknown. Each connection's work is independent —
  // a `void` fire-and-forget so a slow whoami against one central never delays another's socket.
  for (const conn of connections) {
    if (!hasCredentials(conn)) continue
    const live = activeWs.get(conn.id)
    if (!live || live.readyState > WebSocket.OPEN) {
      openConnection(conn)
    }
    if (!conn.user || !conn.machineName) {
      void resolveMemberIdentity(conn)
    }
  }
}

/**
 * Start the member-side agent client. Idempotent — subsequent calls are no-ops.
 * Reads team connections; skips connecting any that lack an endpoint, but always starts a
 * lightweight periodic reconciliation poll so a central added at runtime connects promptly.
 * Never throws.
 */
export function startAgentClient(): void {
  if (started) return
  started = true

  // Initial attempt + ongoing reconciliation. reconcileConnection covers both the "connect now
  // for every already-configured connection" and "connect later once one is added" cases, so a
  // single poll handles startup and runtime changes for every connection at once.
  void reconcileConnection()
  const timer = setInterval(() => {
    void reconcileConnection()
  }, POLL_INTERVAL_MS)
  // Do not keep the process alive solely for this poll.
  timer.unref?.()
}

/**
 * Reconcile every reverse-channel socket against current preferences RIGHT NOW, instead of
 * waiting up to POLL_INTERVAL_MS. Call this the moment the team config changes at runtime (e.g.
 * the PUT /api/preferences handler, or `removeConnection` in team-uploader.ts) so a change is
 * reflected within ~a second rather than after the next poll. Never throws. No-op if the client
 * hasn't been started yet (startup already reconciles).
 */
export function reconcileNow(): void {
  if (!started) return
  void reconcileConnection()
}

/**
 * Test-only window onto the per-connection socket state. The socket lifecycle is otherwise
 * module-private (deliberately — nothing in production may reach into these maps), but the
 * ownership guard in `handleSocketClose` and the `backoffIdx` cleanup in `teardownSocket` are
 * exactly the kind of bookkeeping that regresses silently, so they get a real test.
 *
 * Only paths that touch NO filesystem and schedule NO timer are exercised through this: a
 * non-owning close returns immediately, and `teardownSocket` never reconnects. `scheduleReconnect`
 * deliberately stays out of reach — its timer would read the developer's real preferences.
 */
export const __socketStateForTests = { activeWs, backoffIdx, credFingerprint, handleSocketClose, teardownSocket }
