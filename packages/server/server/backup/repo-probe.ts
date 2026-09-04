/**
 * repo-probe.ts — IO. What live git says about the directories the store knows about.
 *
 * The consolidate store records `git_remote` on only 89 of 282 paths on the reference machine, and
 * that is a limitation of the STORE — the field is stamped where the Claude walk happened to
 * resolve it. So this module asks git, and uses the store only for the LIST of directories worth
 * asking about.
 *
 * Two rules carried over from `repo-facts.ts`, both of which were bugs there first:
 *
 *  - **A directory that is GONE is not a directory outside a repository.** The discriminator is
 *    whether it EXISTS, never whether git answered. `ExitWorktree --remove` leaves a session
 *    registered at a path that names nothing, every `git -C` fails, and calling that "not a repo"
 *    invents a project standing beside the real one.
 *  - **`--git-common-dir` is the key, and it must be absolutised.** Run inside a worktree, git
 *    prints it RELATIVE to that worktree; left relative, two worktrees of one checkout produce two
 *    different keys and the grouping silently fails.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { unlink } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { normalizeGitRemote } from '@agentistics/core'
import { createLimiter } from '../utils'
import type { DirFacts } from './repo-manifest'

const run = promisify(execFile)

/**
 * The environment every git child gets.
 *
 * Two jobs. It never lets git PROMPT — a credential prompt inside a backup hangs the whole run.
 * And it REMOVES the variables that would make `-C` a lie.
 *
 * `git -C <path>` does NOT override an inherited `GIT_DIR`, and a hook is exactly where one is
 * inherited: git fires `pre-commit` with `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_PREFIX` exported, so
 * a backup invoked from a hook would probe every directory against the HOOK's repository.
 * `GIT_COMMON_DIR` is in the list for a sharper reason — measured: on its own, with no `GIT_DIR`
 * set, it silently redirects `rev-parse --git-common-dir`, which is the ONE fact `groupRepos` keys
 * on. (`GIT_OBJECT_DIRECTORY`, `GIT_NAMESPACE` and `GIT_CEILING_DIRECTORIES` were measured too and
 * do not redirect it; they are left alone rather than cargo-culted into the list.)
 */
const HIJACKERS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR'] as const

/**
 * Built PER CALL, deliberately, not captured once at module load.
 *
 * A module-load snapshot is wrong twice over. In production it misses anything that sets these
 * variables after import — a spawn wrapper, a nested hook, a test harness. And it makes the strip
 * UNTESTABLE: a test that sets `process.env.GIT_COMMON_DIR` and then calls the probe would be
 * mutating an object the module had already copied, so it passes identically whether the strip is
 * present or reverted. That was measured — the regression test for this very fix was green against
 * a build with the fix removed. Rebuilding a small object per git call costs nothing next to
 * spawning a process.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of HIJACKERS) delete env[k]
  return env
}

export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string }

/**
 * Run git and say what happened.
 *
 * The distinction this returns is the whole point. Folding a FAILURE into the same value as a
 * SUCCESS WITH EMPTY OUTPUT is how `createBundle` came to report a permission error as "everything
 * is already pushed" and `capturePatch` came to report a 200 MB dirty tree as clean. Both are
 * silent, and both are silent in the reassuring direction.
 */
async function gitRun(cwd: string, args: string[], timeout = 10_000): Promise<GitResult> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { env: gitEnv(), timeout, maxBuffer: 64 * 1024 * 1024 })
    return { ok: true, stdout: stdout.trim() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: msg.split('\n').slice(0, 2).join(' ').slice(0, 200) }
  }
}

/** For the probes where a failure legitimately means "git has no answer about this directory". */
async function git(cwd: string, args: string[], timeout = 10_000): Promise<string | null> {
  const r = await gitRun(cwd, args, timeout)
  return r.ok ? r.stdout : null
}

export async function probeDir(path: string): Promise<DirFacts> {
  const empty: DirFacts = {
    path, exists: false, commonDir: null, topLevel: null, cloneUrl: '', remote: '', branch: '', head: '',
  }
  if (!existsSync(path)) return empty

  const common = await git(path, ['rev-parse', '--git-common-dir'])
  if (common === null) return { ...empty, exists: true }

  const [topLevel, cloneUrl, branch, head] = await Promise.all([
    git(path, ['rev-parse', '--show-toplevel']),
    git(path, ['config', '--get', 'remote.origin.url']),
    git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(path, ['rev-parse', 'HEAD']),
  ])

  return {
    path,
    exists: true,
    // Absolutise: from inside a worktree git prints this relative to the worktree.
    commonDir: isAbsolute(common) ? common : resolve(path, common),
    topLevel: topLevel ?? null,
    cloneUrl: cloneUrl ?? '',
    remote: normalizeGitRemote(cloneUrl ?? '') || '',
    branch: branch === 'HEAD' ? '' : (branch ?? ''),
    head: head ?? '',
  }
}

export async function probeAll(paths: string[], concurrency = 8): Promise<DirFacts[]> {
  const limit = createLimiter(concurrency)
  return Promise.all(paths.map(p => limit(() => probeDir(p))))
}

export type BundleResult = 'written' | 'empty' | 'too-large' | 'failed'

/**
 * Write a bundle of this repository's history.
 *
 * `full: false` writes only what the remote does not have (`--all --not --remotes`) — 265 KB
 * against 30 MB for `--all` on the reference repository, which is why saving every unpushed branch
 * costs effectively nothing. `full: true` is for a repository with no remote, which has no other
 * home.
 *
 * The ceiling is enforced by DELETING an oversized bundle: checking first would need a size git
 * will not predict, and leaving the file would spend the disk the ceiling exists to protect.
 */
export async function createBundle(
  mainDir: string, out: string, opts: { full: boolean; maxBytes: number },
): Promise<BundleResult> {
  const args = opts.full
    ? ['bundle', 'create', out, '--all']
    : ['bundle', 'create', out, '--all', '--not', '--remotes']

  const res = await gitRun(mainDir, args, 120_000)
  if (!res.ok) {
    await unlink(out).catch(() => {})
    // `git bundle` refuses an EMPTY ref set with a non-zero exit and a specific message. That case
    // is not a failure — it means every local commit is already on the remote, the common and happy
    // case. Everything else (a permission error, a full disk, a 120s timeout on a huge repository)
    // is a REAL failure and must be reported as one.
    //
    // The match errs toward `failed`: an unrecognised message becomes `failed`, which costs the
    // user one visible line naming the repository. The opposite mistake — a real failure reported
    // as `empty` — tells them their unpushed work was checked and found to be already safe.
    return /empty bundle/i.test(res.reason) ? 'empty' : 'failed'
  }
  let size = 0
  try { size = statSync(out).size } catch { return 'failed' }
  if (size === 0) { await unlink(out).catch(() => {}); return 'empty' }
  if (size > opts.maxBytes) { await unlink(out).catch(() => {}); return 'too-large' }
  return 'written'
}

export type PatchResult =
  /**
   * No PATCH to write. That covers a genuinely clean tree AND a tree whose only changes are
   * untracked files — `git status` sees those, `git diff HEAD` does not. It never means "nothing to
   * back up here": the untracked list is collected separately by `listUntracked`, and a caller that
   * read `clean` as "skip this directory" would drop it.
   */
  | { kind: 'clean' }
  | { kind: 'patch'; text: string }
  | { kind: 'unavailable'; reason: string }

/**
 * The working tree's uncommitted state.
 *
 * Asked in TWO steps on purpose. `git status --porcelain` is cheap and bounded, and it answers
 * "is this tree dirty" — a question that must be answered even when the diff itself cannot be
 * produced. Only then is the diff taken, which is the part that can exceed a 64 MB buffer or a 30s
 * timeout on a tree with large modified assets.
 *
 * One step would fold those together: an oversized diff came back as an error, an error came back
 * as `null`, and `null` also meant clean — so a working tree full of uncommitted work was backed up
 * as though it had none. That is the exact loss this whole module exists to prevent, arriving
 * silently and in the reassuring direction.
 */
export async function capturePatch(dir: string): Promise<PatchResult> {
  const status = await gitRun(dir, ['status', '--porcelain'], 15_000)
  if (!status.ok) return { kind: 'unavailable', reason: `git status failed: ${status.reason}` }
  if (!status.stdout) return { kind: 'clean' }

  const diff = await gitRun(dir, ['diff', 'HEAD', '--binary'], 30_000)
  if (!diff.ok) return { kind: 'unavailable', reason: `git diff failed: ${diff.reason}` }
  // Dirty per status but an empty diff means the changes are all untracked files, which travel as
  // a LIST rather than as content — `listUntracked` reports them and there is no patch to write.
  return diff.stdout ? { kind: 'patch', text: diff.stdout + '\n' } : { kind: 'clean' }
}

export type UntrackedResult =
  | { kind: 'files'; files: string[] }
  | { kind: 'unavailable'; reason: string }

/**
 * Untracked, not-ignored files, relative to the repository root.
 *
 * Discriminated for the same reason `capturePatch` is: this call COLLECTS BACKUP CONTENT, unlike
 * the probe calls where "git has no answer about this directory" is itself a legitimate answer.
 * Folding a permission error or a corrupted index into an empty list means a tree whose untracked
 * state was never established gets skipped as though it had none — the reassuring direction again.
 */
export async function listUntracked(dir: string): Promise<UntrackedResult> {
  const res = await gitRun(dir, ['ls-files', '--others', '--exclude-standard'])
  if (!res.ok) return { kind: 'unavailable', reason: `git ls-files failed: ${res.reason}` }
  return { kind: 'files', files: res.stdout ? res.stdout.split('\n').filter(Boolean) : [] }
}

/** Every directory worth probing, from the session store. PURE. */
export function candidatePaths(
  sessions: { project_path?: string; current_cwd?: string }[],
): string[] {
  const set = new Set<string>()
  for (const s of sessions) {
    if (s.project_path) set.add(s.project_path)
    if (s.current_cwd) set.add(s.current_cwd)
  }
  return [...set]
}
