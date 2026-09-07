import { test, expect } from 'bun:test'
import {
  PLACEHOLDER_BRANCH, assetRel, expandHome, groupRepos, homeRelative, restoreArgv, restoreCommands,
  type DirFacts,
} from './repo-manifest'

const HOME = '/home/u'

const facts = (over: Partial<DirFacts> & { path: string }): DirFacts => ({
  exists: true, commonDir: null, topLevel: null, cloneUrl: '', remote: '', branch: '', head: '',
  ...over,
})

const mainRepo = (path: string, url = 'git@github.com:org/repo.git'): DirFacts => facts({
  path, commonDir: `${path}/.git`, topLevel: path, cloneUrl: url,
  remote: 'github.com/org/repo', branch: 'main', head: 'a1b2c3d',
})

test('a plain checkout becomes one entry with no worktrees', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/proj`)], HOME)
  expect(e!.key).toBe('github.com/org/repo')
  expect(e!.mainPath).toBe('~/proj')
  expect(e!.mainBranch).toBe('main')
  expect(e!.worktrees).toEqual([])
  expect(e!.note).toBeNull()
})

// The only thing a worktree provably shares with its main checkout is the git COMMON DIR. Grouping
// by remote would merge two unrelated clones of the same repo; grouping by path prefix breaks the
// moment a worktree lives outside its checkout.
test('a worktree groups under its main checkout, by common dir', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/.claude/worktrees/feat`, commonDir: `${HOME}/proj/.git`,
    topLevel: `${HOME}/proj/.claude/worktrees/feat`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'feat/x', head: 'deadbee',
  })
  const entries = groupRepos([wt, main], HOME)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.mainPath).toBe('~/proj')
  expect(entries[0]!.worktrees).toEqual([
    { path: '~/proj/.claude/worktrees/feat', branch: 'feat/x', head: 'deadbee' },
  ])
})

test('a worktree living outside its checkout still groups with it', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: '/tmp/elsewhere', commonDir: `${HOME}/proj/.git`, topLevel: '/tmp/elsewhere',
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'wip', head: 'f00',
  })
  const entries = groupRepos([main, wt], HOME)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.worktrees[0]!.path).toBe('/tmp/elsewhere')
})

test('two clones of the same repo stay two entries', () => {
  const entries = groupRepos([mainRepo(`${HOME}/a`), mainRepo(`${HOME}/b`)], HOME)
  expect(entries).toHaveLength(2)
  expect(entries.map(e => e.mainPath).sort()).toEqual(['~/a', '~/b'])
})

test('a directory that no longer exists is `gone` and is never asked of git', () => {
  const [e] = groupRepos([facts({ path: `${HOME}/deleted`, exists: false })], HOME)
  expect(e!.note).toBe('gone')
  expect(restoreCommands(e!, HOME)).toEqual([])
})

test('an existing directory that is not a repo says so', () => {
  const [e] = groupRepos([facts({ path: `${HOME}/notes` })], HOME)
  expect(e!.note).toBe('not-a-repo')
  expect(restoreCommands(e!, HOME)).toEqual([])
})

test('a repo with no remote is `no-remote` — there is nothing to clone from', () => {
  const [e] = groupRepos([facts({
    path: `${HOME}/local`, commonDir: `${HOME}/local/.git`, topLevel: `${HOME}/local`,
    branch: 'main', head: 'abc',
  })], HOME)
  expect(e!.note).toBe('no-remote')
  expect(e!.key).toBe(`${HOME}/local/.git`)
})

// The bug this module exists to prevent, and which it shipped for one review cycle. A bare
// repository with worktrees hanging off it reports a common dir that is not `<tree>/.git`; the old
// code left mainDir as that raw string, matched no member, and elected members[0] — so a worktree
// became "main" and the restore would rebuild the real checkout as a worktree of itself.
test('a layout that names no working tree is refused, never resolved by array order', () => {
  const bare = `${HOME}/proj.git`
  const wt = (path: string, branch: string): DirFacts => facts({
    path, commonDir: bare, topLevel: path,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo', branch, head: 'abc',
  })
  const [e] = groupRepos([wt(`${HOME}/proj/main`, 'main'), wt(`${HOME}/proj/feat`, 'feat')], HOME)
  expect(e!.note).toBe('no-main-checkout')
  expect(e!.mainPath).toBe('~/proj.git')
  expect(e!.worktrees.map(w => w.path)).toEqual(['~/proj/main', '~/proj/feat'])
  // Nothing runs: an elected worktree would clone over a real checkout.
  expect(restoreArgv(e!, HOME)).toEqual([])
})

// git refuses one branch checked out in two trees, so borrowing a worktree's branch for the
// unprobed main checkout would make `checkout` succeed and the matching `worktree add` fail.
test('an unprobed main checkout keeps its branch UNKNOWN, and every member stays a worktree', () => {
  const wt = facts({
    path: `${HOME}/proj/.worktrees/feat`, commonDir: `${HOME}/proj/.git`,
    topLevel: `${HOME}/proj/.worktrees/feat`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'feat/x', head: 'dead',
  })
  const [e] = groupRepos([wt], HOME)
  expect(e!.mainPath).toBe('~/proj')
  expect(e!.mainBranch).toBe('')
  expect(e!.worktrees).toHaveLength(1)
  const argv = restoreArgv(e!, HOME)
  expect(argv.some(s => s.argv.includes('checkout'))).toBe(false)
  expect(argv.some(s => s.argv.includes('worktree'))).toBe(true)
})

// E2: an unknown main branch WITH a bundle used to `reset --hard`, which left the checkout ON the
// placeholder branch — a working tree at the pushed tip while the real unpushed work sat unreachable
// in `refs/heads/main`. A detached checkout at the clone's own default is honest about knowing no
// branch name, and checks out the content the bundle actually wrote.
test('an unknown main branch with a bundle checks out detached at the clone default, never `reset --hard` on the placeholder', () => {
  const wt = facts({
    path: `${HOME}/proj/.worktrees/feat`, commonDir: `${HOME}/proj/.git`,
    topLevel: `${HOME}/proj/.worktrees/feat`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'feat/x', head: 'dead',
  })
  const [e] = groupRepos([wt], HOME)
  e!.bundle = 'repos/k.bundle'
  const argv = restoreArgv(e!, HOME)
  expect(argv.some(s => s.argv.includes('reset'))).toBe(false)
  expect(argv.some(s =>
    s.argv[0] === 'git' && s.argv.includes('checkout') && s.argv.includes('--detach') && s.argv.includes('origin/HEAD'),
  )).toBe(true)
})

test('outside $HOME outranks no-remote — the stronger statement, and it saves a wasted bundle', () => {
  const [e] = groupRepos([facts({
    path: '/tmp/scratch', commonDir: '/tmp/scratch/.git', topLevel: '/tmp/scratch',
    branch: 'main', head: 'abc',
  })], HOME)
  expect(e!.note).toBe('outside-home')
})

test('a path outside $HOME is recorded and never restored', () => {
  const [e] = groupRepos([mainRepo('/tmp/scratch')], HOME)
  expect(e!.note).toBe('outside-home')
  expect(restoreCommands(e!, HOME)).toEqual([])
})

test('restoreCommands rebuilds clone, bundle, branch, worktrees and patches, in that order', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/wt`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj/wt`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'feat/x', head: 'dead',
  })
  const [e] = groupRepos([main, wt], HOME)
  e!.bundle = 'repos/github.com_org_repo.bundle'
  e!.dirty = [{ path: '~/proj', patch: 'repos/github.com_org_repo__main.patch', untracked: [] }]

  expect(restoreCommands(e!, '/home/new')).toEqual([
    'git clone --no-checkout git@github.com:org/repo.git /home/new/proj',
    'git -C /home/new/proj branch -m agentistics-restore-placeholder',
    'git -C /home/new/proj fetch repos/github.com_org_repo.bundle +refs/heads/*:refs/heads/*',
    'git -C /home/new/proj checkout main',
    'git -C /home/new/proj branch --set-upstream-to origin/main main',
    'git -C /home/new/proj worktree add /home/new/proj/wt feat/x',
    'git -C /home/new/proj apply repos/github.com_org_repo__main.patch',
    'git -C /home/new/proj branch -D agentistics-restore-placeholder',
  ])
})

// E2: `branch -m` above carried the tracking config to the placeholder, and the bundle fetch then
// created `refs/heads/main` with none — a restored repo with unpushed commits answered `git pull`/
// `git push` with "no tracking information" / "no upstream branch". Re-established right after the
// checkout, and marked OPTIONAL: it legitimately fails on a branch with no matching remote branch,
// and that must not cost the worktrees and patches that follow.
test('a restored main branch gets its upstream re-established, marked optional', () => {
  const main = mainRepo(`${HOME}/proj`)
  const [e] = groupRepos([main], HOME)
  e!.bundle = 'repos/k.bundle'
  const argv = restoreArgv(e!, HOME)
  const upstream = argv.find(s => s.argv.includes('--set-upstream-to'))
  expect(upstream?.argv).toEqual(['git', '-C', '/home/u/proj', 'branch', '--set-upstream-to', 'origin/main', 'main'])
  expect(upstream?.optional).toBe(true)
})

// E2: the placeholder held the pre-fetch content reachable during the steps above and would
// otherwise sit in the restored repository forever, bundled again as "unpushed work" by the very
// next backup — deleted LAST, once nothing else needs it, and OPTIONAL for the same reason the
// rename step is.
test('the placeholder branch is deleted last, once nothing else needs it, and optionally', () => {
  const main = mainRepo(`${HOME}/proj`)
  const [e] = groupRepos([main], HOME)
  e!.bundle = 'repos/k.bundle'
  e!.dirty = [{ path: '~/proj', patch: 'repos/k__main.patch', untracked: [] }]
  const argv = restoreArgv(e!, HOME)
  const last = argv[argv.length - 1]!
  expect(last.argv).toEqual(['git', '-C', '/home/u/proj', 'branch', '-D', PLACEHOLDER_BRANCH])
  expect(last.optional).toBe(true)
})

// A repo with no bundle never renamed anything onto the placeholder, so there is nothing to
// re-link or clean up — the two new steps must not appear.
test('with no bundle there is no upstream re-link and no placeholder cleanup', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/proj`)], HOME)
  const argv = restoreArgv(e!, HOME)
  expect(argv.some(s => s.argv.includes('--set-upstream-to'))).toBe(false)
  expect(argv.some(s => s.argv.includes(PLACEHOLDER_BRANCH) && s.argv.includes('-D'))).toBe(false)
})

// Verified against real git, not just read: `--no-checkout` alone does NOT clear the refusal (a
// clone still attaches HEAD to a local branch even without populating the working tree, and even a
// freshly `git init`-ed repo with no commits refuses a fetch into its still-unborn default branch).
// Only moving HEAD off the name the fetch needs to write does — `branch -m <placeholder>` renames
// whatever is CURRENTLY checked out, so the plan never has to know that name in advance.
test('a bundle renames the checked-out branch out of the way before fetching it', () => {
  const main = mainRepo(`${HOME}/proj`)
  const [e] = groupRepos([main], HOME)
  e!.bundle = 'repos/k.bundle'
  const argv = restoreArgv(e!, HOME)
  expect(argv[0]!.argv).toEqual(['git', 'clone', '--no-checkout', 'git@github.com:org/repo.git', '/home/u/proj'])
  expect(argv[1]!.argv).toEqual(['git', '-C', '/home/u/proj', 'branch', '-m', PLACEHOLDER_BRANCH])
  expect(argv[2]!.argv).toEqual(['git', '-C', '/home/u/proj', 'fetch', 'repos/k.bundle', '+refs/heads/*:refs/heads/*'])
  expect(argv[3]!.argv).toEqual(['git', '-C', '/home/u/proj', 'checkout', 'main'])
})

test('with no bundle the clone checks out normally', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/proj`)], HOME)
  const argv = restoreArgv(e!, HOME)
  expect(argv[0]!.argv).toEqual(['git', 'clone', 'git@github.com:org/repo.git', '/home/u/proj'])
  expect(argv.some(s => s.argv.includes('--no-checkout'))).toBe(false)
})

// Display and execution come from ONE source, in two shapes. A path with a space cannot be
// recovered from a joined string, and joining then re-splitting is how a shell injection or a
// silently wrong argv gets in.
test('restoreArgv is the same plan as structured argv, and survives a path with a space', () => {
  const [e] = groupRepos([mainRepo('/home/u/my projects/app')], HOME)
  const argv = restoreArgv(e!, '/home/u')
  expect(argv[0]!.argv).toEqual(['git', 'clone', 'git@github.com:org/repo.git', '/home/u/my projects/app'])
  // The printable form is the same plan, joined for a human to read.
  expect(restoreCommands(e!, '/home/u')[0]).toBe('git clone git@github.com:org/repo.git /home/u/my projects/app')
  expect(restoreCommands(e!, '/home/u')).toHaveLength(argv.length)
})

// A bundle and a patch are paths INSIDE the archive. Printed in the plan they stay archive-
// relative (that is what a reader can locate); executed, they must resolve to where the archive
// was actually extracted, or `git fetch` is handed a path that does not exist.
test('an assetDir resolves the bundle and patch paths, and its absence leaves them archive-relative', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/proj`)], HOME)
  e!.bundle = 'repos/github.com_org_repo.bundle'
  e!.dirty = [{ path: '~/proj', patch: 'repos/github.com_org_repo__main.patch', untracked: [] }]

  const bare = restoreArgv(e!, HOME)
  expect(bare.find(s => s.argv.includes('fetch'))!.argv)
    .toEqual(['git', '-C', '/home/u/proj', 'fetch', 'repos/github.com_org_repo.bundle', '+refs/heads/*:refs/heads/*'])

  const staged = restoreArgv(e!, HOME, '/stage')
  expect(staged.find(s => s.argv.includes('fetch'))!.argv)
    .toEqual(['git', '-C', '/home/u/proj', 'fetch', '/stage/repos/github.com_org_repo.bundle', '+refs/heads/*:refs/heads/*'])
  expect(staged.find(s => s.argv.includes('apply'))!.argv)
    .toEqual(['git', '-C', '/home/u/proj', 'apply', '/stage/repos/github.com_org_repo__main.patch'])
})

test('a repo whose bundle exceeded the ceiling is `too-large` and clones without one', () => {
  const [e] = groupRepos([mainRepo(`${HOME}/big`)], HOME)
  e!.note = 'too-large'
  expect(restoreCommands(e!, HOME)).toEqual([
    'git clone git@github.com:org/repo.git /home/u/big',
    'git -C /home/u/big checkout main',
  ])
})

test('a detached worktree is recreated detached at its head, never with an empty ref', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/wt`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj/wt`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: '', head: 'deadbee',
  })
  const [e] = groupRepos([main, wt], HOME)
  const argv = restoreArgv(e!, HOME)
  expect(argv.map(s => s.argv)).toContainEqual(
    ['git', '-C', '/home/u/proj', 'worktree', 'add', '--detach', '/home/u/proj/wt', 'deadbee'])
  expect(argv.every(s => s.argv.every(x => x !== ''))).toBe(true)
})

test('a worktree with neither branch nor head is left out rather than emitted broken', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/wt`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj/wt`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo', branch: '', head: '',
  })
  const [e] = groupRepos([main, wt], HOME)
  expect(restoreArgv(e!, HOME).some(s => s.argv.includes('worktree'))).toBe(false)
})

test('home paths round-trip, and a path outside home is left absolute', () => {
  expect(homeRelative('/home/u/proj', HOME)).toBe('~/proj')
  expect(homeRelative('/tmp/x', HOME)).toBe('/tmp/x')
  expect(expandHome('~/proj', '/home/new')).toBe('/home/new/proj')
  expect(expandHome('/tmp/x', '/home/new')).toBe('/tmp/x')
})

test('two checkouts of ONE remote get DIFFERENT asset paths', () => {
  // Measured on a real machine: `~/agentistics` (20 branches of unpushed work, a 508 KB bundle)
  // and `~/aipe-blpsoares/agentistics` (everything pushed, 4 KB) are two entries sharing one
  // `key`. Naming the bundle after the key alone had the second `git bundle create` overwrite the
  // first — and `createBundle` DELETES an empty/oversized one, so the second checkout could also
  // erase the first's file while its manifest entry still pointed at it. The backup then carried
  // 4 KB where 508 KB of unpushed branches should have been, and said nothing.
  const a = assetRel('github.com/org/repo', '~/proj', '.bundle')
  const b = assetRel('github.com/org/repo', '~/nested/proj', '.bundle')
  expect(a).not.toBe(b)
  expect(a.startsWith('repos/')).toBe(true)
  expect(a.endsWith('.bundle')).toBe(true)
  // No separator may survive into the file name, or the asset lands in a directory tar never made.
  expect(a.slice('repos/'.length)).not.toInclude('/')
})

test('an asset path is stable for the same checkout and safe for any key', () => {
  expect(assetRel('github.com/org/repo', '~/proj', '.bundle'))
    .toBe(assetRel('github.com/org/repo', '~/proj', '.bundle'))
  expect(assetRel('/var/weird path/../x', '~/a b/c', '.patch'))
    .toMatch(/^repos\/[A-Za-z0-9._-]+\.patch$/)
})

test('the main checkout is never ALSO listed as one of its own worktrees', () => {
  // Two sessions in one checkout — say `~/proj` and `~/proj/packages/web` — probe to the SAME
  // `topLevel`, so `members` holds two objects for one tree. The split filtered by object identity
  // (`m !== main`), which drops exactly one of them and leaves the other standing as a worktree of
  // itself. Measured on a real machine: 6 repositories, and the restore then emits
  // `git worktree add ~/proj` for the tree git has just checked out (git refuses: already exists)
  // and applies that tree's patch twice (the second `git apply` cannot apply an applied patch).
  // Both are hard failures reported over data that was captured perfectly.
  const a = facts({
    path: `${HOME}/proj`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'main', head: 'aaaaaaa',
  })
  const b = facts({
    path: `${HOME}/proj/packages/web`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'main', head: 'aaaaaaa',
  })
  const [e] = groupRepos([a, b], HOME)
  expect(e!.mainPath).toBe('~/proj')
  expect(e!.mainBranch).toBe('main')
  expect(e!.worktrees.map(w => w.path)).not.toContain('~/proj')
  expect(restoreArgv(e!, HOME).some(s => s.argv.includes('worktree'))).toBe(false)
})

test('a REAL worktree beside the main checkout is still kept', () => {
  const main = mainRepo(`${HOME}/proj`)
  const wt = facts({
    path: `${HOME}/proj/wt`, commonDir: `${HOME}/proj/.git`, topLevel: `${HOME}/proj/wt`,
    cloneUrl: 'git@github.com:org/repo.git', remote: 'github.com/org/repo',
    branch: 'feat', head: 'deadbee',
  })
  const [e] = groupRepos([main, wt], HOME)
  expect(e!.worktrees.map(w => w.path)).toEqual(['~/proj/wt'])
})
