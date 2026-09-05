/**
 * github-setup.ts — `agentop backup github setup <url>`, and the refusal that matters.
 *
 * Five checks, in order, and the first one that fails stops everything after it — in particular,
 * NOTHING is written to disk unless every check passed. The order matters for one reason: `gh()`
 * is a network call, and `parseRepoUrl` is free, so the host check runs first — an unrecognized
 * host must never cause a single byte to leave the machine.
 *
 * 1. `parseRepoUrl` — an unknown host is refused before any request.
 * 2. the token must be present (the caller collects it; this module never prompts).
 * 3. `GET /repos/{owner}/{repo}` — a 404 gets the two-case sentence, because the API genuinely
 *    cannot tell "does not exist" from "your token cannot see it" on a private repository.
 * 4. `private === true` or refuse. The user's word does not count — only the API's does.
 * 5. `permissions.push === true` or refuse — an upload that would fail later, after the archive is
 *    already built, is the expensive moment to discover a read-only token.
 *
 * Every refusal returned from here is a full sentence naming what to do next, never a bare status
 * code — `runBackupCli` prints `result.message` as-is.
 */
import { hostname } from 'os'
import type { FetchLike } from './github-api'
import { gh, parseRepoUrl, repoUrlHost } from './github-api'
import type { GithubBackupConfig } from './github-store'
import { writeGithubConfig } from './github-store'

export interface GithubSetupInput {
  url: string
  token: string
  /** Kept out of the manual `--keep`/`--delete-local` flags for wave G1 — defaults match the
   *  config's own "keep everything, keep the local copy" defaults until G2 wires the flags. */
  keepRemote?: number
  deleteLocalAfterUpload?: boolean
  /** What this machine is called in its release tags. Defaults to the hostname — editable because
   *  a hostname is often unreadable and is not guaranteed unique across a person's machines. */
  label?: string
  /**
   * `'gh'` authenticates through the GitHub CLI already on this machine and stores NOTHING; the
   * `token` field then carries the credential used to VERIFY the repository here (gh's own), and
   * is not written. Absent means `'token'`. See `github-cli.ts`.
   */
  auth?: 'token' | 'gh'
  /** Test-only injection points, mirroring `gh()`'s own `fetchImpl` and `backup-store.ts`'s
   *  `file` parameter — a test never has to touch the network or the real `~/.agentistics`. */
  fetchImpl?: FetchLike
  file?: string
}

export type GithubSetupResult =
  | { ok: true; config: GithubBackupConfig }
  | { ok: false; message: string }

interface RepoInfo {
  private: boolean
  permissions?: { push?: boolean }
}

export async function setupGithubBackup(input: GithubSetupInput): Promise<GithubSetupResult> {
  const parsed = parseRepoUrl(input.url)
  if (!parsed) {
    const host = repoUrlHost(input.url)
    return {
      ok: false,
      message: host
        ? `"${host}" is not github.com — this only works with a repository on github.com. `
          + 'Sending a token to a host you did not mean to is the one mistake this cannot undo, '
          + 'so it is refused before any request is made.'
        : `could not read "${input.url}" as a GitHub repository. Use one of: `
          + 'https://github.com/owner/repo, github.com/owner/repo, git@github.com:owner/repo.git, '
          + 'or owner/repo.',
    }
  }
  const { owner, repo } = parsed

  if (!input.token.trim()) {
    return {
      ok: false,
      message: 'a GitHub personal access token is required. Generate one with access to this '
        + 'repository (a fine-grained token scoped to it, or a classic token with the `repo` scope) '
        + 'and run setup again.',
    }
  }

  const res = await gh<RepoInfo>(`/repos/${owner}/${repo}`, input.token, {}, input.fetchImpl)

  if (!res.ok) {
    if (res.status === 404) {
      return {
        ok: false,
        message: `${owner}/${repo} was not found. Either it does not exist, or this token cannot `
          + 'see it — GitHub answers a private repository the same way in both cases. Check the '
          + 'URL, and check that the token has access to this repository.',
      }
    }
    return { ok: false, message: `GitHub refused the request for ${owner}/${repo}: ${res.message}` }
  }

  if (res.data.private !== true) {
    return {
      ok: false,
      message: `${owner}/${repo} is not private. A backup carries this machine's metrics, its `
        + 'first prompts and a map of its directories — that cannot go to a public repository. '
        + 'Make the repository private on GitHub, then run setup again; saying it is private here '
        + 'does not count, only the API answering `private: true` does.',
    }
  }

  if (res.data.permissions?.push !== true) {
    return {
      ok: false,
      message: `this token cannot push to ${owner}/${repo}. Uploading a backup would only fail `
        + 'later, after the archive has already been built — use a token with write access to this '
        + 'repository (a fine-grained token needs "Contents: Read and write").',
    }
  }

  const config: GithubBackupConfig = {
    // On `gh` the token is used for the four checks above and then DROPPED: the whole point of
    // that mode is that this file holds no credential. Writing it "just in case" would be the one
    // thing the mode exists to avoid.
    ...(input.auth === 'gh' ? { auth: 'gh' as const } : null),
    url: input.url,
    owner,
    repo,
    token: input.auth === 'gh' ? '' : input.token,
    keepRemote: input.keepRemote ?? 0,
    deleteLocalAfterUpload: input.deleteLocalAfterUpload ?? false,
    label: input.label ?? hostname(),
  }
  await writeGithubConfig(config, input.file)
  return { ok: true, config }
}
