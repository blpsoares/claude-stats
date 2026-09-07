import { test, expect } from 'bun:test'
import type { SessionMeta, HarnessId } from './types'
import { tagUser, distinctUsers, distinctHarnesses, filterByUsers, filterByHarnesses, clampPushInterval, PUSH_INTERVAL } from './team'

function session(id: string, user?: string): SessionMeta {
  return {
    session_id: id, project_path: '/p', start_time: '2026-06-01T00:00:00Z',
    duration_minutes: 0, user_message_count: 0, assistant_message_count: 0,
    tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
    git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0,
    first_prompt: '', user_interruptions: 0, user_response_times: [],
    tool_errors: 0, tool_error_categories: {}, uses_task_agent: false,
    uses_mcp: false, uses_web_search: false, uses_web_fetch: false,
    lines_added: 0, lines_removed: 0, files_modified: 0, message_hours: [],
    user_message_timestamps: [], harness: 'claude', user,
  }
}

test('tagUser sets the user without mutating the input', () => {
  const s = session('a')
  const tagged = tagUser(s, 'devA')
  expect(tagged.user).toBe('devA')
  expect(s.user).toBeUndefined() // original untouched
})

test('distinctUsers returns sorted unique users and skips undefined', () => {
  const sessions = [session('1', 'devB'), session('2', 'devA'), session('3', 'devB'), session('4')]
  expect(distinctUsers(sessions)).toEqual(['devA', 'devB'])
})

// An ownerless machine's sessions carry `user: ''` (never a fallback to the machine's own name —
// see `machineUserFor` in server/team-tokens.ts). `distinctUsers`/`filterByUsers` must treat that
// exactly like `undefined`, or such a machine would surface as a "member" in the filter/UI
// dimension under its own name — the bug this whole fix exists for.
test('distinctUsers treats an empty-string user (ownerless machine) like undefined — never lists it as a member', () => {
  const sessions = [session('1', 'devA'), session('2', ''), session('3', 'devB')]
  expect(distinctUsers(sessions)).toEqual(['devA', 'devB'])
})

test('filterByUsers drops empty-string-user (ownerless machine) sessions like untagged ones', () => {
  const sessions = [session('1', 'devA'), session('2', ''), session('3', 'devB')]
  expect(filterByUsers(sessions, ['devA', 'devB']).map(s => s.session_id).sort()).toEqual(['1', '3'])
})

test('filterByUsers with empty selection passes everything through', () => {
  const sessions = [session('1', 'devA'), session('2', 'devB')]
  expect(filterByUsers(sessions, [])).toHaveLength(2)
})

test('filterByUsers keeps only selected users and drops untagged sessions', () => {
  const sessions = [session('1', 'devA'), session('2', 'devB'), session('3')]
  const result = filterByUsers(sessions, ['devA'])
  expect(result.map(s => s.session_id)).toEqual(['1'])
})

test('filterByUsers supports multi-select (aggregate of a subset)', () => {
  const sessions = [session('1', 'devA'), session('2', 'devB'), session('3', 'devC')]
  const result = filterByUsers(sessions, ['devA', 'devB'])
  expect(result.map(s => s.session_id).sort()).toEqual(['1', '2'])
})

// distinctHarnesses

test('distinctHarnesses returns harnesses in canonical order, deduped', () => {
  const sessions = [
    harnessSession('1', 'copilot'),
    harnessSession('2', 'claude'),
    harnessSession('3', 'copilot'),
    harnessSession('4', 'gemini'),
  ]
  expect(distinctHarnesses(sessions)).toEqual(['claude', 'gemini', 'copilot'])
})

test('distinctHarnesses treats a missing harness field as claude', () => {
  const s = { ...session('1'), harness: undefined as unknown as 'claude' }
  expect(distinctHarnesses([s])).toEqual(['claude'])
})

test('distinctHarnesses on an empty list returns an empty array', () => {
  expect(distinctHarnesses([])).toEqual([])
})

// filterByHarnesses

function harnessSession(id: string, harness?: HarnessId): SessionMeta {
  return {
    ...session(id),
    harness: harness ?? 'claude',
  }
}

test('filterByHarnesses with empty selection passes everything through', () => {
  const sessions = [harnessSession('1', 'claude'), harnessSession('2', 'codex')]
  expect(filterByHarnesses(sessions, [])).toHaveLength(2)
})

test('filterByHarnesses with undefined treats missing harness as claude', () => {
  // A session created without explicit harness field (pre-team-mode legacy)
  const s: SessionMeta = { ...session('1'), harness: undefined as unknown as 'claude' }
  // Selecting 'claude' should include sessions with no harness field
  const result = filterByHarnesses([s], ['claude'])
  expect(result).toHaveLength(1)
})

test('filterByHarnesses keeps only selected harnesses', () => {
  const sessions = [
    harnessSession('1', 'claude'),
    harnessSession('2', 'codex'),
    harnessSession('3', 'gemini'),
  ]
  const result = filterByHarnesses(sessions, ['codex'])
  expect(result.map(s => s.session_id)).toEqual(['2'])
})

test('filterByHarnesses supports multi-select across a subset', () => {
  const sessions = [
    harnessSession('1', 'claude'),
    harnessSession('2', 'codex'),
    harnessSession('3', 'gemini'),
    harnessSession('4', 'copilot'),
  ]
  const result = filterByHarnesses(sessions, ['claude', 'copilot'])
  expect(result.map(s => s.session_id).sort()).toEqual(['1', '4'])
})

// clampPushInterval

test('clampPushInterval returns DEFAULT for NaN', () => {
  expect(clampPushInterval(NaN)).toBe(PUSH_INTERVAL.DEFAULT_SEC)
})

test('clampPushInterval returns DEFAULT for 0', () => {
  expect(clampPushInterval(0)).toBe(PUSH_INTERVAL.DEFAULT_SEC)
})

test('clampPushInterval returns DEFAULT for negative values', () => {
  expect(clampPushInterval(-10)).toBe(PUSH_INTERVAL.DEFAULT_SEC)
})

test('clampPushInterval returns DEFAULT for Infinity', () => {
  expect(clampPushInterval(Infinity)).toBe(PUSH_INTERVAL.DEFAULT_SEC)
})

test('clampPushInterval clamps below MIN to MIN', () => {
  expect(clampPushInterval(1)).toBe(PUSH_INTERVAL.MIN_SEC)
  expect(clampPushInterval(14)).toBe(PUSH_INTERVAL.MIN_SEC)
})

test('clampPushInterval clamps above MAX to MAX', () => {
  expect(clampPushInterval(9999)).toBe(PUSH_INTERVAL.MAX_SEC)
  expect(clampPushInterval(3601)).toBe(PUSH_INTERVAL.MAX_SEC)
})

test('clampPushInterval passes through in-range value', () => {
  expect(clampPushInterval(30)).toBe(30)
  expect(clampPushInterval(300)).toBe(300)
  expect(clampPushInterval(PUSH_INTERVAL.MIN_SEC)).toBe(PUSH_INTERVAL.MIN_SEC)
  expect(clampPushInterval(PUSH_INTERVAL.MAX_SEC)).toBe(PUSH_INTERVAL.MAX_SEC)
})

test('clampPushInterval with the express floor allows sub-15s values', () => {
  // Central express mode: the floor drops to EXPRESS_MIN_SEC.
  expect(clampPushInterval(5, PUSH_INTERVAL.EXPRESS_MIN_SEC)).toBe(5)
  expect(clampPushInterval(10, PUSH_INTERVAL.EXPRESS_MIN_SEC)).toBe(10)
  // Still floored at the express minimum, never below it.
  expect(clampPushInterval(2, PUSH_INTERVAL.EXPRESS_MIN_SEC)).toBe(PUSH_INTERVAL.EXPRESS_MIN_SEC)
  // MAX still enforced regardless of the floor.
  expect(clampPushInterval(9999, PUSH_INTERVAL.EXPRESS_MIN_SEC)).toBe(PUSH_INTERVAL.MAX_SEC)
})

test('clampPushInterval rounds fractional seconds', () => {
  expect(clampPushInterval(29.4)).toBe(29)
  expect(clampPushInterval(29.6)).toBe(30)
})

import { filterByTeams, filterByMachines } from './team'

test('filterByTeams: empty = all; matches teamId; drops missing', () => {
  const s = [{ teamId: 'A' }, { teamId: 'B' }, {}]
  expect(filterByTeams(s, [])).toHaveLength(3)
  expect(filterByTeams(s, ['A'])).toEqual([{ teamId: 'A' }])
  expect(filterByTeams(s, ['A', 'B']).length).toBe(2)
})

test('filterByMachines: empty = all; matches memberId; drops missing', () => {
  const s = [{ memberId: 'm1' }, { memberId: 'm2' }, {}]
  expect(filterByMachines(s, [])).toHaveLength(3)
  expect(filterByMachines(s, ['m2'])).toEqual([{ memberId: 'm2' }])
})

import { resolveMachineCacheScope } from './team'
import { emptyStatsCache } from './types'

const cache = () => emptyStatsCache()
const OWNERS = {
  alienware: { user: 'Bryan Soares', teamIds: ['dev'] },
  dellBryan: { user: 'Bryan Soares', teamIds: ['dev'] },
  thinkpadVini: { user: 'Vinicius Mostaço', teamIds: ['dev', 'ops'] },
}
const CACHES = { alienware: cache(), dellBryan: cache(), thinkpadVini: cache() }
const base = { machineOwners: OWNERS, machineStatsCaches: CACHES, users: [], teams: [], machines: [] }

test('resolveMachineCacheScope: no machine/team selection → null (member path answers it)', () => {
  expect(resolveMachineCacheScope(base)).toBeNull()
  expect(resolveMachineCacheScope({ ...base, users: ['Bryan Soares'] })).toBeNull()
})

test('resolveMachineCacheScope: selecting a member\'s machines resolves to exactly those caches', () => {
  const scope = resolveMachineCacheScope({ ...base, machines: ['alienware', 'dellBryan'] })
  expect(scope?.sort()).toEqual(['alienware', 'dellBryan'])
})

test('resolveMachineCacheScope: a team resolves to its machines; a member narrows it further', () => {
  expect(resolveMachineCacheScope({ ...base, teams: ['ops'] })).toEqual(['thinkpadVini'])
  expect(resolveMachineCacheScope({ ...base, teams: ['dev'], users: ['Bryan Soares'] })?.sort())
    .toEqual(['alienware', 'dellBryan'])
})

test('resolveMachineCacheScope: presence scope excludes machines of filtered-out members', () => {
  const scope = resolveMachineCacheScope({
    ...base, teams: ['dev'], allowedUsers: new Set(['Vinicius Mostaço']),
  })
  expect(scope).toEqual(['thinkpadVini'])
})

test('resolveMachineCacheScope: a selection that resolves to NO machine is null, never an empty scope', () => {
  // A scoped principal (e.g. a manager) receives `machineOwners` pruned to the machines they may
  // see. Selecting a team whose machines are not in that pruned map — or whose machines were never
  // linked to the team — must fall back to the per-session sum, NOT return [], which the caller
  // merges into an EMPTY statsCache and renders as an authoritative zero across every KPI.
  expect(resolveMachineCacheScope({ ...base, teams: ['finance'] })).toBeNull()
  expect(resolveMachineCacheScope({ ...base, machineOwners: {}, machineStatsCaches: {}, teams: ['dev'] })).toBeNull()
  // Same trap via the presence scope: no member in the team passes the presence filter.
  expect(resolveMachineCacheScope({ ...base, teams: ['ops'], allowedUsers: new Set(['Nobody']) })).toBeNull()
})

test('resolveMachineCacheScope: null (never a partial sum) when the caches cannot serve the scope', () => {
  // No machine maps at all — a solo instance, or a central that predates them.
  expect(resolveMachineCacheScope({ ...base, machineOwners: undefined, machines: ['alienware'] })).toBeNull()
  // A selected machine the tokens table does not know.
  expect(resolveMachineCacheScope({ ...base, machines: ['alienware', 'ghost'] })).toBeNull()
  // A machine in scope that has never pushed a statsCache would silently count as zero.
  const { dellBryan: _drop, ...partial } = CACHES
  expect(resolveMachineCacheScope({ ...base, machineStatsCaches: partial, machines: ['alienware', 'dellBryan'] })).toBeNull()
})

import {
  migrateTeamConfig, normalizeTeamConfig, connectionId, legacyConnectionId,
  readTeamConnections, NO_REPO_KEY, DEFAULT_TEAM, defaultTeam,
} from './team'

test('migrateTeamConfig: a legacy flat member config becomes one connection', () => {
  const out = migrateTeamConfig({
    mode: 'member', endpoint: 'https://central.example:48080/', org: 'acme',
    user: 'lucas', token: 'abc123', pushIntervalSec: 45,
  })
  expect(out.connections).toHaveLength(1)
  expect(out.connections[0]!.endpoint).toBe('https://central.example:48080')
  expect(out.connections[0]!.org).toBe('acme')
  expect(out.connections[0]!.user).toBe('lucas')
  expect(out.connections[0]!.token).toBe('abc123')
  expect(out.connections[0]!.pushIntervalSec).toBe(45)
  expect(out.connections[0]!.deniedRepos).toEqual([])
  expect(out.mode).toBe('member')
  expect(out.schema).toBe(2)
})

test('migrateTeamConfig: a solo config with empty strings fabricates NO connection', () => {
  const out = migrateTeamConfig({ mode: 'solo', endpoint: '', org: 'default', user: '', token: '' })
  expect(out.connections).toEqual([])
  expect(out.mode).toBe('solo')
})

test('migrateTeamConfig: an endpoint with no token still migrates (open/legacy central)', () => {
  const out = migrateTeamConfig({ mode: 'member', endpoint: 'http://c:48080', org: 'default', user: 'lucas' })
  expect(out.connections).toHaveLength(1)
  expect(out.connections[0]!.token).toBe('')
  expect(out.mode).toBe('member')
})

test('migrateTeamConfig: an already-migrated config is preserved, ids intact', () => {
  const first = migrateTeamConfig({ mode: 'member', endpoint: 'http://c:48080', token: 't' })
  const again = migrateTeamConfig(first)
  expect(again.connections[0]!.id).toBe(first.connections[0]!.id)
  expect(again.connections).toHaveLength(1)
})

test('migrateTeamConfig: re-sanitizing an already-migrated config PRESERVES machineName', () => {
  // Real incident: the sanitize-in-place branch rebuilds each connection field by field and
  // never listed `machineName` among them (unlike `pushIntervalSec`/`label`/`addedAt`/
  // `authFailedAt`, which ARE preserved) — so it was silently dropped on every single write,
  // because `readEffective` runs the CURRENT on-disk state through this exact function before
  // any mutate callback even sees it. A connection whose name the central had just resolved
  // read as unresolved again the moment ANYTHING else wrote to preferences.json — a session-view
  // change, a language toggle, anything — not only writes that touch the connection itself.
  const first = migrateTeamConfig({
    mode: 'member',
    connections: [{ id: 'c_x', endpoint: 'http://c:48080', token: 't', machineName: 'Dell-elmd' }],
  })
  expect(first.connections[0]!.machineName).toBe('Dell-elmd')
  // The exact re-entrant call `readEffective` makes on every write: run what is already on disk
  // (an already-migrated shape) back through migrateTeamConfig before any mutate callback sees it.
  const again = migrateTeamConfig(first)
  expect(again.connections[0]!.machineName).toBe('Dell-elmd')
})

test('migrateTeamConfig: a non-string machineName on the wire is dropped, not coerced', () => {
  const out = migrateTeamConfig({
    mode: 'member', connections: [{ id: 'c_x', endpoint: 'http://c:48080', token: 't', machineName: 42 }],
  })
  expect(out.connections[0]!.machineName).toBeUndefined()
})

test('migrateTeamConfig: junk input yields the default solo config', () => {
  for (const raw of [undefined, null, 'nope', 42, []]) {
    expect(migrateTeamConfig(raw).connections).toEqual([])
    expect(migrateTeamConfig(raw).mode).toBe('solo')
  }
})

test('migrateTeamConfig: two calls return distinct array instances (no shared aliasing)', () => {
  const raw = { mode: 'member', endpoint: 'http://c:48080', token: 't' }
  const a = migrateTeamConfig(raw)
  const b = migrateTeamConfig(raw)
  expect(a.connections).not.toBe(b.connections)
  a.connections[0]!.deniedRepos.push('github.com/o/r')
  expect(b.connections[0]!.deniedRepos).toEqual([])
})

test('migrateTeamConfig: the legacy id is deterministic across 100 calls', () => {
  const raw = { mode: 'member', endpoint: 'http://c:48080', token: 't' }
  const ids = new Set(Array.from({ length: 100 }, () => migrateTeamConfig(raw).connections[0]!.id))
  expect(ids.size).toBe(1)
  expect([...ids][0]).toMatch(/^c_[a-f0-9]{12}$/)
})

test('migrateTeamConfig: duplicate normalized endpoints collapse, first wins', () => {
  const out = migrateTeamConfig({
    mode: 'member',
    connections: [
      { id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'a', token: 't1', deniedRepos: [] },
      { id: 'c_bbbbbbbbbbbb', endpoint: 'http://c:48080/', org: 'default', user: 'b', token: 't2', deniedRepos: [] },
    ],
  })
  expect(out.connections).toHaveLength(1)
  expect(out.connections[0]!.id).toBe('c_aaaaaaaaaaaa')
})

test('migrateTeamConfig: an entry with no endpoint is dropped and deniedRepos defaults', () => {
  const out = migrateTeamConfig({
    mode: 'member',
    connections: [
      { id: 'c_aaaaaaaaaaaa', endpoint: '', org: 'default', user: 'a', token: 't' },
      { endpoint: 'http://c:48080', org: 'default', user: 'b', token: 't2' },
    ],
  })
  expect(out.connections).toHaveLength(1)
  expect(out.connections[0]!.deniedRepos).toEqual([])
  expect(out.connections[0]!.id).toMatch(/^c_[a-f0-9]{12}$/)
})

test('normalizeTeamConfig: mode follows connections.length in both directions', () => {
  const withOne = normalizeTeamConfig({
    mode: 'solo', connections: [{ id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'o', user: 'u', token: 't', deniedRepos: [] }],
  })
  expect(withOne.mode).toBe('member')
  expect(normalizeTeamConfig({ mode: 'member', connections: [] }).mode).toBe('solo')
})

test('normalizeTeamConfig: the legacy mirror tracks connections[0] and clears when empty', () => {
  const withOne = normalizeTeamConfig({
    mode: 'solo',
    connections: [{ id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'acme', user: 'lucas', token: 'tok', deniedRepos: [] }],
  })
  expect(withOne.endpoint).toBe('http://c:48080')
  expect(withOne.org).toBe('acme')
  expect(withOne.user).toBe('lucas')
  expect(withOne.token).toBe('tok')
  expect(withOne.schema).toBe(2)

  const emptied = normalizeTeamConfig({ mode: 'member', connections: [] })
  expect(emptied.endpoint).toBe('')
  expect(emptied.token).toBe('')
  expect(emptied.user).toBe('')
})

test('connectionId: format holds and 10000 calls collide zero times', () => {
  const ids = new Set(Array.from({ length: 10_000 }, () => connectionId()))
  expect(ids.size).toBe(10_000)
  for (const id of [...ids].slice(0, 50)) expect(id).toMatch(/^c_[a-f0-9]{12}$/)
})

test('legacyConnectionId: same inputs same id, different token different id', () => {
  expect(legacyConnectionId('http://c:48080', 't')).toBe(legacyConnectionId('http://c:48080', 't'))
  expect(legacyConnectionId('http://c:48080', 't')).not.toBe(legacyConnectionId('http://c:48080', 'u'))
  expect(legacyConnectionId('http://c:48080', '')).toMatch(/^c_[a-f0-9]{12}$/)
})

test('readTeamConnections: never throws on a prefs object missing the array', () => {
  expect(readTeamConnections(undefined)).toEqual([])
  expect(readTeamConnections(null)).toEqual([])
  expect(readTeamConnections({})).toEqual([])
  expect(readTeamConnections({ team: { mode: 'solo' } as never })).toEqual([])
})

test('NO_REPO_KEY is the exact sentinel and contains no slash', () => {
  expect(NO_REPO_KEY).toBe('__no_repo__')
  expect(NO_REPO_KEY.includes('/')).toBe(false)
})

test('DEFAULT_TEAM is solo with an empty connections array', () => {
  expect(DEFAULT_TEAM.mode).toBe('solo')
  expect(DEFAULT_TEAM.connections).toEqual([])
})

test('defaultTeam() hands out a FRESH array; DEFAULT_TEAM is frozen so it cannot be shared into', () => {
  const a = defaultTeam()
  const b = defaultTeam()
  expect(a.connections).not.toBe(b.connections)
  a.connections.push({ id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:1', org: 'o', user: 'u', token: 't', deniedRepos: [] })
  expect(b.connections).toEqual([])
  expect(Object.isFrozen(DEFAULT_TEAM)).toBe(true)
  expect(Object.isFrozen(DEFAULT_TEAM.connections)).toBe(true)
})

// C1 (merge blocker): `agentop member connect` and the web "Connect to central" flow persist
// `{ ...defaultTeam(), mode:'member', endpoint, token }` — an EMPTY connections array alongside
// the legacy flat fields. Treating any array as authoritative read that back as solo: the
// uploader never pushed, no WebSocket ever opened, and the CLI still printed "connected as …".

test('migrateTeamConfig: an empty connections array WITH a flat endpoint still migrates (C1)', () => {
  const written = { ...defaultTeam(), mode: 'member' as const, endpoint: 'http://c:48080', token: 't', org: 'acme', user: 'lucas' }
  const out = migrateTeamConfig(written)
  expect(out.connections).toHaveLength(1)
  expect(out.connections[0]!.endpoint).toBe('http://c:48080')
  expect(out.connections[0]!.token).toBe('t')
  expect(out.connections[0]!.user).toBe('lucas')
  expect(out.mode).toBe('member')
})

test('migrateTeamConfig: an empty connections array with NO endpoint stays genuinely solo (C1)', () => {
  const out = migrateTeamConfig({ ...defaultTeam(), endpoint: '', token: '', user: '' })
  expect(out.connections).toEqual([])
  expect(out.mode).toBe('solo')
  expect(migrateTeamConfig(defaultTeam()).connections).toEqual([])
  expect(migrateTeamConfig(defaultTeam()).mode).toBe('solo')
})

test('migrateTeamConfig: a NON-empty connections array wins over a stale flat mirror (C1)', () => {
  const out = migrateTeamConfig({
    mode: 'member', endpoint: 'http://stale:48080', token: 'stale',
    connections: [{ id: 'c_aaaaaaaaaaaa', endpoint: 'http://real:48080', org: 'default', user: 'u', token: 'real', deniedRepos: [] }],
  })
  expect(out.connections).toHaveLength(1)
  expect(out.connections[0]!.endpoint).toBe('http://real:48080')
  expect(out.endpoint).toBe('http://real:48080')
})

// ---------------------------------------------------------------------------
// Plan 4 Task 2 — typed sources + shareMode. `deniedRepos` becomes a read-only migration
// source; `sources`/`shareMode` are the shape every version from here on writes.
// ---------------------------------------------------------------------------

test('migrateTeamConfig: a legacy deniedRepos list becomes typed repo sources under denylist mode', () => {
  const out = migrateTeamConfig({
    mode: 'member',
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't',
      deniedRepos: ['github.com/o/one', 'github.com/o/two'],
    }],
  })
  expect(out.connections).toHaveLength(1)
  const conn = out.connections[0]!
  expect(conn.shareMode).toBe('denylist')
  expect(conn.sources).toEqual([
    { type: 'repo', value: 'github.com/o/one' },
    { type: 'repo', value: 'github.com/o/two' },
  ])
  // The legacy field is kept, read-only, so an older binary or a container sharing
  // ~/.agentistics keeps working against the same config.
  expect(conn.deniedRepos).toEqual(['github.com/o/one', 'github.com/o/two'])
})

test('migrateTeamConfig: NO_REPO_KEY in deniedRepos becomes the typed `none` source', () => {
  const out = migrateTeamConfig({
    mode: 'member',
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't',
      deniedRepos: [NO_REPO_KEY],
    }],
  })
  expect(out.connections[0]!.sources).toEqual([{ type: 'none', value: '' }])
  expect(out.connections[0]!.shareMode).toBe('denylist')
})

test('migrateTeamConfig: a legacy deniedRepos=[] migrates to sources=[] under denylist (share everything)', () => {
  const out = migrateTeamConfig({
    mode: 'member',
    connections: [{ id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't', deniedRepos: [] }],
  })
  expect(out.connections[0]!.sources).toEqual([])
  expect(out.connections[0]!.shareMode).toBe('denylist')
})

test('migrateTeamConfig: idempotent — 100 calls over the same legacy input produce identical output', () => {
  const raw = {
    mode: 'member',
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't',
      deniedRepos: ['github.com/o/one', NO_REPO_KEY],
    }],
  }
  const first = JSON.stringify(migrateTeamConfig(raw))
  for (let i = 0; i < 100; i++) {
    expect(JSON.stringify(migrateTeamConfig(raw))).toBe(first)
  }
})

test('migrateTeamConfig: re-migrating an already-migrated (typed) config leaves it untouched', () => {
  const already = {
    mode: 'member' as const,
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't',
      deniedRepos: [] as string[],
      shareMode: 'allowlist' as const,
      sources: [{ type: 'project' as const, value: '/home/u/proj' }],
    }],
  }
  const out = migrateTeamConfig(already)
  expect(out.connections[0]!.shareMode).toBe('allowlist')
  expect(out.connections[0]!.sources).toEqual([{ type: 'project', value: '/home/u/proj' }])
})

test('migrateTeamConfig: shareMode absent on an already-migrated entry reads as denylist, never inverted', () => {
  const out = migrateTeamConfig({
    mode: 'member',
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't',
      deniedRepos: [], sources: [{ type: 'repo', value: 'github.com/o/one' }],
    }],
  })
  expect(out.connections[0]!.shareMode).toBe('denylist')
  expect(out.connections[0]!.sources).toEqual([{ type: 'repo', value: 'github.com/o/one' }])
})

test('migrateTeamConfig: a legacy flat member config (no connections array at all) still defaults sources/mode', () => {
  const out = migrateTeamConfig({
    mode: 'member', endpoint: 'https://central.example:48080/', org: 'acme',
    user: 'lucas', token: 'abc123',
  })
  expect(out.connections).toHaveLength(1)
  expect(out.connections[0]!.shareMode).toBe('denylist')
  expect(out.connections[0]!.sources).toEqual([])
})

test('normalizeTeamConfig: the legacy flat mirror keeps working when sources/shareMode are present', () => {
  const withOne = normalizeTeamConfig({
    mode: 'solo',
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'acme', user: 'lucas', token: 'tok',
      deniedRepos: [], shareMode: 'allowlist', sources: [{ type: 'repo', value: 'github.com/o/one' }],
    }],
  })
  expect(withOne.endpoint).toBe('http://c:48080')
  expect(withOne.org).toBe('acme')
  expect(withOne.user).toBe('lucas')
  expect(withOne.token).toBe('tok')
  expect(withOne.connections[0]!.shareMode).toBe('allowlist')
  expect(withOne.connections[0]!.sources).toEqual([{ type: 'repo', value: 'github.com/o/one' }])
})

test('legacyConnectionId needs no node:crypto — deterministic, well-formed and input-sensitive', () => {
  expect(legacyConnectionId('http://c:48080', 't')).toMatch(/^c_[a-f0-9]{12}$/)
  expect(legacyConnectionId('http://c:48080', 't')).toBe(legacyConnectionId('http://c:48080', 't'))
  expect(legacyConnectionId('http://c:48080', 't')).not.toBe(legacyConnectionId('http://d:48080', 't'))
  const ids = new Set(Array.from({ length: 2000 }, (_, i) => legacyConnectionId(`http://c${i}:48080`, `tok${i}`)))
  expect(ids.size).toBe(2000)
})

// ---------------------------------------------------------------------------
// normalizeEndpointKey — the SHARED endpoint identity rule (M3).
//
// Every endpoint comparison on the multi-central path funnels through this: the connection
// upsert's endpoint-uniqueness check, the legacy leave-central mapping, and the Settings panel's
// "which connection am I looking at". It had no direct test, so the exact contract is pinned here.
// ---------------------------------------------------------------------------

import { normalizeEndpointKey } from './team'

test('normalizeEndpointKey: host case and trailing slashes never make one central look like two', () => {
  const canonical = normalizeEndpointKey('https://central.example.com')
  expect(normalizeEndpointKey('https://Central.Example.COM')).toBe(canonical)
  expect(normalizeEndpointKey('https://central.example.com/')).toBe(canonical)
  expect(normalizeEndpointKey('https://central.example.com///')).toBe(canonical)
  expect(normalizeEndpointKey('  https://central.example.com  ')).toBe(canonical)
})

test('normalizeEndpointKey: a default port folds — WHATWG URL already drops it, so the explicit fold is belt-and-braces, not the mechanism', () => {
  expect(normalizeEndpointKey('https://central.example.com:443')).toBe(normalizeEndpointKey('https://central.example.com'))
  expect(normalizeEndpointKey('http://central.example.com:80')).toBe(normalizeEndpointKey('http://central.example.com'))
  // The reason the fold is unreachable: the parser itself strips a default port before the
  // function ever looks at it. Pinned so a future refactor that hand-rolls the parse knows.
  expect(new URL('https://central.example.com:443').port).toBe('')
  expect(new URL('http://central.example.com:80').port).toBe('')
  // A NON-default port is part of the identity — two centrals on one host must stay distinct.
  expect(normalizeEndpointKey('http://central.example.com:48080'))
    .not.toBe(normalizeEndpointKey('http://central.example.com:48081'))
})

test('normalizeEndpointKey: scheme and path case are part of the identity, and the path keeps its case', () => {
  // A reverse proxy may route case-sensitively, so the path is NOT lower-cased.
  expect(normalizeEndpointKey('https://central.example.com/Team')).not.toBe(normalizeEndpointKey('https://central.example.com/team'))
  expect(normalizeEndpointKey('https://central.example.com/Team')).toBe('https://central.example.com/Team')
  // http and https are different endpoints (different port, different trust).
  expect(normalizeEndpointKey('http://central.example.com')).not.toBe(normalizeEndpointKey('https://central.example.com'))
})

test('normalizeEndpointKey: the query string is KEPT and the fragment is DROPPED', () => {
  // A query can carry routing information a proxy acts on, so it stays part of the identity.
  expect(normalizeEndpointKey('https://central.example.com/?tenant=a')).toBe('https://central.example.com?tenant=a')
  expect(normalizeEndpointKey('https://central.example.com/?tenant=a'))
    .not.toBe(normalizeEndpointKey('https://central.example.com/?tenant=b'))
  // A fragment is never sent to a server, so it cannot distinguish two centrals.
  expect(normalizeEndpointKey('https://central.example.com#anything')).toBe(normalizeEndpointKey('https://central.example.com'))
})

test('normalizeEndpointKey: unparseable input still compares consistently instead of throwing', () => {
  expect(normalizeEndpointKey('NOT a url/')).toBe('not a url')
  expect(normalizeEndpointKey('')).toBe('')
  expect(normalizeEndpointKey(undefined as unknown as string)).toBe('')
  expect(normalizeEndpointKey(null as unknown as string)).toBe('')
})

// ---------------------------------------------------------------------------
// The legacy mirror is DERIVED, never frozen (review Critical 1) + the '' fold (Important 3).
// ---------------------------------------------------------------------------

import type { TeamConnection } from './team'

function ruleConn(extra: Partial<TeamConnection> = {}): TeamConnection {
  return {
    id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't',
    deniedRepos: [], shareMode: 'denylist', sources: [], ...extra,
  }
}

test('normalizeTeamConfig: the legacy deniedRepos mirror is rebuilt from sources on every write', () => {
  const out = normalizeTeamConfig({
    mode: 'member',
    connections: [ruleConn({
      // A STALE mirror — exactly the shape a PATCH that wrote only `sources` used to leave behind.
      deniedRepos: ['github.com/o/old'],
      sources: [
        { type: 'repo', value: 'github.com/o/secret' },
        { type: 'none', value: '' },
        { type: 'repo', value: 'github.com/o/other' },
      ],
    })],
  })
  expect(out.connections[0]!.deniedRepos).toEqual(['github.com/o/secret', NO_REPO_KEY, 'github.com/o/other'])
  expect(out.schema).toBe(2)
})

test('normalizeTeamConfig: an allowlist connection writes an EMPTY mirror and bumps the schema', () => {
  const out = normalizeTeamConfig({
    mode: 'member',
    connections: [ruleConn({
      deniedRepos: ['github.com/o/old'],
      shareMode: 'allowlist',
      sources: [{ type: 'repo', value: 'github.com/o/only' }],
    })],
  })
  // An empty mirror alone reads as "no restriction" to an older reader — hence the schema bump.
  expect(out.connections[0]!.deniedRepos).toEqual([])
  expect(out.schema).toBe(3)
})

test('normalizeTeamConfig: a project source also bumps the schema — the mirror cannot express it', () => {
  const out = normalizeTeamConfig({
    mode: 'member',
    connections: [ruleConn({ sources: [{ type: 'project', value: '/home/u/work' }] })],
  })
  expect(out.connections[0]!.deniedRepos).toEqual([])
  expect(out.schema).toBe(3)
})

test('normalizeTeamConfig: a connection with NO sources key keeps its stored mirror verbatim', () => {
  // Nothing to derive from — this is a hand-built/legacy connection, and wiping its denylist
  // here would be the fail-open the derivation exists to prevent.
  const out = normalizeTeamConfig({
    mode: 'member',
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't',
      deniedRepos: ['github.com/o/secret'],
    }],
  })
  expect(out.connections[0]!.deniedRepos).toEqual(['github.com/o/secret'])
})

test("migrateTeamConfig: a stored deniedRepos [''] becomes the `none` source, never repo ''", () => {
  // normalizeDenied folds '' into the sentinel deliberately (NO_REPO_KEY's docstring calls the
  // empty string there a fail-open privacy bug); mapping it to {type:'repo', value:''} instead
  // makes sourceKey drop it and un-blocks the unattributed bucket.
  const out = migrateTeamConfig({
    mode: 'member',
    connections: [{ id: 'c_aaaaaaaaaaaa', endpoint: 'http://c:48080', org: 'default', user: 'u', token: 't', deniedRepos: [''] }],
  })
  expect(out.connections[0]!.sources).toEqual([{ type: 'none', value: '' }])
  expect(out.connections[0]!.deniedRepos).toEqual([NO_REPO_KEY])
})

test('migrateTeamConfig preserves the remote-session switches — the field-by-field rebuild drops anything not listed', () => {
  // The exact bug this file already records for `machineName`: the switches were written to disk
  // correctly and read back as OFF, because every read runs the stored config through this
  // reconstruction. The central is told whatever the read produces, so a dropped field is a
  // consent silently reverted.
  const out = migrateTeamConfig({
    mode: 'member',
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'https://c.example.com', org: 'o', user: 'u', token: 't',
      deniedRepos: [], allowRemoteSessions: true, allowRemoteScreens: true,
    }],
  })
  expect(out.connections[0]!.allowRemoteSessions).toBe(true)
  expect(out.connections[0]!.allowRemoteScreens).toBe(true)
})

test('migrateTeamConfig leaves an absent switch absent, and ignores a non-boolean one', () => {
  // Absent must stay absent rather than becoming `false`: the two are read the same way, but
  // writing one on every read would mark the config changed on every unrelated write.
  const bare = migrateTeamConfig({
    mode: 'member',
    connections: [{ id: 'c_aaaaaaaaaaaa', endpoint: 'https://c.example.com', org: 'o', user: 'u', token: 't', deniedRepos: [] }],
  })
  expect(bare.connections[0]!.allowRemoteSessions).toBeUndefined()
  expect(bare.connections[0]!.allowRemoteScreens).toBeUndefined()

  const junk = migrateTeamConfig({
    mode: 'member',
    connections: [{
      id: 'c_aaaaaaaaaaaa', endpoint: 'https://c.example.com', org: 'o', user: 'u', token: 't',
      deniedRepos: [], allowRemoteSessions: 'yes', allowRemoteScreens: 1,
    }],
  })
  expect(junk.connections[0]!.allowRemoteSessions).toBeUndefined()
  expect(junk.connections[0]!.allowRemoteScreens).toBeUndefined()
})
