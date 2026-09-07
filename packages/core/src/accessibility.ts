/**
 * accessibility.ts — the magnifier lenses' shared vocabulary.
 *
 * PURE and TOTAL. `sanitizeAccessibilityPrefs` is called on BOTH sides of the wire: the server
 * before it stores, the browser before it renders. A hand-edited `preferences.json` or a stale
 * client must never be able to blank the dashboard or draw a lens with a NaN transform, so every
 * number is clamped rather than rejected and every unknown shape falls back.
 *
 * Border COLOUR is deliberately absent: a lens is always the site orange, in every state and both
 * themes. Thickness and shape are the user's; the colour is the product's.
 */

export type LensShape = 'circle' | 'rect'

/** The look of a lens, shared by placed lenses and by the cursor-following one. */
export interface LensStyle {
  shape: LensShape
  /** px. For a circle this is the DIAMETER and `height` is kept equal to it. */
  width: number
  height: number
  /** How many times magnified. */
  zoom: number
  borderWidth: number
  /** px, rectangles only; ignored while `shape === 'circle'`. */
  cornerRadius: number
}

/** A lens the user placed on one page. Coordinates are viewport px — a lens is position:fixed. */
export interface MagnifierLens extends LensStyle {
  id: string
  x: number
  y: number
  /** Pinned = glass: controls hidden and pointer events pass straight through. */
  pinned: boolean
}

export interface AccessibilityPrefs {
  /** The master switch. Off means no lens layer and no observer at all — the cost is zero. */
  enabled: boolean
  followLens: LensStyle
  newLensDefaults: LensStyle
  /** Keyed by EXACT pathname (query and hash ignored) — see `pageKey` in the web package. */
  lensesByPage: Record<string, MagnifierLens[]>
  /**
   * Lenses that follow the user across EVERY page, in their own bucket rather than a `global`
   * flag on a lens sitting inside `lensesByPage`. A flag would leave "which page owns it" a
   * question every reader has to answer, and would make `removePage` a trap (deleting a page
   * could silently take its "global" lenses with it). A separate bucket says what the lens IS,
   * and keeps `pageKey` meaning exactly what it means today.
   */
  globalLenses: MagnifierLens[]
}

/**
 * 0.55, not 1: a lens that REDUCES (shows more context at a glance) is as legitimate a use as one
 * that magnifies — the geometry already supports it (`sourceRect` divides by zoom, so below 1 the
 * source region is simply larger than the lens), this constant was the only thing refusing it.
 */
export const ZOOM_MIN = 0.55
export const ZOOM_MAX = 20
export const LENS_MIN_PX = 60
export const LENS_MAX_PX = 2000
export const BORDER_MIN_PX = 1
export const BORDER_MAX_PX = 12
export const CORNER_MAX_PX = 200
/**
 * A sanity ceiling on a stored `x`/`y` coordinate — not the viewport clamp, which is `clampLens`'s
 * job in the web package. This only stops a hand-edited or corrupted `preferences.json` from
 * carrying a coordinate so large it produces a nonsensical transform before anything on screen
 * ever gets a chance to clamp it to the viewport.
 */
export const COORD_MAX_PX = 100000

export const DEFAULT_LENS_STYLE: LensStyle = {
  shape: 'rect',
  width: 360,
  height: 240,
  zoom: 2.5,
  borderWidth: 3,
  cornerRadius: 12,
}

export const DEFAULT_ACCESSIBILITY_PREFS: AccessibilityPrefs = {
  enabled: false,
  followLens: { ...DEFAULT_LENS_STYLE, shape: 'circle', width: 260, height: 260 },
  newLensDefaults: { ...DEFAULT_LENS_STYLE },
  lensesByPage: {},
  globalLenses: [],
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sanitizeStyle(input: unknown, fallback: LensStyle): LensStyle {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const shape: LensShape = o.shape === 'circle' ? 'circle' : o.shape === 'rect' ? 'rect' : fallback.shape
  const width = num(o.width, fallback.width, LENS_MIN_PX, LENS_MAX_PX)
  return {
    shape,
    width,
    // A circle has one dimension. Keeping height equal to width means no later reader has to
    // remember which of the two is "the real one".
    height: shape === 'circle' ? width : num(o.height, fallback.height, LENS_MIN_PX, LENS_MAX_PX),
    zoom: num(o.zoom, fallback.zoom, ZOOM_MIN, ZOOM_MAX),
    borderWidth: num(o.borderWidth, fallback.borderWidth, BORDER_MIN_PX, BORDER_MAX_PX),
    cornerRadius: num(o.cornerRadius, fallback.cornerRadius, 0, CORNER_MAX_PX),
  }
}

/**
 * The next free `lens-N` id given a set of ids already in use. Deterministic, so sanitising twice
 * yields the same ids — which is what makes it idempotent. The one mint used everywhere a lens
 * needs an id: here, `newLens` (web `lib/magnifier.ts`) and `useAccessibility`'s `duplicateLens` —
 * three copies of this exact loop used to exist, and this is the single source of truth for all of
 * them.
 */
export function mintLensId(taken: Set<string>): string {
  let n = 1
  while (taken.has(`lens-${n}`)) n++
  return `lens-${n}`
}

/**
 * Sanitizes one raw array into a list of valid lenses: total (never throws), clamped (every
 * number lands in range), non-object entries dropped, and ids re-minted deterministically.
 *
 * `preTaken` seeds the "already in use" set — the caller passes the OTHER bucket's finalized ids
 * so a page lens and a global lens can never end up sharing an id. Without that, sanitizing each
 * bucket in isolation would let `lensesByPage['/costs']` and `globalLenses` each mint (or keep) a
 * `lens-1`, and since a page's rendered lenses are `pageLenses ∪ globalLenses` at runtime, the two
 * would collide the moment that page is visited — `selectedId`, the keyboard cycle and every menu
 * key off exactly that id.
 */
function sanitizeLensList(raw: unknown[], fallbackStyle: LensStyle, preTaken: ReadonlySet<string>): MagnifierLens[] {
  const taken = new Set(preTaken)
  const lenses: MagnifierLens[] = []

  // Two-pass approach: first reserve explicit ids (Finding 2), then mint ids for entries that need one.
  // This ensures explicit ids are not clobbered by auto-minted ones.

  // Pass 1: Reserve all explicit, non-empty, non-duplicate ids — a duplicate of one already taken
  // (by an earlier item in this same list, OR by `preTaken`) is NOT reserved, so pass 2 re-mints it.
  const explicitIds = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const io = item as Record<string, unknown>
    const id = typeof io.id === 'string' && io.id.trim() !== '' ? io.id.trim() : ''
    if (id !== '' && !explicitIds.has(id) && !taken.has(id)) {
      explicitIds.add(id)
      taken.add(id)
    }
  }

  // Pass 2: Process all items, skipping non-objects (Finding 1), and minting ids as needed (Finding 2).
  for (const item of raw) {
    // Skip items that are not non-null objects. Don't sanitize them into default lenses.
    if (!item || typeof item !== 'object') continue

    const io = item as Record<string, unknown>
    const style = sanitizeStyle(io, fallbackStyle)
    let id = typeof io.id === 'string' && io.id.trim() !== '' ? io.id.trim() : ''
    // If no explicit id, or if this explicit id is a duplicate (already used in this list or the
    // other bucket), mint a new one.
    if (id === '' || !explicitIds.has(id)) {
      id = mintLensId(taken)
    }
    // Mark this explicit id as used (prevents duplicates from using the same reserved id)
    explicitIds.delete(id)
    taken.add(id)
    lenses.push({
      ...style,
      id,
      // Position is NOT clamped here: the viewport is a browser fact and this module runs on the
      // server too. `clampLens` in the web package does that, on every render.
      x: num(io.x, 0, -LENS_MAX_PX, COORD_MAX_PX),
      y: num(io.y, 0, -LENS_MAX_PX, COORD_MAX_PX),
      pinned: io.pinned === true,
    })
  }
  return lenses
}

export function sanitizeAccessibilityPrefs(input: unknown): AccessibilityPrefs {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const newLensDefaults = sanitizeStyle(o.newLensDefaults, DEFAULT_ACCESSIBILITY_PREFS.newLensDefaults)
  const followLens = sanitizeStyle(o.followLens, DEFAULT_ACCESSIBILITY_PREFS.followLens)

  // Sanitized FIRST, with no other bucket to avoid yet: every stored document that exists today
  // has no `globalLenses` at all, so an absent/non-array value reads as an empty list — the same
  // rule `lensesByPage` already applies to a page key that isn't there.
  const rawGlobal = Array.isArray(o.globalLenses) ? o.globalLenses : []
  const globalLenses = sanitizeLensList(rawGlobal, newLensDefaults, new Set())
  // The ids `globalLenses` settled on — every page's sanitization seeds its OWN taken-set with
  // these, so a page lens that happens to share an id with a global one gets re-minted instead of
  // silently colliding with it the moment the two are rendered together.
  const globalTaken = new Set(globalLenses.map(l => l.id))

  const rawPages =
    o.lensesByPage && typeof o.lensesByPage === 'object'
      ? (o.lensesByPage as Record<string, unknown>)
      : {}

  const lensesByPage: Record<string, MagnifierLens[]> = {}
  for (const [page, raw] of Object.entries(rawPages)) {
    // A page key is a pathname. Anything else is not addressable and would strand its lenses.
    if (!page.startsWith('/')) continue
    if (!Array.isArray(raw)) continue
    const lenses = sanitizeLensList(raw, newLensDefaults, globalTaken)
    // An empty page is not a page. Keeping the key would grow the document forever as pages are
    // visited and cleared.
    if (lenses.length > 0) lensesByPage[page] = lenses
  }

  return { enabled: o.enabled === true, followLens, newLensDefaults, lensesByPage, globalLenses }
}
