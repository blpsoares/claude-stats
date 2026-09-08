/**
 * team-uploader.ts — local → central push for Team Member mode, PER CONNECTION.
 *
 * A machine can be a member of several centrals at once (`preferences.team.connections[]`).
 * Every piece of mutable state that used to be a module-level singleton (error streaks, last
 * success, learned interval, the `running` guard, the debounce timer, the sent-state and
 * sync-signature files) is now keyed by connection id, so one central's failure, cadence or
 * revoked token can never affect another.
 *
 * Pure functions (sessionHash, selectDeltas) are unit-tested.
 * IO functions (loadSentState, saveSentState, pushOnceDetailed, startUploader) are
 * integration-tested manually. handleTeamTestConnection exposes the
 * test-connection route handler.
 *
 * Secrets: the bearer token is NEVER logged.
 */

import { createHash } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import type { SessionMeta, SharedTask, StatsCache, WorkflowRun, TeamConnection, TeamConfig } from '@agentistics/core'
import { PUSH_INTERVAL, clampPushInterval, defaultTeam, normalizeEndpointKey, normalizeTeamConfig, redactSessionText, redactSharedTask } from '@agentistics/core'
import { teamSentFile, teamSyncFile, teamRulesFile, teamForgetFile } from './config'
import { loadConsolidated } from './consolidate'
import { loadWorkflowRuns } from './workflow-store'
import { readPreferences, updateTeamConfig } from './preferences'
import { safeReadJson } from './utils'
import { migrateTeamStateOnce, convertSentStateV1, type SentStateV2 } from './team-migrate'
import { readJsonLimited, LIMITS } from './limits'
import type { ServerProject } from './data'
import {
  buildPathRepoIndex, sharedSessionIds, filterSharedWorkflows, attributionBoundary, buildSplitStatsCache,
  shareRulesOf, sourcesRestrict, filterSharedRules,
  type PathRepoIndex, type DeniedLedger,
} from './share-rules'
import { parseCapabilities, centralCanForget } from './team-capabilities'
import { planRulesReconcile, computeLedger, loadRulesState, saveRulesState } from './team-rules'
import { runForgetSequence, loadForgetJournal, type ForgetJournal, type ForgetProgress } from './team-forget-client'
import { MAX_BATCH_SIZE, clampBatchSize, ingestTimeoutMs, nextBatchSize } from './ingest-batch'

/**
 * The deliveries this machine offers a central, already scrubbed.
 *
 * Best-effort and never throwing, exactly like `readMemberWorkflows`: a board that cannot be read
 * costs the delivery list, never the push. It reads `loadTaskBoard` rather than `loadTaskWorld`
 * because the uploader already holds the sessions and this runs on the central's cadence — see
 * that function's note.
 */
async function readSharedTasks(
  sharedIds: ReadonlySet<string>,
  knownIds: ReadonlySet<string>,
): Promise<SharedTask[]> {
  try {
    const [{ loadTaskBoard }, { selectSharedTasks }, { rowsOfTask }] = await Promise.all([
      import('./sessions/task-source'),
      import('./sessions/task-share'),
      import('./sessions/task-report'),
    ])
    const { book, rows } = await loadTaskBoard()
    const shared = selectSharedTasks({
      tasks: book.tasks,
      rows,
      comments: book.comments,
      subtasks: book.subtasks,
      files: book.files,
      sharedIds,
      knownIds,
      rowsOf: rowsOfTask,
    })
    // The last point at which this text is still purely local.
    return shared.map(redactSharedTask)
  } catch {
    return []
  }
}

/** Overridable for tests, the way `_readMemberWorkflows` is. */
let selectSharedTasksForPush = readSharedTasks
export function __setSharedTasksReader(fn: typeof readSharedTasks): void { selectSharedTasksForPush = fn }
export function __resetSharedTasksReader(): void { selectSharedTasksForPush = readSharedTasks }

/** This machine's local workflow runs (computed metrics only — no chat/prompt text). Fallback
 *  source when `buildApiResponse` could not be run (see `buildPushContext`). Mirrors the
 *  contract of `buildApiResponse`'s `workflows` field: best-effort, never throws. */
async function readMemberWorkflows(): Promise<WorkflowRun[]> {
  try {
    const map = await loadWorkflowRuns()
    return Array.from(map.values())
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Per-connection mutable state — every singleton from the single-central era is now a Map/Set
// keyed by connection id, so state can never leak from one central to another.
// ---------------------------------------------------------------------------

/** Throttle repeated "can't reach central" warnings per connection. */
const _netErrStreak = new Map<string, number>()
/** ms epoch of the last successful contact with each central, for the status pill. */
const _lastSuccessAt = new Map<string, number>()
/** Current error state per connection: 'auth' | 'net'. Absent = ok. */
const _pushErrKind = new Map<string, 'auth' | 'net'>()
/** ms epoch of the FIRST auth-error (401/403) of the current consecutive streak, per connection
 *  (see handleAuthError). Cleared on any success. In-memory only — deliberately not persisted:
 *  what must survive a restart is the DECISION already made (`TeamConnection.authFailedAt`), not
 *  this in-flight clock. A restart mid-streak simply restarts the clock, which only delays
 *  marking the connection — it can never cause a spurious mark, so it is not a correctness gap. */
const _authErrSince = new Map<string, number>()
/** The interval (seconds) most recently learned from each central's policy. */
const _centralIntervalSec = new Map<string, number>()
/** ms round-trip of the most recent SUCCESSFUL policy fetch, per connection — the status route
 *  reads this cached value instead of doing its own blocking probe (see GET /api/team/status in
 *  team-connections.ts). Absent = never successfully measured. */
const _latencyMs = new Map<string, number>()
/** The capabilities most recently learned from each central's `/api/team/policy`, per connection.
 *  Same rule as `_latencyMs`: only a SUCCESSFUL fetch updates this — a network flap or a central
 *  that momentarily 404s must not erase a previously learned `forget.sessions`, or one blip would
 *  disable the user's rules editor. Absent = never successfully learned. */
const _centralCapabilities = new Map<string, string[]>()
/** Connection ids with a push cycle currently in flight. */
const _running = new Set<string>()
/** Connection ids where a change arrived while `_running` — re-run instead of dropping it. */
const _pendingTrigger = new Set<string>()
/** Whether each connection currently has a declared denylist — refreshed on every
 *  `pushOnceDetailed` call. Read by `scheduleOnChangeTrigger`/`scheduleConnectionCycle`, which
 *  only ever see a connId, so the activity-heartbeat defenses in §5.3.4 can reach them. */
const _restrictedConn = new Map<string, boolean>()
/** Live progress of a connection's retroactive removal, for Task 6's status route (and the
 *  Settings progress strip). Present only WHILE a sequence runs — absence means "not resyncing",
 *  never "finished with 0". */
const _resyncProgress = new Map<string, ForgetProgress>()
/** Connections whose `member.resync_started` notification has fired and whose `member.resync_done`
 *  has not. The transition guard matters: without it a central that is down (or too old) would
 *  raise a "removing…" toast on EVERY cycle, forever, for the same removal. */
const _resyncNotified = new Set<string>()
/** Journals found open at boot (`replayForgetJournals`), keyed by connection: what a killed
 *  process already promised a central. Consumed by the next cycle, cleared once the removal
 *  completes. */
const _resumeForget = new Map<string, ForgetJournal>()
/**
 * sha256 over `{statsCache, workflows}` of the last payload the CENTRAL ACTUALLY ACCEPTED for this
 * connection — recorded on every successful push that carries one (both the empty-delta keep-alive
 * path AND batch 0 of the batch path, restricted or not), so this always reflects what the central
 * holds. Only ever CONSULTED for a restricted connection (the keep-alive dedup in §5.3.4); an
 * unrestricted one keeps pushing its keep-alive every cycle regardless of what is recorded here.
 *
 * MUST be updated on every writer, not only the restricted empty-delta branch: a member that goes
 * restricted → unrestricted → restricted again pushes an unsplit cache in between (the batch path,
 * because un-blocking creates session deltas). If that unsplit push does not update this map, the
 * SECOND restricted cycle's split cache can come out byte-identical to what was memoized from
 * BEFORE the unsplit push and get wrongly suppressed — stranding the denied repo's volume in the
 * cache the central already holds, permanently (reproduced end-to-end against a live central; see
 * the Task 3 fix report).
 */
const _lastPushedPayloadHash = new Map<string, string>()

/**
 * Consecutive suppressed (unchanged, restricted, empty-delta) cycles for a connection. Bounds how
 * long the §5.3.4 dedup may go without actually contacting the central — a suppressed cycle sends
 * no request at all, so a revoked token, a wiped central, or a central that is simply down would
 * otherwise never be detected for as long as a quiet blocked repo's payload stays unchanged (the
 * pill reads healthy forever, because nothing is ever sent that could disprove it). At
 * `MAX_SUPPRESSED_STREAK + 1` the cycle forces a real push regardless of the unchanged payload,
 * whose actual response drives `markPushSuccess`/auth handling exactly like any other push.
 *
 * This does NOT reopen the correlation leak the dedup exists to close: that leak is a push's
 * TIMING correlating with the user's LOCAL activity (a push firing within ~2s of a file write
 * reveals session boundaries and working hours). A forced push that fires once every N cycles
 * regardless of what happened locally carries none of that — its timing is a function of the
 * wall clock (plus the connection's existing ±20% cadence jitter), never of the user's activity.
 * What must never happen is making the forced push conditional on anything local.
 */
const _suppressedStreak = new Map<string, number>()

/** N in "suppress at most N in a row" above. At the median 30s push interval this forces a real
 *  contact roughly every 30s * 40 = 1200s = 20 minutes — long enough that a legitimately quiet
 *  blocked repo still mostly stays quiet, short enough that a revoked token or dead central is
 *  caught well within the same working session rather than surviving indefinitely. */
export const MAX_SUPPRESSED_STREAK = 40

function hostOf(endpoint: string): string {
  try { return new URL(endpoint).host || endpoint } catch { return endpoint }
}

/** Display label for a connection in notifications — a nickname if set, else the endpoint host.
 *  Never the token. */
function labelOf(conn: TeamConnection): string {
  return conn.label ?? hostOf(conn.endpoint)
}

function notifyMeta(conn: TeamConnection, extra?: Record<string, unknown>): Record<string, unknown> {
  return { ...extra, connectionId: conn.id, central: labelOf(conn) }
}

type NotifyPayload = { type: 'error' | 'warning' | 'info' | 'success'; code?: string; meta?: Record<string, unknown> }
type Notifier = (n: NotifyPayload) => void

/** Every SSE broadcast in this module goes through this ONE indirection, so tests can swap it
 *  for a no-op/recorder instead of writing a real entry into the developer's
 *  `~/.agentistics/notifications.json` every time an error/recovery test scenario runs. */
function realNotify(n: NotifyPayload): void {
  void import('./sse').then(m => m.broadcastNotification(n)).catch(() => { /* best-effort */ })
}
let _notify: Notifier = realNotify

/** Test-only override — never called from production code. */
export function __setNotifierForTests(fn: Notifier | null): void {
  _notify = fn ?? realNotify
}

function warnPushError(connId: string, msg: string): void {
  const n = (_netErrStreak.get(connId) ?? 0) + 1
  _netErrStreak.set(connId, n)
  if (n === 1 || n % 20 === 0) {
    console.warn(`[team-uploader] ${connId} cannot reach central (${n}x, silencing repeats): ${msg}`)
  }
}
function clearPushError(connId: string): void {
  if ((_netErrStreak.get(connId) ?? 0) > 0) {
    console.info(`[team-uploader] ${connId} central reachable again — resuming pushes`)
  }
  _netErrStreak.set(connId, 0)
}
/** Record a successful contact with a central (used by the status pill + recovery). */
function markPushSuccess(connId: string): void {
  _lastSuccessAt.set(connId, Date.now())
  _authErrSince.delete(connId) // any success clears the sustained-failure clock
}

export interface UploaderStatus {
  /** ms epoch of the last successful contact with the central, or null if never. */
  lastSuccessAt: number | null
  /** current error state: 'auth' (rejected), 'net' (unreachable), or null (ok). */
  errKind: 'auth' | 'net' | null
  /** ms round-trip of the most recent successful policy fetch, or null if never measured. */
  latencyMs: number | null
}

/** A fresh, empty status — what a connection reports before its first cycle ever runs. */
export function emptyStatusFor(_connId: string): UploaderStatus {
  return { lastSuccessAt: null, errKind: null, latencyMs: null }
}

/** Whether this connection's central has ever advertised `forget.sessions` — Task 6's status
 *  route reads this to report `canForget`. `false` before any successful policy fetch, exactly
 *  like `emptyStatusFor`'s `latencyMs: null` — absence is not a negative capability, just an
 *  unmeasured one, but the rules editor treats "unmeasured" and "no" identically (fail closed:
 *  it must never offer a control the central may not be able to honor). */
export function connectionCanForget(connId: string): boolean {
  return centralCanForget(_centralCapabilities.get(connId) ?? [])
}

/** How far this connection's retroactive removal has got, or `null` when none is running. The
 *  phase is `'forget'` while batches are being acked and `'push'` while the rebuilt statsCache is
 *  being delivered — the two halves of §6.1 the user can actually be told apart. */
export function getResyncProgress(connId: string): ForgetProgress | null {
  return _resyncProgress.get(connId) ?? null
}

/** A `lastSuccessAt` this stale relative to a connection's own known interval, with NO error
 *  recorded, means something is silently blocking that a transition-based error would normally
 *  catch — the defense-in-depth half of the B-1 fix (the fetch timeout is the primary fix; this
 *  is what keeps the status pill honest if some other, not-yet-known hang ever slips past it).
 *  Floored at 5 minutes even for express (5s) intervals, so a merely-slow-but-fine cycle never
 *  flickers into "unreachable". */
const STALE_INTERVAL_MULTIPLIER = 3
const STALE_FLOOR_MS = 5 * 60_000

/** Per-connection status snapshot, keyed by connection id. Only connections that have run at
 *  least one cycle (successful or not) appear — a connection with neither key present should be
 *  reported via `emptyStatusFor`. A `lastSuccessAt` far enough in the past is reported as `'net'`
 *  even when no explicit error was ever recorded — see `STALE_INTERVAL_MULTIPLIER`. */
export function getUploaderStatus(): Record<string, UploaderStatus> {
  const out: Record<string, UploaderStatus> = {}
  const now = Date.now()
  for (const id of new Set([..._lastSuccessAt.keys(), ..._pushErrKind.keys()])) {
    const lastSuccessAt = _lastSuccessAt.get(id) ?? null
    let errKind = _pushErrKind.get(id) ?? null
    if (errKind === null && lastSuccessAt !== null) {
      const intervalMs = (_centralIntervalSec.get(id) ?? PUSH_INTERVAL.DEFAULT_SEC) * 1000
      const staleAfterMs = Math.max(STALE_FLOOR_MS, intervalMs * STALE_INTERVAL_MULTIPLIER)
      if (now - lastSuccessAt > staleAfterMs) errKind = 'net'
    }
    out[id] = { lastSuccessAt, errKind, latencyMs: _latencyMs.get(id) ?? null }
  }
  return out
}

// Transition-based user notifications — emit once when entering an error state (auth vs
// network) and once on recovery, so a persistent failure never spams the toast/bell.
// The frontend localizes by `code`; `meta` carries interpolation values (status) plus
// `connectionId`/`central` so multiple centrals never collapse into one toast.
async function notifyPushError(conn: TeamConnection, kind: 'auth' | 'net', meta?: Record<string, unknown>): Promise<void> {
  if (_pushErrKind.get(conn.id) === kind) return
  _pushErrKind.set(conn.id, kind)
  _notify({
    type: kind === 'auth' ? 'error' : 'warning',
    code: kind === 'auth' ? 'member.auth_rejected' : 'member.unreachable',
    meta: notifyMeta(conn, meta),
  })
}
async function notifyPushRecovered(conn: TeamConnection): Promise<void> {
  if (!_pushErrKind.has(conn.id)) return
  _pushErrKind.delete(conn.id)
  _notify({ type: 'success', code: 'member.reconnected', meta: notifyMeta(conn) })
}

// A 401/403 means the central is currently rejecting this connection's token — either because it
// was genuinely revoked, or because the central itself is between a restart and its database
// coming back (a real incident: ~1 minute of 401s at the default 30s cadence). The two look
// IDENTICAL from here, so the response can never be "delete the connection" (see the removed
// AUTH_ERR_RESET_THRESHOLD-based removal this replaced — two consecutive cycles, ~1 minute, used
// to be enough to throw away the token and the user's denylist with it). Instead the failure must
// be SUSTAINED IN TIME before anything durable happens.
//
// Arithmetic: a central restart/DB-coming-back window is on the order of a minute; the previous
// 2-cycle threshold (~1 minute at the default 30s interval) sat squarely inside it. 10 minutes is
// an order of magnitude past any restart this project has actually observed, while still catching
// a genuinely revoked token within the same working session (at the 15s floor that is 40 cycles;
// at the default 30s interval, 20 cycles) — same shape as the old cycle-count threshold, just
// keyed to wall-clock time so a restart's duration, not its cycle count, decides whether it trips.
export const AUTH_FAIL_SUSTAIN_MS = 10 * 60_000

/**
 * Persist the "this connection needs attention" flag — `TeamConnection.authFailedAt` — once a
 * connection's auth failures are confirmed. Never removes the connection: its rules (`shareMode`/
 * `sources`), the label, everything stays. Idempotent (a connection already marked is a no-op, including across a
 * concurrent race — the mutator re-checks after re-reading).
 *
 * Called from two places, both a CONFIRMED rejection rather than a guess: (1) `handleAuthError`
 * below, only once a push cycle's 401/403 streak has been sustained past `AUTH_FAIL_SUSTAIN_MS`
 * (a single push-cycle 401 is too cheap a signal — it is exactly what a central restart produces);
 * (2) `team-forget-client.ts`'s `runForgetSequence`, immediately on its own 401/403 — that one
 * needs no sustain window because a `whoami`/`forget` rejection during an active removal sequence
 * is already a real, single confirmed rejection, not push-cycle noise. Exported for that caller.
 */
export async function markAuthFailed(
  conn: TeamConnection,
  deps: { updateTeamConfig?: typeof updateTeamConfig } = {},
): Promise<void> {
  const _updateTeamConfig = deps.updateTeamConfig ?? updateTeamConfig
  const now = new Date().toISOString()
  try {
    await _updateTeamConfig((current: TeamConfig) => {
      const existing = current.connections ?? []
      const idx = existing.findIndex(c => c.id === conn.id)
      if (idx === -1) return undefined // removed meanwhile (e.g. user disconnected it) — nothing to mark
      if (existing[idx]!.authFailedAt) return undefined // already marked — idempotent
      const next = existing.slice()
      next[idx] = { ...next[idx]!, authFailedAt: now }
      return normalizeTeamConfig({ ...current, connections: next })
    })
    console.warn(`[team-uploader] ${conn.id} (${hostOf(conn.endpoint)}) marked unauthorized — ` +
      `pausing pushes, connection kept (rotate the token on the central, then reconnect if it ` +
      `was genuinely revoked; recovers on its own if the central was only restarting)`)
  } catch (err) {
    console.warn(`[team-uploader] failed to persist auth-failed state for ${conn.id}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Clear the persisted "needs attention" flag once the central accepts this connection's token
 * again — called from every success path in `pushOnceDetailed`. No-op (and no write) when the
 * connection was never marked, so a healthy connection's every successful cycle costs nothing
 * extra here.
 */
async function clearAuthFailure(
  conn: TeamConnection,
  deps: { updateTeamConfig?: typeof updateTeamConfig } = {},
): Promise<void> {
  _authErrSince.delete(conn.id)
  if (!conn.authFailedAt) return
  const _updateTeamConfig = deps.updateTeamConfig ?? updateTeamConfig
  try {
    await _updateTeamConfig((current: TeamConfig) => {
      const existing = current.connections ?? []
      const idx = existing.findIndex(c => c.id === conn.id)
      if (idx === -1) return undefined
      if (!existing[idx]!.authFailedAt) return undefined
      const { authFailedAt: _drop, ...rest } = existing[idx]!
      const next = existing.slice()
      next[idx] = rest
      return normalizeTeamConfig({ ...current, connections: next })
    })
  } catch (err) {
    console.warn(`[team-uploader] failed to clear auth-failed state for ${conn.id}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Handle a persistent-auth (401/403) push failure for one connection. Emits the first-error
 * notification immediately (transition-guarded, unchanged) — the user should hear about it right
 * away — but the DURABLE "needs attention" state only lands once the failure has been sustained
 * for `AUTH_FAIL_SUSTAIN_MS`, so a central restart's brief 401 window never trips it.
 */
async function handleAuthError(
  conn: TeamConnection,
  status: number,
  deps: { updateTeamConfig?: typeof updateTeamConfig } = {},
): Promise<void> {
  await notifyPushError(conn, 'auth', { status })
  if (conn.authFailedAt) return // already marked — nothing new until a success clears it
  const since = _authErrSince.get(conn.id)
  if (since === undefined) {
    _authErrSince.set(conn.id, Date.now())
    return // first failure of this streak — give it time before doing anything durable
  }
  if (Date.now() - since >= AUTH_FAIL_SUSTAIN_MS) {
    await markAuthFailed(conn, deps)
  }
}

/** Fire-and-forget `handleAuthError`, WITH a `.catch()` — it can reach `markAuthFailed` →
 *  `readPreferences()`/`updateTeamConfig()`, which throw by design on a corrupt preferences file
 *  (see preferences.ts). Bare `void handleAuthError(...)` would turn that into an unhandled
 *  rejection instead of the same best-effort warning every other failure path in this file logs. */
function fireHandleAuthError(
  conn: TeamConnection,
  status: number,
  deps: { updateTeamConfig?: typeof updateTeamConfig } = {},
): void {
  void handleAuthError(conn, status, deps).catch(err =>
    console.warn(`[team-uploader] handleAuthError failed for ${conn.id}:`, err instanceof Error ? err.message : String(err)))
}

/** Test-only: fast-forward a connection's sustained-auth-failure clock into the past, so a test
 *  can prove the `AUTH_FAIL_SUSTAIN_MS` threshold trips without a real 10-minute wait. Mirrors the
 *  other `__set*ForTests` seams in this file. */
export function __setAuthErrSinceForTests(connId: string, epochMs: number): void {
  _authErrSince.set(connId, epochMs)
}

/**
 * The central revoked this connection's token (or it is being removed for another reason).
 * Splices ONLY this connection out of `connections[]` — never rewrites the whole team config —
 * so with N connections a single revoked token disconnects exactly one central:
 *   (i)   stop this connection's timers (chain + debounce) and clear its in-memory state,
 *   (ii)  splice `connections[]` via `updateTeamConfig`, whose mutator runs INSIDE
 *         preferences.ts's single write chain — the array it reads is the one current at ITS
 *         turn to write, not a snapshot from before this call started. Without this, two
 *         connections crossing `AUTH_ERR_RESET_THRESHOLD` in the same window (routine, not
 *         theoretical, now that up to 2 run concurrently) could both read `[A, B, C]` and the
 *         second write would resurrect the first removal.
 *   (iii) GC this connection's four state files (sent/sync/rules/forget) AFTER the write
 *         persists — never from the supervisor tick, which would race the add path,
 *   (iv)  best-effort nudge the reverse-channel client to re-reconcile its socket,
 *   (v)   emit a notification naming this connection — 'member.removed' (warning) when the
 *         central revoked the token, 'member.disconnected' (info) when the user removed it
 *         themselves (DELETE /api/team/connections/:id) — `reason` decides which, so a
 *         user-initiated disconnect never reads as "the central kicked you out".
 * Idempotent — once the connection is gone from preferences, a second call is a no-op (and,
 * since the mutator returns `undefined` in that case, does not even re-write the file).
 *
 * `deps.updateTeamConfig` is injectable for tests — the default touches the developer's real
 * ~/.agentistics/preferences.json, which a test must never do. `deps.log` (review finding N5)
 * defaults to `console` — the ONLY caller that overrides it is `cli-member.ts`'s direct-fallback
 * path (via `leaveConnectionById`'s own `deps.log`), which passes a silent logger so `member
 * leave`'s own "left <endpoint>" line isn't followed by a redundant `[team-uploader]` line in the
 * user's terminal. The browser's DELETE route never overrides it, so its behavior — and the
 * `member.disconnected`/`member.removed` notification this function still always fires — is
 * unchanged.
 *
 * Returns `{removed: true}` once the postcondition (this id is not in `connections[]`) holds —
 * whether THIS call did the removing or it was already gone — and `{removed: false, error}` only
 * when the write itself failed (e.g. a preferences-lock timeout). Callers that report success to
 * a user (`cli-member.ts`'s `member leave`, the DELETE route) MUST check this: the previous
 * version warned-and-returned on a write failure with no way for either caller to tell, so a lock
 * timeout printed "left <endpoint>" with the connection still on disk (review finding I1).
 */
export async function removeConnection(
  connId: string,
  reason: 'revoked' | 'manual' = 'revoked',
  deps: { updateTeamConfig?: typeof updateTeamConfig; log?: { info: (msg: string) => void; warn: (msg: string) => void } } = {},
): Promise<{ removed: true } | { removed: false; error: string }> {
  const _updateTeamConfig = deps.updateTeamConfig ?? updateTeamConfig
  const _log = deps.log ?? console
  teardownConnection(connId)

  let removedConn: TeamConnection | undefined
  try {
    await _updateTeamConfig((current: TeamConfig) => {
      const existing = current.connections ?? []
      removedConn = existing.find(c => c.id === connId)
      if (!removedConn) return undefined // already removed — don't spam, don't re-write
      const remaining = existing.filter(c => c.id !== connId)
      return normalizeTeamConfig({ ...defaultTeam(), connections: remaining })
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    _log.warn(`[team-uploader] failed to persist removal of ${connId}: ${msg}`)
    return { removed: false, error: msg }
  }
  if (!removedConn) return { removed: true } // idempotent — the postcondition already held

  // GC only after the config write above persisted — a timer-driven GC (e.g. from the
  // supervisor) could otherwise race a concurrent "add connection" write.
  await Promise.allSettled([
    unlink(teamSentFile(connId)),
    unlink(teamSyncFile(connId)),
    unlink(teamRulesFile(connId)),
    unlink(teamForgetFile(connId)),
  ])

  // Always console.warn, on EVERY removal path, naming the connection + endpoint host + reason —
  // never the token. This is the one line that made a silently-vanished connection debuggable at
  // all (the production incident this fix addresses took guesswork to trace precisely because
  // removal used to be quiet).
  if (reason === 'manual') {
    _log.warn(`[team-uploader] removed connection ${connId} (${hostOf(removedConn.endpoint)}) — reason: user disconnected it`)
  } else {
    _log.warn(`[team-uploader] removed connection ${connId} (${hostOf(removedConn.endpoint)}) — reason: central revoked this token or it was removed`)
  }
  try {
    const { reconcileNow } = await import('./team-agent-client')
    reconcileNow()
  } catch { /* best-effort — the reverse-channel client is still single-socket; see report */ }
  _notify(reason === 'manual'
    ? { type: 'info', code: 'member.disconnected', meta: notifyMeta(removedConn) }
    : { type: 'warning', code: 'member.removed', meta: notifyMeta(removedConn) })
  return { removed: true }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * The sent-state key for one session.
 *
 * A real digest, not the serialized session: the v1 format stored `JSON.stringify(session)` as its
 * value, which made `team-sent.json` roughly the size of the consolidate store and re-parsed it
 * inside the batch loop — N copies on disk with N connections. `createHash` over that exact same
 * string is what lets `convertSentStateV1` upgrade an existing file offline and EXACTLY, so the
 * migration costs zero re-pushes (§5.4). Do not change what is fed to the hash without changing
 * that converter: they are two halves of one identity.
 */
export function sessionHash(s: SessionMeta): string {
  return createHash('sha256').update(JSON.stringify(s)).digest('hex')
}

export interface SentState {
  [sessionId: string]: string // sessionId → last-sent hash
}

export interface SelectDeltasResult {
  toSend: SessionMeta[]
  nextSent: SentState
}

/**
 * Select sessions whose content changed (or are new) vs the sent state.
 * Returns the sessions to push and the next sent-state to persist after a
 * successful push.
 *   toSend   = sessions where sent[session_id] !== sessionHash(s)
 *   nextSent = { ...sent, [each toSend session_id]: its hash }
 *              (merged so unchanged sessions remain in the state)
 */
export function selectDeltas(sessions: SessionMeta[], sent: SentState): SelectDeltasResult {
  const toSend: SessionMeta[] = []
  const nextSent: SentState = { ...sent }

  for (const raw of sessions) {
    const id = raw.session_id
    if (!id) continue
    // Scrub credentials out of the free text BEFORE anything else. This is the last point the
    // data is still purely local, so a secret pasted into a first prompt never crosses the wire.
    // Hashing the REDACTED session keeps sent-state consistent: an unchanged session still hashes
    // the same on every run, so this does not cause a permanent re-send loop.
    const s = redactSessionText(raw)
    const hash = sessionHash(s)
    if (sent[id] !== hash) {
      toSend.push(s)
      nextSent[id] = hash
    }
  }

  return { toSend, nextSent }
}

// ---------------------------------------------------------------------------
// Per-connection sent-state IO
// ---------------------------------------------------------------------------

/** Load the raw (v2) sent-state document for a connection, defaulting to an empty one.
 *  `convertSentStateV1` also accepts an already-v2 file unchanged, so this is the single read
 *  path regardless of which version is on disk (team-migrate.ts writes v2 directly). */
async function loadRawSentState(connId: string): Promise<SentStateV2> {
  const raw = await safeReadJson<unknown>(teamSentFile(connId))
  return convertSentStateV1(raw) ?? { version: 2, hashes: {}, runIds: [] }
}

/** Load sent-state for one connection (= {} if missing or corrupt). */
export async function loadSentState(connId: string): Promise<SentState> {
  const v2 = await loadRawSentState(connId)
  return v2.hashes
}

/** Persist sent-state for one connection. Preserves the file's `runIds` (owned by the
 *  share-rules removal flow, untouched by this module) so a push never clobbers it. */
export async function saveSentState(connId: string, state: SentState): Promise<void> {
  const current = await loadRawSentState(connId)
  const next: SentStateV2 = { version: 2, hashes: state, runIds: current.runIds }
  await writeFile(teamSentFile(connId), JSON.stringify(next, null, 2), 'utf-8')
}

/**
 * Record workflow run ids the central has ACCEPTED into this connection's sent-state.
 *
 * `sent.runIds` is what `planRulesReconcile` reads as `sentRunIds`, and it is the only thing that
 * can ever name a run for withdrawal. Without this writer the list stayed `[]` forever, so
 * `forgetRuns` was always empty and the whole run-withdrawal path — the plan field, the journal's
 * `runIds`, the runs-only refusal and the per-ack drop in team-forget-client.ts — was dead code.
 * The bounded consequence is narrow but real: the central deletes runs by session, so a denied
 * session named in `forgetIds` takes its runs with it, but a run pushed for a session that was
 * never pushed as a session document (an `archiveMode: 'off'` machine ships workflows with zero
 * session docs) is unwithdrawable and nothing would ever notice.
 *
 * Called only AFTER a response the central accepted — the same rule `_lastPushedPayloadHash`
 * follows. Recording a run before the POST succeeded would name it as "the central holds this"
 * when it does not, and the withdrawal that later drops it would be the only correction.
 *
 * Merges rather than replaces: a run stays named until a completed forget sequence drops it.
 * Best-effort — a failed write just means the next accepted push records it again.
 */
async function recordSentRunIds(connId: string, runs: readonly WorkflowRun[]): Promise<void> {
  const ids = runs.map(r => r.runId).filter(Boolean)
  if (ids.length === 0) return
  try {
    const current = await loadRawSentState(connId)
    const merged = unionIds(current.runIds, ids)
    if (merged.length === current.runIds.length) return // nothing new
    await writeFile(teamSentFile(connId), JSON.stringify({ version: 2, hashes: current.hashes, runIds: merged }, null, 2), 'utf-8')
  } catch (err) {
    console.warn(`[team-uploader] could not record pushed run ids for ${connId}:`, err instanceof Error ? err.message : String(err))
  }
}

/**
 * Per-connection batch size, adapted by `nextBatchSize` from what the central actually manages.
 *
 * In memory only: a restart re-probes from `MAX_BATCH_SIZE`, which is the right default for a
 * central that has since been fixed or moved, and costs one shrink cycle on one that has not.
 */
const _batchSize = new Map<string, number>()

function batchSizeFor(connId: string): number {
  return clampBatchSize(_batchSize.get(connId) ?? MAX_BATCH_SIZE)
}

function recordBatchOutcome(connId: string, outcome: 'ok' | 'failed'): void {
  _batchSize.set(connId, nextBatchSize(batchSizeFor(connId), outcome))
}

// ---------------------------------------------------------------------------
// Shared push-cycle context — built ONCE per cycle window and reused by every connection's
// push, so N centrals never trigger N independent buildApiResponse() + full store scans.
// ---------------------------------------------------------------------------

/**
 * The inputs every connection's push needs, built from a SINGLE `buildApiResponse()` call.
 *
 * `realStatsCache` is the supplemented cache and `liveSessions` is the EXACT array it was
 * supplemented from — they must always travel together (see `buildSplitStatsCache`'s
 * same-array precondition in share-rules.ts, not called from this module yet, but a later plan
 * wires it in and inherits whatever pairing this context establishes).
 *
 * `storedSessions` is a DIFFERENT set — the consolidate store, loaded via `loadConsolidated()`
 * AFTER `buildApiResponse()` (which is what writes that store) so it is never read cold or
 * half-written. `storedSessions` is what is actually pushed to the central as session
 * documents; `liveSessions` only feeds arithmetic that assumes the live, complete array.
 */
export interface PushCycleContext {
  /** The supplemented cache — and the array it was supplemented from. They must be the pair. */
  realStatsCache: StatsCache | null
  /** feeds the split's arithmetic (a later plan) — never pushed to the central directly */
  liveSessions: SessionMeta[]
  /** The consolidate store — what is actually PUSHED as session documents. A different set. */
  storedSessions: SessionMeta[]
  projects: ServerProject[]
  workflows: WorkflowRun[]
  /** path → repo key, learned from BOTH `liveSessions`/`storedSessions` and `projects` — see
   *  `buildPathRepoIndex`'s doc comment for why the project seed is load-bearing. Used to resolve
   *  the repo of a session whose own `git_remote` is empty (only the Copilot adapter sets it
   *  among the non-Claude adapters). */
  index: PathRepoIndex
  builtAt: number
  /** Ingest fetch timeout override, in ms — injectable for tests so a "central that never
   *  responds" regression test doesn't have to wait out the real production timeout. Production
   *  code never sets this; `pushOnceDetailed` derives the budget from the batch via
   *  `ingestTimeoutMs` (ingest-batch.ts). */
  ingestTimeoutMs?: number
}

/** Every fetch to a central's `/api/team/ingest` MUST carry a timeout. Without one, a wedged
 *  reverse proxy or a suspended container can accept the TCP connection and simply never
 *  respond — common, not exotic — and `runConnectionPushCycle` holds a concurrency-cap slot
 *  across that fetch, so two such centrals permanently occupy both slots and every OTHER
 *  connection blocks in `acquireSlot()` forever, with no error and a `lastSuccessAt` that is
 *  only ever set, never aged out.
 *
 *  It is NOT a flat number any more. A flat 15s was stated here beside a `BATCH_SIZE` of 200
 *  chosen elsewhere, with nothing checking that one fits the other — and it did not: a real
 *  central costs ~195 ms/session, so those 200 needed ~39s and every first push aborted, forever,
 *  because the sent-state only advances on an ACCEPTED batch. `ingestTimeoutMs` (ingest-batch.ts)
 *  now derives the budget from the batch, and is the only place either number is decided. */

let _cachedContext: PushCycleContext | null = null
let _contextPromise: Promise<PushCycleContext> | null = null

/** The minimum interval (seconds) learned from any connection's central so far, used to bound
 *  how long the shared push context stays fresh. Falls back to the default before any policy has
 *  been learned. */
function minKnownIntervalSec(): number {
  const values = Array.from(_centralIntervalSec.values())
  return values.length ? Math.min(...values) : PUSH_INTERVAL.DEFAULT_SEC
}

/** Injectable data sources for `buildPushContext` — production code never passes this; it exists
 *  so tests can supply fakes and assert call ORDER (buildApiResponse before loadConsolidated)
 *  and content, without touching the real `~/.claude`/`~/.agentistics` on the machine running the
 *  test. */
interface PushContextDeps {
  buildApiResponse?: () => Promise<{ sessions: SessionMeta[]; statsCache: StatsCache | null; projects: ServerProject[]; workflows?: WorkflowRun[] }>
  loadConsolidated?: () => Promise<Map<string, SessionMeta>>
  readMemberWorkflows?: () => Promise<WorkflowRun[]>
}

export async function buildPushContext(deps: PushContextDeps = {}): Promise<PushCycleContext> {
  // buildApiResponse() FIRST — it is what WRITES the consolidate store. Loading the store
  // before this runs would read a cold or half-written one (see the class doc above).
  const _buildApiResponse = deps.buildApiResponse ?? (await import('./data')).buildApiResponse
  let resp: Awaited<ReturnType<typeof _buildApiResponse>> | null = null
  try {
    resp = await _buildApiResponse()
  } catch (err) {
    console.warn('[team-uploader] buildApiResponse failed while building the push context:', err instanceof Error ? err.message : String(err))
  }
  const liveSessions = resp?.sessions ?? []
  // NOT falling back to the raw `~/.claude/stats-cache.json` here (unlike the pre-multi-central
  // code, which read it via safeReadJson when buildApiResponse failed): that raw cache would be
  // paired with `liveSessions: []` (buildApiResponse itself threw, so there IS no live array),
  // which is exactly the same-array precondition this context exists to uphold — a later plan's
  // `buildSplitStatsCache` call would either misattribute a cache to an empty session array or
  // (if it re-validates, as it does) simply refuse the whole cycle. `null` here correctly means
  // "no statsCache this cycle" and pushOnceDetailed already treats that as "nothing to push"
  // rather than inventing paired data that isn't there.
  const realStatsCache = resp?.statsCache ?? null
  const projects = resp?.projects ?? []

  let storedSessions: SessionMeta[] = []
  try {
    const _loadConsolidated = deps.loadConsolidated ?? loadConsolidated
    const consolidatedMap = await _loadConsolidated()
    storedSessions = Array.from(consolidatedMap.values())
  } catch { /* best-effort — an empty store just means nothing to push this cycle */ }

  // buildApiResponse already merges live-discovered + stored workflow runs (see data.ts); reuse
  // it rather than re-reading the store a second time. Fall back to the raw store only if the
  // build itself failed above.
  const _readMemberWorkflows = deps.readMemberWorkflows ?? readMemberWorkflows
  const workflows = resp?.workflows ?? await _readMemberWorkflows()

  // Learned from BOTH sources on purpose: only copilot.ts among the non-Claude adapters sets
  // git_remote, and data.ts's backfill runs against the Claude-only array before the harness
  // merge — so the store carries every Codex/Gemini/Kimi/agy session with no remote, permanently.
  // A directory used exclusively by a non-Claude harness has no session to learn from; the
  // project record does. Anything still unresolved lands in NO_REPO_KEY, which is fail-closed.
  const index = buildPathRepoIndex([...liveSessions, ...storedSessions], projects)

  return { realStatsCache, liveSessions, storedSessions, projects, workflows, index, builtAt: Date.now() }
}

/**
 * Return the shared push-cycle context, rebuilding it only once every `min(intervals)/2`.
 * Concurrent callers within that window await the SAME in-flight build instead of each starting
 * their own `buildApiResponse()` + full store scan.
 */
export async function getPushContext(deps: PushContextDeps = {}): Promise<PushCycleContext> {
  const ttlMs = Math.max(1_000, (minKnownIntervalSec() * 1000) / 2)
  if (_cachedContext && Date.now() - _cachedContext.builtAt < ttlMs) return _cachedContext
  if (_contextPromise) return _contextPromise
  _contextPromise = buildPushContext(deps)
    .then(ctx => {
      _cachedContext = ctx
      _contextPromise = null
      return ctx
    })
    .catch(err => {
      _contextPromise = null
      throw err
    })
  return _contextPromise
}

/** Drop the cached push-cycle context so the next `getPushContext()` rebuilds instead of serving
 *  a pre-change snapshot. `notifyDataChanged()` calls this on every local data change (see its
 *  docstring); exported so a test can also call it directly without needing `startUploader()`
 *  (which would start the real 5s supervisor against the developer's real preferences file). */
export function invalidatePushContext(): void {
  _cachedContext = null
}

/**
 * The last-built push-cycle context, or `null` when none has been built (or it was invalidated).
 * NEVER builds one, and deliberately ignores the TTL — this is for read-only, display-only
 * consumers that want whatever the push cycle last computed and can honestly say "unknowable"
 * otherwise.
 *
 * Its reason to exist: `GET /api/team/status` is polled by the browser every ~5s, while
 * `notifyDataChanged()` calls `invalidatePushContext()` on EVERY local file change. During active
 * coding the TTL therefore protects nothing, and a status handler calling `getPushContext()` runs
 * a full `buildApiResponse()` — which also WRITES the consolidate store — plus
 * `loadConsolidated()` at the browser's poll cadence instead of the connection's push interval.
 */
export function peekPushContext(): PushCycleContext | null {
  return _cachedContext
}

// ---------------------------------------------------------------------------
// Push — per connection
// ---------------------------------------------------------------------------

export interface PushOnceResult {
  count: number
  error?: string
}

/**
 * Best-effort: this connection's `user` is unresolved (empty) — try to resolve it via whoami
 * before giving up on the push. A separate, deliberately small implementation from
 * `resolveMemberIdentity` in team-agent-client.ts (not imported — that module dynamically
 * imports THIS one, see `removeConnection`'s `reconcileNow` nudge, so a static import back would
 * put both on the same load-order cycle for one whoami call).
 *
 * Returns the resolved name, or '' when it could not be resolved this cycle (network error,
 * non-2xx central, or a body that carries no usable `user`) — the caller treats that as "not
 * ready yet", not an error, and retries on the next push cycle (or the WS client's own 5s
 * reconcile poll resolves it first in practice). On success, persists the name into this
 * connection's preferences entry so later cycles — and the WS client — pick it up too.
 *
 * `deps.updateTeamConfig` is injectable for tests — the default touches the developer's real
 * ~/.agentistics/preferences.json, which a test must never do.
 */
async function resolveConnectionUser(
  conn: TeamConnection,
  deps: { updateTeamConfig?: typeof updateTeamConfig } = {},
): Promise<string> {
  const _updateTeamConfig = deps.updateTeamConfig ?? updateTeamConfig
  try {
    const endpoint = conn.endpoint.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (conn.token) headers['Authorization'] = `Bearer ${conn.token}`
    const res = await fetch(`${endpoint}/api/team/whoami`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return ''
    const json = await res.json() as { ok?: boolean; user?: string }
    if (!json.ok || typeof json.user !== 'string' || !json.user) return ''
    const resolved = json.user
    try {
      await _updateTeamConfig((current: TeamConfig) => {
        const existing = current.connections ?? []
        const idx = existing.findIndex(c => c.id === conn.id)
        if (idx === -1) return undefined // removed meanwhile — nothing to update
        if (existing[idx]!.user === resolved) return undefined // already current
        const next = existing.slice()
        next[idx] = { ...next[idx]!, user: resolved }
        return normalizeTeamConfig({ ...current, connections: next })
      })
    } catch {
      // persisting failed — still return the resolved name so THIS push cycle uses it;
      // the next cycle re-resolves and re-attempts the persist.
    }
    return resolved
  } catch {
    return ''
  }
}

/**
 * Cheap liveness/auth probe for a connection currently marked `authFailedAt` — decides only
 * whether the central is STILL EXPLICITLY REJECTING this token, not whether `/api/team/whoami`
 * happens to answer 2xx. An `AGENTISTICS_INGEST_ONLY` central 404s every route except
 * `POST /api/team/ingest` and `POST /api/team/forget` by design (see `index.ts`) — treating that
 * 404 as "still rejected" would strand a member on such a central forever, since the probe would
 * never see anything but 404 even after the operator restores the token. Same for any central
 * behind a proxy that answers a non-2xx for an unknown path while ingest itself is healthy.
 *
 * So: 401/403 → `false` (the central is still actively rejecting — stay paused, do not spend the
 * full push payload proving it again). A network error or timeout also → `false` (the `catch`) —
 * a genuinely down central must still stay paused. EVERYTHING ELSE (2xx, 404, 500, whatever a
 * route that may not even exist here returns) → `true` — "can't tell from this probe alone", so
 * let the real push decide: if the token is in fact still bad, that push 401s and
 * `handleAuthError` simply restarts the 10-minute clock (self-correcting, and it removes any
 * dependency on `/api/team/whoami` existing or behaving a particular way).
 */
async function probeAuthRecovered(conn: TeamConnection): Promise<boolean> {
  try {
    const endpoint = conn.endpoint.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (conn.token) headers['Authorization'] = `Bearer ${conn.token}`
    const res = await fetch(`${endpoint}/api/team/whoami`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (res.status === 401 || res.status === 403) return false
    return true
  } catch {
    return false
  }
}

/**
 * Core push implementation for ONE connection against the SHARED cycle context.
 * No-op (count=0) when the connection has no endpoint, or (having a token or not — an
 * open/legacy central accepts a token-less member, same as the WS client's gate) its `user`
 * cannot be resolved even after a fresh whoami attempt this cycle. Never throws.
 */
export async function pushOnceDetailed(
  conn: TeamConnection,
  ctx: PushCycleContext,
  deps: { updateTeamConfig?: typeof updateTeamConfig; sealed?: DeniedLedger } = {},
): Promise<PushOnceResult> {
  if (!conn.endpoint) {
    return { count: 0 }
  }
  if (conn.authFailedAt) {
    // Sustained auth failure already marked durable — do not hammer a central that is still
    // rejecting this token with the full push payload. A cheap whoami probe, on the connection's
    // OWN normal cycle (this function runs no faster than that), is what lets it recover on its
    // own the moment the central answers again, with no human action.
    const recovered = await probeAuthRecovered(conn)
    if (!recovered) return { count: 0 } // still rejected — stay paused, retry next cycle
    await clearAuthFailure(conn, deps)
    // Fall through: the token just proved itself good again, so this same cycle pushes normally
    // instead of waiting a whole extra interval to notice.
  }
  let user = conn.user
  if (!user) {
    user = await resolveConnectionUser(conn, deps)
    if (!user) return { count: 0 } // still unresolved this cycle — retried next time
  }
  const endpoint = conn.endpoint.replace(/\/+$/, '')
  // The budget for a request carrying `n` sessions. A test may pin it flat; production always
  // derives it, so the batch and its timeout cannot be chosen independently again.
  const timeoutFor = (n: number) => ctx.ingestTimeoutMs ?? ingestTimeoutMs(n)

  try {
    const rules = shareRulesOf(conn.shareMode, conn.sources)
    const restricted = sourcesRestrict(conn.shareMode, conn.sources)
    // Tracked so the scheduling functions (scheduleOnChangeTrigger, scheduleConnectionCycle),
    // which only ever see a connId, can also honor this connection's restriction (§5.3.4).
    _restrictedConn.set(conn.id, restricted)

    // BEFORE selectDeltas — see the class doc. A denied session that reached nextSent would be
    // invisible to every later push, so un-blocking the repo would never send it.
    const shared = restricted ? filterSharedRules(ctx.storedSessions, rules, ctx.index) : ctx.storedSessions
    const sent = await loadSentState(conn.id)
    const { toSend, nextSent } = selectDeltas(shared, sent)

    // The DECLARED rule selects the cache, never a count comparison (R3): `filtered.length <
    // all.length` is false on a cold or empty store and would push the real full-history cache
    // with the denied repo's recent days in it.
    let statsCache: StatsCache | undefined
    if (!restricted) {
      // The member's own statsCache (aggregated Claude history) is pushed so the central can
      // reproduce exact totals; it changes as activity accrues even when no new sessions exist.
      statsCache = ctx.realStatsCache ?? undefined
    } else if (ctx.realStatsCache) {
      const boundary = attributionBoundary(ctx.realStatsCache)
      // `liveSessions`, not storedSessions: buildSplitStatsCache requires that `real` was
      // supplemented from the SAME array passed as allStored. Passing the store makes the split
      // refuse and the machine push no cache at all.
      const split = buildSplitStatsCache({
        real: ctx.realStatsCache,
        allStored: ctx.liveSessions,
        shared: filterSharedRules(ctx.liveSessions, rules, ctx.index),
        boundary,
        sealed: deps.sealed ?? {},
      })
      // null = the split cannot be made faithfully. Push NO cache — never the unsplit one. A
      // missing cache is recoverable; a leaked one is not (§4.4).
      statsCache = split ?? undefined
    }

    // Fail closed: a run whose session is not in the shared set is dropped, INCLUDING one whose
    // session is simply unknown locally. WorkflowRun carries name, phases, agents[].label and
    // totals — task descriptions and cost from the blocked repo.
    const workflows = restricted
      ? filterSharedWorkflows(ctx.workflows, sharedSessionIds(shared))
      : ctx.workflows

    // The deliveries whose owner opted IN. Two independent gates: `Task.shared` decides whether
    // the RECORD travels at all (absent reads as not shared), and the connection's rules decide
    // its SESSIONS exactly as they decide everything else — `sharedSessionIds(shared)` is the very
    // set the sessions above were selected from, so sharing a task can never widen a repository
    // rule. The scrub happens here, on the last hop where the text is still purely local; the
    // central scrubs again on ingest.
    const tasks = await selectSharedTasksForPush(
      sharedSessionIds(shared),
      sharedSessionIds(ctx.storedSessions),
    )

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (conn.token) {
      headers['Authorization'] = `Bearer ${conn.token}`
    }

    // sha256 over what this cycle WOULD attach as the cache payload, regardless of which path
    // ends up sending it — the batch path (below) attaches the identical `{statsCache, workflows}`
    // pair to batch 0, and both writers must agree on exactly this formula or the memo they share
    // desynchronizes (see `_lastPushedPayloadHash`'s doc comment).
    const payloadDigest = createHash('sha256')
      .update(JSON.stringify({ statsCache, workflows, tasks })).digest('hex')

    if (toSend.length === 0) {
      // No session deltas — still push the statsCache/workflows on their own so totals
      // and workflow runs stay fresh.
      if (statsCache || workflows.length > 0 || tasks.length > 0) {
        // A restricted connection with genuinely nothing new must not still POST every cycle:
        // each request stamps `lastSeenAt` on the central at ~2s resolution, from which session
        // boundaries, working hours and intensity of the HIDDEN work are reconstructable from
        // request timing alone, even though no content ever crosses the wire (§5.3.4). Skip when
        // this cycle's payload is byte-identical to the last one actually ACCEPTED for this
        // connection (by either this branch or the batch path below). Unrestricted connections
        // are unaffected — a steady keep-alive is not a privacy leak when nothing is hidden.
        if (restricted && _lastPushedPayloadHash.get(conn.id) === payloadDigest) {
          const streak = (_suppressedStreak.get(conn.id) ?? 0) + 1
          if (streak <= MAX_SUPPRESSED_STREAK) {
            // Suppressed, NOT marked as success: we never contacted the central this cycle, so
            // claiming success here would let a revoked token, a wiped central, or a central that
            // is simply down go undetected for as long as the payload stays unchanged — exactly
            // the quiet-blocked-repo case this dedup exists to keep quiet. `markPushSuccess` is
            // only earned by an actual response (see the forced push below and every other path
            // in this function).
            _suppressedStreak.set(conn.id, streak)
            return { count: 0 }
          }
          // The bound elapsed: force a real push even though nothing changed, purely to re-verify
          // liveness. This does NOT reopen the §5.3.4 correlation leak that dedup exists to close
          // — that leak is about a push's TIMING correlating with the user's local activity (a
          // push firing within ~2s of a file write reveals session boundaries and working hours).
          // A push that fires once every MAX_SUPPRESSED_STREAK cycles regardless of what happened
          // locally carries no such correlation: its timing is a function of the wall clock (plus
          // the existing ±20% jitter on the connection's cadence), never of the user's activity.
          // Falls through to the normal fetch below, whose real response drives
          // markPushSuccess/auth handling exactly like any other push.
        }
        // Reached whenever a real push is about to be attempted: unrestricted, a restricted
        // connection whose payload actually changed, or a restricted connection whose suppression
        // bound just elapsed. Reset the streak NOW, before the network call — an ATTEMPT is what
        // resets it, not a successful one: a failed forced push must not leave the streak pinned
        // past the bound, or every later cycle would force another attempt instead of going back
        // to suppressing for up to MAX_SUPPRESSED_STREAK cycles.
        if (restricted) _suppressedStreak.set(conn.id, 0)
        try {
          const res = await fetch(`${endpoint}/api/team/ingest`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ org: conn.org, user, sessions: [], statsCache, workflows, tasks }),
            signal: AbortSignal.timeout(timeoutFor(0)),
          })
          // A reachable central (even a non-2xx that isn't auth) counts as contact for the pill.
          if (res.ok) {
            markPushSuccess(conn.id); clearPushError(conn.id); void notifyPushRecovered(conn)
            await clearAuthFailure(conn, deps)
            // Only memoize once the central actually accepted it — recording it BEFORE a
            // known-successful POST would permanently swallow a payload whose first attempt
            // failed (network error or non-2xx): every later cycle with the same unchanged
            // content would then match the memoized digest and never retry, silently losing that
            // statsCache/workflow update until unrelated content happens to change.
            _lastPushedPayloadHash.set(conn.id, payloadDigest)
            // Same rule, same moment: the runs this payload carried are now held by the central,
            // so they become withdrawable.
            await recordSentRunIds(conn.id, workflows)
          } else if (res.status === 401 || res.status === 403) fireHandleAuthError(conn, res.status, deps)
        } catch (e) {
          warnPushError(conn.id, e instanceof Error ? e.message : String(e))
          void notifyPushError(conn, 'net')
        }
      }
      return { count: 0 }
    }

    let pushed = 0

    // Read ONCE for the whole loop: every batch of this push is the size the previous push earned,
    // and adapting mid-loop would make the same cycle send batches of different sizes for no
    // reason a reader could follow.
    const batchSize = batchSizeFor(conn.id)
    for (let i = 0; i < toSend.length; i += batchSize) {
      const batch = toSend.slice(i, i + batchSize)
      let res: Response
      try {
        res = await fetch(`${endpoint}/api/team/ingest`, {
          method: 'POST',
          headers,
          // Attach the statsCache/workflows to the first batch only (idempotent upsert on the central).
          body: JSON.stringify({ org: conn.org, user, sessions: batch, ...(i === 0 ? { statsCache, workflows, tasks } : {}) }),
          signal: AbortSignal.timeout(timeoutFor(batch.length)),
        })
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        // The central did not answer in the budget this batch was given, so the batch is too big
        // for it — shrink, and let the next cycle prove the smaller one. Without this a central
        // slower than PER_SESSION_MS assumes would retry an impossible request forever, which is
        // the shape of the bug this module exists to have fixed once.
        recordBatchOutcome(conn.id, 'failed')
        warnPushError(conn.id, msg)
        void notifyPushError(conn, 'net')
        return { count: pushed, error: msg }
      }

      if (!res.ok) {
        const msg = `ingest returned ${res.status}`
        console.warn(`[team-uploader] ${conn.id} ${msg}; stopping push`)
        // 401/403 = the central is rejecting the token → actionable auth notification immediately;
        // a DURABLE "needs attention" mark (and the pushes-paused behavior above) only lands once
        // the failure has been sustained past AUTH_FAIL_SUSTAIN_MS — the connection is never
        // removed from here.
        if (res.status === 401 || res.status === 403) fireHandleAuthError(conn, res.status, deps)
        return { count: pushed, error: msg }
      }

      // Batch succeeded — advance this connection's sent-state for this batch
      const batchSent: SentState = {}
      for (const s of batch) {
        if (s.session_id) batchSent[s.session_id] = nextSent[s.session_id]!
      }
      const current = await loadSentState(conn.id)
      await saveSentState(conn.id, { ...current, ...batchSent })
      pushed += batch.length
      // The central absorbed a batch this size inside its budget — earn a slightly larger one.
      recordBatchOutcome(conn.id, 'ok')
      markPushSuccess(conn.id)
      clearPushError(conn.id)
      void notifyPushRecovered(conn)
      await clearAuthFailure(conn, deps)
      if (i === 0) {
        // Batch 0 carried the SAME `{statsCache, workflows}` pair the empty-delta branch above
        // would have attached — and the central just accepted it. Recording it here (restricted
        // OR not) is what keeps the memo meaning "what the central last accepted" rather than
        // "the last payload the OTHER branch happened to send": without this, a restricted →
        // unrestricted → restricted transition pushes its unsplit cache through THIS path, the
        // memo is never updated, and a later restricted cycle whose split cache happens to match
        // what was memoized from BEFORE this unsplit push gets wrongly suppressed — stranding the
        // denied repo's volume in the cache the central already holds (reproduced end-to-end
        // against a live central).
        _lastPushedPayloadHash.set(conn.id, payloadDigest)
        // Batch 0 is also the batch that carried `workflows` — the central accepted it, so those
        // runs are now withdrawable. Recorded here rather than after the loop for the same reason
        // the memo is: only an accepted response earns it.
        await recordSentRunIds(conn.id, workflows)
      }
    }

    return { count: pushed }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[team-uploader] unexpected error in pushOnceDetailed (${conn.id}):`, msg)
    return { count: 0, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Concurrency cap — pushes run sequentially with AT MOST 2 in flight at once, so one hung
// central can never exhaust sockets or starve the others. A plain Promise.all over every
// connection would have no such bound.
// ---------------------------------------------------------------------------

export const MAX_CONCURRENT_PUSHES = 2
let _activeSlots = 0
const _slotWaiters: Array<() => void> = []

/** Test-only accessor onto the semaphore's internal count — lets a test assert the invariant
 *  (`_activeSlots` never exceeds `MAX_CONCURRENT_PUSHES`) directly instead of inferring it from
 *  timing. Never called from production code. */
export function __activeSlotsForTests(): number {
  return _activeSlots
}

/**
 * Release a slot. If a waiter is queued, the slot is TRANSFERRED directly to it (the woken
 * waiter's `acquireSlot()` does NOT increment `_activeSlots` again) rather than decremented and
 * then re-incremented by the waiter — decrement-then-signal briefly counted 3 in flight against
 * a cap of 2 whenever a synchronous arrival raced the woken waiter's own increment.
 */
function releaseSlot(): void {
  const next = _slotWaiters.shift()
  if (next) { next(); return } // ownership transferred — _activeSlots is unchanged
  _activeSlots--
}

/** Exported for tests only (the B-5 semaphore regression test) — every production call site
 *  stays internal to this module. */
export async function acquireSlot(): Promise<() => void> {
  if (_activeSlots < MAX_CONCURRENT_PUSHES) {
    _activeSlots++
    return releaseSlot
  }
  await new Promise<void>(resolve => { _slotWaiters.push(resolve) })
  // The slot was TRANSFERRED by releaseSlot above, not freed — no increment here.
  return releaseSlot
}

// ---------------------------------------------------------------------------
// Periodic per-connection uploader
// ---------------------------------------------------------------------------

/**
 * Fetch the central policy: push interval + the central's data instanceId + its advertised
 * capabilities (Task 2's `parseCapabilities`, so Task 6's status route can report `canForget`).
 * Falls back to the default interval / null id / empty capabilities on any network or parse
 * error — the CALLER is responsible for not clobbering a previously learned capability list with
 * this empty fallback (same rule the latency cache already follows), because a plain fetch
 * failure must not disable the rules editor over one flap.
 */
async function fetchCentralPolicy(endpoint: string): Promise<{ intervalSec: number; instanceId: string | null; latencyMs: number | null; capabilities: string[] }> {
  const t0 = Date.now()
  try {
    const res = await fetch(`${endpoint}/api/team/policy`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return { intervalSec: PUSH_INTERVAL.DEFAULT_SEC, instanceId: null, latencyMs: null, capabilities: [] }
    const latencyMs = Date.now() - t0
    const json = await res.json() as { pushIntervalSec?: unknown; instanceId?: unknown; capabilities?: unknown }
    const sec = typeof json.pushIntervalSec === 'number' ? json.pushIntervalSec : PUSH_INTERVAL.DEFAULT_SEC
    const instanceId = typeof json.instanceId === 'string' ? json.instanceId : null
    const capabilities = parseCapabilities(json.capabilities)
    // Honor express intervals (the central may dictate below the normal 15s floor).
    return { intervalSec: clampPushInterval(sec, PUSH_INTERVAL.EXPRESS_MIN_SEC), instanceId, latencyMs, capabilities }
  } catch {
    return { intervalSec: PUSH_INTERVAL.DEFAULT_SEC, instanceId: null, latencyMs: null, capabilities: [] }
  }
}

/**
 * Auto-reconcile one connection's sent-state with its central. The sent-state assumes the
 * central still holds everything we pushed — but a destructive action (member revoked +
 * re-added, a new central endpoint, or a wiped central DB) breaks that assumption silently. We
 * fingerprint the current target as endpoint+token+instanceId; when it differs from what the
 * sent-state was built against, we clear the sent-state so the next push re-sends the full
 * history.
 *
 * Re-pushing is idempotent (the central upserts by session_id), so a reset never double-counts.
 * A null instanceId (old/unreachable central) is treated as empty — it never spuriously resets.
 */
async function reconcileSyncState(connId: string, endpoint: string, token: string, instanceId: string | null): Promise<void> {
  // Only reconcile against a KNOWN central identity. A null instanceId means the central is
  // unreachable or predates this feature — reconciling then would falsely reset on every flap.
  if (!instanceId) return
  const sig = createHash('sha256').update(`${endpoint}\0${token}\0${instanceId}`).digest('hex')
  const prev = await safeReadJson<{ sig?: string }>(teamSyncFile(connId))
  if (prev?.sig === sig) return // target unchanged — nothing to reconcile

  // Signature changed (or first run) → the central may not have our data. Clear the sent-state
  // so the next push re-sends everything, then record the new signature.
  await saveSentState(connId, {})
  _lastSuccessAt.delete(connId)
  try {
    await writeFile(teamSyncFile(connId), JSON.stringify({ sig }), 'utf-8')
  } catch { /* best-effort — worst case we reconcile again next cycle */ }
  if (prev?.sig) console.info(`[team-uploader] ${connId} central sync signature changed — re-pushing full history`)
}

/**
 * Compute this connection's rules plan (the denial-based shrink detector + the seal ledger) and
 * persist the resulting state. PURE decision, impure shell: `planRulesReconcile` (team-rules.ts)
 * does the whole computation; this function only gathers its inputs from the shared push-cycle
 * context and this connection's own sent-state/rules-state files, then writes the result back.
 *
 * `runForgetSequence` (team-forget-client.ts) is what actually performs the removal against
 * `rulesPlan.forgetIds`/`forgetRuns`; this function only computes the plan and logs it.
 *
 * `RulesState` holds two things with OPPOSITE persistence rules, and they are split here:
 *
 * - **The seal ledger (`sealed`/`pending`/`boundary`) is written on EVERY cycle**, unconditionally
 *   and best-effort, exactly as it always was. It is NOT re-derivable: `advanceSeal` seals out of
 *   `prev.pending` — the PERSISTED value, not the freshly measured one — and its CALLER CONTRACT
 *   (share-rules.ts) is that it must run on every push cycle without skipping one, because a day
 *   only seals while it is still in `prev.pending` and the boundary has just passed it. Computing
 *   the ledger in memory and discarding it IS a skipped cycle from the ledger's point of view, and
 *   the case where that happens is the COMMON one: a central that is down, rejecting, or too old
 *   to forget keeps the removal failing for hours. The day would enter `pending` only in memory,
 *   the boundary would cross it, and once its sessions age out of the store the seal is
 *   unrecoverable — the blocked repository's volume for that day then ships inside the
 *   undecomposable rollup.
 * - **The rules hash (and the `sharedIds` snapshot paired with it) is written only once the
 *   removal it implies has actually happened** — `runConnectionPushCycle` does that. The hash is
 *   what suppresses re-detection, so persisting it after a failed removal would make the machine
 *   stop asking with the data still on the central. Unlike the ledger, it IS re-derivable: the
 *   next cycle recomputes the same hash from the same denylist.
 */
async function reconcileRulesFor(conn: TeamConnection, ctx: PushCycleContext) {
  const prevRules = await loadRulesState(conn.id)
  const rawSent = await loadRawSentState(conn.id)
  const rulesPlan = planRulesReconcile({
    mode: conn.shareMode,
    sources: conn.sources,
    sentHashes: rawSent.hashes,
    sentRunIds: rawSent.runIds,
    storedSessions: ctx.storedSessions,
    liveSessions: ctx.liveSessions,
    workflows: ctx.workflows,
    index: ctx.index,
    real: ctx.realStatsCache,
    prev: prevRules,
  })
  if (rulesPlan.forgetIds.length > 0 || rulesPlan.forgetRuns.length > 0) {
    console.info(
      `[team-uploader] ${conn.id} denylist excludes ${rulesPlan.forgetIds.length} previously-sent ` +
      `session(s) and ${rulesPlan.forgetRuns.length} workflow run(s) the central may still hold`,
    )
  }
  // The ledger half, now — before anything that can fail, and regardless of what the removal does
  // next. `prevRules.rulesHash`/`sharedIds` are carried through UNCHANGED so this write can never
  // claim a removal happened; only the success path below replaces them.
  await saveRulesState(conn.id, {
    ...prevRules,
    boundary: rulesPlan.next.boundary,
    sealed: rulesPlan.next.sealed,
    pending: rulesPlan.next.pending,
  })
  return rulesPlan
}

/** Union of two id lists, order-preserving and deduped. */
function unionIds(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...a, ...b]) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Boot replay (§6.1 step d). A journal left open by a killed process names exactly what a central
 * was already promised, and nothing else would ever notice it: the sync signature did not change,
 * so `reconcileSyncState` triggers no re-push, and the sent-state advance for the unacked half may
 * itself have been lost. Read each connection's journal here and hand it to that connection's next
 * cycle, which runs the sequence under the push lock like any other.
 *
 * A replay is idempotent — deleting an already-deleted id returns `deleted: 0` (team-forget.ts is
 * explicit about this) — so re-naming an id the central already removed costs one request and
 * nothing else. Do NOT "optimize" the replay away on that basis: being a no-op in the common case
 * is what makes it safe, not what makes it pointless.
 *
 * `deps` is injectable so a test never reads the developer's real preferences file. Never throws.
 */
export async function replayForgetJournals(
  deps: { readPreferences?: typeof readPreferences; loadForgetJournal?: typeof loadForgetJournal } = {},
): Promise<number> {
  try {
    const prefs = await (deps.readPreferences ?? readPreferences)()
    const _loadForgetJournal = deps.loadForgetJournal ?? loadForgetJournal
    let queued = 0
    for (const conn of prefs.team?.connections ?? []) {
      const journal = await _loadForgetJournal(conn.id)
      if (!journal) continue
      _resumeForget.set(conn.id, journal)
      queued++
      console.info(
        `[team-uploader] ${conn.id} found an open removal journal (started ${journal.startedAt}) — ` +
        `${journal.ids.length} session(s) will be re-named on the next cycle`,
      )
    }
    return queued
  } catch (err) {
    console.warn('[team-uploader] could not replay removal journals:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

// Push-on-change: coalesce a burst of local file changes into a single push per connection, and
// never push more often than that connection's central interval floor.
const ON_CHANGE_DEBOUNCE_MS = 2_000
const SUPERVISOR_INTERVAL_MS = 5_000

/** Recursive chain timers, one per connection with an active chain. */
const _chainTimer = new Map<string, ReturnType<typeof setTimeout>>()
/** Debounce timers for the on-change trigger, one per connection. */
const _onChangeTimer = new Map<string, ReturnType<typeof setTimeout>>()
/** Connection ids with a live recursive schedule chain (what the supervisor diffs against). */
const _activeChains = new Set<string>()

function stopConnectionChain(connId: string): void {
  _activeChains.delete(connId)
  const t = _chainTimer.get(connId)
  if (t) { clearTimeout(t); _chainTimer.delete(connId) }
  const ct = _onChangeTimer.get(connId)
  if (ct) { clearTimeout(ct); _onChangeTimer.delete(connId) }
}

/** Clear ALL in-memory state for a connection — timers plus status/error maps. Does NOT touch
 *  disk; file GC is the exclusive responsibility of `removeConnection`'s serialized write (see
 *  its docstring — a timer-driven GC would race the add path). */
function teardownConnection(connId: string): void {
  stopConnectionChain(connId)
  _running.delete(connId)
  _pendingTrigger.delete(connId)
  _lastSuccessAt.delete(connId)
  _pushErrKind.delete(connId)
  _authErrSince.delete(connId)
  _netErrStreak.delete(connId)
  _centralIntervalSec.delete(connId)
  _latencyMs.delete(connId)
  _centralCapabilities.delete(connId)
  _restrictedConn.delete(connId)
  _lastPushedPayloadHash.delete(connId)
  _suppressedStreak.delete(connId)
  _resyncProgress.delete(connId)
  _resyncNotified.delete(connId)
  _resumeForget.delete(connId)
}

function scheduleConnectionCycle(connId: string, delaySec: number): void {
  const existing = _chainTimer.get(connId)
  if (existing) clearTimeout(existing)
  // ±20% jitter on a restricted connection's periodic delay only: a perfectly regular cadence is
  // itself a timing signal an observer could correlate with activity inside the hidden repo
  // (§5.3.4). An unrestricted connection has nothing to hide and keeps its exact interval.
  const jitteredSec = _restrictedConn.get(connId)
    ? delaySec * (1 + (Math.random() * 0.4 - 0.2))
    : delaySec
  const t = setTimeout(() => { void runConnectionCycle(connId) }, Math.max(0, jitteredSec) * 1_000)
  t.unref?.()
  _chainTimer.set(connId, t)
}

/** Injectable for tests — `ctx`, when supplied, is used VERBATIM instead of calling the internal
 *  `getPushContext()`, which otherwise touches the real `~/.claude`/`~/.agentistics` (via
 *  `buildApiResponse()`/`loadConsolidated()`) unless a NEIGHBOURING test happens to have left a
 *  still-fresh fake context in the module-level cache — an accident a test must never depend on. */
interface RunPushCycleDeps {
  ctx?: PushCycleContext
  /** Injectable for tests that exercise an auth failure through the full cycle (including the
   *  retroactive-removal sequence's own `onRevoked` → `markAuthFailed`) — the default touches the
   *  developer's real `~/.agentistics/preferences.json`, which a test must never do. */
  updateTeamConfig?: typeof updateTeamConfig
}

/** The bounded (semaphore-limited) network portion of one connection's cycle: learn the
 *  central's policy, reconcile sync state, then push against the SHARED context. Returns the
 *  next interval (seconds) this connection should wait before its next cycle. */
async function runConnectionPushCycle(conn: TeamConnection, deps: RunPushCycleDeps = {}): Promise<number> {
  const release = await acquireSlot()
  try {
    const endpoint = conn.endpoint.replace(/\/+$/, '')
    const policy = await fetchCentralPolicy(endpoint)
    // The central is the sole authority on the interval; this connection follows it (honoring
    // express intervals below the normal 15s floor). No connection-side override.
    const nextIntervalSec = clampPushInterval(policy.intervalSec, PUSH_INTERVAL.EXPRESS_MIN_SEC)
    _centralIntervalSec.set(conn.id, nextIntervalSec)
    // Cache the round-trip for GET /api/team/status (team-connections.ts), which must never do
    // its own blocking probe. Only a SUCCESSFUL fetch updates it — a failed/timed-out attempt
    // leaves the last known good value in place rather than overwriting it with noise. The
    // capability list follows the exact same rule (policy.latencyMs is non-null iff the fetch
    // actually succeeded) — a flaky/old central must not erase a previously learned
    // `forget.sessions` and disable the rules editor over one network blip.
    if (policy.latencyMs != null) {
      _latencyMs.set(conn.id, policy.latencyMs)
      _centralCapabilities.set(conn.id, policy.capabilities)
    }
    const ctx = deps.ctx ?? await getPushContext()
    // Rules and shrink are LOCAL facts and are evaluated unconditionally, before anything that
    // depends on the central's identity. `reconcileSyncState` opens with `if (!instanceId) return`
    // and `fetchCentralPolicy` reports a null instanceId for every non-OK response, parse failure,
    // timeout and every AGENTISTICS_INGEST_ONLY central (which 404s /api/team/policy by
    // construction) — so putting the rules check behind that guard would let a user on an older or
    // flaky central block a repo, see a green pill, and have the removal never run (R18).
    const rulesPlan = await reconcileRulesFor(conn, ctx)

    // A journal left open by a killed process is unioned into this cycle's plan — see
    // `replayForgetJournals`. The union can only ever ADD ids the central was already promised.
    const resume = _resumeForget.get(conn.id)
    const forgetIds = resume ? unionIds(rulesPlan.forgetIds, resume.ids) : rulesPlan.forgetIds
    const forgetRuns = resume ? unionIds(rulesPlan.forgetRuns, resume.runIds) : rulesPlan.forgetRuns
    const needsForget = forgetIds.length > 0 || forgetRuns.length > 0

    // Step 4 of §6.1: the sig reconcile plus the push that replaces the aggregate the delete just
    // invalidated, run INSIDE the sequence so `memberStats` is never absent (§6.2) and so the
    // journal can stay open until the cache actually lands (§6.3).
    let didPush = false
    const syncAndPush = async (): Promise<boolean> => {
      didPush = true
      await reconcileSyncState(conn.id, endpoint, conn.token ?? '', policy.instanceId)
      // `rulesPlan.next.sealed`, never `{}`: the ledger's ONLY consumer is the split cache's
      // subtraction against `real`'s rollup rows. A push built with an empty ledger emits a
      // sealed day's row VERBATIM — the blocked repository's sessions, messages, tokens and hour
      // buckets — and a sealed day cannot be re-derived once its sessions age out of the store.
      const res = await pushOnceDetailed({ ...conn, endpoint }, ctx, { sealed: rulesPlan.next.sealed, updateTeamConfig: deps.updateTeamConfig })
      return !res.error
    }

    // Set when the forget sequence stopped because the central rejected the token (401/403) —
    // the connection was just marked auth-failed (never removed), and NOTHING further may be
    // attempted against it for the rest of this cycle: not the fallback push below, which would
    // otherwise immediately hit the same still-rejecting central with the full payload using this
    // cycle's now-stale `conn` snapshot (the mark itself is only visible from the NEXT cycle's
    // fresh `readPreferences()` read).
    let authRejectedThisCycle = false

    if (needsForget) {
      // The whole sequence runs under this connection's push lock (`_running`, taken by
      // `runConnectionCycle`) with `_pendingTrigger` deferral, so a debounced push cannot land
      // after the delete and re-insert exactly what was removed (R27).
      // Gated on `forgetIds`, not on `needsForget`: a plan naming only workflow runs cannot be
      // carried out at all (see `runForgetSequence`), so announcing a removal for it would promise
      // something that is about to be refused.
      if (forgetIds.length > 0 && connectionCanForget(conn.id) && !_resyncNotified.has(conn.id)) {
        _resyncNotified.add(conn.id)
        _notify({ type: 'info', code: 'member.resync_started', meta: notifyMeta(conn, { count: forgetIds.length }) })
      }
      _resyncProgress.set(conn.id, { phase: 'forget', done: 0, total: forgetIds.length })
      const outcome = await runForgetSequence(
        { ...conn, endpoint },
        { forgetIds, forgetRuns, rulesHash: rulesPlan.next.rulesHash },
        {
          canForget: connectionCanForget,
          // Mark, never remove — see the class docstring in team-forget-client.ts. A rejection
          // here is a real, confirmed one (the request already happened), so no sustain window.
          onRevoked: async () => { await markAuthFailed({ ...conn, endpoint }, { updateTeamConfig: deps.updateTeamConfig }) },
          onProgress: p => { _resyncProgress.set(conn.id, p) },
          pushRebuiltCache: syncAndPush,
        },
      )
      _resyncProgress.delete(conn.id)
      if (outcome.ok) {
        _resumeForget.delete(conn.id)
        // ONLY now: the rules hash is what suppresses re-detection, so persisting it after a
        // failed removal would make the machine stop asking while the central still holds the
        // data. A failed cycle simply re-derives the same plan from the same inputs next time.
        await saveRulesState(conn.id, rulesPlan.next)
        if (_resyncNotified.delete(conn.id)) {
          _notify({ type: 'success', code: 'member.resync_done', meta: notifyMeta(conn, { count: forgetIds.length }) })
        }
      } else {
        console.warn(`[team-uploader] ${conn.id} retroactive removal incomplete: ${outcome.error ?? 'unknown error'}`)
        authRejectedThisCycle = !!outcome.authRejected
      }
    } else {
      await saveRulesState(conn.id, rulesPlan.next)
    }

    if (!didPush && !authRejectedThisCycle) {
      // §5.5b: `reconcileSyncState` CLEARS the sent-state on a signature change, and the
      // sent-state is the only record of what this connection pushed. Running it after a removal
      // that did not complete would strand every already-pushed denied session on the central
      // with no way left to name it — a token rotation changes the sig without deleting anything
      // there. Skipping it only defers a full re-push, which is recoverable; the removal is
      // retried (and the reconcile allowed) on the next cycle.
      if (!needsForget) {
        await reconcileSyncState(conn.id, endpoint, conn.token ?? '', policy.instanceId)
      }
      // The push itself always runs: a central too old to forget, or one that is momentarily
      // down, must not stop this connection pushing altogether. Same ledger as the sequence's own
      // push above — this is the branch a machine with nothing to forget takes EVERY cycle, so an
      // empty ledger here is the common case of the leak, not the rare one.
      await pushOnceDetailed({ ...conn, endpoint }, ctx, { sealed: rulesPlan.next.sealed, updateTeamConfig: deps.updateTeamConfig })
    }
    return nextIntervalSec
  } finally {
    release()
  }
}

let _migrated = false

/** Injectable for tests — the defaults touch the developer's real preferences file and run the
 *  real (marker-guarded, so normally cheap) state migration; a test must never do either. `ctx`
 *  and `updateTeamConfig` are threaded straight through to `runConnectionPushCycle` (see
 *  `RunPushCycleDeps`). */
interface RunCycleDeps {
  readPreferences?: typeof readPreferences
  migrateTeamStateOnce?: () => Promise<void>
  ctx?: PushCycleContext
  updateTeamConfig?: typeof updateTeamConfig
}

/**
 * Run one connection's guarded cycle: skip (and remember) if a cycle is already running for
 * this connection — a mid-cycle trigger is DEFERRED via `_pendingTrigger`, never dropped. Always
 * reschedules itself while the chain is active, so this single function is both the periodic
 * timer body and the on-change trigger's target. Exported for tests (see `RunCycleDeps`).
 */
export async function runConnectionCycle(connId: string, deps: RunCycleDeps = {}): Promise<void> {
  if (_running.has(connId)) {
    _pendingTrigger.add(connId)
    return
  }
  _running.add(connId)
  let nextIntervalSec: number = PUSH_INTERVAL.DEFAULT_SEC
  try {
    if (!_migrated) {
      _migrated = true
      // A machine that never boots the full server (member-only) still needs the once-per-
      // install move to the per-connection state layout — run it before the first push.
      const _migrateTeamStateOnce = deps.migrateTeamStateOnce ?? migrateTeamStateOnce
      await _migrateTeamStateOnce().catch(err =>
        console.warn('[team-migrate] state migration failed (will retry next boot):', err instanceof Error ? err.message : String(err)))
    }
    const _readPreferences = deps.readPreferences ?? readPreferences
    const prefs = await _readPreferences()
    const conn = (prefs.team?.connections ?? []).find(c => c.id === connId)
    if (!conn) {
      // Removed between scheduling and firing — the supervisor will also catch this, but stop
      // right away rather than waiting for its next tick.
      stopConnectionChain(connId)
      return
    }
    nextIntervalSec = await runConnectionPushCycle(conn, { ctx: deps.ctx, updateTeamConfig: deps.updateTeamConfig })
  } catch (err) {
    console.warn(`[team-uploader] cycle error for ${connId}:`, err instanceof Error ? err.message : String(err))
  } finally {
    _running.delete(connId)
    const hadPending = _pendingTrigger.delete(connId)
    if (_activeChains.has(connId)) {
      // A change arrived mid-cycle — run again soon instead of waiting a full interval.
      scheduleConnectionCycle(connId, hadPending ? 1 : nextIntervalSec)
    }
  }
}

function startConnectionChain(conn: TeamConnection): void {
  if (_activeChains.has(conn.id)) return
  _activeChains.add(conn.id)
  // First cycle ~800 ms after the chain starts — short enough that a connection added while the
  // server is already running (or a member that starts already configured) shows up on its
  // central almost immediately, then the cadence becomes dynamic from that central's policy.
  scheduleConnectionCycle(conn.id, 0.8)
}

/**
 * Diff `preferences.team.connections` against the live timer map: start a chain for a new
 * connection id, stop (and clear in-memory state for) a chain whose id is no longer present.
 * This is what makes adding/removing a central in the browser take effect without a restart.
 *
 * Deliberately does NOT GC state files for a removed id — that happens only inside
 * `removeConnection`'s serialized preferences write, never from a timer, or a GC here could race
 * a concurrent "add connection" write that reintroduces the same id.
 */
async function supervisorTick(deps: { readPreferences?: typeof readPreferences } = {}): Promise<void> {
  try {
    const _readPreferences = deps.readPreferences ?? readPreferences
    const prefs = await _readPreferences()
    const conns = prefs.team?.connections ?? []
    const liveIds = new Set(conns.map(c => c.id))

    for (const c of conns) {
      // Seeded from CONFIG, not only from a completed push: the gap between a denylist being
      // declared (or the process starting) and this connection's first push would otherwise
      // still fan out on every local change and use an unjittered cadence — exactly the moment a
      // user has just blocked a repo, which is when the timing leak in §5.3.4 matters most. This
      // tick runs every ~5s, so a freshly-declared restriction is honored well before any push.
      _restrictedConn.set(c.id, sourcesRestrict(c.shareMode, c.sources))
      if (!_activeChains.has(c.id)) startConnectionChain(c)
    }
    for (const id of Array.from(_activeChains)) {
      if (!liveIds.has(id)) teardownConnection(id)
    }
  } catch (err) {
    console.warn('[team-uploader] supervisor tick error:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Reconcile the live timer map against `preferences.team.connections` RIGHT NOW, instead of
 * waiting up to `SUPERVISOR_INTERVAL_MS`. Call this the moment a connection is added, rotated or
 * renamed (team-connections.ts) so its push chain starts within about a second rather than after
 * the next tick. Safe to call before `startUploader()` — `supervisorTick` only reads preferences
 * and starts/stops per-connection chains; it does not depend on the `started` flag. Never throws.
 *
 * `deps.readPreferences` is injectable for tests — the default touches the developer's real
 * ~/.agentistics/preferences.json, which a test must never do.
 */
export async function reconcileUploaderNow(deps: { readPreferences?: typeof readPreferences } = {}): Promise<void> {
  await supervisorTick(deps)
}

let started = false
let _supervisorTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the per-connection uploader. Idempotent — calling more than once is a no-op.
 * A supervisor tick runs every ~5s, diffing `preferences.team.connections` against the live
 * timer map (see `supervisorTick`), so connections added/removed at runtime take effect without
 * a server restart. Each connection then runs its own independent recursive cycle (see
 * `runConnectionCycle`), with actual network I/O bounded to at most 2 connections at once.
 */
export function startUploader(): void {
  if (started) return
  started = true
  // Before anything pushes: a removal journal left open by a killed process is loaded and handed
  // to the owning connection's first cycle (§6.1 step d, R5).
  void replayForgetJournals()
  void supervisorTick() // start any already-configured connections immediately, not after 5s
  _supervisorTimer = setInterval(() => { void supervisorTick() }, SUPERVISOR_INTERVAL_MS)
  _supervisorTimer.unref?.()
}

/** Test-only setter for `_restrictedConn` — lets a test exercise the scheduling defenses in
 *  §5.3.4 (fan-out suppression, jitter) without running a full push cycle against a real
 *  connection. Never called from production code. */
export function __setRestrictedForTests(connId: string, restricted: boolean): void {
  _restrictedConn.set(connId, restricted)
}

/** Test-only accessor — whether an on-change push is currently pending for this connection.
 *  Never called from production code. */
export function __hasPendingOnChangeForTests(connId: string): boolean {
  return _onChangeTimer.has(connId)
}

/** Test-only cleanup — clears a pending on-change timer without letting it fire (which would
 *  call `runConnectionCycle` against the real `readPreferences()`). Never called from production
 *  code. */
export function __clearOnChangeTimerForTests(connId: string): void {
  const t = _onChangeTimer.get(connId)
  if (t) { clearTimeout(t); _onChangeTimer.delete(connId) }
}

/** Test-only cleanup — clears ALL in-memory state (chains, timers, status/error maps) for a
 *  connection, same as `teardownConnection` (no disk IO). Lets a test that started a chain via
 *  `reconcileUploaderNow`/`supervisorTick` (which also schedules a real periodic timer) clean up
 *  before that timer could ever fire against a fake/nonexistent connection. Never called from
 *  production code. */
export function __teardownConnectionForTests(connId: string): void {
  teardownConnection(connId)
}

/** Exported so a test can exercise the fan-out-suppression rule directly (§5.3.4) without
 *  driving the whole `started`/`_activeChains`/`notifyDataChanged` machinery, which would
 *  otherwise require a real (or `startUploader`-spawned) supervisor. Every production call site
 *  remains internal to this module (`notifyDataChanged`). */
export function scheduleOnChangeTrigger(connId: string): void {
  // A restricted connection does not fan out on a local change at all: doing so would turn work
  // inside a denied repo into a ~2s-resolution timestamped heartbeat on the central the moment it
  // happens, which is exactly the activity signal §5.3.4 exists to withhold. Its periodic cycle
  // (jittered above) is the only thing that ever pushes for it.
  if (_restrictedConn.get(connId)) return
  if (_onChangeTimer.has(connId)) return // already scheduled — coalesce a burst of file events
  const floorMs = (_centralIntervalSec.get(connId) ?? PUSH_INTERVAL.DEFAULT_SEC) * 1_000
  const lastSuccess = _lastSuccessAt.get(connId) ?? null
  const sinceLast = lastSuccess ? Date.now() - lastSuccess : Infinity
  const delay = Math.max(ON_CHANGE_DEBOUNCE_MS, floorMs - sinceLast)
  const t = setTimeout(() => {
    _onChangeTimer.delete(connId)
    void runConnectionCycle(connId)
  }, delay)
  t.unref?.()
  _onChangeTimer.set(connId, t)
}

/**
 * Signal that local data changed (called by the file watcher). Schedules a DEBOUNCED push for
 * EVERY connection with an active chain: coalesces a burst of file events into one push per
 * connection, and never pushes a given connection sooner than ITS OWN central's interval since
 * its last successful push. No-op until the uploader has started.
 *
 * ALSO invalidates the shared push-cycle context (`_cachedContext`). Without this, a change that
 * lands while a cached context is still within its TTL window (up to `min(intervals)/2`, e.g.
 * 15s by default) would be invisible to the very push this function schedules: `getPushContext`
 * would keep serving the pre-change snapshot, `selectDeltas` would find no delta against it, and
 * the change would silently wait for the NEXT full interval anyway — the same latency as the
 * dropped-event bug this function's deferral (`_pendingTrigger`) exists to fix, reached by a
 * different route. The single-flight promise in `getPushContext` already prevents the rebuild
 * stampede the TTL exists to avoid, so invalidating on every change is safe.
 */
export function notifyDataChanged(): void {
  invalidatePushContext()
  if (!started) return
  for (const connId of _activeChains) scheduleOnChangeTrigger(connId)
}

/**
 * Kick an immediate push cycle out of band (e.g. right after `member connect`), without waiting
 * for the next timer tick. When `connId` is given, only that connection is pushed; omitted means
 * every configured connection. The concurrency cap (`acquireSlot`) still applies, so this is safe
 * to call even with many connections. No-op for connections not yet configured.
 */
export async function pushNow(connId?: string): Promise<void> {
  const prefs = await readPreferences()
  const conns = prefs.team?.connections ?? []
  const targets = connId ? conns.filter(c => c.id === connId) : conns
  await Promise.all(targets.map(c => runConnectionCycle(c.id)))
}

// ---------------------------------------------------------------------------
// push-now route handler
// ---------------------------------------------------------------------------

interface PushNowResult {
  connectionId: string
  count: number
  error?: string
}

interface PushNowResponse {
  ok: boolean
  results: PushNowResult[]
  /** Sum across `results` — kept for older clients that only read this field. */
  count: number
  /** The first error across `results`, if any — kept for older clients. */
  error?: string
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/**
 * Push one connection against `ctx`, through the SAME `_running` guard and concurrency cap the
 * periodic cycle uses — an explicit push-now (this function's only caller) must never race a
 * periodic/on-change cycle already in flight for the same connection into a lost sent-state
 * update (two concurrent `saveSentState` calls for the same connId, last write wins, dropping
 * whichever batch's advance lost the race). If a cycle is already running for this connection,
 * this defers (matching `runConnectionCycle`'s `_pendingTrigger`) and returns a zero result
 * immediately rather than blocking the HTTP response — the already-running cycle picks up any
 * newer data on its own.
 *
 * The seal is DERIVED here and deliberately NOT persisted — the one asymmetry between this path
 * and the periodic cycle.
 *
 * Why derived and not simply loaded: the persisted `sealed` only covers days that had already
 * crossed Claude's watermark by the last periodic cycle. A day that crossed since then is still
 * sitting in `pending`, so a "Push now" landing in that window would emit that day's rollup row
 * unreduced — the blocked repository's volume, on the wire. It is bounded by one push interval,
 * but it is a leak in a privacy control, and `computeLedger` closes it for the cost of one pure
 * call over data the context already holds.
 *
 * Why NOT persisted: `advanceSeal` seals out of `prev.pending` and its caller contract belongs to
 * the periodic cycle, which owns the cadence. Writing the result here would make the ledger a
 * function of how often a human presses a button, and would also advance `pending` past a
 * measurement the cycle has not taken. `reconcileRulesFor` stays the only writer — and this path
 * deliberately never runs it, so a manual push can never trigger a removal sequence out of band.
 *
 * Exported for tests only; `handlePushNow` is the sole production caller.
 */
export async function guardedManualPush(conn: TeamConnection, ctx: PushCycleContext): Promise<PushOnceResult> {
  if (_running.has(conn.id)) {
    _pendingTrigger.add(conn.id)
    return { count: 0 }
  }
  _running.add(conn.id)
  const release = await acquireSlot()
  try {
    const prev = await loadRulesState(conn.id)
    // The SAME pure helper the periodic cycle's `planRulesReconcile` uses — two callers deriving
    // seals two different ways is the class of drift this whole area has been fixing.
    const { sealed } = computeLedger({
      liveSessions: ctx.liveSessions,
      rules: shareRulesOf(conn.shareMode, conn.sources),
      index: ctx.index,
      real: ctx.realStatsCache,
      prev,
    })
    return await pushOnceDetailed(conn, ctx, { sealed })
  } finally {
    release()
    _running.delete(conn.id)
  }
}

/**
 * Server-side handler for POST /api/team/push-now — body `{ connectionId? }` (also accepts the
 * older `?connId=` query param). Reads current preferences, pushes every connection (or just the
 * one named) via `guardedManualPush` against one shared context, and returns
 * `{ ok, results: [{connectionId, count, error?}], count }` — `count` is the sum across
 * `results`, kept for clients that only read that field. Always returns 200.
 */
export async function handlePushNow(req: Request): Promise<Response> {
  const prefs = await readPreferences()
  const conns = prefs.team?.connections ?? []

  if (conns.length === 0) {
    return jsonResponse({ ok: false, results: [], count: 0, error: 'Not in member mode' } satisfies PushNowResponse)
  }

  // The body is optional (an empty/absent body means "push every connection"), so a parse
  // failure is not itself an error — only an explicitly-named, unknown connectionId is.
  let connId: string | undefined
  const parsed = await readJsonLimited<{ connectionId?: unknown }>(req, LIMITS.bodyBytes)
  if (parsed.ok && typeof parsed.value?.connectionId === 'string') connId = parsed.value.connectionId
  if (!connId) {
    try { connId = new URL(req.url).searchParams.get('connId') ?? undefined } catch { /* ignore */ }
  }
  const targets = connId ? conns.filter(c => c.id === connId) : conns
  if (targets.length === 0) {
    return jsonResponse({ ok: false, results: [], count: 0, error: 'unknown connection' } satisfies PushNowResponse)
  }

  const ctx = await getPushContext()
  const results: PushNowResult[] = []
  // Sequential — this is an explicit, one-off user action (not the periodic cycle), so a plain
  // loop is simplest; `guardedManualPush` itself still applies the cap (and the running-guard)
  // per connection.
  for (const conn of targets) {
    const { count, error } = await guardedManualPush(conn, ctx)
    results.push({ connectionId: conn.id, count, ...(error ? { error } : {}) })
  }

  const count = results.reduce((sum, r) => sum + r.count, 0)
  const firstError = results.find(r => r.error)?.error
  const result: PushNowResponse = {
    ok: !firstError,
    results,
    count,
    ...(firstError ? { error: firstError } : {}),
  }
  return jsonResponse(result)
}

// ---------------------------------------------------------------------------
// test-connection route handler
// ---------------------------------------------------------------------------

interface TestConnectionBody {
  endpoint: string
  token: string
}

interface TestConnectionResult {
  ok: boolean
  status: number
  error?: string
  user?: string
  org?: string
  machineName?: string
  email?: string
  teamId?: string
  team?: string
}

/**
 * Server-side handler for POST /api/team/test-connection.
 * Sends an empty ingest to the given endpoint and reports success/failure.
 * The bearer token never leaves the server process.
 */
export async function handleTeamTestConnection(req: Request): Promise<Response> {
  let body: TestConnectionBody
  try {
    body = await req.json() as TestConnectionBody
  } catch {
    const result: TestConnectionResult = { ok: false, status: 400, error: 'Invalid JSON body' }
    return jsonResponse(result)
  }

  const { endpoint, token } = body

  if (!endpoint) {
    const result: TestConnectionResult = { ok: false, status: 0, error: 'endpoint is required' }
    return jsonResponse(result)
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  let result: TestConnectionResult
  try {
    // Ping the ingest endpoint with an empty sessions array to verify connectivity.
    // org must be non-empty to pass the central's parseIngestBody validation; the value is
    // irrelevant here (no sessions are stored on a ping), so send the default namespace.
    const res = await fetch(`${endpoint}/api/team/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ org: 'default', user: '', sessions: [] }),
      signal: AbortSignal.timeout(10_000),
    })

    if (res.ok) {
      let responseOk = true
      try {
        const json = await res.json() as { ok?: boolean }
        responseOk = json.ok === true
      } catch {
        // If we can't parse JSON, treat a 2xx as ok
      }
      result = responseOk
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `Unexpected response from central` }
    } else {
      let errorText = `HTTP ${res.status}`
      try {
        const json = await res.json() as { error?: string }
        if (json.error) errorText = json.error
      } catch { /* ignore */ }
      result = { ok: false, status: res.status, error: errorText }
    }
  } catch (err) {
    result = {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'Network error',
    }
  }

  // On success, resolve the member's identity from the central via whoami.
  // The token stays server-side; plaintext is never logged.
  if (result.ok && token) {
    try {
      const whoamiRes = await fetch(`${endpoint}/api/team/whoami`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (whoamiRes.ok) {
        const whoamiJson = await whoamiRes.json() as {
          ok?: boolean
          user?: string
          org?: string
          machineName?: string
          email?: string
          teamId?: string
          team?: string
        }
        if (whoamiJson.ok && typeof whoamiJson.user === 'string') {
          result = {
            ...result,
            user: whoamiJson.user,
            org: whoamiJson.org,
            ...(typeof whoamiJson.machineName === 'string' && { machineName: whoamiJson.machineName }),
            ...(typeof whoamiJson.email === 'string' && { email: whoamiJson.email }),
            ...(typeof whoamiJson.teamId === 'string' && { teamId: whoamiJson.teamId }),
            ...(typeof whoamiJson.team === 'string' && { team: whoamiJson.team }),
          }
        }
      }
    } catch { /* whoami is best-effort; a failed lookup does not fail the connection test */ }
  }

  return jsonResponse(result)
}

/**
 * Member-side proxy for POST /api/team/leave-central, KEPT for an old cached SPA that still
 * PUTs a full flat `team: solo` object after calling this (the current frontend removes a
 * connection through DELETE /api/team/connections/:id instead — see team-connections.ts). The
 * request body (`{ endpoint, token, ... }`, unchanged since the single-connection era) carries no
 * connection id, so it is mapped to one here by matching endpoint or token. Calls the central's
 * /api/team/leave with the given token so the central removes this member's data, then removes
 * ONLY the matching connection (and its state files) via `removeConnection` — never a global
 * reset, which with N connections would hand an UNRELATED central a spurious full re-push. Keeps
 * the token server-side; never throws.
 */
/**
 * Map the legacy `{ endpoint, token }` leave body onto ONE stored connection. Pure.
 *
 * The endpoint half goes through `normalizeEndpointKey` — the shared identity rule every other
 * comparison on this branch already uses — never a raw string compare. This route exists purely for
 * a CACHED SPA, and a cached tab posting `https://Central.example.com` against a stored
 * `https://central.example.com` matched nothing; the token half could not save it either, because
 * `redactPreferences` blanks `team.token` on the way out, so such a tab has no token to send. The
 * route then answered success while removing nothing locally, leaving the connection happily
 * pushing to a central that had just deleted its data.
 */
export function matchConnectionForLeave(
  connections: readonly TeamConnection[],
  endpoint: string,
  token: string,
): TeamConnection | undefined {
  const wanted = normalizeEndpointKey(endpoint)
  return connections.find(c =>
    (wanted !== '' && normalizeEndpointKey(c.endpoint) === wanted) || (token !== '' && c.token === token))
}

export async function handleLeaveCentral(req: Request): Promise<Response> {
  let body: { endpoint?: unknown; token?: unknown; org?: unknown; user?: unknown } = {}
  try { body = (await req.json()) as typeof body } catch { /* empty ok */ }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.replace(/\/+$/, '') : ''
  const token = typeof body.token === 'string' ? body.token : ''
  const org = typeof body.org === 'string' && body.org ? body.org : 'default'
  const user = typeof body.user === 'string' ? body.user : ''

  if (!endpoint) {
    return jsonResponse({ ok: false, error: 'endpoint is required' })
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  try {
    const res = await fetch(`${endpoint}/api/team/leave`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ org, user }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => ({}))) as { deleted?: number; error?: string }
    // Leaving deletes this member's data on the central. Remove ONLY the matching connection
    // locally, so a future rejoin (even same token+central) re-pushes everything instead of
    // assuming the central still has it — and so an unrelated connection is never touched.
    try {
      const prefs = await readPreferences()
      const conn = matchConnectionForLeave(prefs.team?.connections ?? [], endpoint, token)
      if (conn) await removeConnection(conn.id, 'manual')
    } catch { /* best-effort — the connection may already be gone from preferences */ }
    return jsonResponse({ ok: res.ok, deleted: data.deleted, error: res.ok ? undefined : (data.error ?? `HTTP ${res.status}`) })
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Network error' })
  }
}
