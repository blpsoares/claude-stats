// team-agent.ts — central-side WebSocket agent registry (Phase 7)
//
// Maintains a live map of machine → connected ServerWebSocket sockets, and
// tracks presence/liveness (ping/pong RTT) for the team dashboard. On-demand
// chat retrieval over this channel has been removed — the central never
// requests or views member chat (see GET /api/team/session-chat, which is
// now a 410 in index.ts).
//
// Keyed by `memberId` (the token hash), NOT by the resolved `user` display name. `memberId` is
// the machine's own stable identity — the same key sessions and stats already use — and it is
// unique per machine by construction. `user` is not: two ownerless machines both carry
// `user: ''` (see team-tokens.ts `machineUserFor`), and even for an owned machine `user` is a
// mutable display name shared across every machine of that owner. Keying the live registry by
// `user` made two machines share ONE presence signal whenever their `user` matched — for a real
// person's fleet that was the intended fold (see `foldPresenceByUser` in team-presence.ts, which
// still folds machine-level presence up to a per-person view on purpose), but for two unrelated
// ownerless machines it silently merged their online/offline state: one connecting made the
// other read online too. `memberId` never collides, so the registry itself can no longer make
// that mistake — any folding by `user` now happens strictly downstream, over already-correct
// per-machine facts.

import type { ServerWebSocket } from 'bun'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data attached to each server-side WebSocket via server.upgrade(req, { data }) */
export interface AgentSocketData {
  user: string
  /** The MACHINE behind this socket (token hash) — its stable identity, and the key this whole
   *  registry is organized by. `team-live` also keys by this and never by `user`. */
  memberId: string
  isAgent?: boolean
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** memberId (machine) → set of connected sockets. */
const agentSockets = new Map<string, Set<ServerWebSocket<AgentSocketData>>>()

/** Machines that have EVER held a live socket this run — so once a machine's WS drops we can
 *  trust that signal (offline after a short grace) instead of waiting out the heartbeat. */
const everHadSocket = new Set<string>()
/** memberId → ms epoch when its LAST socket dropped (cleared on reconnect). */
const lastDropAt = new Map<string, number>()
/** memberId → ms epoch of the last "member connected" notification, to suppress reconnect spam. */
const lastConnectNotifyAt = new Map<string, number>()
/** Don't re-announce the same machine connecting more than once per this window. */
const CONNECT_NOTIFY_THROTTLE_MS = 5 * 60_000

/** Grace after a socket drops before the machine counts as offline — absorbs the brief WS
 *  reconnect gap (backoff starts at 1s) without flickering, while still flipping fast on a kill. */
const SOCKET_GRACE_MS = 8_000

// ---------------------------------------------------------------------------
// Liveness + latency — ping each socket periodically; a socket that misses
// MAX_MISSED_PONGS consecutive pings is considered dead and force-closed, so a
// hard-killed machine (no TCP FIN) still transitions to offline promptly.
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 10_000
const MAX_MISSED_PONGS = 2

interface SockState {
  latencyMs: number | null
  awaitingPong: boolean
  pingSentAt: number
  missed: number
}

const sockState = new Map<ServerWebSocket<AgentSocketData>, SockState>()
let pingTimer: ReturnType<typeof setInterval> | null = null
/** Optional hook (wired by index.ts) fired when the online set changes, for live UI updates. */
let onPresenceChange: (() => void) | null = null

export function setPresenceChangeHook(fn: () => void): void {
  onPresenceChange = fn
}

function ensurePingLoop(): void {
  if (pingTimer) return
  pingTimer = setInterval(() => {
    for (const [ws, st] of sockState) {
      if (st.awaitingPong) {
        st.missed += 1
        if (st.missed >= MAX_MISSED_PONGS) {
          try { ws.close() } catch { /* close() triggers the close handler → unregisterAgent */ }
          continue
        }
      }
      st.awaitingPong = true
      st.pingSentAt = Date.now()
      try { ws.ping() } catch { /* dead socket; next tick escalates via missed count */ }
    }
  }, PING_INTERVAL_MS)
}

function stopPingLoop(): void {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle hooks (called from index.ts websocket: {} handler)
// ---------------------------------------------------------------------------

export function registerAgent(ws: ServerWebSocket<AgentSocketData>): void {
  const { user, memberId } = ws.data
  // Was this machine offline (no live socket) before this connection?
  const wasOffline = !agentSockets.has(memberId) || agentSockets.get(memberId)!.size === 0
  if (!agentSockets.has(memberId)) agentSockets.set(memberId, new Set())
  agentSockets.get(memberId)!.add(ws)
  sockState.set(ws, { latencyMs: null, awaitingPong: false, pingSentAt: 0, missed: 0 })
  everHadSocket.add(memberId)
  lastDropAt.delete(memberId) // reconnected → clear the drop marker
  ensurePingLoop()
  onPresenceChange?.()

  // Announce a genuine connect on the central (throttled so a flapping reconnect never spams).
  // The throttle key is the machine (memberId), not `user`: two machines sharing a `user` (a
  // real person's fleet, or two ownerless machines sharing `''`) must not suppress each other's
  // connect notification.
  if (wasOffline) {
    const now = Date.now()
    if (now - (lastConnectNotifyAt.get(memberId) ?? 0) > CONNECT_NOTIFY_THROTTLE_MS) {
      lastConnectNotifyAt.set(memberId, now)
      void import('./sse').then(m => m.broadcastNotification({
        type: 'info', code: 'central.member_connected', meta: { user },
      })).catch(() => { /* best-effort */ })
    }
  }
}

export function unregisterAgent(ws: ServerWebSocket<AgentSocketData>): void {
  const { memberId } = ws.data
  sockState.delete(ws)
  const sockets = agentSockets.get(memberId)
  if (!sockets) { if (sockState.size === 0) stopPingLoop(); return }
  sockets.delete(ws)
  // Every socket in this set already belongs to THIS machine (the map is keyed by memberId), so
  // an empty set means nothing on it is open any more — drop its live report now instead of
  // leaving stale rows on the dashboard until the TTL expires.
  if (sockets.size === 0) {
    void import('./team-live').then(m => m.clearMemberLive(memberId)).catch(() => { /* best-effort */ })
    // Same lifetime, same reason: a consent is a statement the machine is making NOW. Keeping the
    // last known answer would have the central saying "this machine allows session management"
    // about a laptop that has been shut for a week.
    void import('./machine-consent').then(m => m.forgetMachineConsent(memberId)).catch(() => { /* best-effort */ })
    // An open fleet question can no longer be answered. Settling it now spares its asker the full
    // timeout for an answer that cannot come.
    void import('./machine-fleet-relay').then(m => m.abandonMachineFleet(memberId)).catch(() => { /* best-effort */ })
    agentSockets.delete(memberId)
    // Record the drop; after the grace, the machine counts as offline. Fire a presence update
    // AT grace-expiry so the dashboard flips without waiting for its next poll.
    lastDropAt.set(memberId, Date.now())
    setTimeout(() => { if (!agentSockets.has(memberId)) onPresenceChange?.() }, SOCKET_GRACE_MS + 250)
  }
  if (sockState.size === 0) stopPingLoop()
  onPresenceChange?.()
}

/** Called from the websocket `pong` handler when a member answers our ping. */
export function onAgentPong(ws: ServerWebSocket<AgentSocketData>): void {
  const st = sockState.get(ws)
  if (!st) return
  if (st.awaitingPong) st.latencyMs = Date.now() - st.pingSentAt
  st.awaitingPong = false
  st.missed = 0
}

export interface PresenceSignal {
  /** true when the machine has ≥1 live socket right now. */
  online: boolean
  /** best (lowest) observed WS latency in ms, or null if no live socket / no ping yet. */
  latencyMs: number | null
  /** true when the machine has held a live socket this run (its WS is the authoritative signal). */
  everHadSocket: boolean
  /** whether the machine is within the reconnect grace after its last socket dropped. */
  inDropGrace: boolean
}

/**
 * Per-machine socket presence signals, keyed by `memberId`. Includes machines that are
 * connected now AND those that have disconnected (so team-presence can decide offline vs
 * a heartbeat fallback). `now` lets the caller share one clock across the snapshot.
 */
export function getPresenceSignals(now = Date.now()): Map<string, PresenceSignal> {
  const out = new Map<string, PresenceSignal>()
  const ids = new Set<string>([...agentSockets.keys(), ...everHadSocket])
  for (const id of ids) {
    const socks = agentSockets.get(id)
    const online = !!socks && socks.size > 0
    let latency: number | null = null
    if (online) {
      for (const ws of socks!) {
        const st = sockState.get(ws)
        if (st?.latencyMs != null) latency = latency == null ? st.latencyMs : Math.min(latency, st.latencyMs)
      }
    }
    const dropAt = lastDropAt.get(id)
    out.set(id, {
      online,
      latencyMs: latency,
      everHadSocket: everHadSocket.has(id),
      inDropGrace: !online && dropAt != null && now - dropAt <= SOCKET_GRACE_MS,
    })
  }
  return out
}

/**
 * Called when a member sends a WebSocket message to the central. On-demand
 * chat retrieval (the former 'chat-result' message) has been removed — the
 * central no longer requests or accepts chat content over this channel.
 * The member→central types are exactly three, and none of them carries chat: 'live-sessions' (what
 * is open) and 'remote-consent' (what this machine permits a central to do with its sessions) are
 * unsolicited statements about the machine that sent them; 'fleet-reply' is the ONLY answer to a
 * question, matched by rid against one in-flight request. Anything else is dropped.
 */
export function onAgentMessage(
  ws: ServerWebSocket<AgentSocketData>,
  raw: string | Buffer,
): void {
  // 'live-sessions' — the member's own open-assistant snapshot, which the central cannot detect
  // itself (it reads /proc, and member processes are not on this machine). Metrics only: session
  // ids and the cwd of a not-yet-persisted process, never chat. Rejected wholesale if malformed,
  // so a bad frame can never poison the panel.
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8')
    if (!text) return
    const msg = JSON.parse(text) as {
      type?: string; sessionIds?: unknown; processes?: unknown; sessionActivities?: unknown
      sessions?: unknown; screens?: unknown
      rid?: unknown; reply?: unknown
    }
    // 'remote-consent' — what this machine has agreed a central may do with its SESSIONS. Two
    // booleans, unsolicited, announced by the machine on connect and whenever a switch moves. The
    // central never asks for it and it carries no session, no screen and no rule; see
    // `machine-consent.ts` and `remoteSessions.ts`.
    if (msg?.type === 'remote-consent') {
      void import('./machine-consent').then(m => {
        // The machine id comes from the AUTHENTICATED SOCKET, never the frame — a member cannot
        // agree on another machine's behalf, the same rule 'live-sessions' below follows.
        m.recordMachineConsent(ws.data.memberId, msg.sessions, msg.screens)
        onPresenceChange?.()
      }).catch(() => { /* best-effort */ })
      return
    }
    // 'fleet-reply' — the answer to a 'fleet-request' THIS central sent. Matched by rid against
    // the one in-flight question for this machine, and accepted only from the machine it was sent
    // to: the id comes from the authenticated socket, never from the frame, so a member cannot
    // answer for another. An unmatched reply is dropped — see machine-fleet-relay.ts.
    if (msg?.type === 'fleet-reply') {
      void import('./machine-fleet-relay')
        .then(m => { m.acceptMachineFleetReply(ws.data.memberId, msg.rid, msg.reply) })
        .catch(() => { /* best-effort — the asker's timeout still settles it */ })
      return
    }
    if (msg?.type !== 'live-sessions') return
    const sessionIds = Array.isArray(msg.sessionIds)
      ? msg.sessionIds.filter((x): x is string => typeof x === 'string')
      : []
    const processes = Array.isArray(msg.processes)
      ? msg.processes.filter((p): p is { harness: string; cwd: string } =>
          !!p && typeof p === 'object' && typeof (p as { cwd?: unknown }).cwd === 'string')
      : []
    const sessionActivities = msg.sessionActivities && typeof msg.sessionActivities === 'object'
      ? msg.sessionActivities as Record<string, 'working' | 'waiting' | 'waiting-approval' | 'exited'>
      : undefined
    void import('./team-live').then(m => {
      // The member NEVER names itself — the machine id and display name are taken from the
      // authenticated socket, so a member cannot report live sessions on someone else's behalf.
      m.recordMemberLive(ws.data.memberId, ws.data.user, sessionIds, processes as never, Date.now(), sessionActivities)
      onPresenceChange?.()
    }).catch(() => { /* best-effort */ })
  } catch { /* ignore malformed frames */ }
}

/** Whether a machine has a live socket RIGHT NOW.
 *
 *  Deliberately not `computeMachinePresence`'s answer, which keeps a machine "online" through a
 *  short grace after its last socket drops so the dashboard does not flicker on a reconnect. That
 *  grace is right for a status dot and wrong for a question: asking a machine whose socket is gone
 *  buys a full timeout and then reports it as SILENT, which reads as a broken machine rather than
 *  a disconnected one. */
export function hasAgentSocket(memberId: string): boolean {
  const socks = agentSockets.get(memberId)
  return !!socks && socks.size > 0
}

/** Push a JSON message to every live socket of ONE machine (by `memberId`). Best-effort — dead
 *  sockets are skipped. Used by the central to notify a machine of admin actions (e.g. rename,
 *  reassign) — keyed by `memberId` rather than `user` so the message reaches ONLY the machine it
 *  is about, never a sibling machine that happens to share the same owner display name. */
export function notifyMember(memberId: string, payload: Record<string, unknown>): void {
  const socks = agentSockets.get(memberId)
  if (!socks || socks.size === 0) return
  const msg = JSON.stringify(payload)
  for (const ws of socks) {
    try { ws.send(msg) } catch { /* dead socket — the ping loop will reap it */ }
  }
}
