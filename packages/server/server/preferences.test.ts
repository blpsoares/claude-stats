import { test, expect } from 'bun:test'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'node:url'
import {
  readPreferencesFrom, writePreferencesTo, updateTeamConfigAt, legacyPreferencesSource,
  LOCK_STALE_MS, LOCK_ACQUIRE_TIMEOUT_MS, __setTestOnlyDisableLock,
  __setTestOnlyForceLockVanished, __setTestOnlyAcquireTimeoutMs, PreferencesLockTimeoutError,
} from './preferences'

// Regression: preferences were stored under CLAUDE_DIR, which in Docker (machine +
// self-contributing central) is the host ~/.claude mounted READ-ONLY at /host-claude.
// writePreferences therefore failed (EROFS) and every launch re-asked the archive-mode
// consent gate + the install prompt. Preferences must live in the writable ~/.agentistics
// dir, with a one-time migration from the legacy CLAUDE_DIR location so native installs
// keep their existing choices.

/**
 * `legacyPreferencesSource` — the PURE decision behind the isolation contract.
 *
 * The defect it pins: `~/.claude/agentistics-preferences.json` is derived from CLAUDE_DIR, the one
 * persisted path that is NOT under `AGENTISTICS_DATA_DIR`, so the legacy migration read it for
 * EVERY data dir. Starting a server with a brand-new, empty `AGENTISTICS_DIR` wrote a
 * `preferences.json` into it holding a `mode: 'member'` connection — WITH ITS BEARER TOKEN — to a
 * central the operator had never configured, and then created that connection's state files. An
 * isolated instance inherited a credential and would have pushed under it.
 */
test('legacyPreferencesSource seeds the DEFAULT data dir and nothing else', () => {
  const legacy = '/home/u/.claude/agentistics-preferences.json'
  const def = '/home/u/.agentistics'

  // The default install still migrates — that is what the legacy file is for.
  expect(legacyPreferencesSource(def, def, legacy)).toBe(legacy)
  // A trailing separator names the same directory, so it must not read as isolated.
  expect(legacyPreferencesSource(def + '/', def, legacy)).toBe(legacy)

  // Any other data dir is isolated: no legacy file may seed it, ever.
  for (const isolated of ['/tmp/agy-iso', '/var/lib/agentistics', '/home/u/.agentistics-2', '/home/other/.agentistics']) {
    expect(legacyPreferencesSource(isolated, def, legacy)).toBeNull()
  }
})

test('a null legacy source is never read — an isolated data dir starts on defaults, not on someone else\'s connection', async () => {
  const { primary, legacy } = tmpPaths()
  // Seed the legacy location with exactly the shape that leaked: a member connection + token.
  await Bun.write(legacy, JSON.stringify({
    theme: 'dark',
    team: { mode: 'member', endpoint: 'http://central:48080', token: 'secret-bearer', user: 'Alienware', org: 'siths' },
  }))

  // Passing the legacy path migrates it (the default-data-dir case)...
  const migrated = await readPreferencesFrom(primary, legacy)
  expect(migrated.team?.mode).toBe('member')
  expect(migrated.team?.connections?.[0]?.token).toBe('secret-bearer')

  // ...but an isolated instance is given `null` and must see none of it.
  const { primary: isolatedPrimary } = tmpPaths()
  const isolated = await readPreferencesFrom(isolatedPrimary, null)
  expect(isolated.team?.mode).toBe('solo')
  expect(isolated.team?.connections).toEqual([])
  expect(isolated.theme).toBeUndefined()
  // And nothing was written into the isolated dir at all: with no legacy source there is no
  // migration, so a pure read stays a pure read.
  expect(await Bun.file(isolatedPrimary).exists()).toBe(false)
})

function tmpPaths() {
  const base = join(tmpdir(), `agentistics-prefs-${crypto.randomUUID()}`)
  return {
    primary: join(base, 'agentistics', 'preferences.json'),
    legacy: join(base, 'claude', 'agentistics-preferences.json'),
  }
}

test('write then read round-trips through the primary (writable) path', async () => {
  const { primary, legacy } = tmpPaths()
  await writePreferencesTo(primary, legacy, { installDismissed: true, archiveMode: 'consolidate' })
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.installDismissed).toBe(true)
  expect(p.archiveMode).toBe('consolidate')
  expect(await Bun.file(primary).exists()).toBe(true)
})

test('falls back to the legacy file and migrates it to the primary', async () => {
  const { primary, legacy } = tmpPaths()
  await Bun.write(legacy, JSON.stringify({ archiveMode: 'full', theme: 'light' }))
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.archiveMode).toBe('full')
  expect(p.theme).toBe('light')
  // migration: the primary now exists so future reads never touch the (read-only) legacy dir
  expect(await Bun.file(primary).exists()).toBe(true)
})

test('primary wins over legacy when both exist', async () => {
  const { primary, legacy } = tmpPaths()
  await Bun.write(legacy, JSON.stringify({ archiveMode: 'off' }))
  await Bun.write(primary, JSON.stringify({ archiveMode: 'consolidate' }))
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.archiveMode).toBe('consolidate')
})

test('both missing yields defaults (archiveMode undefined → gate shows once)', async () => {
  const { primary, legacy } = tmpPaths()
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.archiveMode).toBeUndefined()
  expect(p.customLayout).toEqual([])
})

test('writePreferencesTo merges with legacy values on first write', async () => {
  const { primary, legacy } = tmpPaths()
  await Bun.write(legacy, JSON.stringify({ theme: 'light' }))
  await writePreferencesTo(primary, legacy, { installDismissed: true })
  const p = await readPreferencesFrom(primary, legacy)
  expect(p.theme).toBe('light')        // preserved from legacy
  expect(p.installDismissed).toBe(true)
})

// Task 2: serialized/atomic writes + migrateTeamConfig at the single choke point + refuse to
// silently default over a corrupt primary file (which would present the machine as solo and
// discard every connection, denylist, archiveMode and layout).

import { mkdtemp, writeFile, readFile, readdir, open, utimes } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { dirname } from 'node:path'

async function tmpPaths2() {
  const dir = await mkdtemp(join(osTmpdir(), 'agentistics-prefs-'))
  return { primary: join(dir, 'preferences.json'), legacy: join(dir, 'legacy.json') }
}

test('readPreferencesFrom migrates a legacy flat team block into connections[]', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writeFile(primary, JSON.stringify({
    team: { mode: 'member', endpoint: 'http://c:48080', org: 'acme', user: 'lucas', token: 'tok' },
  }))
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.team?.connections).toHaveLength(1)
  expect(prefs.team?.connections[0]!.endpoint).toBe('http://c:48080')
  expect(prefs.team?.mode).toBe('member')
})

test('readPreferencesFrom returns defaults for an absent or empty file', async () => {
  const { primary, legacy } = await tmpPaths2()
  expect((await readPreferencesFrom(primary, legacy)).team?.connections).toEqual([])
  await writeFile(primary, '   ')
  expect((await readPreferencesFrom(primary, legacy)).team?.connections).toEqual([])
})

test('readPreferencesFrom THROWS on a corrupt non-empty file instead of silently defaulting', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writeFile(primary, '{"team": {"connections": [')
  await expect(readPreferencesFrom(primary, legacy)).rejects.toThrow()
})

test('the default team object is never shared between reads', async () => {
  const { primary, legacy } = await tmpPaths2()
  const a = await readPreferencesFrom(primary, legacy)
  const b = await readPreferencesFrom(primary, legacy)
  expect(a.team).not.toBe(b.team)
  a.team!.connections.push({ id: 'c_aaaaaaaaaaaa', endpoint: 'x', org: 'o', user: 'u', token: 't', deniedRepos: [] })
  expect(b.team!.connections).toEqual([])
})

test('concurrent writes are serialized — no lost update', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { theme: 'dark' })
  await Promise.all([
    writePreferencesTo(primary, legacy, { lang: 'pt' }),
    writePreferencesTo(primary, legacy, { currency: 'BRL' }),
    writePreferencesTo(primary, legacy, { monthlyBudgetUSD: 100 }),
  ])
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.theme).toBe('dark')
  expect(prefs.lang).toBe('pt')
  expect(prefs.currency).toBe('BRL')
  expect(prefs.monthlyBudgetUSD).toBe(100)
})

/**
 * A CONCURRENT READER is what makes this test about atomicity. Asserting only that the file
 * parses AFTER every write has settled passes just as well against a plain `Bun.write`, which
 * truncates in place — the torn state exists, the old test simply never looked at it. Here a
 * second task reads the file in a tight loop while the writes run and every single read must
 * parse.
 */
async function readUntilDone(path: string, done: () => boolean): Promise<number> {
  let reads = 0
  while (!done()) {
    let text: string
    try {
      text = await readFile(path, 'utf-8')
    } catch {
      continue // not created yet, or observed exactly between unlink and rename — not a tear
    }
    if (text === '') continue
    reads++
    JSON.parse(text) // throws → the reader observed a partially written file
    await new Promise(r => setTimeout(r, 0))
  }
  return reads
}

test('a concurrent reader NEVER observes a partially written file', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { monthlyBudgetUSD: -1 })
  let finished = false
  const reader = readUntilDone(primary, () => finished)
  const writes = Array.from({ length: 40 }, (_, i) => writePreferencesTo(primary, legacy, { monthlyBudgetUSD: i, theme: i % 2 ? 'dark' : 'light' }))
  await Promise.all(writes)
  finished = true
  const reads = await reader
  expect(reads).toBeGreaterThan(0)
  const text = await readFile(primary, 'utf-8')
  expect(() => JSON.parse(text)).not.toThrow()
  const leftoverTmp = (await readdir(dirname(primary))).filter(f => f.includes('.tmp-'))
  expect(leftoverTmp).toEqual([])
})

// Follow-up fix (review): writeFileAtomic's tmp name used to be unique only per PROCESS
// (`${path}.tmp-${process.pid}`), not per call. readPreferencesFrom's legacy-migration branch
// called writeFileAtomic directly, outside the write chain writePreferencesTo uses — two
// concurrent migration writes (or a migration racing writePreferencesTo) could pick the
// IDENTICAL tmp filename and interleave/corrupt it before either rename() fired. Fixed by (1)
// mixing a monotonic counter + random suffix into the tmp name so every call gets a distinct
// path, and (2) routing the migration write through the SAME `enqueueWrite` chain as
// writePreferencesTo (via a non-writing `readEffective` helper so the chain can't re-enter
// itself and deadlock).

test('concurrent legacy-migration reads never collide on the tmp filename — a reader mid-flight always sees whole JSON', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writeFile(legacy, JSON.stringify({ archiveMode: 'full', theme: 'light' }))
  let finished = false
  const reader = readUntilDone(primary, () => finished)
  const results = await Promise.all(Array.from({ length: 20 }, () => readPreferencesFrom(primary, legacy)))
  finished = true
  await reader
  for (const r of results) {
    expect(r.archiveMode).toBe('full')
    expect(r.theme).toBe('light')
  }
  const text = await readFile(primary, 'utf-8')
  expect(() => JSON.parse(text)).not.toThrow()
  const leftoverTmp = (await readdir(dirname(primary))).filter(f => f.includes('.tmp-'))
  expect(leftoverTmp).toEqual([])
})

test('a legacy migration racing an explicit write never loses either — both survive', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writeFile(legacy, JSON.stringify({ archiveMode: 'full', theme: 'light' }))
  const [migrated] = await Promise.all([
    readPreferencesFrom(primary, legacy),
    writePreferencesTo(primary, legacy, { installDismissed: true }),
  ])
  // The migration read itself always sees the legacy content (in-memory result), regardless
  // of which write wins the race to land on disk first.
  expect(migrated.archiveMode).toBe('full')
  expect(migrated.theme).toBe('light')
  // The FINAL on-disk state must have both the migrated legacy fields and the explicit write —
  // neither the migration's write nor writePreferencesTo's write may clobber the other's data.
  const final = await readPreferencesFrom(primary, legacy)
  expect(final.archiveMode).toBe('full')
  expect(final.theme).toBe('light')
  expect(final.installDismissed).toBe(true)
})

// I4 / spec §5.8: a `team` payload with NO `connections` key is a legacy single-connection edit,
// never a replacement of the array. The shallow top-level merge would otherwise let an old
// cached tab (or an older sidecar sharing ~/.agentistics) wipe every connection and denylist.

const conn = (id: string, endpoint: string, denied: string[] = []) => ({
  id, endpoint, org: 'default', user: 'u', token: 'tok', deniedRepos: denied,
})

test('a legacy-shaped team payload CANNOT empty a stored two-connection array', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, {
    team: { schema: 2, mode: 'member', connections: [conn('c_aaaaaaaaaaaa', 'http://a:48080', ['github.com/o/secret']), conn('c_bbbbbbbbbbbb', 'http://b:48080')] },
  })
  // The pre-upgrade SPA's "Disconnect": a full flat solo object, no connections key.
  await writePreferencesTo(primary, legacy, { team: { mode: 'solo', endpoint: '', token: '', user: '', org: 'default' } as never })
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.team?.connections.map(c => c.id)).toEqual(['c_aaaaaaaaaaaa', 'c_bbbbbbbbbbbb'])
  expect(prefs.team?.connections[0]!.deniedRepos).toEqual(['github.com/o/secret'])
  expect(prefs.team?.mode).toBe('member')
})

test('a team payload WITH a connections key replaces the array, as before', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, {
    team: { schema: 2, mode: 'member', connections: [conn('c_aaaaaaaaaaaa', 'http://a:48080'), conn('c_bbbbbbbbbbbb', 'http://b:48080')] },
  })
  await writePreferencesTo(primary, legacy, {
    team: { schema: 2, mode: 'member', connections: [conn('c_cccccccccccc', 'http://c:48080')] },
  })
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.team?.connections.map(c => c.id)).toEqual(['c_cccccccccccc'])
})

test('a legacy flat team edit on a machine with NO stored connections still lands as one', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { team: { mode: 'member', endpoint: 'http://c:48080', token: 't', user: 'lucas', org: 'acme' } as never })
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.team?.connections).toHaveLength(1)
  expect(prefs.team?.connections[0]!.endpoint).toBe('http://c:48080')
  expect(prefs.team?.mode).toBe('member')
})

test('a legacy team edit leaves the rest of the preferences alone', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { theme: 'light', archiveMode: 'consolidate' })
  await writePreferencesTo(primary, legacy, { team: { mode: 'solo' } as never })
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.theme).toBe('light')
  expect(prefs.archiveMode).toBe('consolidate')
})

test('a corrupt LEGACY file does not throw — the primary is authoritative and legacy corruption is not fatal', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writeFile(legacy, '{not valid json')
  const prefs = await readPreferencesFrom(primary, legacy)
  expect(prefs.team?.connections).toEqual([])
  expect(prefs.customLayout).toEqual([])
})

// ---------------------------------------------------------------------------
// Secret redaction on read-out (spec §5.8)
// ---------------------------------------------------------------------------

import { redactPreferences } from './preferences'
import type { Preferences } from './preferences'

function prefsWithTokens(): Preferences {
  return {
    theme: 'dark',
    team: {
      schema: 2,
      mode: 'member',
      connections: [
        { id: 'c_0123456789ab', endpoint: 'http://a:48080', org: 'acme', user: 'lucas', token: 'SECRET-A', deniedRepos: ['github.com/o/r'] },
        { id: 'c_ba9876543210', endpoint: 'http://b:48080', org: 'default', user: 'lucas', token: 'SECRET-B', deniedRepos: [] },
      ],
      endpoint: 'http://a:48080', org: 'acme', user: 'lucas', token: 'SECRET-A',
    },
  } as Preferences
}

test('redactPreferences blanks every connection token and drops the legacy mirror', () => {
  const out = redactPreferences(prefsWithTokens())
  expect(out.team!.connections.map(c => c.token)).toEqual(['', ''])
  expect(out.team!.token).toBeUndefined()
  expect(JSON.stringify(out)).not.toContain('SECRET-A')
  expect(JSON.stringify(out)).not.toContain('SECRET-B')
})

test('redactPreferences keeps everything the UI actually needs', () => {
  const out = redactPreferences(prefsWithTokens())
  expect(out.theme).toBe('dark')
  expect(out.team!.mode).toBe('member')
  expect(out.team!.connections[0]!.endpoint).toBe('http://a:48080')
  expect(out.team!.connections[0]!.user).toBe('lucas')
  expect(out.team!.connections[0]!.deniedRepos).toEqual(['github.com/o/r'])
  expect(out.team!.endpoint).toBe('http://a:48080')
})

test('redactPreferences never mutates its input', () => {
  const input = prefsWithTokens()
  redactPreferences(input)
  expect(input.team!.connections[0]!.token).toBe('SECRET-A')
  expect(input.team!.token).toBe('SECRET-A')
})

test('redactPreferences is total — solo, absent team and a missing array', () => {
  expect(redactPreferences({} as Preferences).team).toBeUndefined()
  const solo = redactPreferences({ team: { schema: 2, mode: 'solo', connections: [] } } as Preferences)
  expect(solo.team!.connections).toEqual([])
  expect(() => redactPreferences({ team: { mode: 'member' } } as unknown as Preferences)).not.toThrow()
})

test('a PUT of the REDACTED shape cannot blank a stored token', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, prefsWithTokens())
  const redacted = redactPreferences(await readPreferencesFrom(primary, legacy))

  await writePreferencesTo(primary, legacy, { team: redacted.team })

  const after = await readPreferencesFrom(primary, legacy)
  expect(after.team!.connections.map(c => c.token)).toEqual(['SECRET-A', 'SECRET-B'])
  expect(after.team!.connections).toHaveLength(2)
})

test('a genuine token change still lands — an empty token only ever means "unchanged"', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, prefsWithTokens())
  const team = (await readPreferencesFrom(primary, legacy)).team!
  team.connections[0]!.token = 'ROTATED'
  team.connections[1]!.token = ''

  await writePreferencesTo(primary, legacy, { team })

  const after = await readPreferencesFrom(primary, legacy)
  expect(after.team!.connections[0]!.token).toBe('ROTATED')
  expect(after.team!.connections[1]!.token).toBe('SECRET-B')
})

// ---------------------------------------------------------------------------
// Cross-process lock (Task 5) — `enqueueWrite` only serializes writes WITHIN one process; Bun
// serves dashboard requests concurrently in the long-running server while a CLI subcommand
// (`cli-member.ts` et al.) can write the SAME preferences.json from a SEPARATE `bun` process with
// its own, independent write chain. This spawns a REAL second OS process (see
// preferences.lock-test-child.ts) racing the SAME read-modify-write against the main test
// process, proving the O_EXCL lock file — not just the in-process chain — is what prevents a lost
// update across process boundaries.
//
// R5 (round-2 review): a `bun run <script>` child's own startup/import cost (~100ms+) dwarfs the
// sub-millisecond time a handful of sequential fs writes take, so without synchronization the
// MAIN process routinely finishes its entire loop before the child has even started — no overlap
// ever happens, and the test would stay green whether or not the lock exists. `waitForFile` below
// is a barrier: the child writes a ready-marker right after its own startup completes and right
// before its write loop starts; the parent waits for that marker before starting its own loop, so
// both loops actually run concurrently for their full duration instead of hoping for scheduling
// luck.
// ---------------------------------------------------------------------------

const childScriptPath = join(
  // `new URL(import.meta.url).pathname` yields a leading-slash path like `/C:/…` on Windows,
  // which breaks the spawned `bun run` — `fileURLToPath` handles the platform difference.
  dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'preferences.lock-test-child.ts',
)

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path} to appear`)
    await new Promise(r => setTimeout(r, 5))
  }
}

/** Outcome of `raceTwoProcesses`. With the lock disabled, EITHER side reading a torn write mid-race
 *  can throw (not just the final read) — `readJsonPrefs` deliberately throws on unparseable JSON
 *  rather than silently defaulting (see its own doc comment), so a torn write surfaces as an
 *  exception from `updateTeamConfigAt` itself, not only as a bad final file. All of that is
 *  evidence of the SAME underlying corruption, not a test bug, so it's captured here rather than
 *  left to crash the test. */
interface RaceResult {
  ids: string[] | null
  /** The final file failed to parse, OR either process's write loop threw (almost always because
   *  it tried to read a torn file mid-race) OR the child exited non-zero. */
  corrupted: boolean
}

/** Spawns the child fixture, waits for both sides to be ready, then races `COUNT` sequential
 *  `updateTeamConfigAt` appends from THIS process against `COUNT` from the child — the real
 *  production write path, from two real OS processes, synchronized to actually overlap.
 *  `disableLock` plumbs `__setTestOnlyDisableLock` through to BOTH sides (it's a per-process
 *  module-level flag, so the child needs its own `--disable-lock` flag; setting it only in the
 *  parent would leave the child still locking and prove nothing). */
async function raceTwoProcesses(opts: { primary: string; legacy: string; count: number; disableLock: boolean }): Promise<RaceResult> {
  const { primary, legacy, count } = opts
  const childReady = `${primary}.child-ready`
  const childArgs = [childScriptPath, primary, legacy, 'bbbb', String(count), childReady]
  if (opts.disableLock) childArgs.push('--disable-lock')
  const child = Bun.spawn(['bun', 'run', ...childArgs], { stdout: 'pipe', stderr: 'pipe' })

  if (opts.disableLock) __setTestOnlyDisableLock(true)
  let mainCorrupted = false
  try {
    await waitForFile(childReady, 10_000) // barrier: don't start until the child is about to loop

    const mainWrites = (async () => {
      for (let i = 0; i < count; i++) {
        await updateTeamConfigAt(primary, legacy, (current) => ({
          ...current,
          connections: [
            ...current.connections,
            {
              id: `c_aaaa${i.toString(16).padStart(8, '0')}`,
              // A distinct endpoint per entry: `connections[]`'s uniqueness key is the endpoint
              // (see TeamConnection's doc comment in core/src/team.ts) — migrateTeamConfig
              // legitimately dedupes same-endpoint entries, which would look exactly like a
              // lost-update bug in the lock if every iteration reused one endpoint.
              endpoint: `http://127.0.0.1:2/aaaa${i}`,
              org: 'default',
              user: '',
              token: '',
              deniedRepos: [],
            },
          ],
        }))
      }
    })().catch(() => { mainCorrupted = true }) // a torn read mid-race throws — that IS the finding

    const [exitCode] = await Promise.all([child.exited, mainWrites])
    if (exitCode !== 0) mainCorrupted = true // the child hit the same class of failure
  } finally {
    if (opts.disableLock) __setTestOnlyDisableLock(false) // never leak into a later test
  }

  let text: string
  try {
    text = await readFile(primary, 'utf-8')
    JSON.parse(text) // torn writes from two processes racing rename() fail to parse
  } catch {
    return { ids: null, corrupted: true }
  }
  if (mainCorrupted) return { ids: null, corrupted: true }
  const final = await readPreferencesFrom(primary, legacy)
  return { ids: final.team!.connections.map(c => c.id), corrupted: false }
}

test('two SEPARATE OS processes writing the same preferences file concurrently lose no updates', async () => {
  const { primary, legacy } = await tmpPaths2()
  // Seed the file so both writers start from a real, parseable base rather than racing the
  // very first mkdir/create.
  await writePreferencesTo(primary, legacy, { team: { schema: 2, mode: 'member', connections: [] } })

  const COUNT = 15
  const { ids, corrupted } = await raceTwoProcesses({ primary, legacy, count: COUNT, disableLock: false })

  expect(corrupted).toBe(false) // the file on disk is whole JSON, not a torn write, and neither side threw
  // Every single one of the 2×COUNT appends survived — no lost update across the process
  // boundary, which is exactly what a missing/ineffective cross-process lock would drop.
  expect(ids).toHaveLength(2 * COUNT)
  expect(new Set(ids).size).toBe(2 * COUNT) // no duplicate/corrupted id either
  const mainIds = ids!.filter(id => id.startsWith('c_aaaa'))
  const childIds = ids!.filter(id => id.startsWith('c_bbbb'))
  expect(mainIds).toHaveLength(COUNT)
  expect(childIds).toHaveLength(COUNT)
}, 20_000)

test('control: with the lock disabled via the test-only seam, the SAME synchronized race loses or corrupts data — proves the guard above is not vacuous on this hardware', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { team: { schema: 2, mode: 'member', connections: [] } })

  // A much higher COUNT than the guard test above: each individual read-modify-write is a
  // handful of fast fs syscalls, so even with synchronized starts the contention window per
  // iteration is small — more iterations means more chances for the two processes' operations to
  // actually interleave mid-cycle instead of happening to serialize by accident.
  const COUNT = 200
  const { ids, corrupted } = await raceTwoProcesses({ primary, legacy, count: COUNT, disableLock: true })

  // With BOTH processes' lock acquisition short-circuited to a no-op (same synchronized-start
  // race as the guard test above — same COUNT, same barrier, same production `updateTeamConfigAt`
  // call), the read-modify-write MUST tear or lose an update: either the file fails to parse or a
  // process throws reading a torn file mid-race (both captured as `corrupted`), or fewer than
  // 2×COUNT ids survive. If this assertion ever starts failing, it means EITHER the hardware
  // genuinely stopped reproducing the race (investigate before trusting the guard test's green as
  // meaningful) OR something reintroduced accidental serialization outside the lock.
  const lostOrTorn = corrupted || ids === null || ids.length < 2 * COUNT
  expect(lostOrTorn).toBe(true)
}, 20_000)

// The exact bug R1/R2 fixed: LOCK_ACQUIRE_TIMEOUT_MS being <= LOCK_STALE_MS makes the stale-reclaim
// path unreachable for ordinary contention (a waiter always gives up before a fresh-looking lock
// could ever be judged stale) — this is a standing regression guard against that specific
// inversion recurring, not just documentation of the current values.
test('LOCK_ACQUIRE_TIMEOUT_MS is strictly greater than LOCK_STALE_MS — the waiter always gets a turn at reclaiming a stale lock', () => {
  expect(LOCK_ACQUIRE_TIMEOUT_MS).toBeGreaterThan(LOCK_STALE_MS)
})

// ---------------------------------------------------------------------------
// R2-regression bound (round-3 review): the fix that let a known-free retry bypass the deadline
// check (so a stale reclaim landing right at the deadline isn't discarded, see R2 above) has to
// stay BOUNDED — a waiter that keeps landing on `staleReclaimed`/`lockVanished` on every single
// iteration must not spin past `LOCK_ACQUIRE_TIMEOUT_MS` forever. `__setTestOnlyForceLockVanished`
// makes every contention iteration report "known free" without touching the real lock file (which
// this test holds open and never releases, so `open('wx')` genuinely keeps failing EEXIST) —
// reproducing sustained "known-free-but-still-contended" pressure deterministically, instead of
// needing to win a real race against another process. `__setTestOnlyAcquireTimeoutMs` shortens the
// bound so this doesn't take the real ~70s.
// ---------------------------------------------------------------------------

test('a waiter that keeps seeing the lock as free-but-uncontested is still bounded — it throws PreferencesLockTimeoutError instead of spinning forever', async () => {
  const { primary, legacy } = await tmpPaths2()
  const lockPath = `${primary}.lock`

  // A REAL lock file, held forever (never released) — every `open(lockPath, 'wx')` inside
  // `acquireFileLock` genuinely fails EEXIST for the rest of this test.
  const handle = await open(lockPath, 'wx')
  await handle.writeFile('some-other-process-holds-this-forever', 'utf-8')
  await handle.close()

  __setTestOnlyAcquireTimeoutMs(300)
  __setTestOnlyForceLockVanished(true)
  try {
    const start = Date.now()
    await expect(writePreferencesTo(primary, legacy, { installDismissed: true }))
      .rejects.toBeInstanceOf(PreferencesLockTimeoutError)
    const elapsed = Date.now() - start
    // Bounded near the shortened 300ms deadline (plus at most one grace retry's worth of
    // overhead), not spinning for seconds — a regression here would mean the R2 fix's "retry
    // without waiting" path became unbounded again.
    expect(elapsed).toBeLessThan(2_000)
  } finally {
    __setTestOnlyForceLockVanished(false)
    __setTestOnlyAcquireTimeoutMs(null)
  }
}, 3_000) // explicit timeout: bun's internal 5s default marks a hang FAILED but doesn't cancel
// the still-spinning acquireFileLock promise, so `bun test` never exits on its own if this bound
// ever regresses — it has to be killed externally (as verified in round 4). A short explicit
// timeout, well above the shortened 300ms bound this test actually uses but well below the
// default, turns a future regression into a fast, legible red instead of a hung pipeline.

test('a brand-new connection with no token is still stored token-less', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, prefsWithTokens())
  const team = (await readPreferencesFrom(primary, legacy)).team!
  team.connections.push({ id: 'c_ffffffffffff', endpoint: 'http://open:48080', org: 'default', user: 'lucas', token: '', deniedRepos: [] })

  await writePreferencesTo(primary, legacy, { team })

  const after = await readPreferencesFrom(primary, legacy)
  expect(after.team!.connections).toHaveLength(3)
  expect(after.team!.connections[2]!.token).toBe('')
})

// ---------------------------------------------------------------------------
// Stale-lock reclaim (Task 5) — a process killed mid-write (SIGKILL, OOM, crash) leaves its
// `<primary>.lock` file behind forever; without a staleness bound every later write on this
// machine would fail/hang permanently, since nothing else ever deletes it. `acquireFileLock`
// treats a lock file older than `LOCK_STALE_MS` (60s — see the comment on the constant in
// preferences.ts) as abandoned and reclaims it. This test plants exactly that: a lock file with
// an mtime far in the past, held by no real process.
// ---------------------------------------------------------------------------

test('a stale lock file (planted, mtime far in the past) is reclaimed — a write succeeds instead of hanging', async () => {
  const { primary, legacy } = await tmpPaths2()
  await writePreferencesTo(primary, legacy, { team: { schema: 2, mode: 'member', connections: [] } })

  // Plant an abandoned lock file next to primary, backdated well past LOCK_STALE_MS (60s). Its
  // content deliberately does NOT match any real owner token — that's fine, `acquireFileLock`
  // only checks content on RELEASE (to avoid deleting someone else's lock), never as a condition
  // for reclaiming a stale one.
  const lockPath = `${primary}.lock`
  const handle = await open(lockPath, 'w')
  await handle.close()
  // Comfortably past LOCK_STALE_MS — 5x, not just barely over it, so the comparison can never
  // flake on the few ms this test itself takes to reach the stat() call, and never silently goes
  // stale itself if the threshold is retuned again later.
  const longAgo = new Date(Date.now() - 5 * LOCK_STALE_MS)
  await utimes(lockPath, longAgo, longAgo)

  const start = Date.now()
  const team = (await readPreferencesFrom(primary, legacy)).team!
  team.connections.push({ id: 'c_deadbeef0001', endpoint: 'http://stale:1', org: 'default', user: '', token: '', deniedRepos: [] })
  await writePreferencesTo(primary, legacy, { team })
  const elapsed = Date.now() - start

  // Reclaimed almost immediately — nowhere near LOCK_ACQUIRE_TIMEOUT_MS (70s), which is the
  // bound for a LIVE lock that never frees, not a stale one. A missing staleness check would
  // block here until that full timeout elapsed and then throw `PreferencesLockTimeoutError`.
  expect(elapsed).toBeLessThan(2_000)

  const after = await readPreferencesFrom(primary, legacy)
  expect(after.team!.connections.map(c => c.id)).toContain('c_deadbeef0001')
  // The reclaim left a fresh lock behind only transiently — writePreferencesTo released it.
  const stillLocked = await Bun.file(lockPath).exists()
  expect(stillLocked).toBe(false)
})

// ---------------------------------------------------------------------------
// C1 — the PUT /api/preferences guard against an empty-connections wipe.
//
// Losing a connection loses its token, which is stored NOWHERE else on the machine and cannot be
// recovered without re-minting it on the central. The web Disconnect button used to PUT a full flat
// solo `team` object (an own `connections: []` key), which mergeTeamPayload honours as an explicit
// replacement of the whole array — so disconnecting from one central deleted them all.
// ---------------------------------------------------------------------------

import { guardTeamConnectionsWipe } from './preferences'
import type { TeamConfig } from '@agentistics/core'

function guardConn(id: string, endpoint: string) {
  return { id, endpoint, org: 'default', user: 'lucas', token: `tok-${id}`, deniedRepos: [] }
}

test('guardTeamConnectionsWipe strips an empty connections key while connections are stored', () => {
  const payload = { schema: 2, mode: 'solo', connections: [], endpoint: '', org: 'default', user: '', token: '' } as unknown as TeamConfig
  const out = guardTeamConnectionsWipe(payload, 3)
  expect(out.guarded).toBe(true)
  expect(Object.prototype.hasOwnProperty.call(out.team, 'connections')).toBe(false)
  // The rest of the payload is untouched, and the input is never mutated.
  expect(out.team.mode).toBe('solo')
  expect(payload.connections).toEqual([])
})

test('guardTeamConnectionsWipe leaves a genuine payload alone: a non-empty array, no array at all, or nothing stored', () => {
  const withArray = { schema: 2, mode: 'member', connections: [guardConn('c_0123456789ab', 'http://a:48080')] } as unknown as TeamConfig
  expect(guardTeamConnectionsWipe(withArray, 2).guarded).toBe(false)
  expect(guardTeamConnectionsWipe(withArray, 2).team).toBe(withArray)

  const noArray = { schema: 2, mode: 'member', endpoint: 'http://a:48080' } as unknown as TeamConfig
  expect(guardTeamConnectionsWipe(noArray, 2).guarded).toBe(false)
  expect(guardTeamConnectionsWipe(noArray, 2).team).toBe(noArray)

  // Nothing stored → an empty array is not a wipe; a fresh solo machine must stay writable.
  const empty = { schema: 2, mode: 'solo', connections: [] } as unknown as TeamConfig
  expect(guardTeamConnectionsWipe(empty, 0).guarded).toBe(false)
  expect(guardTeamConnectionsWipe(empty, 0).team).toBe(empty)
})

test('C1 end to end: the guarded payload written through writePreferencesTo preserves every connection and token', async () => {
  const { primary, legacy } = await tmpPaths2()
  const stored = [guardConn('c_0123456789ab', 'http://a:48080'), guardConn('c_ba9876543210', 'http://b:48080'), guardConn('c_ccccdddd0000', 'http://c:48080')]
  await writeFile(primary, JSON.stringify({ team: { schema: 2, mode: 'member', connections: stored } }))

  // Exactly what the old Disconnect button PUT: defaultTeam() plus a kept interval.
  const soloPayload = { schema: 2, mode: 'solo', connections: [], endpoint: '', org: 'default', user: '', token: '', pushIntervalSec: 60 } as unknown as TeamConfig
  const guarded = guardTeamConnectionsWipe(soloPayload, stored.length)
  expect(guarded.guarded).toBe(true)
  await writePreferencesTo(primary, legacy, { team: guarded.team })

  const after = await readPreferencesFrom(primary, legacy)
  expect(after.team!.connections.map(c => c.id)).toEqual(stored.map(c => c.id))
  expect(after.team!.connections.map(c => c.token)).toEqual(stored.map(c => c.token))
  expect(after.team!.mode).toBe('member')

  // The unguarded payload is what the damage looks like — asserted so the guard's necessity is
  // documented by a failing-without-it fact, not by a comment.
  await writePreferencesTo(primary, legacy, { team: soloPayload })
  const wiped = await readPreferencesFrom(primary, legacy)
  expect(wiped.team!.connections).toEqual([])
})

import {
  clampSessionPollMs, sessionPollMsOrDefault,
  SESSION_POLL_DEFAULT_MS, SESSION_POLL_MIN_MS, SESSION_POLL_MAX_MS,
} from './preferences'

test('sessionPollMsOrDefault falls back to the built-in default when unset', () => {
  expect(sessionPollMsOrDefault({})).toBe(SESSION_POLL_DEFAULT_MS)
})

test('sessionPollMsOrDefault clamps a stored value to the floor and ceiling', () => {
  expect(sessionPollMsOrDefault({ sessionPollMs: 1 })).toBe(SESSION_POLL_MIN_MS)
  expect(sessionPollMsOrDefault({ sessionPollMs: 1_000_000 })).toBe(SESSION_POLL_MAX_MS)
  expect(sessionPollMsOrDefault({ sessionPollMs: 2_000 })).toBe(2_000)
})

test('clampSessionPollMs falls back to the default for a non-finite value', () => {
  expect(clampSessionPollMs(NaN)).toBe(SESSION_POLL_DEFAULT_MS)
  expect(clampSessionPollMs(Infinity)).toBe(SESSION_POLL_DEFAULT_MS)
})

// THREE — the persisted search-scope preference the cockpit (j-20260826-fi) builds on.
// The scope SET rides `sessionView` and its whole-object write; this file owns where it lives,
// its default, and its validation. The renderer is the TUI's.
import { resolveSessionSearchScopes, DEFAULT_SESSION_SEARCH_SCOPES } from './preferences'

test('search scopes: never chosen reads as the default (all own fields, no transcript)', () => {
  expect(resolveSessionSearchScopes({})).toEqual([...DEFAULT_SESSION_SEARCH_SCOPES])
  expect(DEFAULT_SESSION_SEARCH_SCOPES).not.toContain('transcript')
  expect(DEFAULT_SESSION_SEARCH_SCOPES).toContain('name')
})

test('search scopes: a stored set is honoured, in canonical order and deduped', () => {
  const p = { sessionView: { grouping: 'none', showClosed: false, showExited: false, showUnfiled: false, searchScopes: ['prompt', 'name', 'prompt', 'transcript'] } } as never
  expect(resolveSessionSearchScopes(p)).toEqual(['name', 'prompt', 'transcript'])
})

test('search scopes: an empty stored array is a real (empty) choice, distinct from never-chosen', () => {
  const p = { sessionView: { grouping: 'none', showClosed: false, showExited: false, showUnfiled: false, searchScopes: [] } } as never
  expect(resolveSessionSearchScopes(p)).toEqual([])
})

test('search scopes: unknown values are dropped rather than crashing', () => {
  const p = { sessionView: { grouping: 'none', showClosed: false, showExited: false, showUnfiled: false, searchScopes: ['name', 'bogus', 'folder'] } } as never
  expect(resolveSessionSearchScopes(p)).toEqual(['name', 'folder'])
})
