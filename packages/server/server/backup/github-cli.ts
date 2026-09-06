/**
 * github-cli.ts — use the GitHub CLI this machine already has, instead of storing a token.
 *
 * The question that produced this module: why ask for a personal access token at all, when `gh` is
 * installed, logged in as the user, and already allowed to do this? It is a fair question and the
 * answer was only that the uploader talks to the REST API over `fetch` and nobody had wired `gh`
 * in. So there are now TWO auth modes and `gh` is the one offered first when it can work:
 *
 *   'gh'     — nothing is stored. `gh auth token` is run at the moment a request needs a
 *              credential, and the value lives in memory for that call.
 *   'token'  — a PAT in `~/.agentistics/github-backup.json` (0600). Still the right answer on a
 *              machine with no `gh`, and the NARROWER one: a fine-grained PAT can be scoped to the
 *              single backup repository, while `gh`'s token carries whatever scopes the user's
 *              login has — on the machine this was written for, that included `admin:org` and
 *              `delete_repo`. Convenience against blast radius; the interface states both.
 *
 * `gh auth token` is asked EVERY time rather than cached. gh's own token can be rotated or revoked
 * between two backups, and a copy kept here would go on failing with a credential the user already
 * replaced — while looking like a problem with the backup.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)

/**
 * The one command this module shells out to.
 *
 * `gh auth token` prints the active account's token and exits non-zero when nobody is logged in.
 * It never prompts and never opens a browser, which is what makes it safe to run from the daemon
 * that performs a scheduled backup with nobody watching.
 */
export const GH_TOKEN_ARGV = ['gh', 'auth', 'token'] as const

export type GhTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'not-installed' | 'not-logged-in' | 'failed' }

/** Ask `gh` for the active account's token. Total: never throws. */
export async function ghToken(): Promise<GhTokenResult> {
  const [cmd, ...args] = GH_TOKEN_ARGV
  try {
    const { stdout } = await run(cmd!, args, { timeout: 10_000 })
    const token = stdout.trim()
    // gh can exit 0 having printed nothing — a configured host with no token for it. An empty
    // credential must never be sent: GitHub answers a private repository's 404 to it, which reads
    // as "the repository is gone".
    return token ? { ok: true, token } : { ok: false, reason: 'not-logged-in' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/ENOENT|not found/i.test(msg)) return { ok: false, reason: 'not-installed' }
    if (/not logged in|authentication|gh auth login/i.test(msg)) return { ok: false, reason: 'not-logged-in' }
    return { ok: false, reason: 'failed' }
  }
}

/** The two fields of a config this module reads. Kept structural so `github-store.ts` owns the
 *  whole shape and this stays testable without one. */
export interface AuthConfig {
  auth?: 'token' | 'gh'
  token: string
}

/**
 * The credential a config actually uses, resolved at the moment it is needed.
 *
 * **Absent `auth` reads as `'token'`** — every config written before this module holds one, and
 * treating absence as anything else would break every machine already versioning, at the moment it
 * tried to upload. Same migration rule `shareMode` and the consent switches follow.
 *
 * A `gh` that cannot answer yields a REASON and never falls back to a stored token: on a `gh`
 * config there is none, and on any config an unannounced switch of credential is a backup uploaded
 * under something the user did not choose.
 */
export async function resolveGithubAuth(
  config: AuthConfig, ask: () => Promise<GhTokenResult> = ghToken,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  if ((config.auth ?? 'token') === 'token') {
    const token = config.token.trim()
    return token
      ? { ok: true, token }
      : { ok: false, reason: 'this machine has no stored GitHub token. Re-connect the repository.' }
  }
  const r = await ask()
  if (r.ok) return r
  return {
    ok: false,
    reason: r.reason === 'not-installed'
      ? 'the GitHub CLI (gh) is not installed on this machine, and this backup is configured to '
        + 'authenticate through it. Install gh, or re-connect the repository with a token.'
      : r.reason === 'not-logged-in'
        ? 'the GitHub CLI (gh) is not logged in. Run `gh auth login`, or re-connect the repository '
          + 'with a token.'
        : 'the GitHub CLI (gh) could not produce a token.',
  }
}

export interface GhPresence {
  installed: boolean
  /** The logged-in account, or null. */
  account: string | null
}

export type GhAvailability =
  | { usable: true; account: string }
  | { usable: false; reason: 'not-installed' | 'logged-out' }

/**
 * Whether the interface may OFFER the gh option, and why not when it may not.
 *
 * Two reasons rather than one, because "install gh" and "run `gh auth login`" are different
 * instructions and a single sentence covering both would be right for neither.
 */
export function describeGhAuth(p: GhPresence): GhAvailability {
  if (!p.installed) return { usable: false, reason: 'not-installed' }
  if (!p.account) return { usable: false, reason: 'logged-out' }
  return { usable: true, account: p.account }
}

/** Is gh here, and who is it? Total: never throws. */
export async function probeGh(): Promise<GhPresence> {
  try {
    const { stdout } = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 10_000 })
    const account = stdout.trim()
    return { installed: true, account: account || null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { installed: !/ENOENT|not found/i.test(msg), account: null }
  }
}
