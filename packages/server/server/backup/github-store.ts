/**
 * github-store.ts — where the GitHub backup token lives.
 *
 * `~/.agentistics/github-backup.json`, mode **0600**, because it holds a live personal access
 * token: `token` is never logged, never returned by a route, and never included in a backup — it
 * is listed in `backup-plan.ts`'s `EXCLUDE_RULES` as a `secret` for exactly that reason. A route
 * that wants to show the connection may read this file but must strip `token` before answering —
 * see `GithubBackupStatus` below, the one shape a route may return.
 *
 * The read/write shape mirrors `backup-store.ts`: pure decisions would have nothing to decide here
 * (there is one record, not a history), so this module is the I/O edge itself, with an optional
 * `file` parameter on every function — the same test-injection point `readBackups`/`recordBackup`
 * use, so a test never has to touch the real `~/.agentistics`.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'

export const GITHUB_BACKUP_CONFIG_FILE = join(AGENTISTICS_DATA_DIR, 'github-backup.json')

export interface GithubBackupConfig {
  /** `https://github.com/<owner>/<repo>` (or whichever form the user pasted) — display only. */
  url: string
  owner: string
  repo: string
  /** A GitHub PAT. NEVER logged, NEVER returned by a route, NEVER included in a backup. */
  token: string
  /** How many `backup-` releases to keep on GitHub. 0 means keep them all. */
  keepRemote: number
  /** Delete the local archive once the upload is confirmed byte-for-byte. */
  deleteLocalAfterUpload: boolean
}

/** What a route may return about this config. No `token`, ever — see the module header. */
export type GithubBackupStatus =
  | { configured: false }
  | { configured: true; url: string; owner: string; repo: string }

/** Strip the token. The ONLY shape any route may hand back. */
export function toStatus(config: GithubBackupConfig | null): GithubBackupStatus {
  if (!config) return { configured: false }
  return { configured: true, url: config.url, owner: config.owner, repo: config.repo }
}

function isValidConfig(v: unknown): v is GithubBackupConfig {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.url === 'string' && typeof o.owner === 'string'
    && typeof o.repo === 'string' && typeof o.token === 'string'
}

/** Reads the config, or `null` if it is absent, unreadable, or malformed. Never throws. */
export async function readGithubConfig(file = GITHUB_BACKUP_CONFIG_FILE): Promise<GithubBackupConfig | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isValidConfig(parsed)) return null
  return {
    url: parsed.url,
    owner: parsed.owner,
    repo: parsed.repo,
    token: parsed.token,
    keepRemote: typeof (parsed as Partial<GithubBackupConfig>).keepRemote === 'number'
      ? (parsed as GithubBackupConfig).keepRemote : 0,
    deleteLocalAfterUpload: (parsed as Partial<GithubBackupConfig>).deleteLocalAfterUpload === true,
  }
}

/**
 * Writes the config at mode 0600. `writeFile`'s own `mode` option only applies when the file is
 * CREATED (the syscall's mode argument is ignored on an existing file), so a config being
 * overwritten — a token rotation, a re-run of setup — is followed by an explicit `chmod` rather
 * than trusting the create-time mode to still be the one in force.
 */
export async function writeGithubConfig(
  config: GithubBackupConfig, file = GITHUB_BACKUP_CONFIG_FILE,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  await chmod(file, 0o600)
}
