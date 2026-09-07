/**
 * bootPhase.ts — the one predicate that decides whether the app is still BOOTING.
 *
 * The dashboard already showed a boot loader (`LoadingScreen`), but it was gated on `loading` — the
 * `/api/data` fetch — ALONE. That flag flips false the moment that single fetch resolves, while the
 * app still cannot paint real content until the derived stats are computed AND the first-run
 * preferences (the archive choice) have resolved. Each of those in-between moments returned a SILENT
 * BLANK screen (a bare `min-height:100vh` dark div): the loader vanished before the data was ready,
 * which is exactly the "loader some antes de os dados estarem prontos" report.
 *
 * Keeping this rule in one pure, tested function means the render gate can never again decide it in
 * one place and forget it in the next.
 */

export interface BootSignals {
  /** The `/api/data` fetch is in flight. */
  loading: boolean
  /** `data !== null` — the payload has arrived. */
  hasData: boolean
  /** The derived stats (`useDerivedStats`) have been computed from `data`. */
  hasDerived: boolean
  /** The first-run preferences have resolved — `archiveChoice !== undefined` (null counts as
   *  resolved: it means "loaded, not yet chosen", which is the consent gate, not a loading state). */
  prefsLoaded: boolean
}

/** True while the boot loader must stay on screen — the app is not yet ready to paint content. */
export function bootLoading(s: BootSignals): boolean {
  return s.loading || !s.hasData || !s.hasDerived || !s.prefsLoaded
}
