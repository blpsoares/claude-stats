/**
 * repo-manifest.ts — PURE. From what git said about a directory to a repository that can be rebuilt.
 *
 * ## Grouped by the git COMMON DIR, and only by that
 *
 * The hard part is not listing repositories, it is knowing that 218 directories are really 89.
 * Three candidate keys, and two of them are wrong:
 *
 *  - by REMOTE — merges two independent clones of the same repository into one entry, and then the
 *    restore rebuilds one of them and silently drops the other;
 *  - by PATH PREFIX — breaks the moment a worktree lives outside its checkout, which `git worktree
 *    add /tmp/x` does routinely;
 *  - by COMMON DIR — exact. A worktree's `--git-common-dir` IS its main checkout's `.git`. That is
 *    the one thing they provably share, which is the same reasoning `repo-facts.ts` records when it
 *    refuses `--show-toplevel` as a key.
 *
 * ## Four notes, each of which means "there is nothing to clone"
 *
 * `gone` (the directory no longer exists), `not-a-repo` (it exists and git does not know it),
 * `no-remote` (a real repository with nowhere to clone from — its history can only travel as a full
 * bundle), `outside-home` (recorded so the report is complete; `/tmp` is not a place to put a
 * repository back). A directory that is GONE is not a directory outside a repository, and the
 * discriminator is whether it EXISTS, never whether git answered — the same distinction
 * `repo-facts.ts` exists to make.
 *
 * `restoreCommands` is the reverse direction and lives here so the plan a person reads and the
 * commands that run are the same function. A note means it emits nothing at all.
 */

export type RepoNote = 'no-remote' | 'gone' | 'not-a-repo' | 'outside-home' | 'too-large' | null

export interface RepoWorktree {
  /** `~`-prefixed when under $HOME, absolute otherwise. */
  path: string
  branch: string
  head: string
}

export interface RepoDirty {
  path: string
  /** Path INSIDE the archive (`repos/<key>__<dir>.patch`), or null when the tree was clean. */
  patch: string | null
  /**
   * Untracked file names — a LIST, never the contents.
   *
   * An untracked `.env`, `credentials.json` or service-account key sitting in a working tree is
   * exactly the class of file Task 1's exclusion table exists to keep out of the archive, and it
   * is invisible to that table because it lives under a repository path rather than a known
   * dotfile. Carrying the contents would smuggle back in through the repos layer precisely what
   * the secrets decision keeps out of the raw layer. The restore prints these by name so nothing
   * goes missing in silence.
   */
  untracked: string[]
}

export interface RepoEntry {
  /** The normalized remote, or the common dir when there is none. Stable across machines. */
  key: string
  /** The url as configured — what git actually needs, not the normalized form. */
  cloneUrl: string
  mainPath: string
  mainBranch: string
  worktrees: RepoWorktree[]
  /** Path inside the archive, or null. */
  bundle: string | null
  dirty: RepoDirty[]
  note: RepoNote
}

/** What one probe of one directory produced. All paths absolute. */
export interface DirFacts {
  path: string
  exists: boolean
  /** Absolute path of `git rev-parse --git-common-dir`, or null when git said nothing. */
  commonDir: string | null
  topLevel: string | null
  cloneUrl: string
  /** Normalized via normalizeGitRemote by the caller. '' when there is none. */
  remote: string
  branch: string
  head: string
}

export function homeRelative(path: string, homeDir: string): string {
  if (path === homeDir) return '~'
  return path.startsWith(homeDir + '/') ? '~' + path.slice(homeDir.length) : path
}

export function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  return path.startsWith('~/') ? homeDir + path.slice(1) : path
}

function isUnder(path: string, homeDir: string): boolean {
  return path === homeDir || path.startsWith(homeDir + '/')
}

/**
 * Turn a flat list of probed directories into repository entries.
 *
 * A directory whose `topLevel` equals `dirname(commonDir)` is the MAIN checkout; every other
 * directory sharing that common dir is one of its worktrees. A group with no main checkout among
 * the probed directories (the checkout itself was never a session cwd) promotes the common dir's
 * parent to `mainPath`, because that is where git will put it back.
 */
export function groupRepos(facts: DirFacts[], homeDir: string): RepoEntry[] {
  const noted: RepoEntry[] = []
  const groups = new Map<string, DirFacts[]>()

  for (const f of facts) {
    if (!f.exists) {
      noted.push(bare(f, homeDir, 'gone'))
      continue
    }
    if (!f.commonDir || !f.topLevel) {
      noted.push(bare(f, homeDir, 'not-a-repo'))
      continue
    }
    const list = groups.get(f.commonDir) ?? []
    list.push(f)
    groups.set(f.commonDir, list)
  }

  const entries: RepoEntry[] = []
  for (const [commonDir, members] of groups) {
    const mainDir = commonDir.replace(/\/\.git$/, '')
    const main = members.find(m => m.topLevel === mainDir) ?? members[0]!
    const worktrees = members.filter(m => m !== main)

    const remote = members.find(m => m.remote)?.remote ?? ''
    const cloneUrl = members.find(m => m.cloneUrl)?.cloneUrl ?? ''

    let note: RepoNote = null
    if (!remote) note = 'no-remote'
    else if (!isUnder(mainDir, homeDir)) note = 'outside-home'

    entries.push({
      key: remote || commonDir,
      cloneUrl,
      mainPath: homeRelative(mainDir, homeDir),
      mainBranch: main.branch,
      worktrees: worktrees.map(w => ({
        path: homeRelative(w.topLevel ?? w.path, homeDir),
        branch: w.branch,
        head: w.head,
      })),
      bundle: null,
      dirty: [],
      note,
    })
  }
  return [...entries, ...noted]
}

function bare(f: DirFacts, homeDir: string, note: RepoNote): RepoEntry {
  return {
    key: f.path,
    cloneUrl: '',
    mainPath: homeRelative(f.path, homeDir),
    mainBranch: '',
    worktrees: [],
    bundle: null,
    dirty: [],
    note,
  }
}

/**
 * The exact commands that rebuild this entry under `homeDir`.
 *
 * Empty for every note except `too-large`, which is a real, cloneable repository whose local-only
 * history did not fit — it clones, and the report says what did not come with it. Returning the
 * commands rather than running them is what lets `agentop restore` print the plan before touching
 * anything.
 */
export function restoreArgv(entry: RepoEntry, homeDir: string, assetDir = ''): string[][] {
  if (entry.note && entry.note !== 'too-large') return []
  if (!entry.cloneUrl) return []

  const main = expandHome(entry.mainPath, homeDir)
  // `bundle` and `patch` are paths INSIDE the archive. At restore time they live under wherever
  // the archive was extracted, so the caller passes that directory; the plan printed BEFORE
  // extraction passes nothing and shows the archive-relative path, which is what a reader wants.
  const asset = (rel: string): string => (assetDir ? `${assetDir}/${rel}` : rel)
  const out: string[][] = [['git', 'clone', entry.cloneUrl, main]]

  // Fetch the bundle BEFORE checking out: the branch we want may only exist inside it.
  if (entry.bundle) out.push(['git', '-C', main, 'fetch', asset(entry.bundle), 'refs/heads/*:refs/heads/*'])
  if (entry.mainBranch) out.push(['git', '-C', main, 'checkout', entry.mainBranch])

  for (const w of entry.worktrees) {
    out.push(['git', '-C', main, 'worktree', 'add', expandHome(w.path, homeDir), w.branch])
  }
  for (const d of entry.dirty) {
    if (d.patch) out.push(['git', '-C', expandHome(d.path, homeDir), 'apply', asset(d.patch)])
  }
  return out
}

/**
 * The same plan, joined for a person to read.
 *
 * `restoreArgv` is what RUNS and `restoreCommands` is what PRINTS, from one source — because a
 * path containing a space cannot be recovered from a joined string, and joining then re-splitting
 * is how a wrong argv (or a shell) gets in. The printed form is for the human reading
 * `agentop restore`'s plan; nothing executes it.
 */
export function restoreCommands(entry: RepoEntry, homeDir: string, assetDir = ''): string[] {
  return restoreArgv(entry, homeDir, assetDir).map(a => a.join(' '))
}
