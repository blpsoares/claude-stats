/**
 * backup-size.ts — PURE. What a backup weighs, measured.
 *
 * Three rules, and the third is the one with teeth.
 *
 * 1. **Per layer AND per harness.** The per-harness map is what lets a surface print a harness's
 *    own weight beside its own last-backup date. A single total at the top would let an unticked
 *    harness look covered.
 * 2. **Retention is a total.** 7 daily copies of the `raw` layer are 17 GB, and that has to be
 *    visible at the moment someone raises `keep N` or adds `raw` to a schedule — not afterwards.
 * 3. **Nothing here predicts a compressed size.** Compression depends on the bytes, and the bytes
 *    are only known once they are written; a ratio applied to a plan produces a figure that reads
 *    like a measurement and is not one. The compressed size exists in exactly one place —
 *    `BackupRecord.archiveBytes`, written after the archive exists. `backup-size.test.ts` asserts
 *    this over the module's own source, so the rule survives a refactor that finds it inconvenient.
 */
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { BACKUP_LAYERS, type BackupLayer } from './backup-plan'

export interface LayerSize {
  bytes: number
  files: number
  /** Bytes attributable to one harness. Cross-harness bytes are in `bytes` and in no entry here. */
  byHarness: Partial<Record<HarnessId, number>>
}

export type BackupSizes = Record<BackupLayer, LayerSize>

export function emptySizes(): BackupSizes {
  const out = {} as BackupSizes
  for (const l of BACKUP_LAYERS) out[l] = { bytes: 0, files: 0, byHarness: {} }
  return out
}

/** Add one measured file. `harness` is null for cross-harness data. Mutates, because this is
 *  called once per file over a two-gigabyte walk. */
export function addBytes(
  sizes: BackupSizes, layer: BackupLayer, harness: HarnessId | null, bytes: number,
): void {
  const l = sizes[layer]
  l.bytes += bytes
  l.files += 1
  if (harness) l.byHarness[harness] = (l.byHarness[harness] ?? 0) + bytes
}

export function layerTotal(sizes: BackupSizes, layer: BackupLayer): number {
  return sizes[layer].bytes
}

/** The total of only the layers actually being written. */
export function plannedTotal(sizes: BackupSizes, layers: BackupLayer[]): number {
  return layers.reduce((n, l) => n + sizes[l].bytes, 0)
}

/** Everything one harness contributes, across every layer. */
export function harnessTotal(sizes: BackupSizes, harness: HarnessId): number {
  return BACKUP_LAYERS.reduce((n, l) => n + (sizes[l].byHarness[harness] ?? 0), 0)
}

/** Harnesses that contributed anything, in display order. */
export function harnessesPresent(sizes: BackupSizes): HarnessId[] {
  return HARNESS_ORDER.filter(h => harnessTotal(sizes, h) > 0)
}

/** What every retained backup occupies together. Takes the records' real file sizes. */
export function retainedTotal(records: { archiveBytes: number }[]): number {
  return records.reduce((n, r) => n + r.archiveBytes, 0)
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  let v = n
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${UNITS[i]}`
}
