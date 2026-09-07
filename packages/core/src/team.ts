import type { SessionMeta, HarnessId, StatsCache } from './types'
import { HARNESS_ORDER } from './types'

// NOTHING in this file may import `node:crypto`. It is re-exported by core's barrel and core is
// bundled into packages/web by Vite, which replaces Node builtins with a shim that THROWS on
// first use — so the first web component calling connectionId() or migrateTeamConfig() would
// fail at runtime, in the code path that mints connection ids. The global `crypto` (Bun,
// browsers, Node 18+) covers randomUUID; the legacy id needs no cryptography (see below).

// ---------------------------------------------------------------------------
// TeamConfig — shared member configuration (single source of truth)
// ---------------------------------------------------------------------------

/** The sentinel repo key for sessions with no resolvable git remote. NEVER '' — an empty
 *  string is eaten by any `.filter(Boolean)` in the UI or CLI path, which would turn
 *  "block unattributed work" into "block nothing": a fail-open privacy bug. */
export const NO_REPO_KEY = '__no_repo__'

/** What a rule can be keyed on: a repository (canonical remote key), a project (its path), or
 *  the `none` bucket — sessions that resolve to no repository at all. */
export type ShareSourceType = 'repo' | 'project' | 'none'

export interface ShareSource {
  type: ShareSourceType
  /** Canonical repo key, or the project path, or '' for the `none` bucket. */
  value: string
}

export interface TeamConnection {
  /** Local, opaque, filesystem-safe handle. NEVER sent to a central. */
  id: string
  /** Central base URL, no trailing slash. The uniqueness key across connections[]. */
  endpoint: string
  /** Org namespace used on the central. */
  org: string
  /** Display name resolved from GET /api/team/whoami — never user-typed. Per connection,
   *  because each central mints its own token and resolves its own name. */
  user: string
  /**
   * What the CENTRAL calls this machine, resolved from `whoami` alongside `user`.
   *
   * Per connection, for the same reason `user` is: each central mints its own token and names the
   * machine itself. Optional because an older central does not send one and a connection that has
   * never completed a handshake has not learned it yet — absent means unknown, never a hostname
   * substituted for it.
   */
  machineName?: string
  /** Bearer secret (never logged). May be '' against an open/legacy central. */
  token: string
  /** LEGACY MIRROR of `sources`, DERIVED on every write by `normalizeTeamConfig` — never edited
   *  by hand and never a second source of truth. It exists because an older binary (or a
   *  container sharing ~/.agentistics), the shipped repository picker and `agentop status` all
   *  still read it; leaving it frozen while `sources` moved on made those readers describe rules
   *  that were no longer in force, and the picker then PATCHed that stale draft back, silently
   *  un-blocking a repository. It can only express "these repo keys, plus the unattributed
   *  bucket, are blocked" — see `legacyMirrorOf` / `TEAM_SCHEMA_TYPED_RULES`. */
  deniedRepos: string[]
  /** 'denylist' (share everything except `sources`) | 'allowlist' (share only `sources`).
   *  ABSENT reads as 'denylist' — every config that predates this field already behaves as a
   *  denylist, and defaulting to anything else would silently invert live privacy rules. */
  shareMode?: 'denylist' | 'allowlist'
  /** The typed rule list. Replaces `deniedRepos`, which is kept as a read migration source. */
  sources?: ShareSource[]
  /** Member-side mirror of the central's cadence; the central still owns the floor. */
  pushIntervalSec?: number
  /** Optional nickname for THE CENTRAL this connection points at (the card's title); falls back to
   *  the endpoint host. It never names, and may never mask, the MACHINE — the card resolves that
   *  from the central's own `machineName` and otherwise from the host (`cardIdentity.ts`).
   *  WRITE-NOTHING from the web
   *  UI — the display name is set by the CENTRAL on the minted token (`GET /api/team/whoami`'s
   *  `machineName`), never by the machine itself, so nothing in `components/team/` may create or
   *  edit this field anymore. It stays here, and is still READ, only because an older config (or
   *  `agentop member connect --label`, a CLI-only flag that still POSTs a label at connect time)
   *  may carry one; dropping the field outright would rename an existing card on upgrade. The
   *  server's `PATCH /api/team/connections/:id { label }` route also still accepts it, but the web
   *  UI is not, and must never become, a caller of that path. */
  label?: string
  /** ISO — deterministic card ordering. */
  addedAt?: string
  /**
   * This machine's consent for THIS central to manage its sessions. Absent reads as OFF — see
   * `remoteSessions.ts`, which is the only place the two switches are interpreted.
   *
   * Per CONNECTION rather than per machine, like every other rule on this type: consent is given to
   * one central, and a machine connected to two has no reason to give both the same answer. The
   * ask was phrased per machine because most machines have one connection.
   *
   * Unlike `shareMode`/`sources`, these two DO travel to the central — announced by the machine
   * over the reverse channel, never asked for. That is not an inconsistency: a sharing rule is
   * enforced by the member simply not sending the data, so the central learning it would add
   * exposure and buy nothing; this one has to be readable by the account that owns the machine, on
   * the central, or the only way to discover why a fleet is empty is to walk to the machine.
   */
  allowRemoteSessions?: boolean
  /** Additionally let the session SCREEN travel (and with it `approve`/`prompt`). Never in force
   *  while `allowRemoteSessions` is off — `resolveRemoteConsent` is what applies that. */
  allowRemoteScreens?: boolean
  /** ISO — set once this connection's auth failures have been REJECTED (401/403) continuously
   *  for at least `AUTH_FAIL_SUSTAIN_MS` (team-uploader.ts). While set, pushes are paused (a
   *  central that is rejecting the token is never hammered) but the connection and its
   *  `deniedRepos` are kept — an auth failure must never delete a connection, only mark it. A
   *  transient blip (e.g. a central restart recreating its DB) clears on the very next success
   *  and never reaches this field at all. Absent = never marked / already recovered. */
  authFailedAt?: string
}

/** The shape every reader since the multi-connection migration understands: `connections[]` whose
 *  rules are fully expressed by the legacy `deniedRepos` mirror. */
export const TEAM_SCHEMA_BASE = 2
/** Stamped INSTEAD of `TEAM_SCHEMA_BASE` as soon as any connection's rules cannot be expressed by
 *  that mirror — an `allowlist` connection, or any `project` source. Both cases mirror as an EMPTY
 *  `deniedRepos`, and an empty mirror is exactly what "no restriction at all" looks like to a
 *  reader that only knows `deniedRepos`: it would share the very repositories the user restricted.
 *  The version marker is therefore load-bearing, not bookkeeping — it is the only thing that lets a
 *  reader tell "nothing is blocked" from "the rules are in a shape I cannot read". */
export const TEAM_SCHEMA_TYPED_RULES = 3

export interface TeamConfig {
  /** Written by this version and above. Absent means an older client wrote it. */
  schema?: 2 | 3
  mode: 'solo' | 'member'
  connections: TeamConnection[]
  /** Legacy MIRROR of connections[0]. Still written for one release so an older binary or
   *  a container sharing ~/.agentistics keeps working. Read by migrateTeamConfig. */
  endpoint?: string
  org?: string
  user?: string
  token?: string
  pushIntervalSec?: number
}

/** A FRESH default team config. Use this anywhere the value is about to be spread or mutated —
 *  a module-level const's `connections: []` is aliased by every `{ ...DEFAULT_TEAM }`, so one
 *  caller's `push()` would land in every other caller's array. */
export function defaultTeam(): TeamConfig {
  return { schema: 2, mode: 'solo', connections: [] }
}

/** Frozen (array included) so a stray mutation throws in strict mode instead of corrupting
 *  shared state. Kept exported for compatibility; prefer `defaultTeam()`. */
export const DEFAULT_TEAM: TeamConfig = Object.freeze({
  schema: 2, mode: 'solo', connections: Object.freeze([]) as unknown as TeamConnection[],
}) as TeamConfig

const ID_RE = /^c_[a-f0-9]{12}$/

/** A fresh random handle, minted once when a connection is added. The GLOBAL `crypto` — present
 *  in Bun, in browsers and in Node 18+ — so core stays free of `node:crypto`. */
export function connectionId(): string {
  return 'c_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/** FNV-1a, 32 bits, as an 8-char lowercase hex string. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // h *= 16777619, in 32-bit arithmetic without overflowing the double mantissa.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The handle used ONLY by the legacy migration. It must be deterministic: migrateTeamConfig
 * runs in a read path, and a random id there would mint a different handle on every read
 * until something persisted it — a new sent-state file, a full re-push and a new WebSocket
 * every cycle, forever.
 *
 * A NON-CRYPTOGRAPHIC hash (FNV-1a, twice, for 12 hex chars) is deliberate and sufficient: the
 * id is a LOCAL filesystem handle for `connections/team-sent-<id>.json`, it is never sent to a
 * central, it guards nothing and reveals nothing (its inputs are already on this disk in clear),
 * and uniqueness inside `connections[]` is checked at mint time. Using sha256 here would drag
 * `node:crypto` into the browser bundle for no security gain. `denialSignature()` in
 * share-rules.ts is a different question — it stays sha256 and stays server-side.
 */
export function legacyConnectionId(endpoint: string, token: string): string {
  const seed = `${endpoint}\0${token}`
  // Two rounds over differently-salted inputs: one FNV-1a is 32 bits wide, the id is 48.
  return 'c_' + (fnv1a(seed) + fnv1a('id' + seed)).slice(0, 12)
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Normalize an endpoint into a STABLE identity key for comparison/dedup — never for storage or
 * display, which keep the endpoint exactly as entered. Lower-cases the HOST only (path case can
 * be meaningful, e.g. a case-sensitive route on a reverse proxy) and folds each scheme's default
 * port, so `https://Central.example.com:443/` and `https://central.example.com` compare equal.
 * Without this, `https://Central.example.com` re-added against a stored
 * `https://central.example.com` reads as a brand-new endpoint and inserts a second connection —
 * exactly the double-count-under-two-`memberId`s failure endpoint-uniqueness exists to prevent.
 * Falls back to a trimmed-slash, lower-cased string for anything that does not parse as a URL, so
 * a malformed value still compares consistently instead of throwing. Pure.
 */
export function normalizeEndpointKey(url: string): string {
  const trimmed = trimSlashes((url ?? '').trim())
  try {
    const u = new URL(trimmed)
    const defaultPort = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : ''
    const port = u.port && u.port !== defaultPort ? `:${u.port}` : ''
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${trimSlashes(u.pathname)}${u.search}`
  } catch {
    return trimmed.toLowerCase()
  }
}

/**
 * The legacy `deniedRepos` mirror for one connection, DERIVED from its typed rules — the single
 * writer of that field. Only a DENYLIST of repo keys is expressible:
 *  - `allowlist` mode mirrors as `[]`, because the legacy shape has no way to say "share only
 *    these". The empty list is not the whole answer (it reads as "share everything") — the schema
 *    bump is; see `TEAM_SCHEMA_TYPED_RULES`.
 *  - `project` sources are dropped for the same reason, and bump the schema likewise.
 *  - `none` — and, defensively, an empty `value` on any repo source — folds to `NO_REPO_KEY`, the
 *    same fold `normalizeDenied` performs: `''` is eaten by any `.filter(Boolean)` downstream,
 *    which turns "block unattributed work" into "block nothing".
 * Order is preserved and duplicates collapse. Pure.
 */
function legacyMirrorOf(c: TeamConnection): string[] {
  if (c.shareMode === 'allowlist') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of c.sources ?? []) {
    if (!s || s.type === 'project') continue
    const key = s.type === 'none' || s.value === '' ? NO_REPO_KEY : s.value
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** Whether `legacyMirrorOf` loses nothing for this connection. False → the config must carry
 *  `TEAM_SCHEMA_TYPED_RULES` so a reader that only knows the mirror can tell it is incomplete
 *  instead of reading it as "no restrictions". Pure. */
function mirrorExpressesRules(c: TeamConnection): boolean {
  if (c.shareMode === 'allowlist') return false
  return !(c.sources ?? []).some(s => s && s.type === 'project')
}

/** Force `mode` from connections.length, stamp the schema, and rebuild the legacy mirrors —
 *  `deniedRepos` is DERIVED from `sources` here and nowhere else, so every write path (POST,
 *  PATCH, the uploader, the migration) leaves the two describing the same rules. A connection
 *  carrying NO `sources` key at all is the one exception: there is nothing to derive from, and
 *  blanking its stored denylist would be the fail-open this derivation exists to prevent.
 *  Pure — returns a new object with a new array. */
export function normalizeTeamConfig(cfg: TeamConfig): TeamConfig {
  const connections = cfg.connections.map(c => ({
    ...c,
    deniedRepos: c.sources ? legacyMirrorOf(c) : [...c.deniedRepos],
    ...(c.sources ? { sources: c.sources.map(s => ({ ...s })) } : {}),
  }))
  const first = connections[0]
  return {
    schema: connections.every(mirrorExpressesRules) ? TEAM_SCHEMA_BASE : TEAM_SCHEMA_TYPED_RULES,
    mode: connections.length > 0 ? 'member' : 'solo',
    connections,
    endpoint: first?.endpoint ?? '',
    org: first?.org ?? 'default',
    user: first?.user ?? '',
    token: first?.token ?? '',
    ...(first?.pushIntervalSec !== undefined ? { pushIntervalSec: first.pushIntervalSec } : {}),
  }
}

const SHARE_SOURCE_TYPES = new Set<ShareSourceType>(['repo', 'project', 'none'])

/** `shareMode` absent (or junk) reads as `'denylist'` — every config that predates this field is
 *  already a denylist, and defaulting to anything else would silently invert live privacy rules. */
function migrateShareMode(entry: Partial<TeamConnection> & Record<string, unknown>): 'denylist' | 'allowlist' {
  return entry.shareMode === 'allowlist' ? 'allowlist' : 'denylist'
}

/** Derive the typed `sources` list. An entry that already carries `sources` is trusted as-is
 *  (sanitized); one that doesn't is migrated from the legacy `deniedRepos` denylist, mapping
 *  `NO_REPO_KEY` — AND a bare `''`, the fold `normalizeDenied` has always performed — to the typed
 *  `none` bucket. Mapping `''` to `{type:'repo', value:''}` instead would produce a source
 *  `sourceKey` drops, silently un-blocking the unattributed bucket on a config where it was
 *  blocked. Pure. */
function migrateSources(entry: Partial<TeamConnection> & Record<string, unknown>, deniedRepos: string[]): ShareSource[] {
  if (Array.isArray(entry.sources)) {
    return (entry.sources as unknown[])
      .filter((s): s is ShareSource =>
        !!s && typeof s === 'object' &&
        SHARE_SOURCE_TYPES.has((s as ShareSource).type) &&
        typeof (s as ShareSource).value === 'string')
      .map(s => ({ type: s.type, value: s.value }))
  }
  return deniedRepos.map(v => (v === NO_REPO_KEY || v === '')
    ? { type: 'none' as const, value: '' }
    : { type: 'repo' as const, value: v })
}

/**
 * Shape migration — pure, deterministic, idempotent, safe in a read path.
 * MUST return a fresh object with a fresh array on every call: DEFAULT_PREFS.team is spread
 * into every preferences read, and an aliased array becomes a live cross-caller bug.
 */
export function migrateTeamConfig(raw: unknown): TeamConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return normalizeTeamConfig({ mode: 'solo', connections: [] })
  const r = raw as Partial<TeamConfig> & Record<string, unknown>
  const flatEndpoint = trimSlashes(typeof r.endpoint === 'string' ? r.endpoint : '')

  // Already migrated → sanitize in place.
  if (Array.isArray(r.connections)) {
    const seenId = new Set<string>()
    const seenEndpoint = new Set<string>()
    const connections: TeamConnection[] = []
    for (const entry of r.connections as Partial<TeamConnection>[]) {
      if (!entry || typeof entry !== 'object') continue
      const endpoint = trimSlashes(typeof entry.endpoint === 'string' ? entry.endpoint : '')
      if (!endpoint) continue
      if (seenEndpoint.has(endpoint)) continue
      let id = typeof entry.id === 'string' && ID_RE.test(entry.id) ? entry.id : connectionId()
      while (seenId.has(id)) id = connectionId()
      seenId.add(id)
      seenEndpoint.add(endpoint)
      const deniedRepos = Array.isArray(entry.deniedRepos) ? entry.deniedRepos.filter(x => typeof x === 'string') : []
      connections.push({
        id,
        endpoint,
        org: typeof entry.org === 'string' && entry.org ? entry.org : 'default',
        user: typeof entry.user === 'string' ? entry.user : '',
        token: typeof entry.token === 'string' ? entry.token : '',
        deniedRepos,
        shareMode: migrateShareMode(entry),
        sources: migrateSources(entry, deniedRepos),
        ...(typeof entry.pushIntervalSec === 'number' ? { pushIntervalSec: entry.pushIntervalSec } : {}),
        ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
        ...(typeof entry.addedAt === 'string' ? { addedAt: entry.addedAt } : {}),
        ...(typeof entry.authFailedAt === 'string' ? { authFailedAt: entry.authFailedAt } : {}),
        // Missing here silently dropped the field on EVERY write, not only ones touching the
        // connection itself: `readEffective` runs whatever is already on disk through this exact
        // reconstruction before any mutate callback ever sees `current` — so a name the central
        // had just resolved read as unresolved again the instant anything else wrote to
        // preferences.json (a session-view change, a language toggle, a note). Measured live:
        // `resolveMemberIdentity` persisted it correctly and a raw disk read confirmed it at
        // +200ms; by +2.2s, with no OTHER write traced anywhere in that window, it was gone.
        ...(typeof entry.machineName === 'string' && entry.machineName ? { machineName: entry.machineName } : {}),
        // Same trap as `machineName` above, and it bit the same way: the switches persisted
        // correctly and then read back as OFF, because `readEffective` runs the stored config
        // through this reconstruction before any mutate callback sees it. A consent that silently
        // reverts to "no" is the harmless direction of the bug and still a lie about what the user
        // chose — and the central is told whatever this read produces.
        ...(typeof entry.allowRemoteSessions === 'boolean' ? { allowRemoteSessions: entry.allowRemoteSessions } : {}),
        ...(typeof entry.allowRemoteScreens === 'boolean' ? { allowRemoteScreens: entry.allowRemoteScreens } : {}),
      })
    }
    // An EMPTY sanitized array is NOT proof of "solo", and treating it as authoritative was a
    // silent no-op for `agentop member connect` and the web "Connect to central" flow: both
    // persist `{ ...defaultTeam(), mode: 'member', endpoint, token }` — an empty connections
    // array ALONGSIDE the legacy flat fields — so the next read produced mode 'solo' with a
    // blanked mirror. The uploader never pushed and no WebSocket ever opened, while the CLI
    // printed "connected as <name>". When the array yields nothing but a flat endpoint IS
    // present, the legacy branch below is the truthful reading.
    if (connections.length > 0 || !flatEndpoint) {
      return normalizeTeamConfig({ mode: 'solo', connections })
    }
  }

  // Legacy flat config. Guard on `endpoint` ALONE — not on mode (cli-setup and the web solo
  // path write a solo object that still carries empty-string endpoint/token, and fabricating
  // a connection from those would start an uploader on a solo machine), and not on token
  // (a token-less member against an open/legacy central is a live shape; requiring one would
  // silently drop those members to solo and stop their pushes).
  const endpoint = flatEndpoint
  if (endpoint) {
    const token = typeof r.token === 'string' ? r.token : ''
    return normalizeTeamConfig({
      mode: 'member',
      connections: [{
        id: legacyConnectionId(endpoint, token),
        endpoint,
        org: typeof r.org === 'string' && r.org ? r.org : 'default',
        user: typeof r.user === 'string' ? r.user : '',
        token,
        deniedRepos: [],
        shareMode: 'denylist',
        sources: [],
        ...(typeof r.pushIntervalSec === 'number' ? { pushIntervalSec: r.pushIntervalSec } : {}),
      }],
    })
  }

  return normalizeTeamConfig({ mode: 'solo', connections: [] })
}

/** Read connections off a preferences object without ever throwing. Exists so the three
 *  web-local DEFAULT_TEAM_CONFIG duplicates can be deleted — leaving them would spread
 *  `connections: undefined` over a loaded prefs object and `.map` would throw. */
export function readTeamConnections(prefs: { team?: TeamConfig } | null | undefined): TeamConnection[] {
  const list = prefs?.team?.connections
  return Array.isArray(list) ? list : []
}

// ---------------------------------------------------------------------------
// Push interval — central-controlled cadence (Phase 6)
// ---------------------------------------------------------------------------

/** Bounds and default for the push interval, in seconds. */
export const PUSH_INTERVAL = {
  MIN_SEC: 15,
  MAX_SEC: 3600,
  DEFAULT_SEC: 30,
  // Express mode floor — the central may dictate intervals shorter than MIN_SEC
  // (down to this value) when the admin enables express mode.
  EXPRESS_MIN_SEC: 5,
} as const

/**
 * Clamp a push-interval value (seconds) to [minSec, MAX_SEC].
 * Non-finite, NaN, or <= 0 values fall back to DEFAULT_SEC.
 * In-range values are rounded to the nearest second. `minSec` defaults to the
 * normal MIN_SEC; pass EXPRESS_MIN_SEC to allow the central's express intervals.
 */
export function clampPushInterval(sec: number, minSec: number = PUSH_INTERVAL.MIN_SEC): number {
  if (!Number.isFinite(sec) || sec <= 0) return PUSH_INTERVAL.DEFAULT_SEC
  const rounded = Math.round(sec)
  if (rounded < minSec) return minSec
  if (rounded > PUSH_INTERVAL.MAX_SEC) return PUSH_INTERVAL.MAX_SEC
  return rounded
}

/** Tag a session with its owning user (team mode). Pure — returns a new object. */
export function tagUser(session: SessionMeta, user: string): SessionMeta {
  return { ...session, user }
}

/** Distinct, sorted list of users present in a session list. Skips undefined. Pure. */
export function distinctUsers(sessions: SessionMeta[]): string[] {
  const set = new Set<string>()
  for (const s of sessions) if (s.user) set.add(s.user)
  return Array.from(set).sort()
}

/** Distinct, sorted list of harnesses present in a session list (missing harness = 'claude').
 *  Sorted by the canonical order claude→codex→gemini→copilot→antigravity. Pure. */
export function distinctHarnesses(sessions: { harness?: HarnessId }[]): HarnessId[] {
  const order: HarnessId[] = HARNESS_ORDER
  const set = new Set<HarnessId>()
  for (const s of sessions) set.add(s.harness ?? 'claude')
  return order.filter(h => set.has(h))
}

/** Multi-select user predicate. Empty/undefined selection = all sessions pass.
 *  Sessions with no `user` are excluded when a selection is active. Pure. */
export function filterByUsers<T extends { user?: string }>(sessions: T[], users: string[]): T[] {
  if (!users || users.length === 0) return sessions
  const set = new Set(users)
  return sessions.filter(s => !!s.user && set.has(s.user))
}

/** Multi-select harness predicate. Empty/undefined selection = all sessions pass.
 *  Sessions with no `harness` field are treated as 'claude'. Pure. */
export function filterByHarnesses<T extends { harness?: HarnessId }>(sessions: T[], harnesses: HarnessId[]): T[] {
  if (!harnesses || harnesses.length === 0) return sessions
  const set = new Set(harnesses)
  return sessions.filter(s => set.has(s.harness ?? 'claude'))
}

/** Multi-select team predicate (central). Empty/undefined = all pass. A session passes if ANY of its
 *  teams is selected (a machine can be in several teams); falls back to the single `teamId` on legacy
 *  data. Sessions with no team are excluded when a selection is active. Pure. */
export function filterByTeams<T extends { teamId?: string; teamIds?: string[] }>(sessions: T[], teams: string[]): T[] {
  if (!teams || teams.length === 0) return sessions
  const set = new Set(teams)
  return sessions.filter(s => {
    const ids = (s.teamIds && s.teamIds.length) ? s.teamIds : (s.teamId ? [s.teamId] : [])
    return ids.some(t => set.has(t))
  })
}

/** Multi-select machine predicate (central). Empty/undefined = all pass. Matches `session.memberId`
 *  (the machine's token hash); sessions with no memberId are excluded when active. Pure. */
export function filterByMachines<T extends { memberId?: string }>(sessions: T[], machines: string[]): T[] {
  if (!machines || machines.length === 0) return sessions
  const set = new Set(machines)
  return sessions.filter(s => !!s.memberId && set.has(s.memberId))
}

export interface MachineScopeInput {
  machineOwners?: Record<string, { user: string; teamIds: string[] }>
  machineStatsCaches?: Record<string, StatsCache>
  /** Selected members (display names), teams and machines — the live filter selection. */
  users: string[]
  teams: string[]
  machines: string[]
  /** Presence scope, when one is in force. `null` = every member allowed. */
  allowedUsers?: Set<string> | null
}

/**
 * Resolve a machine/team selection to the exact set of `machineStatsCaches` keys whose merge
 * reproduces that scope's authoritative deep history.
 *
 * WHY this exists: `userStatsCaches` is keyed by display name and already SUMS a member's
 * machines, so a machine or team selection could not be served from it and fell back to summing
 * the individual session documents — which only cover the sessions still stored one-by-one. The
 * same scope therefore reported a fraction of what selecting the member reported (a member with
 * two machines showed 835 sessions by member and 225 by his own two machines).
 *
 * Returns `null` when the caches cannot serve the scope faithfully — no machine maps at all, no
 * machine/team dimension selected, or any machine in scope missing its cache. `null` means
 * "fall back to the per-session sum", i.e. the previous behaviour, so this can only ever add
 * precision, never invent it. Pure.
 */
export function resolveMachineCacheScope(input: MachineScopeInput): string[] | null {
  const { machineOwners, machineStatsCaches, users, teams, machines, allowedUsers } = input
  if (!machineOwners || !machineStatsCaches) return null
  // Not a machine/team question — the member path (userStatsCaches) already answers it exactly.
  if (teams.length === 0 && machines.length === 0) return null

  const machineSet = new Set(machines)
  const teamSet = new Set(teams)
  const userSet = new Set(users)

  // A machine explicitly selected but unknown to the tokens table means the two views disagree
  // about what exists; summing the rest would silently drop it.
  if (machines.some(id => !machineOwners[id])) return null

  const scope = Object.entries(machineOwners)
    .filter(([id, m]) => {
      if (machines.length > 0 && !machineSet.has(id)) return false
      if (teams.length > 0 && !m.teamIds.some(t => teamSet.has(t))) return false
      if (users.length > 0 && !userSet.has(m.user)) return false
      if (allowedUsers && !allowedUsers.has(m.user)) return false
      return true
    })
    .map(([id]) => id)

  // A machine in scope with no cache would be counted as zero — under-report rather than admit it.
  if (scope.some(id => !machineStatsCaches[id])) return null
  // A selection that resolves to NO machine is not an authoritative empty history — it means this
  // viewer's `machineOwners` cannot express the selection. A scoped principal (a manager) receives
  // the map pruned to the machines they may see, and a machine that was never linked to a team is
  // absent from every team's scope, so `[]` here is "I don't know", not "zero". Returning it made
  // the caller merge an EMPTY statsCache and render a confident 0 across every KPI. Fall back.
  if (scope.length === 0) return null
  return scope
}


// Machine connect token (optionally carries the central endpoint)
// The bearer sent to the central is ALWAYS the raw secret. When the central has a public URL
// configured, the token shown to the user is a composite that also carries the endpoint, so
// pasting it on a machine auto-fills the URL. Backward compatible: a raw secret parses fine.

/** Pack a connect token, embedding the endpoint when provided. */
export function packConnectToken(secret: string, endpoint?: string): string {
  const url = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!url) return secret
  // btoa exists in Bun + browsers; make it URL-safe (no +,/,=).
  const enc = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `act1_${enc}.${secret}`
}

/** Parse a connect token → { endpoint?, secret }. A raw secret (no embedded URL) returns
 *  just { secret }. The secret is what must be sent to the central as the bearer. */
export function unpackConnectToken(token: string): { endpoint?: string; secret: string } {
  const t = (token ?? '').trim()
  if (t.startsWith('act1_') && t.includes('.')) {
    const rest = t.slice('act1_'.length)
    const dot = rest.indexOf('.')
    const enc = rest.slice(0, dot)
    const secret = rest.slice(dot + 1)
    try {
      const endpoint = atob(enc.replace(/-/g, '+').replace(/_/g, '/'))
      if (endpoint && secret) return { endpoint, secret }
    } catch { /* fall through to raw */ }
  }
  return { secret: t }
}
