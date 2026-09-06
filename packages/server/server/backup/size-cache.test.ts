/**
 * size-cache.test.ts — the per-layer size measurement is CACHED, because the page waits on it.
 */
import { test, expect } from 'bun:test'
import { SIZE_CACHE_TTL_MS, cachedSizes, storeSizes, resetSizeCache } from './size-cache'

const SIZES = { labels: { metrics: '2.4 MB', repos: null, archive: '1 MB', raw: '9 GB' }, sizes: {} as never }

test('nothing measured yet answers NULL — never a zero', () => {
  // Measured on a real machine: walking every layer took 7.2s, and the whole settings page waited
  // on it. The fix is to stop waiting, which means the page must be able to render with the sizes
  // still unknown — and "unknown" has to be distinguishable from "this layer is empty".
  resetSizeCache()
  expect(cachedSizes(0)).toBe(null)
})

test('a stored measurement is served back inside its window', () => {
  resetSizeCache()
  storeSizes(SIZES, 1_000)
  expect(cachedSizes(1_000)?.labels.raw).toBe('9 GB')
  expect(cachedSizes(1_000 + SIZE_CACHE_TTL_MS - 1)?.labels.raw).toBe('9 GB')
})

test('past its window it answers null, so a stale figure is never presented as current', () => {
  resetSizeCache()
  storeSizes(SIZES, 1_000)
  expect(cachedSizes(1_000 + SIZE_CACHE_TTL_MS)).toBe(null)
})

test('the window is long enough to be worth having', () => {
  // A backup changes these numbers, and nothing else does at any speed a person would notice.
  // Re-walking gigabytes on every page load to catch a change nobody made is the cost this exists
  // to remove.
  expect(SIZE_CACHE_TTL_MS).toBeGreaterThanOrEqual(60_000)
})
