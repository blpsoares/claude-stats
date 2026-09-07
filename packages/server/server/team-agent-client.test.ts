import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import {
  agentWsUrl, backoffDelay, BACKOFF_MS, fingerprintOf, shouldTeardown, decodeAgentFrame,
  liveReportNeedsData, LIVE_REPORT_DATA_MAX_AGE_MS,
} from './team-agent-client'
import type { TeamConnection } from '@agentistics/core'

// ---------------------------------------------------------------------------
// agentWsUrl — pure URL builder
// ---------------------------------------------------------------------------

test('agentWsUrl maps http/https to ws/wss and appends the agent route', () => {
  expect(agentWsUrl('http://host.example.com')).toBe('ws://host.example.com/api/team/agent')
  expect(agentWsUrl('https://host.example.com')).toBe('wss://host.example.com/api/team/agent')
})

test('agentWsUrl trims a trailing slash — a bare trailing slash must not double the slash before the route', () => {
  // http://host/ naively becomes ws://host//api/team/agent, whose double slash misses the
  // server's exact-match upgrade route and the socket never connects.
  expect(agentWsUrl('http://host.example.com/')).toBe('ws://host.example.com/api/team/agent')
  expect(agentWsUrl('https://host.example.com/')).toBe('wss://host.example.com/api/team/agent')
})

test('agentWsUrl trims multiple trailing slashes', () => {
  expect(agentWsUrl('http://host.example.com///')).toBe('ws://host.example.com/api/team/agent')
})

test('agentWsUrl never produces a double slash before the route, for any input shape', () => {
  for (const endpoint of ['http://host', 'http://host/', 'https://host.example.com:8080', 'https://host.example.com:8080/']) {
    expect(agentWsUrl(endpoint)).not.toContain('//api/team/agent')
  }
})

test('agentWsUrl preserves a port and path prefix', () => {
  expect(agentWsUrl('http://host.example.com:48080')).toBe('ws://host.example.com:48080/api/team/agent')
})

// ---------------------------------------------------------------------------
// backoffDelay — pure exponential backoff schedule
// ---------------------------------------------------------------------------

test('backoffDelay follows BACKOFF_MS for in-range indices', () => {
  for (let i = 0; i < BACKOFF_MS.length; i++) {
    expect(backoffDelay(i)).toBe(BACKOFF_MS[i]!)
  }
})

test('backoffDelay clamps to the last entry once the index runs past the table', () => {
  const last = BACKOFF_MS[BACKOFF_MS.length - 1]!
  expect(backoffDelay(BACKOFF_MS.length)).toBe(last)
  expect(backoffDelay(BACKOFF_MS.length + 100)).toBe(last)
})

test('backoffDelay clamps a negative index to the first entry, never going out of bounds', () => {
  expect(backoffDelay(-1)).toBe(BACKOFF_MS[0]!)
  expect(backoffDelay(-100)).toBe(BACKOFF_MS[0]!)
})

test('backoffDelay is monotonically non-decreasing across the table', () => {
  for (let i = 1; i < BACKOFF_MS.length; i++) {
    expect(backoffDelay(i)).toBeGreaterThanOrEqual(backoffDelay(i - 1))
  }
})

// ---------------------------------------------------------------------------
// shouldTeardown — pure fingerprint-vs-connection decision
// ---------------------------------------------------------------------------

function makeConn(overrides?: Partial<TeamConnection>): TeamConnection {
  return {
    id: 'c_aaaaaaaaaaaa',
    endpoint: 'http://127.0.0.1:48001',
    org: 'default',
    user: 'alice',
    token: 'tok-1',
    deniedRepos: [],
    ...overrides,
  }
}

test('shouldTeardown is false when the stored fingerprint still matches the live connection', () => {
  const conn = makeConn()
  expect(shouldTeardown(fingerprintOf(conn), conn)).toBe(false)
})

test('shouldTeardown is true once the token rotates — the stored fingerprint no longer matches', () => {
  const before = makeConn({ token: 'tok-1' })
  const after = makeConn({ token: 'tok-2' })
  expect(shouldTeardown(fingerprintOf(before), after)).toBe(true)
})

test('shouldTeardown is true once the endpoint changes', () => {
  const before = makeConn({ endpoint: 'http://127.0.0.1:48001' })
  const after = makeConn({ endpoint: 'http://127.0.0.1:48002' })
  expect(shouldTeardown(fingerprintOf(before), after)).toBe(true)
})

test('shouldTeardown is true when the connection is gone from preferences (removed)', () => {
  expect(shouldTeardown(fingerprintOf(makeConn()), undefined)).toBe(true)
})

test('shouldTeardown is true when the connection lost its endpoint', () => {
  const conn = makeConn({ endpoint: '' })
  expect(shouldTeardown(fingerprintOf(makeConn()), conn)).toBe(true)
})

// ---------------------------------------------------------------------------
// decodeAgentFrame — pure inbound-frame decoder
// ---------------------------------------------------------------------------

const META = { connectionId: 'c_aaaaaaaaaaaa', central: 'central-1' }

test('decodeAgentFrame: junk / empty / unparseable input decodes to no-op', () => {
  for (const raw of ['', '{not json', '{}', '[]', '"just a string"']) {
    const d = decodeAgentFrame(raw, META)
    expect(d.notification).toBeNull()
    expect(d.userUpdate).toBeNull()
    expect(d.refreshDashboard).toBe(false)
  }
})

test('decodeAgentFrame: an unrecognized type decodes to no-op', () => {
  const d = decodeAgentFrame(JSON.stringify({ type: 'ping' }), META)
  expect(d.notification).toBeNull()
  expect(d.userUpdate).toBeNull()
})

test('decodeAgentFrame: renamed carries connectionId/central in meta and persists the new name', () => {
  const d = decodeAgentFrame(JSON.stringify({ type: 'renamed', name: 'shiny-laptop', actor: 'alice' }), META)
  expect(d.notification).toEqual({
    type: 'info', code: 'machine.renamed',
    meta: { name: 'shiny-laptop', actor: 'alice', connectionId: 'c_aaaaaaaaaaaa', central: 'central-1' },
  })
  expect(d.userUpdate).toBe('shiny-laptop')
  expect(d.refreshDashboard).toBe(false)
})

test('decodeAgentFrame: renamed with an empty/missing name notifies but does not update user', () => {
  const d = decodeAgentFrame(JSON.stringify({ type: 'renamed', actor: 'alice' }), META)
  expect(d.notification?.code).toBe('machine.renamed')
  expect(d.userUpdate).toBeNull()
})

test('decodeAgentFrame: reassigned to a named account persists that name directly, like a rename', () => {
  const d = decodeAgentFrame(JSON.stringify({ type: 'reassigned', account: 'bob@example.com', actor: 'admin' }), META)
  expect(d.notification).toEqual({
    type: 'info', code: 'machine.reassigned',
    meta: { account: 'bob@example.com', actor: 'admin', connectionId: 'c_aaaaaaaaaaaa', central: 'central-1' },
  })
  expect(d.userUpdate).toBe('bob@example.com')
  expect(d.refreshDashboard).toBe(true)
})

test('decodeAgentFrame: reassigned with a null account clears user (the fallback name is unknown locally) instead of leaving the stale one', () => {
  const d = decodeAgentFrame(JSON.stringify({ type: 'reassigned', account: null, actor: 'admin' }), META)
  expect(d.userUpdate).toBe('') // '' means "clear", not "no update" (null)
  expect(d.refreshDashboard).toBe(true)
})

// ---------------------------------------------------------------------------
// I1 / M6 — the socket 'close' ownership guard and teardown's backoff cleanup.
//
// A token rotation tears the old socket down while `reconcileConnection` opens the replacement in
// the same pass, so the OLD socket's 'close' fires when the map already holds the NEW one. Only
// the two map deletes used to be guarded: `stopLiveReporting` and `scheduleReconnect` ran
// unconditionally, so the old socket's close cleared the NEW socket's live-reporting timer, which
// nothing re-arms — that central's live-session panel went blank permanently while pushes and
// presence stayed green.
//
// Both paths exercised here are filesystem-free and timer-free by construction (a non-owning close
// returns immediately; teardown never reconnects), so nothing reads the real ~/.agentistics.
// ---------------------------------------------------------------------------

import { __socketStateForTests as S } from './team-agent-client'

/** The three WebSocket members these paths touch. `close()` records instead of networking. */
function fakeSocket(): { closed: number } & WebSocket {
  const rec = { closed: 0 }
  return Object.assign(rec, {
    readyState: 1,
    close() { rec.closed++ },
    addEventListener() { /* nothing subscribes in these tests */ },
  }) as unknown as { closed: number } & WebSocket
}

test('a superseded socket closing leaves the replacement socket, its fingerprint and its backoff untouched', () => {
  const id = 'c_aaaaaaaaaaa1'
  const oldSocket = fakeSocket()
  const newSocket = fakeSocket()
  // The state after a rotation: the NEW socket owns the id.
  S.activeWs.set(id, newSocket)
  S.credFingerprint.set(id, 'fingerprint-of-the-new-socket')
  S.backoffIdx.set(id, 2)

  S.handleSocketClose(id, oldSocket)

  expect(S.activeWs.get(id)).toBe(newSocket)
  expect(S.credFingerprint.get(id)).toBe('fingerprint-of-the-new-socket')
  // Unchanged: `scheduleReconnect` (which increments this) must not have run for the new socket.
  expect(S.backoffIdx.get(id)).toBe(2)

  S.activeWs.delete(id)
  S.credFingerprint.delete(id)
  S.backoffIdx.delete(id)
})

test('teardownSocket forgets the socket, its fingerprint AND its backoff index', () => {
  const id = 'c_aaaaaaaaaaa2'
  const socket = fakeSocket()
  S.activeWs.set(id, socket)
  S.credFingerprint.set(id, 'fp')
  // A connection that had been failing sits at the 30s backoff cap; a rotated connection must not
  // inherit it, and an id removed for good must not leave an entry behind.
  S.backoffIdx.set(id, BACKOFF_MS.length - 1)

  S.teardownSocket(id)

  expect(S.activeWs.has(id)).toBe(false)
  expect(S.credFingerprint.has(id)).toBe(false)
  expect(S.backoffIdx.has(id)).toBe(false)
  expect(socket.closed).toBe(1)
})

test('the socket state maps are left empty by these tests — no cross-test leakage', () => {
  // Order-independence guard: every id above is unique to its test and cleaned up, so a later
  // test (or a later run in a different order) can never observe another's socket state.
  expect([...S.activeWs.keys()].filter(k => k.startsWith('c_aaaaaaaaaaa'))).toEqual([])
  expect([...S.backoffIdx.keys()].filter(k => k.startsWith('c_aaaaaaaaaaa'))).toEqual([])
})

// ---------------------------------------------------------------------------
// resolveMemberIdentity — best-effort whoami resolution, including machineName
// ---------------------------------------------------------------------------

import { resolveMemberIdentity } from './team-agent-client'
import type { TeamConfig } from '@agentistics/core'
import type { TeamConfigMutator } from './preferences'

let fakeConnCounter = 0
/** A unique `id` per call by default — `resolveMemberIdentity`'s retry cooldown is keyed by
 *  connection id in MODULE-level state shared across every test in this file, so two tests
 *  reusing one id would have the first test's attempt silently cool down the second's. */
function fakeConn(port: number, extra: Partial<TeamConnection> = {}): TeamConnection {
  return {
    id: `c_test_${fakeConnCounter++}`, endpoint: `http://127.0.0.1:${port}`, org: 'default', user: '',
    token: 'tok', deniedRepos: [], ...extra,
  }
}

/** Same in-memory fake `team-uploader.test.ts` uses — never touches the real preferences file. */
function fakeStore(conn: TeamConnection): {
  store: TeamConfig
  update: typeof import('./preferences').updateTeamConfig
} {
  let store: TeamConfig = { schema: 2, mode: 'member', connections: [conn] }
  const update = (async (mutate: TeamConfigMutator) => {
    const next = mutate(store)
    if (next !== undefined) store = next
    return store
  }) as typeof import('./preferences').updateTeamConfig
  return { get store() { return store }, update } as never
}

describe('resolveMemberIdentity', () => {
  test('resolves BOTH user and machineName from one whoami call when both are missing', async () => {
    await using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true, user: 'resolved-name', org: 'default', machineName: 'laptop-b' }),
    })
    const conn = fakeConn(server.port!)
    const fx = fakeStore(conn)

    await resolveMemberIdentity(conn, { updateTeamConfig: fx.update })

    expect(fx.store.connections[0]?.user).toBe('resolved-name')
    expect(fx.store.connections[0]?.machineName).toBe('laptop-b')
  })

  test('a connection whose user is already resolved but whose machineName is still missing gets machineName backfilled', async () => {
    await using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true, user: 'already-resolved', org: 'default', machineName: 'laptop-b' }),
    })
    const conn = fakeConn(server.port!, { user: 'already-resolved' })
    const fx = fakeStore(conn)

    await resolveMemberIdentity(conn, { updateTeamConfig: fx.update })

    expect(fx.store.connections[0]?.machineName).toBe('laptop-b')
  })

  test('a connection with BOTH already resolved keeps its machineName when a later call reaches a central that omits it', async () => {
    await using server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true, user: 'already-resolved', org: 'default' }), // no machineName this time
    })
    const conn = fakeConn(server.port!, { user: 'already-resolved', machineName: 'laptop-b' })
    const fx = fakeStore(conn)

    await resolveMemberIdentity(conn, { updateTeamConfig: fx.update })

    // Its existing machineName survives — a response that merely OMITS the field is not evidence
    // the central un-named the machine, the same non-destructive rule `applyProjectFacts` follows.
    expect(fx.store.connections[0]?.machineName).toBe('laptop-b')
  })

  test('a connection retried immediately after a FAILED attempt does not call the central again — cooldown, not just an in-flight guard', async () => {
    // Real incident: the reconcile loop calls this every 5s while machineName stays unresolved,
    // with no floor beyond "not currently in flight". A central that briefly 429s whoami got hit
    // again 5s later, which is exactly what RENEWS a soft per-account rate-limit window — the
    // loop kept the lockout alive against itself, forever, because failure was indistinguishable
    // from "never tried". `resolvingUser`'s in-flight guard clears the instant the failed call
    // returns, so it does nothing to prevent the very next reconcile tick from trying again.
    let hits = 0
    await using server = Bun.serve({
      port: 0,
      fetch: () => { hits++; return new Response('rate limited', { status: 429 }) },
    })
    // A connection id unique to this test — the cooldown map is module-level state shared across
    // every test in this file, and reusing `c_test` would inherit an attempt timestamp another
    // test already recorded for that id.
    const conn = fakeConn(server.port!, { id: 'c_cooldown_test', user: 'already-resolved' })
    const fx = fakeStore(conn)

    await resolveMemberIdentity(conn, { updateTeamConfig: fx.update }) // fails, 429
    expect(hits).toBe(1)
    await resolveMemberIdentity(conn, { updateTeamConfig: fx.update }) // retried "5s later"
    expect(hits).toBe(1) // still 1 — withheld by the cooldown, not sent again
  })

  test('a connection with BOTH already resolved never calls the central at all', async () => {
    let hits = 0
    await using server = Bun.serve({
      port: 0,
      fetch: () => { hits++; return Response.json({ ok: true, user: 'x', org: 'default' }) },
    })
    const conn = fakeConn(server.port!, { user: 'already-resolved', machineName: 'laptop-b' })
    const fx = fakeStore(conn)

    await resolveMemberIdentity(conn, { updateTeamConfig: fx.update })

    expect(hits).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// liveReportNeedsData — how often the live-session report may cause a FULL rebuild
//
// Measured 2026-09-03 on a real member machine: calling buildApiResponse() on every 8s tick made
// this timer the cadence of a full transcript walk — 1.457 MB of file reads per minute, 30% of a
// core, RSS oscillating 1,28-2,20 GB, with no browser open. The same build in solo mode (no
// reverse channel, so no live-report loop) idled at 188 MB and 0 MB/min.
// ---------------------------------------------------------------------------

test('liveReportNeedsData rebuilds when the loop has never held a corpus', () => {
  // The FIRST report has nothing to reuse. Reporting no sessions because the corpus was not ready
  // would be worse than the one build, so `null` always rebuilds — whatever the clock says.
  expect(liveReportNeedsData(null, 0)).toBe(true)
  expect(liveReportNeedsData(null, 1_000_000)).toBe(true)
})

test('liveReportNeedsData reuses a corpus younger than the max age', () => {
  const now = 1_000_000
  expect(liveReportNeedsData(now - 1, now)).toBe(false)
  expect(liveReportNeedsData(now - (LIVE_REPORT_DATA_MAX_AGE_MS - 1), now)).toBe(false)
})

test('liveReportNeedsData rebuilds at exactly the max age, and beyond', () => {
  const now = 1_000_000
  expect(liveReportNeedsData(now - LIVE_REPORT_DATA_MAX_AGE_MS, now)).toBe(true)
  expect(liveReportNeedsData(now - LIVE_REPORT_DATA_MAX_AGE_MS * 10, now)).toBe(true)
})

test('liveReportNeedsData holds a corpus across several report ticks — that is the whole point', () => {
  // Eight-second ticks against a sixty-second age: seven of every eight ticks must reuse, or the
  // loop is back to setting the cadence of the most expensive computation in the process.
  const built = 1_000_000
  const rebuilds = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .filter(tick => liveReportNeedsData(built, built + tick * 8_000))
  expect(rebuilds).toEqual([8, 9]) // 64s and 72s — the first tick at or past 60s, and after
})

test('liveReportNeedsData takes an explicit max age, so a caller is never forced onto the default', () => {
  expect(liveReportNeedsData(0, 5_000, 10_000)).toBe(false)
  expect(liveReportNeedsData(0, 10_000, 10_000)).toBe(true)
})
