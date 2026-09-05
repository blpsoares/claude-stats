import { exec } from 'child_process'
import { promisify } from 'util'
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { ProjectGitStats } from '@agentistics/core'
import { normalizeGitRemote } from '@agentistics/core'

const execAsync = promisify(exec)

// UUID regex: 8-4-4-4-12 hex groups
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Decode a Claude project directory name back to a filesystem path. */
export function decodeProjectDir(dirName: string): string {
  // Claude encodes absolute paths by replacing every '/' with '-'
  // The leading '-' corresponds to the leading '/' of an absolute path
  if (dirName.startsWith('-')) {
    return dirName.replace(/-/g, '/')
  }
  // Relative or unknown — just return as-is prefixed with /
  return '/' + dirName.replace(/-/g, '/')
}

/**
 * Builds the git command prefix. On Windows, POSIX paths (starting with '/')
 * are Linux/WSL paths and must be run via `wsl git`; Windows-native paths
 * (e.g. C:\...) use the regular `git` binary directly.
 */
function gitCmd(projectPath: string): string {
  if (process.platform === 'win32' && projectPath.startsWith('/')) {
    return 'wsl git'
  }
  return 'git'
}

/**
 * The commits of a directory inside a window, with their subjects — the EVIDENCE half of a task
 * delivery (`task-evidence.ts` reads the PR references out of these messages).
 *
 * Separate from `getGitFileStats` / `getProjectGitStats`, which answer with COUNTS: a count cannot
 * carry a subject, and the subject is where a PR reference lives.
 *
 * `--pretty=tformat:` and never `format:`. The latter omits the terminal newline on the LAST record,
 * so a line-wise reader silently drops the OLDEST commit of every range — the same defect the
 * release workflow's lint exists to prevent, in a different reader. NUL separates the fields
 * because a commit subject may contain anything else.
 */
export async function getCommitsInWindow(
  projectPath: string,
  afterIso: string,
  beforeIso: string,
): Promise<Array<{ sha: string; message: string; atMs: number }>> {
  if (!projectPath || !afterIso || !beforeIso) return []
  try {
    const { stdout } = await execAsync(
      `${gitCmd(projectPath)} -C "${projectPath}" log --after="${afterIso}" --before="${beforeIso}"`
      + ' --pretty=tformat:%H%x00%cI%x00%s',
      { timeout: 5000 },
    )
    const out: Array<{ sha: string; message: string; atMs: number }> = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const [sha, iso, ...rest] = line.split('\u0000')
      const atMs = Date.parse(iso ?? '')
      if (!sha || !Number.isFinite(atMs)) continue
      out.push({ sha, message: rest.join('\u0000'), atMs })
    }
    return out
  } catch {
    // Not a repository, no git, or a directory that is gone. Evidence is best effort: a delivery
    // is not refused because its commits could not be read.
    return []
  }
}

export async function getGitFileStats(
  projectPath: string,
  afterIso: string,
  beforeIso: string
): Promise<{ linesAdded: number; linesRemoved: number; filesModified: number }> {
  const empty = { linesAdded: 0, linesRemoved: 0, filesModified: 0 }
  if (!projectPath || !afterIso || !beforeIso) return empty
  try {
    // add 1 minute buffer on each side so the commits made during the session are included
    const after = new Date(new Date(afterIso).getTime() - 60_000).toISOString()
    const before = new Date(new Date(beforeIso).getTime() + 60_000).toISOString()
    const { stdout } = await execAsync(
      `${gitCmd(projectPath)} -C "${projectPath}" log --numstat --after="${after}" --before="${before}" --format=""`,
      { timeout: 5000 }
    )
    let linesAdded = 0, linesRemoved = 0
    const filesSeen = new Set<string>()
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (m) {
        linesAdded += parseInt(m[1]!, 10)
        linesRemoved += parseInt(m[2]!, 10)
        filesSeen.add(m[3]!)
      }
    }
    return { linesAdded, linesRemoved, filesModified: filesSeen.size }
  } catch {
    return empty
  }
}

/**
 * Read a repo's `origin` remote URL and return it normalized (`host/org/repo`, no protocol),
 * or `undefined` when the path isn't a git repo or has no origin remote. Reuses the same
 * `gitCmd` (Windows/WSL) split and no-prompt env guard as the stats helpers so a misconfigured
 * remote can never hang the scan. This is the local-machine source of the group-by-repo key.
 */
export async function getGitRemote(projectPath: string): Promise<string | undefined> {
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
  const cmd = gitCmd(projectPath)
  try {
    const { stdout } = await execAsync(
      `${cmd} -C "${projectPath}" config --get remote.origin.url`,
      { timeout: 3000, env: gitEnv }
    )
    const normalized = normalizeGitRemote(stdout.trim())
    return normalized || undefined
  } catch {
    return undefined
  }
}

async function getGitStatsForSingleRepo(projectPath: string, sinceIso?: string): Promise<ProjectGitStats | undefined> {
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
  const cmd = gitCmd(projectPath)
  try {
    await execAsync(`${cmd} -C "${projectPath}" rev-parse --git-dir`, { timeout: 3000, env: gitEnv })
  } catch {
    return undefined
  }
  try {
    const sinceArg = sinceIso ? ` --since="${sinceIso}"` : ''
    const { stdout } = await execAsync(
      `${cmd} -C "${projectPath}" log --numstat --format="COMMIT %H %ai"${sinceArg} HEAD`,
      { timeout: 10000, env: gitEnv }
    )
    let commits = 0, linesAdded = 0, linesRemoved = 0
    const filesSeen = new Set<string>()
    let since = ''
    for (const line of stdout.split('\n')) {
      if (line.startsWith('COMMIT ')) {
        commits++
        const date = line.split(' ')[2]
        if (date && (!since || date < since)) since = date
      } else {
        const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (m) {
          linesAdded += parseInt(m[1]!, 10)
          linesRemoved += parseInt(m[2]!, 10)
          filesSeen.add(m[3]!)
        }
      }
    }
    if (commits === 0) return undefined
    return { commits, lines_added: linesAdded, lines_removed: linesRemoved, files_modified: filesSeen.size, since }
  } catch {
    return undefined
  }
}

export async function getProjectGitStats(projectPath: string, sinceIso?: string): Promise<ProjectGitStats | undefined> {
  // Try projectPath itself first (the common case: a single git repo)
  const direct = await getGitStatsForSingleRepo(projectPath, sinceIso)
  if (direct) return direct

  // Fallback: projectPath may be a workspace folder containing multiple git repos.
  // Scan one level of subdirectories and aggregate stats across all git repos found.
  let entries: { name: string; isDirectory(): boolean }[] = []
  try {
    entries = await readdir(projectPath, { withFileTypes: true })
  } catch {
    return undefined
  }

  const subdirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => join(projectPath, e.name))
  let combined: ProjectGitStats | undefined
  for (const sub of subdirs) {
    // No sinceIso filter for workspace subdirs — these are often bootstrapped repos
    // with early commits that predate any Claude sessions.
    const stats = await getGitStatsForSingleRepo(sub, undefined)
    if (!stats) continue
    if (!combined) {
      combined = { ...stats }
    } else {
      combined.commits += stats.commits
      combined.lines_added += stats.lines_added
      combined.lines_removed += stats.lines_removed
      combined.files_modified += stats.files_modified
      if (stats.since && (!combined.since || stats.since < combined.since)) combined.since = stats.since
    }
  }
  return combined
}
