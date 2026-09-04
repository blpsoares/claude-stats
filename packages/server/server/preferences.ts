import { join, dirname } from 'path'
import { mkdir, rename, writeFile, open, unlink, stat, readFile, utimes } from 'node:fs/promises'
import { AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR, CLAUDE_DIR } from './config'
import type { BillingSettings, SavedComparison, TeamConfig } from '@agentistics/core'
import { migrateTeamConfig } from '@agentistics/core'
// TYPE-only, and the allowed direction: `server -> tui`. The arrangements are declared once, in
// `session-dimensions.ts`, and this file stores whichever one was chosen.
import type { SessionGroupingId } from '@agentistics/tui/control'
// The searchable dimensions, declared once in the TUI's `search-scope.ts` and stored here — the
// same `server -> tui` direction, and the same single-source rule as `SessionGroupingId`: a scope
// added there fails this build until it is handled, rather than being silently un-persistable.
import { SEARCH_SCOPES, type SearchScope } from '@agentistics/tui/control/search-scope'

// Preferences live in the writable ~/.agentistics dir. The legacy location under CLAUDE_DIR
// is read-only in Docker (host ~/.claude mounted :ro), which silently broke persistence and
// re-asked the consent gate every launch. We still READ the legacy file (and migrate it) so
// native installs that predate this change keep their saved choices.
export const PREFERENCES_FILE = join(AGENTISTICS_DATA_DIR, 'preferences.json')
const LEGACY_PREFERENCES_PATH = join(CLAUDE_DIR, 'agentistics-preferences.json')

/** Trailing separators are not part of a directory's identity — `AGENTISTICS_DIR=/tmp/x/` and
 *  `/tmp/x` name the same place, and a raw string compare would treat one of them as isolated
 *  and the other as the default install. Pure; no filesystem access, no cwd. */
function sameDir(a: string, b: string): boolean {
  const strip = (p: string) => p.replace(/[\\/]+$/, '')
  return strip(a) === strip(b)
}

/**
 * Which legacy file — if any — may seed `dataDir`, given the default install location.
 *
 * PURE. Returns `legacyFile` only for the DEFAULT data directory, and `null` for every other
 * one, which is what makes the answer a fact about the directory rather than about whether an
 * env var happened to be set: `AGENTISTICS_DIR` pointed AT the default still migrates.
 *
 * Why the restriction exists — a real, reproduced defect, not tidiness. `LEGACY_PREFERENCES_PATH`
 * is derived from `CLAUDE_DIR`, the one persisted path in this product that is NOT under
 * `AGENTISTICS_DATA_DIR`, so the migration read it no matter which data dir the instance was
 * given. Starting a server with a brand-new, empty `AGENTISTICS_DIR` therefore wrote a
 * `preferences.json` into it holding a `mode: 'member'` connection to a central the operator
 * never configured — INCLUDING ITS BEARER TOKEN — and then created the connection state files
 * for it. A second instance on one host, a container with its own volume and a test rig each
 * silently inherited a credential, and would have pushed to that central under it. That is the
 * same class of defect config.ts's header records (three isolated machines each pushing 108
 * sessions belonging to none of them), reached through the one path that had escaped the rule:
 * a path derived from `AGENTISTICS_DIR` may never be seeded from a location outside it.
 *
 * The legacy import itself is still correct where it belongs — `~/.claude/agentistics-preferences.json`
 * is the predecessor of `$HOME/.agentistics/preferences.json` and of nothing else, so native
 * installs that predate the move keep their saved choices.
 */
export function legacyPreferencesSource(
  dataDir: string,
  defaultDataDir: string,
  legacyFile: string,
): string | null {
  return sameDir(dataDir, defaultDataDir) ? legacyFile : null
}

/** `null` on any instance given its own data dir — see `legacyPreferencesSource`. */
export const LEGACY_PREFERENCES_FILE = legacyPreferencesSource(
  AGENTISTICS_DATA_DIR,
  DEFAULT_AGENTISTICS_DATA_DIR,
  LEGACY_PREFERENCES_PATH,
)

export interface CustomGridItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
  componentId: string
}

export interface Preferences {
  customLayout?: CustomGridItem[]
  monthlyBudgetUSD?: number | null
  cardOrder?: string[]
  lang?: 'pt' | 'en'
  theme?: 'dark' | 'light'
  currency?: 'USD' | 'BRL'
  cardPrecision?: Record<string, boolean>
  chatModel?: string
  chatSoundEnabled?: boolean
  /** Whether this machine serves the chat at all. ABSENT READS AS OFF — chat spawns an assistant
   *  CLI on the host, and until it was made opt-in every machine installed for its metrics also
   *  shipped a shell nobody had chosen. It can only ever narrow `CAPS.localChat`; see chat-gate.ts. */
  chatEnabled?: boolean
  /** true once the user dismissed the install prompt with "don't show again".
   *  Persisted server-side (not localStorage) so it survives incognito windows. */
  installDismissed?: boolean
  /** How this machine is actually billed — a timeline of periods per harness, plus the display
   *  basis. Drives the "plan" cost basis; see `billing.ts` in @agentistics/core.
   *
   *  LOCAL ONLY. This never enters `IngestBody`, a team document or an audit event: what someone
   *  pays is theirs, and a central cannot price a fleet from one operator's timeline anyway.
   *  It needs no `redactPreferences` entry — a plan id and a monthly amount are not credentials,
   *  and the writes go through the same shallow merge as every other field, so the settings screen
   *  must always PUT the complete object rather than a partial one. */
  billing?: BillingSettings
  /** Saved comparisons — N filter scopes the user asks about repeatedly, and which of them are
   *  pinned to the Home page. Local only, same as `billing`. */
  comparisons?: SavedComparison[]
  /** How the app preserves session history past Claude's 30-day cleanup.
   *  `undefined` = not chosen yet (the blocking consent gate is shown).
   *    - 'consolidate' = store computed per-session metrics only (~KB, recommended)
   *    - 'full'        = mirror raw transcripts too (heavy, lets you re-read chats)
   *    - 'off'         = do nothing, use Claude's default folder */
  archiveMode?: 'off' | 'consolidate' | 'full'
  /**
   * How often the cockpit refreshes the fleet list and the session detail pane, in milliseconds.
   *
   * `undefined` reads as the built-in default (`SESSION_POLL_DEFAULT_MS`). Clamped to
   * `[SESSION_POLL_MIN_MS, SESSION_POLL_MAX_MS]` on write, never on read — a value saved by an
   * older binary before the floor existed still parses, and `sessionPollMsOrDefault` is where the
   * clamp actually applies. Below the floor the cost is real: each tick captures a `tmux` pane per
   * live session, and a poll faster than the terminal can usefully redraw buys no responsiveness,
   * only load.
   */
  sessionPollMs?: number
  /** How this machine backs itself up. Absent reads as `schedule: 'off'` — a machine must not
   *  start writing gigabytes because it was upgraded. See backup/schedule.ts. */
  backup?: {
    schedule?: 'off' | 'daily' | 'weekly'
    /** Layers a MANUAL run writes when no `--with-*` flag is given. An explicit flag wins. */
    layers?: ('metrics' | 'repos' | 'archive' | 'raw')[]
    /** Layers a SCHEDULED run writes. Deliberately separate: `raw` is 2.4 GB a copy, so a daily
     *  schedule that inherited a manual run's layers would fill a disk. */
    scheduleLayers?: ('metrics' | 'repos' | 'archive' | 'raw')[]
    harnesses?: string[]
    destDir?: string
    keep?: number
    maxBundleBytes?: number
  }
  /**
   * How the cockpit's fleet list was last arranged.
   *
   * Stored here rather than held in the TUI because the control center owns no persistence — the
   * same reason the language lives here. Without it the grouping was per-run state, so every restart
   * threw away the arrangement someone chose, which reads as the screen forgetting on its own.
   */
  sessionView?: {
    /**
     * `SessionGroupingId` and never a union spelled out here.
     *
     * This was a hand-copied list of the arrangements — the third copy of one, beside `GROUPINGS`
     * and `SessionViewPrefs` — which is the pattern CLAUDE.md forbids for harnesses and for the
     * same reason: TypeScript accepts a union with a member missing, so a new arrangement was
     * offered by the menu, accepted by the CLI, and refused only by the type of the file it is
     * saved to.
     */
    grouping: SessionGroupingId
    /**
     * What the list is narrowed to, per dimension — the ONE stored source for every filter.
     *
     * See `session-dimensions.ts`. The five fields under it are DERIVED ON WRITE and read back only
     * by that module's migration, so an older binary still comes up filtered; anything that reads
     * them as the live answer is a bug.
     */
    filters?: Record<string, string[]>
    filtersVersion?: number
    showNamed?: boolean
    showClosed: boolean
    showExited: boolean
    showUnfiled: boolean
    showDone?: boolean
    onlyActive?: boolean
    states?: string[]
    sort?: { by: string; dir: 'asc' | 'desc' }
    hideDetail?: boolean
    marked?: string[]
    /** How the fleet is arranged — a list of rows, or a grid of cards. */
    layout?: 'list' | 'cards'
    /** The session at the top of the open card page: a page number would name other sessions by
     *  the next poll, so the page is remembered by identity. */
    cardAnchor?: string
    /**
     * WHICH scopes the session search looks in — the cumulative set the user has enabled (name,
     * folder, harness, note, task, prompt, transcript). It is a SET, so the "all" control is simply
     * every scope present, and an empty array is a real choice (search nothing but what is typed
     * against no field — the caller decides what an empty set means for its filter).
     *
     * Stored inside `sessionView` because it is part of "how the fleet list was last arranged", and
     * so it rides the SAME whole-object `setSessionView` / PUT `/api/preferences` write every other
     * field here does — no new route, no new setter. Absent = never chosen; read it through
     * `resolveSessionSearchScopes`, which supplies the default and drops any value this build does
     * not know, so an older or hand-edited config degrades to a sane search rather than a crash.
     *
     * The renderer/UI is the TUI's (`j-20260826-fi`); this is only where the choice persists.
     */
    searchScopes?: SearchScope[]
  }
  /**
   * The session TASKS the user has marked finished.
   *
   * A task is a free string on a session, so "finished" cannot live on the sessions — it is a
   * statement about the work, and the work outlives any one of its sessions. Kept here beside the
   * arrangement for the same reason: the control center owns no persistence.
   */
  finishedTasks?: string[]
  /** @deprecated legacy boolean — read by resolveArchiveMode for migration only */
  archiveSessions?: boolean
  /** Team mode configuration. Absent / mode=solo means solo behavior (no push). */
  team?: TeamConfig
  /** Whether the `agentop` control center puts the terminal into mouse-reporting mode.
   *  Absent = on, which is the default the control center assumes. Turned off with `m` in the app
   *  by anyone who would rather keep their terminal's own click-drag text selection. */
  mouse?: boolean
}

export type ArchiveMode = 'off' | 'consolidate' | 'full'

/** Resolve the effective mode, migrating the legacy `archiveSessions` boolean.
 *  Returns undefined when the user has never chosen (gate must be shown). */
export function resolveArchiveMode(p: Preferences): ArchiveMode | undefined {
  if (p.archiveMode) return p.archiveMode
  if (p.archiveSessions === true) return 'full'
  if (p.archiveSessions === false) return 'off'
  return undefined
}

export async function getArchiveMode(): Promise<ArchiveMode | undefined> {
  return resolveArchiveMode(await readPreferences())
}

/** The cockpit's built-in refresh cadence — unchanged from what the feature shipped with. */
export const SESSION_POLL_DEFAULT_MS = 5_000
/** Below this, a tick captures a `tmux` pane per live session more often than a terminal can
 *  usefully redraw — all cost, no perceptible gain. */
export const SESSION_POLL_MIN_MS = 1_000
export const SESSION_POLL_MAX_MS = 30_000
/** The presets offered in the config pane, fastest first. */
export const SESSION_POLL_PRESETS_MS = [1_000, 2_000, SESSION_POLL_DEFAULT_MS, 10_000] as const

export function clampSessionPollMs(ms: number): number {
  if (!Number.isFinite(ms)) return SESSION_POLL_DEFAULT_MS
  return Math.min(SESSION_POLL_MAX_MS, Math.max(SESSION_POLL_MIN_MS, Math.round(ms)))
}

/** The effective poll interval — `undefined` reads as the default, exactly like `archiveMode`. */
export function sessionPollMsOrDefault(p: Preferences): number {
  return p.sessionPollMs !== undefined ? clampSessionPollMs(p.sessionPollMs) : SESSION_POLL_DEFAULT_MS
}

/**
 * The scopes the session search looks in when the user has NEVER chosen — every scope a row carries
 * ON ITS OWN.
 *
 * `transcript` is deliberately OUT of the default: it is the only scope that is not a property of a
 * row but a question asked of the disk (a text scan of every conversation), so making it always-on
 * would put a file walk behind every keystroke. It stays an explicit opt-in the user enables — which
 * is exactly the cumulative control the cockpit is adding. This default reproduces the search's
 * existing reach (all own fields), so nothing narrows on upgrade.
 */
export const DEFAULT_SESSION_SEARCH_SCOPES: SearchScope[] =
  SEARCH_SCOPES.filter((s): s is SearchScope => s !== 'transcript')

/**
 * The effective session-search scopes — `undefined` reads as the default, exactly like every other
 * `sessionView` field.
 *
 * Validated on read: only scopes THIS build knows survive, returned in canonical `SEARCH_SCOPES`
 * order and deduped, so a config hand-edited or written by a newer binary degrades to a sane search
 * rather than a crash. A stored EMPTY array is honoured as a real (empty) choice — distinct from
 * "never chosen", which is the `undefined` branch above.
 */
export function resolveSessionSearchScopes(p: Preferences): SearchScope[] {
  const stored = p.sessionView?.searchScopes
  if (!Array.isArray(stored)) return [...DEFAULT_SESSION_SEARCH_SCOPES]
  const set = new Set(stored)
  return SEARCH_SCOPES.filter(s => set.has(s))
}

/** Read + parse a preferences JSON file.
 *  - absent or blank  → null  (a legitimate "nothing here")
 *  - present but corrupt → THROWS. Falling through to defaults here presents the machine as
 *    solo and silently discards every connection, denylist, archiveMode and layout. */
async function readJsonPrefs(path: string): Promise<Preferences | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  const text = await file.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as Preferences
  } catch (err) {
    throw new Error(`preferences file at ${path} is present but unparseable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A FRESH defaults object every call — never a shared const. `team` in particular is spread
 *  into every read, and an aliased connections array becomes a live cross-caller bug. */
function defaultPrefs(): Preferences {
  return { customLayout: [], team: migrateTeamConfig(undefined) }
}

/** Read the effective preferences (primary, else migrated legacy, else defaults) with NO
 *  side-effecting write. `writePreferencesTo`'s read-merge step uses this (never the
 *  write-triggering `readPreferencesFrom`) so it can never re-enter `enqueueWrite` from inside
 *  an already-running chained callback — see the deadlock note on `enqueueWrite`. */
async function readEffective(primary: string, legacy: string | null): Promise<{ prefs: Preferences; migratedFromLegacy: boolean }> {
  const p = await readJsonPrefs(primary)
  if (p) return { prefs: withMigratedTeam(p), migratedFromLegacy: false }
  // `legacy === null` means this data dir has no legacy predecessor and MUST NOT be seeded from
  // outside itself — see `legacyPreferencesSource`. It is not "the file is missing": nothing is
  // even looked at, so an isolated instance cannot inherit a stranger's bearer token.
  if (legacy === null) return { prefs: defaultPrefs(), migratedFromLegacy: false }
  let l: Preferences | null = null
  try {
    l = await readJsonPrefs(legacy)
  } catch {
    // A corrupt LEGACY file is not fatal — the primary is authoritative and the legacy
    // location is read-only in Docker. Treat it as absent.
    l = null
  }
  if (l) return { prefs: withMigratedTeam(l), migratedFromLegacy: true }
  return { prefs: defaultPrefs(), migratedFromLegacy: false }
}

/** Read preferences from `primary`, falling back to `legacy` (and migrating it to `primary`
 *  best-effort) when the primary file is absent. Exported for tests; `readPreferences` binds
 *  the real paths. */
export async function readPreferencesFrom(primary: string, legacy: string | null): Promise<Preferences> {
  const { prefs, migratedFromLegacy } = await readEffective(primary, legacy)
  if (!migratedFromLegacy) return prefs
  // One-time migration so future reads hit the writable primary. Routed through the SAME
  // write chain as writePreferencesTo (enqueueWrite): without this, two concurrent migration
  // writes (or a migration racing an explicit writePreferencesTo) would call writeFileAtomic
  // independently and could interleave/clobber each other. Safe against reentrancy —
  // readPreferencesFrom is never called from inside an enqueueWrite callback; see there.
  return enqueueWrite(async () => {
    // This whole branch is a BEST-EFFORT opportunistic persist of the migrated shape, so the
    // NEXT read hits the writable primary directly — it is never the caller's only chance to get
    // a usable result (that's `prefs`, already computed above). Acquiring the cross-process lock
    // can fail for reasons that have nothing to do with contention (EACCES/EROFS on a read-only
    // data dir, `PreferencesLockTimeoutError` under sustained contention) and none of those may
    // turn a READ into a throw — `readPreferencesOrExit` would exit the whole CLI over what was
    // always a skippable write. See B-4.
    let release: (() => Promise<void>) | null = null
    try {
      release = await acquireFileLock(primary)
    } catch {
      return prefs
    }
    try {
      // Re-check under the chain (and now the cross-process lock): primary may have been
      // created — by our own read above racing another queued write, by that write itself, or
      // by a SEPARATE PROCESS that migrated first — since we decided to migrate.
      const p2 = await readJsonPrefs(primary)
      if (p2) return withMigratedTeam(p2)
      // The legacy dir may be read-only (Docker), so a failed migration write is expected and
      // ignored — the caller still gets the migrated-in-memory result.
      try { await writeFileAtomic(primary, JSON.stringify(prefs, null, 2)) } catch { /* read-only legacy dir */ }
      return prefs
    } finally {
      await release()
    }
  })
}

/** The ONE choke point where the shape migration runs, so every reader — CLI, uploader, WS
 *  client, GET/PUT /api/preferences — sees connections[]. Migrating only in the uploader
 *  would leave cli-status.ts, cli-start.ts and bin/cli.ts on the un-migrated shape. */
function withMigratedTeam(p: Preferences): Preferences {
  return { ...defaultPrefs(), ...p, team: migrateTeamConfig(p.team) }
}

export async function readPreferences(): Promise<Preferences> {
  return readPreferencesFrom(PREFERENCES_FILE, LEGACY_PREFERENCES_FILE)
}

/**
 * CLI entry points: read the preferences or die with ONE clear line naming the file.
 *
 * `readPreferences` now THROWS on a corrupt (present, non-empty, unparseable) file instead of
 * silently presenting the machine as solo. Every command that reads it must therefore say what
 * is wrong and exit non-zero — an unhandled rejection stack, or a bare `mode: solo`, are both
 * worse than the truth. Never prints the file's contents (it holds central tokens).
 */
export async function readPreferencesOrExit(): Promise<Preferences> {
  try {
    return await readPreferences()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    process.stderr.write(`agentop: cannot read ${PREFERENCES_FILE} — ${reason}\n`)
    process.stderr.write('  fix or move that file, then run the command again.\n')
    process.exit(1)
  }
}

/** Monotonic per-process counter mixed into every tmp filename so concurrent `writeFileAtomic`
 *  calls to the SAME target never pick the same tmp path — `${pid}` alone is unique per
 *  process, not per call, and two calls racing on the identical tmp name would interleave their
 *  writes before either `rename()` fires. */
let _tmpSeq = 0

/** tmp + rename. `Bun.write` truncates in place, so a concurrent reader can observe a
 *  half-written file; rename on the same filesystem is atomic. The tmp name is unique per
 *  CALL (pid + monotonic counter + random suffix), not just per process. */
async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${++_tmpSeq}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, text, 'utf-8')
  await rename(tmp, path)
}

// ---------------------------------------------------------------------------
// Cross-process lock — `enqueueWrite` only serializes writes WITHIN this process. Bun serves
// dashboard requests concurrently in the long-running server process while `cli-member.ts` (and
// any other CLI subcommand that falls back to a direct write — see cli-member.ts's docstring)
// writes the SAME preferences.json from a SEPARATE `bun` process with its own, independent
// `_writeChain`. Two processes racing a read-merge-write on the same file is the exact "two
// connections read [A,B,C], one writes [B,C], the other writes [A,C] from a stale read" hazard
// `updateTeamConfig` closes WITHIN a process — an O_EXCL lock FILE closes it ACROSS processes,
// since the filesystem is the only thing both processes can see.
// ---------------------------------------------------------------------------

/**
 * A lock older than this is presumed abandoned by a crashed/killed process holding it, and is
 * reclaimed rather than blocking every future write on this machine forever.
 *
 * 60s, not a bound on the write itself: the critical section runs `await`s inside the SAME
 * single-threaded event loop as `buildApiResponse` (thousands of JSONL files, git subprocesses)
 * in the long-running server process, so the loop can stall between the lock's read and its
 * rename for a lot longer than the syscalls alone take — a big-history machine, a CPU-quota'd
 * container, or a WSL2 `/mnt` path are all within a couple times of a much smaller bound. Getting
 * this wrong is not symmetric: too short and a legitimately slow holder gets its lock stolen out
 * from under it (see B-2's owner check for why that's now merely wasteful instead of unsafe);
 * too long only delays how quickly a genuinely crashed holder's lock is reclaimed. The mtime
 * heartbeat below (`LOCK_HEARTBEAT_MS`) is the holder's own defense — it refreshes well inside
 * this window so a slow-but-alive holder is never mistaken for a dead one.
 */
// Exported so tests can plant a lock file backdated relative to the REAL threshold instead of a
// hardcoded guess that silently goes stale itself the next time this constant is tuned (see
// preferences.test.ts's stale-lock-reclaim test, which broke exactly this way when this moved
// 10s → 60s during review — a hardcoded "60s ago" test input became "not old enough" overnight).
export const LOCK_STALE_MS = 60_000
/** How often a lock HOLDER refreshes the lock file's mtime while inside the critical section, so
 *  a legitimately slow write defends itself against being judged stale by a contending process.
 *  Comfortably below `LOCK_STALE_MS` so at least a few refreshes land before staleness could ever
 *  apply, even if one tick is itself delayed by a slow event loop. */
const LOCK_HEARTBEAT_MS = 15_000
/**
 * Total time a WAITER spends trying to acquire before giving up and throwing
 * `PreferencesLockTimeoutError`. This is intentionally `LOCK_STALE_MS` PLUS a margin — waiting
 * for anything less than `LOCK_STALE_MS` would let a waiter give up before a fresh-looking lock
 * could ever be judged stale, making the reclaim path unreachable for ordinary contention (the
 * bug the code review caught: the old bound was 5s against a 10s staleness window). The margin
 * covers the reclaim-and-retry round trip itself, not a second full staleness window.
 */
export const LOCK_ACQUIRE_TIMEOUT_MS = LOCK_STALE_MS + 10_000
const LOCK_POLL_MS = 100

function lockPathFor(primary: string): string {
  return `${primary}.lock`
}

/** Thrown when `acquireFileLock` cannot get the lock within `LOCK_ACQUIRE_TIMEOUT_MS`. A caller
 *  that reaches this must NOT proceed unlocked — that was the B-1 finding: doing so silently
 *  drops whichever side loses the resulting race, including a connection's token that exists
 *  nowhere else. Surfacing this as a typed error lets a CLI command print an actionable message
 *  ("another agentop process is writing preferences, retry") and exit non-zero instead. */
export class PreferencesLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`timed out waiting for the preferences write lock at ${lockPath} — another agentop process appears to be writing preferences`)
    this.name = 'PreferencesLockTimeoutError'
  }
}

/**
 * TEST-ONLY seam (R5 in the round-2 review): `preferences.test.ts` is the only file allowed to
 * call this. It exists because the alternative — proving the cross-process test actually catches
 * a missing lock — was previously done by hand-editing `acquireFileLock` to a no-op with `sed`,
 * running the suite, and reverting. That is not a repeatable regression guard, and per the
 * review, "unproven on this hardware" is exactly the state a probabilistic guard can rot in
 * silently. With this flag, `preferences.test.ts` has a committed, permanent control test that
 * disables the lock through a real code path (not a source edit) and asserts the SAME race that
 * the main guard test protects against reliably loses or corrupts data — proving the guard is not
 * vacuous, on every CI run, not just the one time a reviewer's finding forced a manual check.
 * Never read by any production code path; defaults to (and must always default to) `false`.
 */
let _testOnlyDisableLock = false
export function __setTestOnlyDisableLock(disabled: boolean): void {
  _testOnlyDisableLock = disabled
}

/**
 * TEST-ONLY seam (round-3 review, the R2-regression bound test): forces every contention
 * iteration inside `acquireFileLock` to treat the lock as "known free right now"
 * (`lockVanished = true`) WITHOUT actually checking or touching the file on disk — simulating a
 * waiter that keeps landing on that signal on every single iteration, which is exactly the
 * scenario that could spin past `LOCK_ACQUIRE_TIMEOUT_MS` before the round-3 fix bounded it to
 * one grace retry past the deadline. Combined with a REAL, permanently-held lock file (so `open`
 * genuinely keeps failing `EEXIST`) this reproduces sustained "known-free-but-still-contended"
 * pressure deterministically, instead of needing an adversarial second process racing real
 * timing. Never read by any production code path; defaults to (and must always default to)
 * `false`. */
let _testOnlyForceLockVanished = false
export function __setTestOnlyForceLockVanished(force: boolean): void {
  _testOnlyForceLockVanished = force
}

/**
 * TEST-ONLY seam (round-3 review): overrides `LOCK_ACQUIRE_TIMEOUT_MS` for a single test run, so
 * the bound test above does not have to wait out the real ~70s timeout. `null` (the default)
 * means "use the real constant" — never read by any production code path. */
let _testOnlyAcquireTimeoutMsOverride: number | null = null
export function __setTestOnlyAcquireTimeoutMs(ms: number | null): void {
  _testOnlyAcquireTimeoutMsOverride = ms
}

/**
 * Acquire an O_EXCL lock file next to `primary`. `open(path, 'wx')` fails with EEXIST if the
 * file already exists — the same primitive `mkdir -p` style tools use for a filesystem mutex,
 * portable across the platforms this ships on (no `flock` dependency).
 *
 * The lock file's CONTENT is an owner token unique to this acquisition (pid + timestamp + random
 * suffix), not empty — B-2's fix. Without an owner, a reclaim-then-steal race is possible: A
 * holds the lock legitimately but slowly, B judges it stale and unlinks it, B creates its own
 * lock, A finishes its (legitimate) critical section and unconditionally unlinks — deleting B's
 * lock, not its own — and C can then acquire while B is still inside. `release()` here only
 * unlinks when the file on disk still holds ITS OWN owner token, so a holder can only ever delete
 * a lock it still owns.
 *
 * Returns a release function; the caller MUST call it in a `finally` (see
 * `writePreferencesTo`/`updateTeamConfigAt` below) or a crash mid-critical-section leaves a lock
 * for the NEXT writer to reclaim once it goes stale — never a permanent deadlock, but a real wait
 * for `LOCK_STALE_MS`.
 */
async function acquireFileLock(primary: string): Promise<() => Promise<void>> {
  if (_testOnlyDisableLock) return async () => {}
  const lockPath = lockPathFor(primary)
  await mkdir(dirname(lockPath), { recursive: true })
  const owner = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const deadline = Date.now() + (_testOnlyAcquireTimeoutMsOverride ?? LOCK_ACQUIRE_TIMEOUT_MS)
  // R2-regression guard: a waiter that keeps landing on `staleReclaimed`/`lockVanished` on EVERY
  // iteration (plausible under sustained multi-process contention — repeatedly racing another
  // process's own create/release cycle) must still be bounded. This is spent EXACTLY ONCE: the
  // first time the deadline has already passed AND the lock looks free right now, this call gets
  // one final zero-delay retry instead of discarding a lock it may be entitled to (the original
  // R2 finding) — but if that retry doesn't land (still contended), every SUBSEQUENT free-looking
  // iteration past the deadline throws immediately rather than looping forever.
  let usedFinalFreeRetryPastDeadline = false
  while (true) {
    let created = false
    try {
      const handle = await open(lockPath, 'wx')
      created = true // R1: the lock file now exists — any failure from here on must unlink it,
      // or a transient ENOSPC/EIO on the write/close leaves a lock nobody holds and no writer on
      // this machine can proceed again until LOCK_STALE_MS (60s) elapses.
      try {
        await handle.writeFile(owner, 'utf-8')
        await handle.close()
      } catch (writeErr) {
        // Close the handle before unlinking: `writeFile` throwing leaves the fd OPEN, and this
        // path is retried on every contended write, so a repeating ENOSPC/EIO leaks one descriptor
        // per failure until the process hits its fd limit. `close()` on an already-closed handle
        // throws, hence the inner try — the write error is the one worth propagating.
        try { await handle.close() } catch { /* already closed, or closing failed too */ }
        try { await unlink(lockPath) } catch { /* best-effort — see the outer catch below too */ }
        throw writeErr
      }
      // Defend this lock against a contending process's staleness check while we're still
      // legitimately inside the critical section (B-2's second half) — a `setInterval` refresh
      // of the mtime, unref'd so it can never keep this process alive on its own. R3: re-reads
      // the file's OWNER before each refresh (not just its own remembered `owner` var) and stops
      // itself the moment it no longer matches — otherwise a heartbeat that fired blind would
      // keep refreshing WHOEVER'S lock now occupies this path after a stale-reclaim stole it out
      // from under this holder, making that stolen lock look perpetually fresh to everyone else.
      const heartbeat = setInterval(() => {
        void (async () => {
          try {
            const current = await readFile(lockPath, 'utf-8')
            if (current !== owner) {
              clearInterval(heartbeat)
              return
            }
            const now = new Date()
            await utimes(lockPath, now, now)
          } catch {
            // The lock is gone, unreadable, or the filesystem is misbehaving — nothing this
            // timer can fix; it will simply try again next tick (or the section will end and
            // clear it via `releaseFileLock`).
          }
        })()
      }, LOCK_HEARTBEAT_MS)
      heartbeat.unref?.()
      return () => releaseFileLock(lockPath, owner, heartbeat)
    } catch (err) {
      if (created) throw err // R1: NOT an EEXIST contention case — a real failure after we
      // already created the file, already unlinked above; propagate as-is, never re-enter the
      // contention/retry loop with a lock we just gave up on.
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      // Someone else holds it (or held it and crashed) — decide whether we have POSITIVE
      // evidence the lock is free right now (staleReclaimed / lockVanished), which is the only
      // case allowed to retry `open()` without waiting. Every other path — including a failed
      // reclaim attempt (EPERM/EBUSY on Windows, EACCES/EROFS elsewhere) and a `stat` failure
      // that is NOT "the file is gone" — must fall through to the shared timeout check and poll
      // sleep below. B-3's finding: the previous version `continue`d straight from BOTH the
      // reclaim-attempt catch and the stat catch, so a lock this process can see but cannot
      // remove (or a permission error masquerading as "vanished") busy-spun at 100% CPU forever,
      // never reaching either the deadline check or the sleep.
      let staleReclaimed = false
      let lockVanished = false
      if (_testOnlyForceLockVanished) {
        // TEST-ONLY: skip the real stat/unlink dance entirely and just claim "free right now" —
        // see the seam's doc comment. The lock file on disk is untouched (still held by whatever
        // actually created it), so the next `open()` genuinely fails EEXIST again, reproducing
        // sustained known-free-but-still-contended pressure on every iteration.
        lockVanished = true
      } else {
        try {
          const st = await stat(lockPath)
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            try {
              await unlink(lockPath)
              staleReclaimed = true
            } catch {
              // Could not remove it — another reclaimer may have won the race, or the filesystem
              // refused (EPERM/EBUSY/EACCES/EROFS). Either way this is NOT "known free now"; fall
              // through to the timeout+sleep tail like ordinary contention.
            }
          }
        } catch (statErr) {
          if ((statErr as NodeJS.ErrnoException)?.code === 'ENOENT') lockVanished = true
          // Any OTHER stat failure (EACCES/EIO/...) is not proof the lock vanished — treated as
          // ordinary contention below, never as a reason to retry immediately.
        }
      }
      // R2/round-3: a stale reclaim (or a lock that simply vanished) that lands AT OR AFTER the
      // deadline just freed the lock this call is entitled to take — throwing immediately would
      // discard a lock we are about to be able to acquire, for no reason but bad luck in when the
      // clock was read. But that "known-free retry bypasses the deadline" exception must itself
      // be bounded, or a waiter that keeps landing on ENOENT/a successful reclaim every single
      // iteration (repeatedly racing another process's create/release cycle) spins past
      // LOCK_ACQUIRE_TIMEOUT_MS forever — silently reintroducing the unbounded hang R4 exists to
      // prevent, and worse than the bug it replaced (that one at least threw). So: past the
      // deadline, a known-free signal is honored EXACTLY ONCE per `acquireFileLock` call (one
      // more zero-delay `open()` attempt); if the lock is still contended on the very next
      // iteration, it throws instead of granting another free pass.
      if (staleReclaimed || lockVanished) {
        if (Date.now() <= deadline) continue // still within budget — always retry, no cost to bound
        if (!usedFinalFreeRetryPastDeadline) {
          usedFinalFreeRetryPastDeadline = true
          continue // the ONE grace retry past the deadline
        }
        // Already spent the grace retry AND still seeing the lock as free-but-uncontested is a
        // contradiction in practice (the immediately-preceding `open()` should have succeeded) —
        // but if it somehow recurs, this is exactly the "keeps landing on known-free" case R2's
        // regression targets, so fall through to the throw below rather than looping again.
      }
      if (Date.now() > deadline) throw new PreferencesLockTimeoutError(lockPath)
      await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS))
    }
  }
}

/** Release a lock this process owns: only unlinks the file if its content still matches the
 *  owner token minted at acquisition (see the doc comment on `acquireFileLock`) — otherwise this
 *  is no longer OUR lock (we were reclaimed as stale while finishing up) and deleting it would
 *  steal mutual exclusion from whoever holds it now. Always clears the heartbeat first so it can
 *  never fire after release believes the section is over. */
async function releaseFileLock(lockPath: string, owner: string, heartbeat: ReturnType<typeof setInterval>): Promise<void> {
  clearInterval(heartbeat)
  try {
    const content = await readFile(lockPath, 'utf-8')
    if (content === owner) await unlink(lockPath)
  } catch {
    // Already gone, or unreadable — nothing more this process can safely do.
  }
}

/** Single write chain for the WHOLE module: every enqueued function awaits the previous one,
 *  so a read-merge-write can never interleave with another queued write and lose the
 *  connections array. `writePreferencesTo`, `readPreferencesFrom`'s legacy-migration branch, and
 *  `updateTeamConfig` all enqueue onto this SAME chain, so none of the three can interleave or
 *  clobber another.
 *
 *  Deadlock-freedom: `enqueueWrite` is called only from those three call sites (never from inside
 *  a callback already running as part of this chain). The callbacks queued here call
 *  `readEffective` (a plain, non-enqueuing read) and `writeFileAtomic` (plain fs I/O) — neither
 *  calls back into `enqueueWrite`. `updateTeamConfig`'s `mutate` callback is synchronous and pure
 *  by contract (it must never itself call `readPreferences`/`writePreferences`/
 *  `updateTeamConfig`), so it cannot reintroduce a cycle either. No queued callback ever awaits a
 *  promise that is itself waiting on that same callback to finish; the chain is a straight FIFO
 *  with no cycle. */
let _writeChain: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = _writeChain.then(fn, fn)
  _writeChain = next.catch(() => {})
  return next
}

/**
 * Spec §5.8: **a `team` payload with no `connections` key is a legacy single-connection edit,
 * never a replacement of the array.**
 *
 * The top-level merge is shallow, so any caller handing over a `team` object replaces the whole
 * connections array. An old cached tab — or an older sidecar sharing ~/.agentistics — that saves
 * Settings, or clicks Disconnect (which PUTs a full flat solo object), would otherwise delete
 * every connection and every denylist. When the payload carries `connections` explicitly it
 * replaces, exactly as before.
 */
/**
 * Spec §5.8: the GET response blanks every token, so the shape the UI holds cannot be written
 * back verbatim without destroying the credentials. An EMPTY incoming token therefore means
 * "unchanged", never "clear it": a stored non-empty token survives, matched by connection id and
 * falling back to the normalized endpoint for a payload that predates ids.
 *
 * A genuinely new connection carries no stored counterpart, so its empty token stays empty —
 * token-less members against an open central remain expressible.
 */
function keepStoredTokens(current: TeamConfig | undefined, incoming: TeamConfig): TeamConfig {
  const stored = current?.connections ?? []
  if (stored.length === 0) return incoming
  const byId = new Map(stored.map(c => [c.id, c]))
  const byEndpoint = new Map(stored.map(c => [c.endpoint.replace(/\/+$/, ''), c]))
  return {
    ...incoming,
    connections: (incoming.connections ?? []).map(c => {
      if (c.token) return c
      const previous = byId.get(c.id) ?? byEndpoint.get((c.endpoint ?? '').replace(/\/+$/, ''))
      return previous?.token ? { ...c, token: previous.token } : c
    }),
  }
}

function mergeTeamPayload(current: TeamConfig | undefined, incoming: TeamConfig): TeamConfig {
  if (Object.prototype.hasOwnProperty.call(incoming, 'connections')) {
    return keepStoredTokens(current, incoming)
  }
  const stored = current?.connections ?? []
  // With nothing stored there is no array to protect: run the payload through the migration so
  // a legacy flat edit that DOES name an endpoint still lands as a connection.
  if (stored.length === 0) return migrateTeamConfig(incoming)
  return migrateTeamConfig({ ...incoming, connections: stored })
}

/**
 * C1 guard for `PUT /api/preferences` ONLY — a `team` payload whose `connections` array is present
 * and EMPTY while connections are stored is almost certainly a stale client wiping the fleet, not
 * an intentional disconnect-all. It strips the `connections` key so `mergeTeamPayload`'s legacy
 * branch preserves the stored array (and therefore the tokens, which exist nowhere else on this
 * machine and cannot be recovered without re-minting them on each central).
 *
 * Why it is NOT inside `mergeTeamPayload`, where `current` would be atomically available: two
 * legitimate in-process callers write exactly this shape on purpose — `removeConnection` splicing
 * the LAST connection, and `cli-setup`'s solo branch (which confirms first). Guarding at the merge
 * would resurrect a connection the user just removed. The route is the untrusted boundary, so the
 * route is where the guard belongs; a real disconnect goes through
 * `DELETE /api/team/connections/:id`.
 *
 * Pure. Returns the payload unchanged (same object) when there is nothing to guard.
 */
export function guardTeamConnectionsWipe(
  team: TeamConfig,
  storedCount: number,
): { team: TeamConfig; guarded: boolean } {
  if (!Object.prototype.hasOwnProperty.call(team, 'connections')) return { team, guarded: false }
  if ((team.connections?.length ?? 0) > 0 || storedCount === 0) return { team, guarded: false }
  const { connections: _dropped, ...rest } = team
  return { team: rest as TeamConfig, guarded: true }
}

/** Merge `prefs` over the current preferences and persist to `primary`. Exported for tests. */
export async function writePreferencesTo(primary: string, legacy: string | null, prefs: Preferences): Promise<void> {
  return enqueueWrite(async () => {
    const release = await acquireFileLock(primary)
    try {
      const { prefs: current } = await readEffective(primary, legacy)
      const merged = { ...current, ...prefs }
      if (prefs.team) merged.team = mergeTeamPayload(current.team, prefs.team)
      await writeFileAtomic(primary, JSON.stringify(merged, null, 2))
    } finally {
      await release()
    }
  })
}

export async function writePreferences(prefs: Preferences): Promise<void> {
  return writePreferencesTo(PREFERENCES_FILE, LEGACY_PREFERENCES_FILE, prefs)
}

/**
 * Atomically read-modify-write JUST the team config, running `mutate` INSIDE the single write
 * chain (`enqueueWrite`) instead of outside it.
 *
 * Why this exists: a plain `readPreferences()` followed by `writePreferences({ team })` reads the
 * current `connections[]` OUTSIDE the chain, then writes a value computed from that stale read.
 * With two callers racing (e.g. two connections both crossing their auth-error threshold in the
 * same window, which the concurrency cap makes routine, not theoretical) both read `[A, B, C]`;
 * A's removal writes `[B, C]`, then B's (computed from the SAME stale `[A, B, C]`) writes
 * `[A, C]` — A is back in preferences with its state files already unlinked, B is gone. A
 * mutator run inside the chain instead reads the CURRENT array at the moment it is its turn to
 * write, so the second caller sees the first caller's result and can never resurrect it.
 *
 * `mutate` receives the current (already-migrated) team config and returns the new one, or
 * `undefined` to signal "nothing to do" — no write happens in that case, so a caller like
 * `removeConnection` can stay idempotent without an extra disk write on a repeat call.
 */
export type TeamConfigMutator = (current: TeamConfig) => TeamConfig | undefined

/** Path-parameterized implementation — exported for tests (mirrors `writePreferencesTo`'s split
 *  from `writePreferences`), so the atomicity `updateTeamConfig` provides can be exercised
 *  against real tmp files and the REAL `enqueueWrite` chain, without ever touching the
 *  developer's actual `~/.agentistics/preferences.json`. */
export async function updateTeamConfigAt(primary: string, legacy: string | null, mutate: TeamConfigMutator): Promise<TeamConfig> {
  return enqueueWrite(async () => {
    const release = await acquireFileLock(primary)
    try {
      const { prefs: current } = await readEffective(primary, legacy)
      const currentTeam = current.team ?? migrateTeamConfig(undefined)
      const nextTeam = mutate(currentTeam)
      if (nextTeam === undefined) return currentTeam
      const merged = { ...current, team: mergeTeamPayload(current.team, nextTeam) }
      await writeFileAtomic(primary, JSON.stringify(merged, null, 2))
      return merged.team as TeamConfig
    } finally {
      await release()
    }
  })
}

export async function updateTeamConfig(mutate: TeamConfigMutator): Promise<TeamConfig> {
  return updateTeamConfigAt(PREFERENCES_FILE, LEGACY_PREFERENCES_FILE, mutate)
}

/**
 * Strip every secret from a preferences object before it leaves the process.
 *
 * `GET /api/preferences` is reachable from any page the user happens to visit (the port is
 * local, not private), and nothing in the UI needs a token: adding a connection POSTs one,
 * and probe/leave/test all run server-side. So the read-out blanks `team.connections[].token`
 * and drops the legacy `team.token` mirror entirely.
 *
 * Pure — never mutates its input. Total: a solo config, an absent `team` and a malformed one
 * all pass through without throwing.
 */
export function redactPreferences(prefs: Preferences): Preferences {
  if (!prefs?.team) return { ...prefs }
  const { token: _dropped, ...teamRest } = prefs.team
  const connections = Array.isArray(prefs.team.connections)
    ? prefs.team.connections.map(c => ({ ...c, token: '' }))
    : prefs.team.connections
  return { ...prefs, team: { ...teamRest, connections } as TeamConfig }
}
