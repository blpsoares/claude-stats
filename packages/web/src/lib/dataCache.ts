/**
 * dataCache.ts — PURE: is this persisted `/api/data` snapshot safe to render?
 *
 * `useData` seeds its state from a localStorage snapshot so reopening the app (especially as an
 * installed PWA) paints immediately instead of showing the loading screen. That seeding also sets
 * `loading: false`, which is the whole problem: a present cache goes STRAIGHT into
 * `computeDerivedStats` with no loader, no guard and no server round-trip in between. The read was
 * a `JSON.parse(raw) as AppData` — a cast, not a check — so anything under that key that merely
 * PARSES was trusted as a complete payload.
 *
 * Reproduced: a snapshot missing `statsCache` throws
 * `TypeError: Cannot read properties of undefined (reading 'dailyActivity')` inside
 * `computeDerivedStats`, the root error boundary catches it, and its Reload button re-reads the
 * same snapshot — so the app is bricked for that origin until someone clears site data by hand.
 * The recovery is not something a user can be expected to find.
 *
 * How a bad snapshot gets written, in order of likelihood:
 *  - an OLDER BUILD wrote it. The key is versioned `v1` and has never been bumped while `AppData`
 *    kept growing (`machineStatsCaches`, `harnesses`, workflow runs…), so an upgrade reads a
 *    payload shaped for a different version of this code.
 *  - `fetch('/api/data')` answered 200 with something that is not an `AppData` — a proxy page, a
 *    captive portal, an ingest-only central — and the same blind cast cached it.
 *
 * This is deliberately a SHAPE check and not a schema: it asserts only what the render path
 * dereferences without its own guard. `statsCache` is the one that actually crashes today; the
 * two arrays are here because every surface maps over them. A snapshot that fails is not repaired
 * — it is DISCARDED, and the app falls back to the ordinary streamed first load, which is the
 * correct behaviour for "we have no trustworthy cache". Repairing it would mean inventing the
 * missing half, and a fabricated `statsCache` is a confident zero on every KPI.
 */

/** The fields the render path dereferences before anything has validated them. */
export function isUsableDataCache(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  // `computeDerivedStats` reads `effectiveStatsCache.dailyActivity` with no guard on the object
  // itself — this is the exact crash.
  if (!v.statsCache || typeof v.statsCache !== 'object' || Array.isArray(v.statsCache)) return false
  if (!Array.isArray(v.sessions)) return false
  if (!Array.isArray(v.projects)) return false
  return true
}
