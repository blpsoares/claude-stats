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
import type { BackupLayer } from './backup-plan'

/** GitHub's own limit on a single Release asset — 2 GiB, matching the binary units this product
 *  already uses for every other size (`backup-size.ts`'s `formatBytes`). */
export const GITHUB_RELEASE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

export type GithubFitVerdict = 'fits' | 'maybe-not'

export function githubFitVerdict(
  layers: BackupLayer[], layerBytes: Record<BackupLayer, number | null>,
): GithubFitVerdict {
  const total = layers.reduce((n, l) => n + (layerBytes[l] ?? 0), 0)
  return total < GITHUB_RELEASE_LIMIT_BYTES ? 'fits' : 'maybe-not'
}
