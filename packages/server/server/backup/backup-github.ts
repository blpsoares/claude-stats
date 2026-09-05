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
export function releaseTag(atIso: string, label?: string): string {
  const stamp = atIso.replace(/[:.]/g, '-')
  const slug = labelSlug(label)
  return slug ? `backup-${slug}-${stamp}` : `backup-${stamp}`
}

/**
 * A machine label folded to what a git ref may hold, or `null` when nothing usable is left.
 *
 * Null rather than a placeholder on purpose: a label of `???` folds to nothing, and minting
 * `backup--<stamp>` for it would produce a tag that reads as an unlabelled one while being a third
 * shape neither reader expects.
 */
export function labelSlug(label: string | undefined): string | null {
  if (!label) return null
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length ? slug : null
}

/**
 * The machine a backup tag belongs to, or `null` for a tag minted before labels existed.
 *
 * TWO machines pointing at ONE repository is the case labels exist for, and the label had to go in
 * the TAG rather than only in the release body and the asset filename — those two are read by
 * nobody. Retention reads tags, the listing reads tags, and the GitHub releases page shows tags. A
 * label kept out of the tag meant `pruneRemote` weighed every machine's releases against one
 * `keepRemote`: a laptop backing up daily filled the window and DELETED the desktop's only backup,
 * silently, which is the opposite of what a second machine was added for.
 */
export function tagLabel(tag: string): string | null {
  const m = LABELLED_TAG_RE.exec(tag)
  return m?.[1] ?? null
}

/**
 * Only a tag `releaseTag` could have minted is ever touched by retention (`github-retention.ts`).
 * A release the user created by hand — however they named it — must never be mistaken for one of
 * ours, so this is deliberately the exact shape `releaseTag` produces, not a loose `backup-` prefix
 * a hand-made release could accidentally share.
 */
const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z`
const BACKUP_TAG_RE = new RegExp(`^backup-${STAMP}$`)
/** The label is `[a-z0-9-]` and the stamp begins with four digits and a `-`, so the greedy label
 *  group can never swallow part of the timestamp: the anchored stamp only matches at its own start. */
const LABELLED_TAG_RE = new RegExp(`^backup-([a-z0-9][a-z0-9-]*?)-(?:${STAMP})$`)

/**
 * Both shapes are ours. An UNLABELLED tag is one minted before labels existed, and refusing to
 * recognise it would leave every release already in a user's repository permanently un-prunable —
 * retention only ever touches a tag it recognises — accumulating until the repository filled up.
 */
export function isBackupTag(tag: string): boolean {
  return BACKUP_TAG_RE.test(tag) || LABELLED_TAG_RE.test(tag)
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
 *
 * **This is ONE format, written HERE, and read in TWO other places.** `parseReleaseBody` just below
 * is the TypeScript reader (`github-restore.ts`'s wave G3 restore). The THIRD reader is
 * `github-workflow.ts`'s `buildBackupDocWorkflow()` — a GitHub Actions workflow that runs on the
 * runner's own shell, never Bun, so it CANNOT import this module and re-parses the same
 * `- label: value` lines by hand (`grep`/`sed`). **A field added here must be added to
 * `parseReleaseBody` below AND to that workflow's parsing step, or the three drift** — the
 * TypeScript pair is caught by this file's own round-trip test, but the YAML has no compiler to
 * catch it, which is exactly why this paragraph exists on both ends.
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

/** The fields wave G3's restore reads back out of a release body — the reverse of
 *  `buildReleaseBody`, over the SAME lines, so the two can never drift apart silently: a field
 *  added to one and not the other fails `backup-github.test.ts`'s round-trip check rather than
 *  shipping a restore that cannot find what the upload wrote. */
export type ReleaseSummary = ReleaseBodyInput

function matchLine(body: string, label: string): string | null {
  const m = body.match(new RegExp(`^- ${label}: (.+)$`, 'm'))
  return m ? m[1]!.trim() : null
}

/**
 * Parse a release body `buildReleaseBody` produced. Returns `null` when the body is not shaped
 * like one this module wrote — a hand-made release, or one from an incompatible future version —
 * so the caller can refuse rather than restore from a summary it invented by guessing.
 */
export function parseReleaseBody(body: string): ReleaseSummary | null {
  const createdAt = matchLine(body, 'created')
  const hostname = matchLine(body, 'host')
  const layersRaw = matchLine(body, 'layers')
  const harnessesRaw = matchLine(body, 'harnesses')
  const sessionsRaw = matchLine(body, 'sessions')
  const sizeRaw = matchLine(body, 'size')
  const sha256Raw = matchLine(body, 'sha256')
  if (!createdAt || !hostname || !layersRaw || !harnessesRaw || !sessionsRaw || !sizeRaw || !sha256Raw) {
    return null
  }

  const sizeMatch = sizeRaw.match(/\((\d+) bytes\)/)
  const sha256Match = sha256Raw.match(/`([0-9a-f]+)`/i)
  const sessionCount = Number(sessionsRaw)
  const archiveBytes = sizeMatch ? Number(sizeMatch[1]) : NaN
  if (!sizeMatch || !sha256Match || !Number.isFinite(sessionCount) || !Number.isFinite(archiveBytes)) return null

  return {
    createdAt,
    hostname,
    layers: layersRaw.split(',').map(s => s.trim()).filter(Boolean) as BackupLayer[],
    harnesses: harnessesRaw.split(',').map(s => s.trim()).filter(Boolean) as HarnessId[],
    sessionCount,
    archiveBytes,
    sha256: sha256Match[1]!,
  }
}
