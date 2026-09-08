/**
 * fleetCache.ts — PURE: what of a fleet snapshot may be remembered across a reload, and what may
 * never be.
 *
 * Leaving the page and coming back re-mounted the poller with an empty list, so the sidebar showed
 * its loading state for a full poll interval every time — on a phone, where "leaving" is switching
 * apps, that is most visits. `/api/data` has had a localStorage snapshot for exactly this reason;
 * the fleet had none.
 *
 * But a fleet is LIVE state, and that makes it different from the metrics snapshot in one way that
 * decides this module's whole shape: **the screen is never cached.** `lastLines`, `chatTurns`,
 * `approvalLines` and `dialogOptions` are what a session is saying RIGHT NOW. Painting yesterday's
 * terminal under a live-looking row is the confident-stale defect `fleetStale.ts` exists to
 * prevent, one layer worse — there the list was old and said so, here the words would be a
 * session's own and simply wrong. They are stripped, and the panel re-reads them from the live
 * poll like it always did.
 *
 * What IS remembered is the row's identity and placement — title, harness, state, directory, task,
 * note — which is what the list draws and what makes a reopen recognisable. It is remembered with
 * the TIME it was taken, so the surface can say the list has not been confirmed yet rather than
 * presenting it as current.
 */

/** Per-row fields that describe the moment rather than the session. Never persisted. */
export const VOLATILE_ROW_FIELDS = [
  'lastLines', 'chatTurns', 'approvalLines', 'dialogOptions',
] as const

export interface CachedFleet<T> {
  /** ms epoch when the poll that produced this answered. */
  at: number
  payload: T
}

/**
 * Strip everything that describes the moment, so what is stored is the fleet's shape and not its
 * screen. Deliberately field-by-field on an allowlist-of-removals rather than a whitelist: the
 * payload is large and mostly harmless, and a new benign field should not have to be added here to
 * be remembered. A new SENSITIVE field must be added to `VOLATILE_ROW_FIELDS`, which is why that
 * list is exported and tested.
 */
export function stripVolatile<T extends { rows?: unknown[]; sessions?: unknown[] }>(payload: T): T {
  const scrub = (arr: unknown[] | undefined): unknown[] | undefined => {
    if (!Array.isArray(arr)) return arr
    return arr.map(row => {
      if (!row || typeof row !== 'object') return row
      const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
      for (const f of VOLATILE_ROW_FIELDS) delete out[f]
      return out
    })
  }
  return { ...payload, rows: scrub(payload.rows), sessions: scrub(payload.sessions) } as T
}

/**
 * Is a stored snapshot worth painting?
 *
 * Old enough and it stops being a head start and becomes a lie with a timestamp: a fleet from last
 * week describes sessions that have since ended, been renamed, or been reopened under new ids. Two
 * hours is the judgement — long enough to cover a lunch, a meeting, or a phone left in a pocket,
 * short enough that nobody mistakes it for the truth.
 */
export const FLEET_CACHE_MAX_AGE_MS = 2 * 60 * 60_000

export function cacheIsUsable(at: number | undefined, now: number, maxAgeMs = FLEET_CACHE_MAX_AGE_MS): boolean {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false
  // A stamp in the FUTURE is a clock that moved, not a fresh snapshot — refused rather than trusted
  // forever.
  if (at > now) return false
  return now - at < maxAgeMs
}
