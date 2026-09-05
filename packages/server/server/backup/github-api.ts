/**
 * github-api.ts — PURE where a decision can be made without a network, IO where it cannot.
 *
 * This module sends a live credential (the PAT in `github-store.ts`) to whatever host it is told
 * to. `parseRepoUrl` is the gate: it runs BEFORE any request, and it accepts only `github.com` —
 * an unrecognized host is refused rather than guessed at, because sending the token to a host the
 * user mistyped is the one outcome this code must never produce.
 *
 * `gh()` is the one place a request actually leaves the machine. It never throws (a network
 * failure, a bad status and a malformed body are all just another `{ ok: false }`), and it never
 * lets the token reach an error message — `redact()` runs over every string this function
 * produces, not just the ones that look like they might contain it, because the one occurrence
 * that was not sanitized on purpose is the one that ships.
 */

export interface ParsedRepo {
  owner: string
  repo: string
}

// GitHub usernames/orgs: alphanumeric or single hyphens, no leading/trailing/doubled hyphen, no
// dots. Repo names: alphanumeric plus `.`, `_`, `-`. Neither may be empty.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]+$/

function isValidOwner(s: string): boolean {
  return OWNER_RE.test(s)
}

function isValidRepoName(s: string): boolean {
  return REPO_RE.test(s) && s !== '.' && s !== '..'
}

function stripGitSuffix(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -4) : path
}

function toOwnerRepo(path: string): ParsedRepo | null {
  const trimmed = stripGitSuffix(path.replace(/\/+$/, ''))
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts as [string, string]
  if (!isValidOwner(owner) || !isValidRepoName(repo)) return null
  return { owner, repo }
}

/**
 * `https://github.com/o/r`, `github.com/o/r`, `git@github.com:o/r.git`, `o/r` -> `{owner, repo}`.
 * Any other host, or anything that does not resolve to exactly two path segments, is `null` — the
 * caller names the host with `repoUrlHost()` for the refusal sentence, since this function's own
 * contract is the narrow one the plan asks for: a parse, not a message.
 */
export function parseRepoUrl(input: string): ParsedRepo | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const ssh = trimmed.match(/^git@([^:]+):(.+)$/)
  if (ssh) {
    const host = ssh[1]!
    if (host !== 'github.com') return null
    return toOwnerRepo(ssh[2]!)
  }

  const withProtocol = trimmed.match(/^https?:\/\/([^/]+)\/(.+)$/)
  if (withProtocol) {
    const host = withProtocol[1]!.replace(/^www\./, '')
    if (host !== 'github.com') return null
    return toOwnerRepo(withProtocol[2]!)
  }

  const firstSlash = trimmed.indexOf('/')
  if (firstSlash === -1) return null
  const maybeHost = trimmed.slice(0, firstSlash)
  if (maybeHost.includes('.')) {
    // Looks like a bare host (has a dot) — e.g. `github.com/o/r` or `gitlab.com/o/r`.
    if (maybeHost !== 'github.com') return null
    return toOwnerRepo(trimmed.slice(firstSlash + 1))
  }
  if (maybeHost.includes('@') || maybeHost.includes(':')) return null

  // Shorthand `owner/repo`.
  return toOwnerRepo(trimmed)
}

/**
 * Best-effort extraction of what host `input` NAMED, for the refusal sentence when
 * `parseRepoUrl` returns null. Returns `null` when there is no host to report (a malformed
 * shorthand, an empty string) — the caller falls back to a generic "could not parse" sentence.
 */
export function repoUrlHost(input: string): string | null {
  const trimmed = input.trim()
  const ssh = trimmed.match(/^git@([^:]+):/)
  if (ssh) return ssh[1] ?? null
  const withProtocol = trimmed.match(/^https?:\/\/([^/]+)/)
  if (withProtocol) return (withProtocol[1] ?? '').replace(/^www\./, '') || null
  const firstSlash = trimmed.indexOf('/')
  if (firstSlash !== -1) {
    const maybeHost = trimmed.slice(0, firstSlash)
    if (maybeHost.includes('.')) return maybeHost
  }
  return null
}

export type GhResult<T = unknown> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; message: string }

/** The subset of `fetch` this module needs — lets tests inject a fake with no network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Replace every occurrence of `token` in `message` — defense in depth: nothing here is expected
 *  to echo the token, but a message built from an underlying error or an unexpected response body
 *  is not under this module's control, so every string this function returns is swept regardless. */
function redact(message: string, token: string): string {
  if (!token) return message
  return message.split(token).join('[redacted]')
}

function apiMessageFrom(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string') {
      return (parsed as { message: string }).message
    }
  } catch {
    // Not JSON, or not shaped like GitHub's error body — fall through to the generic message.
  }
  return null
}

/**
 * One authenticated GitHub REST call. Never throws — a thrown network error, a non-2xx status and
 * an unparsable body are all reported as `{ ok: false }`, never propagated, so a caller never has
 * to wrap this in try/catch to stay honest about what happened.
 *
 * `init.headers` is merged AFTER the defaults so a caller can override `Accept` (a binary asset
 * download needs `application/octet-stream`, not the JSON media type every metadata call uses).
 */
export async function gh<T = unknown>(
  path: string,
  token: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<GhResult<T>> {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`

  let res: Response
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  } catch (err) {
    return { ok: false, status: 0, message: redact(`network error: ${describeError(err)}`, token) }
  }

  if (!res.ok) {
    let bodyText = ''
    try {
      bodyText = await res.text()
    } catch {
      // Body unreadable — report the status alone.
    }
    const apiMessage = apiMessageFrom(bodyText)
    const message = apiMessage
      ? `GitHub returned ${res.status}: ${apiMessage}`
      : `GitHub returned ${res.status} with no further detail`
    return { ok: false, status: res.status, message: redact(message, token) }
  }

  try {
    const data = (await res.json()) as T
    return { ok: true, data, status: res.status }
  } catch (err) {
    return {
      ok: false, status: res.status,
      message: redact(`could not parse GitHub's response: ${describeError(err)}`, token),
    }
  }
}
