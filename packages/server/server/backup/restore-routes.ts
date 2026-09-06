/**
 * restore-routes.ts — restoring FROM the interface.
 *
 * The scenario every rule here is written against: a machine that has just been reformatted. It has
 * the repository URL and NOTHING else — no stored config, no token, no local backup history, no
 * expected hash. So every fact comes from the repository, and the one credential that can already
 * be on such a machine is `gh`, because `gh auth login` is part of setting a machine up at all.
 *
 * This module LISTS and RESOLVES. Performing the restore stays in `restore.ts`, which is where the
 * staging and verification rules live and where they are tested against real archives.
 */
import { formatBytes } from './backup-size'
import { isBackupTag, parseReleaseBody } from './backup-github'
import { ghToken, type GhTokenResult } from './github-cli'
import { parseRepoUrl, gh, type FetchLike } from './github-api'
import { groupReleasesByMachine, type ListedBackupRelease } from './github-restore'
import type { BackupLayer } from './backup-plan'

/**
 * The token to use for a restore, on a machine that may have nothing stored.
 *
 * A pasted token wins because it was just typed for this. Otherwise `gh` — and when neither can
 * answer, the sentence names BOTH ways out, because on a fresh machine the person may not know
 * either is an option.
 */
export async function restoreCredential(
  input: { token?: string }, ask: () => Promise<GhTokenResult> = ghToken,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const pasted = input.token?.trim()
  if (pasted) return { ok: true, token: pasted }

  const r = await ask()
  if (r.ok) return r
  return {
    ok: false,
    reason: 'this machine has no GitHub credential. Either log in with the GitHub CLI '
      + '(`gh auth login`), or paste a personal access token that can read the repository.',
  }
}

/** One backup, as a person choosing between them needs to see it. Every derived field is nullable:
 *  a release whose body cannot be decoded is still LISTED — dropping it could hide somebody's only
 *  copy — with what is unknown said rather than invented. */
export interface RestoreCandidate {
  tagName: string
  createdAt: string
  sizeLabel: string | null
  layers: BackupLayer[] | null
  harnesses: string[] | null
  sessions: number | null
  sha256: string | null
}

export interface RestoreMachine {
  machine: string | null
  releases: RestoreCandidate[]
}

interface RawRelease {
  tag_name: string
  created_at: string
  body?: string
}

/**
 * What a repository holds, grouped by the MACHINE that made each backup.
 *
 * Grouping is the point rather than a nicety: one repository can hold several machines' backups —
 * that is what the labelled tags exist for — and a flat chronological list interleaves them, so
 * "the newest" is whichever machine happened to run last. Restoring the wrong computer onto this
 * one is the failure this whole surface has to make impossible to do by accident.
 */
export async function restoreListing(
  input: { url: string; token: string },
  opts: { fetchImpl?: FetchLike } = {},
): Promise<{ ok: true; machines: RestoreMachine[] } | { ok: false; reason: string }> {
  // Before any request, exactly as `github-setup.ts` does: sending a token to a host the user
  // mistyped is the one mistake that cannot be undone.
  const parsed = parseRepoUrl(input.url)
  if (!parsed) {
    return {
      ok: false,
      reason: `could not read "${input.url}" as a github.com repository. Use `
        + 'https://github.com/owner/repo, owner/repo, or git@github.com:owner/repo.git.',
    }
  }

  const res = await gh<RawRelease[]>(
    `/repos/${parsed.owner}/${parsed.repo}/releases?per_page=100`, input.token, {}, opts.fetchImpl,
  )
  if (!res.ok) return { ok: false, reason: res.message }

  const listed: ListedBackupRelease[] = res.data.map(r => ({
    tagName: r.tag_name,
    createdAt: r.created_at,
    summary: parseReleaseBody(r.body ?? ''),
  }))

  const machines = groupReleasesByMachine(listed.filter(r => isBackupTag(r.tagName)))
    .map(g => ({
      machine: g.machine,
      releases: g.releases.map<RestoreCandidate>(r => ({
        tagName: r.tagName,
        createdAt: r.createdAt,
        // `formatBytes` here and not on the client: the same figure, in the same words, as every
        // other size this product prints.
        sizeLabel: r.summary ? formatBytes(r.summary.archiveBytes) : null,
        layers: r.summary?.layers ?? null,
        harnesses: r.summary?.harnesses ?? null,
        sessions: r.summary?.sessionCount ?? null,
        sha256: r.summary?.sha256 ?? null,
      })),
    }))

  return { ok: true, machines }
}


/**
 * How many output lines a running restore keeps.
 *
 * Bounded because the repos phase prints thousands — 235 repositories, several git commands each,
 * on the machine this was written for — and the screen only ever shows the tail. An unbounded list
 * would grow a server-side object for the length of the restore with nothing reading most of it.
 */
export const RESTORE_LINE_CAP = 500

export type RestoreJobState = 'queued' | 'running' | 'done' | 'failed'

/**
 * A restore in flight.
 *
 * It is a JOB rather than a request/response because of the second phase: restoring metrics takes
 * seconds (699 files in 2.6s, measured), while restoring repositories clones every repository the
 * backup mapped and can take many minutes. Holding an HTTP request open for that would time out in
 * a proxy, in the browser, or both — and the one thing worse than a slow restore is one whose
 * outcome nobody ever learns.
 */
export interface RestoreJob {
  id: string
  tag: string
  withRepos: boolean
  state: RestoreJobState
  startedAt: string
  finishedAt: string | null
  lines: string[]
  written: number | null
  reason: string | null
}

export function newRestoreJob(input: { tag: string; withRepos: boolean }): RestoreJob {
  return {
    id: `r_${Math.random().toString(36).slice(2, 10)}`,
    tag: input.tag,
    withRepos: input.withRepos,
    state: 'queued',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lines: [],
    written: null,
    reason: null,
  }
}

/** Append one line, keeping the TAIL — the end of a restore is where its outcome is. */
export function restoreJobLine(job: RestoreJob, line: string): void {
  job.lines.push(line)
  if (job.lines.length > RESTORE_LINE_CAP) job.lines.splice(0, job.lines.length - RESTORE_LINE_CAP)
}

export function finishRestoreJob(
  job: RestoreJob,
  outcome: { ok: true; written: number; skipped: number } | { ok: false; reason: string },
): void {
  job.finishedAt = new Date().toISOString()
  if (outcome.ok) {
    job.state = 'done'
    job.written = outcome.written
  } else {
    job.state = 'failed'
    job.reason = outcome.reason
  }
}
