import { test, expect } from 'bun:test'
import type { RepoEntry } from './repo-manifest'
import {
  PREFERENCES_REL, mergePreferences, planMetrics, planRepos, remaining, rewriteHome,
  type RestoreState,
} from './restore-plan'

const entry = (over: Partial<RepoEntry> & { key: string }): RepoEntry => ({
  cloneUrl: 'git@github.com:org/repo.git', mainPath: '~/proj', mainBranch: 'main',
  worktrees: [], bundle: null, dirty: [], note: null,
  ...over,
})

// --- metrics --------------------------------------------------------------------------------

test('a file the machine does not have is written', () => {
  const a = planMetrics([{ rel: '.agentistics/sessions/claude/a.json', mtimeMs: 100 }], new Map())
  expect(a).toEqual([{ kind: 'write', rel: '.agentistics/sessions/claude/a.json' }])
})

test('a file older than the local copy is skipped, naming why', () => {
  const local = new Map([['.agentistics/sessions/claude/a.json', 200]])
  const a = planMetrics([{ rel: '.agentistics/sessions/claude/a.json', mtimeMs: 100 }], local)
  expect(a).toEqual([{ kind: 'skip', rel: '.agentistics/sessions/claude/a.json', reason: 'newer-local' }])
})

test('a file newer than the local copy is written', () => {
  const local = new Map([['.agentistics/sessions/claude/a.json', 100]])
  const a = planMetrics([{ rel: '.agentistics/sessions/claude/a.json', mtimeMs: 200 }], local)
  expect(a[0]!.kind).toBe('write')
})

// Claude owns stats-cache.json and rewrites it. Ours goes where applyArchivedStats already reads
// it with per-field max, never additive — an existing rule reused rather than a new one invented.
test('stats-cache.json is redirected into the archive stats dir, never over Claude own', () => {
  const a = planMetrics([{ rel: '.claude/stats-cache.json', mtimeMs: 100 }], new Map())
  expect(a).toEqual([{
    kind: 'write',
    rel: '.claude/stats-cache.json',
    redirectTo: '.agentistics/archive/stats-cache/stats-cache.json',
  }])
})

// E4: preferences.json is the one file the tool writes for ITSELF, so on the realistic flow —
// reformat, install, run setup, THEN restore — the local copy is always minutes old. Newer-wins
// would ALWAYS discard the backup's copy, dropping the billing timeline and custom layouts Wave B
// went to the trouble of carrying redacted. It gets its own `merge` action instead, regardless of
// which side is newer.
test('preferences.json always merges — it is never skipped for being older or written outright', () => {
  const localNewer = new Map([[PREFERENCES_REL, 999_999]])
  expect(planMetrics([{ rel: PREFERENCES_REL, mtimeMs: 100 }], localNewer))
    .toEqual([{ kind: 'merge', rel: PREFERENCES_REL }])

  expect(planMetrics([{ rel: PREFERENCES_REL, mtimeMs: 999_999 }], new Map()))
    .toEqual([{ kind: 'merge', rel: PREFERENCES_REL }])
})

// --- mergePreferences (pure) ------------------------------------------------------------------

test('mergePreferences keeps every local key, and fills in what the backup has and the local lacks', () => {
  const local = JSON.stringify({ lang: 'en', localOnly: 1 })
  const archived = JSON.stringify({ lang: 'pt', localOnly: 2, backupOnly: 3 })
  const r = mergePreferences(local, archived)
  const merged = JSON.parse(r.text) as Record<string, unknown>
  expect(merged.lang).toBe('en')          // local wins
  expect(merged.localOnly).toBe(1)        // local wins
  expect(merged.backupOnly).toBe(3)       // taken from the backup, since local lacked it
  expect(r.tookFromBackup).toEqual(['backupOnly'])
})

// `team`'s tokens were stripped before the file traveled (stageRedactedFiles) — a half-`team` block
// landing on an already-configured machine is worse than no team at all, so it is never merged in
// EITHER direction, whichever side actually has it.
test('mergePreferences never merges the team block, in either direction', () => {
  const local = JSON.stringify({ lang: 'en' })
  const archived = JSON.stringify({ lang: 'pt', team: { token: 'nope', mode: 'member' } })
  const r = mergePreferences(local, archived)
  const merged = JSON.parse(r.text) as Record<string, unknown>
  expect(merged.team).toBeUndefined()
  expect(r.tookFromBackup).not.toContain('team')
})

test('a local team block survives untouched even when the backup also carries one', () => {
  const local = JSON.stringify({ team: { mode: 'solo' } })
  const archived = JSON.stringify({ team: { mode: 'member', token: 'nope' } })
  const r = mergePreferences(local, archived)
  expect(JSON.parse(r.text)).toEqual({ team: { mode: 'solo' } })
})

test('an unparseable local file yields the archived copy wholesale, minus team', () => {
  const r = mergePreferences('{not json', JSON.stringify({ lang: 'pt', team: { token: 'x' } }))
  const merged = JSON.parse(r.text) as Record<string, unknown>
  expect(merged.lang).toBe('pt')
  expect(merged.team).toBeUndefined()
})

test('an unparseable backup copy leaves the local file untouched', () => {
  const r = mergePreferences(JSON.stringify({ lang: 'en' }), '{not json')
  expect(r.text).toBe(JSON.stringify({ lang: 'en' }))
  expect(r.tookFromBackup).toEqual([])
})

// --- repos ----------------------------------------------------------------------------------

const fresh = (): RestoreState => ({ repos: {} })

test('a repo with nothing recorded is pending, and carries its commands', () => {
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], fresh(), () => false, '/home/n')
  expect(steps[0]!.state).toBe('pending')
  expect(steps[0]!.commands[0]).toBe('git clone git@github.com:org/repo.git /home/n/proj')
})

test('a repo already done is not attempted again — this is what makes rerunning safe', () => {
  const state: RestoreState = { repos: { 'github.com/org/repo': { state: 'done' } } }
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], state, () => false, '/home/n')
  expect(steps[0]!.state).toBe('done')
  expect(remaining(steps)).toHaveLength(0)
})

test('a repo that failed is retried on the next run', () => {
  const state: RestoreState = { repos: { 'github.com/org/repo': { state: 'failed', reason: 'auth' } } }
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], state, () => false, '/home/n')
  expect(remaining(steps)).toHaveLength(1)
  expect(steps[0]!.previousFailure).toBe('auth')
})

// D2: a repo that fails AFTER its clone (branch rename, fetch, checkout, worktree add, apply) leaves
// the destination on disk. `destExists` alone would then read that as a plain `skipped` forever —
// the CLI tells the user to re-run to retry failures, and the re-run does nothing and exits 0. It
// must get its own state, checked BEFORE `destExists`.
test('a repo that failed AFTER cloning is half-restored, not silently skipped', () => {
  const state: RestoreState = { repos: { 'github.com/org/repo': { state: 'failed', reason: 'worktree add failed' } } }
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], state, () => true, '/home/n')
  expect(steps[0]!.state).toBe('half-restored')
  expect(steps[0]!.previousFailure).toBe('worktree add failed')
  expect(steps[0]!.commands).toEqual([])
})

test('a destination that already exists is skipped with a reason, never overwritten', () => {
  const steps = planRepos([entry({ key: 'github.com/org/repo' })], fresh(), () => true, '/home/n')
  expect(steps[0]!.state).toBe('skipped')
  expect(steps[0]!.reason).toBe('destination-exists')
  expect(steps[0]!.commands).toEqual([])
})

test('every note that cannot be cloned is skipped, and says which note', () => {
  for (const note of ['gone', 'not-a-repo', 'no-remote', 'outside-home'] as const) {
    const steps = planRepos([entry({ key: `k-${note}`, note })], fresh(), () => false, '/home/n')
    expect(steps[0]!.state).toBe('skipped')
    expect(steps[0]!.reason).toBe(note)
  }
})

test('too-large is NOT a skip — the repo clones, minus its local-only history', () => {
  const steps = planRepos([entry({ key: 'k', note: 'too-large' })], fresh(), () => false, '/home/n')
  expect(steps[0]!.state).toBe('pending')
  expect(steps[0]!.commands.length).toBeGreaterThan(0)
})

// --- $HOME rewrite --------------------------------------------------------------------------

test('the home prefix is rewritten when the two differ', () => {
  const j = '{"project_path":"/home/old/proj","current_cwd":"/home/old/proj/wt"}'
  expect(rewriteHome(j, '/home/old', '/home/new'))
    .toBe('{"project_path":"/home/new/proj","current_cwd":"/home/new/proj/wt"}')
})

test('an identical home is a no-op — the text is returned untouched', () => {
  const j = '{"project_path":"/home/same/proj"}'
  expect(rewriteHome(j, '/home/same', '/home/same')).toBe(j)
})

// /home/old must not match inside /home/older. A bare string replace does, and would corrupt
// every path of an unrelated user whose name starts the same way.
test('a home that is a prefix of another directory name is not rewritten', () => {
  const j = '{"a":"/home/older/proj","b":"/home/old/proj"}'
  expect(rewriteHome(j, '/home/old', '/home/new'))
    .toBe('{"a":"/home/older/proj","b":"/home/new/proj"}')
})
