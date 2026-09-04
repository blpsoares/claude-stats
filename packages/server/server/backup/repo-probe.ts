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
import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { normalizeGitRemote } from '@agentistics/core'
import { createLimiter } from '../utils'
import type { DirFacts } from './repo-manifest'

const run = promisify(execFile)

/**
 * Never let git prompt. A credential prompt inside a backup hangs the whole run.
 *
 * Also strips GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_PREFIX: a caller invoked from inside a
 * git hook (this repo's own pre-commit, run from a linked worktree, does exactly this) has those
 * exported into its environment pointing at a DIFFERENT repository, and `-C <path>` below does not
 * override GIT_DIR — it still wins repository discovery. Left unstripped, every `git -C <dir>` call
 * here would silently answer for the hook's repository instead of the directory being probed.
 */
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_CONFIG_NOSYSTEM: '1' }
delete GIT_ENV.GIT_DIR
delete GIT_ENV.GIT_WORK_TREE
delete GIT_ENV.GIT_INDEX_FILE
delete GIT_ENV.GIT_PREFIX

async function git(cwd: string, args: string[], timeout = 10_000): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { env: GIT_ENV, timeout, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return null
  }
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

  const ok = await git(mainDir, args, 120_000)
  if (ok === null) {
    // `git bundle` refuses an empty ref set with a non-zero exit. That is not a failure: it means
    // every local commit is already on the remote, which is the common and happy case.
    await unlink(out).catch(() => {})
    return 'empty'
  }
  const { statSync } = await import('fs')
  let size = 0
  try { size = statSync(out).size } catch { return 'failed' }
  if (size === 0) { await unlink(out).catch(() => {}); return 'empty' }
  if (size > opts.maxBytes) { await unlink(out).catch(() => {}); return 'too-large' }
  return 'written'
}

/** The working tree's diff against HEAD, staged and unstaged together, or null when clean. */
export async function capturePatch(dir: string): Promise<string | null> {
  const patch = await git(dir, ['diff', 'HEAD', '--binary'], 30_000)
  return patch ? patch + '\n' : null
}

/** Untracked, not-ignored files, relative to the repository root. */
export async function listUntracked(dir: string): Promise<string[]> {
  const out = await git(dir, ['ls-files', '--others', '--exclude-standard'])
  return out ? out.split('\n').filter(Boolean) : []
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
