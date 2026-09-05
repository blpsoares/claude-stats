/**
 * backup-github.ts — PURE. Whether the layers ticked right now would fit a single GitHub Release
 * asset.
 *
 * This is NOT the "push a backup to GitHub Releases" feature — that does not exist yet. It is the
 * honest indicator that belongs beside the format picker so the eventual feature has a place to
 * live, and so a user learns the constraint before they build a workflow around it: a release
 * asset is capped at 2 GiB PER FILE.
 *
 * **Reasoned only from the measured UNCOMPRESSED total.** `backup-size.ts`'s own header states the
 * rule this module exists to respect: compression depends on bytes that do not exist until an
 * archive is actually written, so a predicted compressed figure reads like a measurement and is
 * not one. Compression can only ever SHRINK, so:
 *
 *  - under the cap uncompressed → the eventual archive will certainly fit ("fits").
 *  - at or over the cap uncompressed → it MIGHT still fit once compressed, or it might not — the
 *    honest ceiling is "maybe-not", never a confident yes or no.
 *
 * `layerBytes` mirrors `backup-size.ts`'s measured totals; a layer whose size is not measurable
 * ahead of a run (`repos`, before one has built a manifest) contributes nothing to the sum — its
 * real weight is unknown, not zero, but it is usually small next to `raw` or `archive` and the
 * running total is still the most honest figure a machine can state before running.
 */
import type { HarnessId } from '@agentistics/core'
import type { BackupLayer } from './backup-plan'
import { formatBytes } from './backup-size'

/** GitHub's own limit on a single Release asset — 2 GiB, matching the binary units this product
 *  already uses for every other size (`backup-size.ts`'s `formatBytes`). */
export const GITHUB_RELEASE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

/** Below this, a MEASURED archive is comfortably clear of the cap. Between here and the cap it
 *  still uploads — GitHub, not this product, is the authority on whether 2 GiB minus a few bytes
 *  fits — but the NEXT backup (which only grows) may not, so the wave warns rather than staying
 *  silent until the day it refuses outright. */
export const GITHUB_NEAR_LIMIT_BYTES = 1.7 * 1024 * 1024 * 1024

export type GithubFitVerdict = 'fits' | 'maybe-not'

export function githubFitVerdict(
  layers: BackupLayer[], layerBytes: Record<BackupLayer, number | null>,
): GithubFitVerdict {
  const total = layers.reduce((n, l) => n + (layerBytes[l] ?? 0), 0)
  return total < GITHUB_RELEASE_LIMIT_BYTES ? 'fits' : 'maybe-not'
}

/**
 * `uploadVerdict` is the same reasoning as `githubFitVerdict`, applied to a REAL, MEASURED
 * `archiveBytes` rather than a plan — so it has a third answer the plan-time verdict cannot afford:
 * `too-large` refuses outright instead of shrugging "maybe-not", because there is nothing left to
 * discover once the archive already exists. `< 1.7 GB` -> `ok`; `1.7-2 GB` -> `near-limit` (still
 * uploads, warns that the next one may not fit); `>= 2 GB` -> `too-large` (never uploads).
 */
export type UploadVerdict = 'ok' | 'near-limit' | 'too-large'

export function uploadVerdict(archiveBytes: number): UploadVerdict {
  if (archiveBytes >= GITHUB_RELEASE_LIMIT_BYTES) return 'too-large'
  if (archiveBytes >= GITHUB_NEAR_LIMIT_BYTES) return 'near-limit'
  return 'ok'
}

/**
 * The refusal for `too-large`, stated the way the user asked for it: where the file already is,
 * that it is a single self-sufficient thing, that a pendrive/Drive/another machine all work from
 * it as-is, the exact command to restore from there, and the alternatives that WOULD fit under
 * GitHub instead of this one.
 */
export function tooLargeUploadMessage(path: string, archiveBytes: number): string {
  return `this backup is ${formatBytes(archiveBytes)}, at or over GitHub's `
    + `${formatBytes(GITHUB_RELEASE_LIMIT_BYTES)} release-asset limit — it was NOT uploaded. `
    + `It stays exactly where it already is: ${path}. That is a single, self-sufficient file: `
    + 'copy it to a pendrive, a cloud drive, or straight onto another machine, and restore from '
    + `there with \`agentop restore ${path}\`. To fit a future backup under GitHub instead, run `
    + '`agentop backup` on its own (leave out --with-archive and --with-raw), or back up one '
    + '`--harness` at a time.'
}

/**
 * The GitHub release tag for a backup taken `at` (the same ISO timestamp `BackupRecord.at` and
 * `BackupManifest.createdAt` carry). Sanitized exactly like the archive's own filename stamp
 * (`backup.ts`'s `stamp`, `:`/`.` -> `-`) — a git ref name may not contain a colon, and using the
 * SAME substitution the archive filename already uses means the tag and the file it names read as
 * the same timestamp at a glance, which is what `agentop restore <url> --release <tag>` (wave G3)
 * is typed against.
 */
export function releaseTag(atIso: string): string {
  return `backup-${atIso.replace(/[:.]/g, '-')}`
}

/**
 * Only a tag `releaseTag` could have minted is ever touched by retention (`github-retention.ts`).
 * A release the user created by hand — however they named it — must never be mistaken for one of
 * ours, so this is deliberately the exact shape `releaseTag` produces, not a loose `backup-` prefix
 * a hand-made release could accidentally share.
 */
const BACKUP_TAG_RE = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z$/

export function isBackupTag(tag: string): boolean {
  return BACKUP_TAG_RE.test(tag)
}

export interface ReleaseBodyInput {
  layers: BackupLayer[]
  harnesses: HarnessId[]
  /** Every file under `.agentistics/sessions/<harness>/` in the manifest's own file list — one
   *  file per session (see `consolidate.ts`), so this is an exact count, not an estimate. */
  sessionCount: number
  /** The archive's real, measured size — `BackupRecord.archiveBytes`, never a plan-time figure. */
  archiveBytes: number
  sha256: string
  createdAt: string
  hostname: string
}

/**
 * The release BODY — the manifest summary that travels with the upload. This is what makes wave G3
 * possible: on a reformatted machine `~/.agentistics/backups.jsonl` does not exist, so the expected
 * sha256 has nowhere else to live before the archive is downloaded and hashed. Everything here is
 * plain text on purpose — GitHub renders it as Markdown, but a `curl`/`gh api` read of the release
 * must be able to grep it too.
 */
export function buildReleaseBody(input: ReleaseBodyInput): string {
  return [
    '# Agentistics backup',
    '',
    `- created: ${input.createdAt}`,
    `- host: ${input.hostname}`,
    `- layers: ${input.layers.join(', ')}`,
    `- harnesses: ${input.harnesses.join(', ')}`,
    `- sessions: ${input.sessionCount}`,
    `- size: ${formatBytes(input.archiveBytes)} (${input.archiveBytes} bytes)`,
    `- sha256: \`${input.sha256}\``,
    '',
    'Restore on any machine with `agentop restore <downloaded-file>` after downloading this '
      + 'release\'s asset. The sha256 above is the ONLY copy of this hash outside the machine that '
      + 'made it — a reformatted machine has no local `backups.jsonl` to compare against, so this '
      + 'body is what a restore verifies against.',
  ].join('\n')
}
