/**
 * size-cache.ts — the per-layer size measurement, remembered.
 *
 * `measuredLayerSizes()` walks every source of every layer, and the `raw` layer is the harness
 * directories: 15.341 files on the machine this was written for, and **7.2 seconds** measured with
 * the whole Settings → Backup page waiting on it. That is what the user saw as a page stuck on
 * "Loading".
 *
 * So the page stops waiting. It renders with whatever has already been measured, and `null` when
 * nothing has — which is why `cachedSizes` answers `null` rather than zeroes: "not measured yet"
 * and "this layer is empty" are different facts, and the surfaces already say the first in words
 * ("known after running"). A confident `0` beside a layer holding gigabytes is the error this
 * whole product is written against.
 */
import type { MeasuredLayers } from '../cli-backup'

/**
 * How long a measurement stands.
 *
 * Only a backup moves these numbers, and nothing moves them at a speed a person would notice —
 * so re-walking gigabytes on every page load spends seconds to catch a change nobody made.
 */
export const SIZE_CACHE_TTL_MS = 5 * 60_000

let cached: { at: number; value: MeasuredLayers } | null = null

/** The last measurement if it is still current, else `null`. `nowMs` is a parameter so the rule is
 *  testable without waiting five minutes. */
export function cachedSizes(nowMs: number = Date.now()): MeasuredLayers | null {
  if (!cached) return null
  return nowMs - cached.at < SIZE_CACHE_TTL_MS ? cached.value : null
}

export function storeSizes(value: MeasuredLayers, nowMs: number = Date.now()): void {
  cached = { at: nowMs, value }
}

/** For tests, and for a caller that knows the numbers just changed — a backup that just ran. */
export function resetSizeCache(): void {
  cached = null
}
