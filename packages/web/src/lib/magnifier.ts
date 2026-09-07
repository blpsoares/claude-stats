/**
 * magnifier.ts — every number a lens needs, and nothing that touches the DOM.
 *
 * The lens is `position: fixed`, so all coordinates here are VIEWPORT pixels. The mirror inside a
 * lens is a viewport-sized stage carrying a transform; `stageTransform` is the only place that
 * transform is decided, so the renderer cannot disagree with the geometry the keyboard edits.
 */
import type { LensStyle, MagnifierLens } from '@agentistics/core'
import { LENS_MAX_PX, LENS_MIN_PX, mintLensId, ZOOM_MAX, ZOOM_MIN } from '@agentistics/core'

/**
 * The DOM id of the magnifier layer's portal container (`MagnifierLayer.tsx`), a sibling of
 * `#root`. Lives here, not in either component file, so `Lens.tsx`'s `elementBehindLens` can name
 * the exact container to hide hit-testing on without importing `MagnifierLayer.tsx` and creating a
 * cycle (`MagnifierLayer` already imports `Lens`).
 */
export const MAGNIFIER_LAYER_ID = 'ag-magnifiers'

export interface Rect { x: number; y: number; width: number; height: number }
export interface Viewport { width: number; height: number }
export interface KeyMods { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean }
export type LensKeyResult = MagnifierLens | 'remove' | 'deselect' | null

export const MOVE_STEP_PX = 10
export const MOVE_FINE_PX = 1
export const RESIZE_STEP_PX = 10
/** The KEYBOARD zoom step (`+`/`-`, and the on-lens zoom-in/out buttons) — unchanged by the
 *  ZOOM_MIN range now reaching 0.55: `clampLens` floors at `ZOOM_MIN`, so a run of `-` presses
 *  still lands exactly on 0.55 at the bottom. */
export const ZOOM_STEP = 0.5
/**
 * A zoom SLIDER's step, deliberately finer than `ZOOM_STEP`. `ZOOM_MIN`..`ZOOM_MAX` (0.55..20) is
 * a wide range, and a slider stepping by the keyboard's 0.5 would offer exactly ONE stop below
 * 1× (0.55, then straight to 1.05) — usable at the keyboard, where each press is a deliberate
 * step, but a single jump is not a slider a user can drag to a felt-out value. This constant is UI
 * only (like `SIZE_SLIDER_MAX_PX`, which is why it lives here and not beside `ZOOM_MIN` in
 * `@agentistics/core`) and never touches `clampLens` or `applyLensKey`.
 */
export const ZOOM_SLIDER_STEP = 0.05
/**
 * The width/height sliders' UI ceiling — deliberately far below `LENS_MAX_PX` (2000). It is a
 * usability choice (a lens that large eats the whole screen and the live preview with it), not a
 * data constraint, which is why it lives here beside the other UI constants rather than in
 * `@agentistics/core` next to the stored bound it deliberately undercuts.
 */
export const SIZE_SLIDER_MAX_PX = 1200

/**
 * A lens belongs to one EXACT pathname. Query and hash are dropped on purpose: applying a filter
 * is not arriving at a different page, and a lens that vanished when a date preset changed would
 * read as a bug.
 */
export function pageKey(pathname: string): string {
  const p = pathname.split('?')[0]!.split('#')[0]!
  if (p === '' || p === '/') return '/'
  return p.endsWith('/') ? p.slice(0, -1) : p
}

/**
 * A zoom value for display, everywhere one is shown — the lens's own label, its menu, the
 * settings preview and readout, and the announcement sentence. `ZOOM_SLIDER_STEP` (0.05) and
 * repeated `+`/`-` arithmetic on `ZOOM_STEP` (0.5) can both leave a binary-float remainder (e.g.
 * `0.6499999999999999`), which is invisible at the old integer-only range (1.5..20) and would
 * otherwise surface the moment the floor moved to 0.55. Rounding to two decimals is enough
 * precision to tell 0.55 from 1.05 apart and never enough to hide an intentional step.
 */
export function fmtZoom(zoom: number): string {
  return (Math.round(zoom * 100) / 100).toString()
}

/**
 * The two ways a lens's position can be read into a source region — named explicitly because
 * they disagree, and the disagreement is the whole fix this type documents:
 *
 * - `'pan'` — the lens's position is a PARKING SPOT the user chose. Panning proportionally to
 *   that position is what makes the page's outer band reachable at all (see `panAxis`'s own
 *   comment for the corner-unreachable bug this replaced). This is what every PLACED lens needs.
 * - `'cursor'` — the lens's position IS the pointer: the follow lens is centred on the cursor
 *   every frame, not parked. Panning it would show, at the lens's centre, content that is NOT
 *   under the cursor — the user aims at what they see and the click (which passes straight
 *   through, since the follow lens is `pointerEvents: 'none'`) lands on a different element. A
 *   pointer must show what is physically beneath it or aiming becomes impossible, so this mode
 *   centres the region on the lens instead (see `cursorAxis`).
 *
 * Defaults to `'pan'` because every placed lens (the overwhelming majority of callers) needs it;
 * the follow lens is the one caller that must ask for `'cursor'` explicitly.
 */
export type SourceAnchor = 'pan' | 'cursor'

/**
 * The viewport region a lens magnifies: shrunk by the zoom, then read into position by `anchor`
 * (see `SourceAnchor` above) — PANNED for a placed lens, CENTRED on the pointer for the cursor-
 * following one.
 *
 * What the lens actually SHOWS is its content box — `box-sizing: border-box` makes that
 * `width - 2*borderWidth` by `height - 2*borderWidth`, not the frame's own size — so that is
 * the size that gets divided by the zoom. Getting this wrong offsets the magnified image by
 * exactly `borderWidth` px (because the translation in stageTransform only lands the region
 * at the content box when the region size is derived from the interior, not the frame).
 */
export function sourceRect(lens: LensStyle & { x: number; y: number }, vp: Viewport, anchor: SourceAnchor = 'pan'): Rect {
  const width = (lens.width - 2 * lens.borderWidth) / lens.zoom
  const height = (lens.height - 2 * lens.borderWidth) / lens.zoom

  const x = anchor === 'cursor'
    ? cursorAxis(lens.x, lens.width, width)
    : panAxis(lens.x, lens.width, width, vp.width)
  const y = anchor === 'cursor'
    ? cursorAxis(lens.y, lens.height, height)
    : panAxis(lens.y, lens.height, height, vp.height)

  return { x, y, width, height }
}

/**
 * One axis of the PAN anchor — for a PLACED lens, whose position is a parking spot the user
 * chose. Centring the region on the lens's own centre — the old rule — makes the outer band of
 * the page unreachable: a lens pinned against the left edge is centred at half its own width, so
 * nothing further left is ever inside ANY source region (measured ~150px at 4x, ~95px at 1.55x
 * on the running build). `clampLens` keeps the LENS on screen but never widens the region it can
 * show, and the old clamp on this function only ever engaged once the region itself was wider
 * than the viewport (zoom below 1x) — it never helped at normal zoom, which is where the bug was
 * reported.
 *
 * So each axis is a PAN: the lens's position — clamped into `[0, viewport size - lens size]`,
 * because the cursor-following lens is not clamped by `clampLens` and can sit partly off-screen —
 * is read as a fraction of the room the LENS has to move in (`lensRange`), and that same fraction
 * is applied to the room the SOURCE REGION has to move in (`srcRange`). A lens at the left wall
 * (fraction 0) shows the region's own left wall; a lens at the right wall (fraction 1) shows the
 * region's right wall; everything between is a straight line. Two cases where that ratio makes
 * no sense are centred instead: a lens as wide as (or wider than) the viewport has no room to
 * move in, and a region wider than the viewport — reachable now that zoom can go below 1x, down
 * to 0.55x — has no room to sit fully inside it; resizing the region to fit would change the
 * magnification the user picked, which this function may never do.
 *
 * Trade-off, stated plainly: away from the exact centre of the viewport, the lens no longer
 * shows literally what is beneath it — it shows the region reached by panning proportionally to
 * the lens's own position. That is what makes every corner of the page reachable, and it is how
 * OS-level magnifiers behave. The one point where this rule and a plain centred one agree exactly
 * is a lens centred in the viewport — the position a lens is born at (`newLens`).
 */
function panAxis(lensPos: number, lensSize: number, regionSize: number, vpSize: number): number {
  const lensRange = vpSize - lensSize
  const srcRange = vpSize - regionSize
  if (lensRange <= 0 || srcRange < 0) return (vpSize - regionSize) / 2
  const clampedLensPos = Math.min(Math.max(lensPos, 0), lensRange)
  return (clampedLensPos / lensRange) * srcRange
}

/**
 * One axis of the CURSOR anchor — for the follow lens, whose position IS the pointer. The region is
 * centred on the lens's own centre, and that is the whole rule: `lensPointToPage`'s inverse then
 * maps the lens's visual centre back to the exact viewport point the cursor sits on, everywhere on
 * the page, which is the property that makes aiming through it possible at all.
 *
 * IT IS DELIBERATELY NOT CLAMPED INTO THE VIEWPORT, and that is a fix rather than an oversight.
 * This lens is centred on the pointer and is NOT kept on screen (see `FollowLens` — unlike a placed
 * lens it has no `clampLens`), so near an edge half of its frame hangs off the screen. Sliding the
 * REGION back inside while the FRAME stayed where it was pushed the page's own outer band into the
 * half nobody can see: with an 800px lens at 2x, a cursor at x=100 showed the band from x=195
 * onwards and painted everything left of it off-screen — reported as "at the edges I cannot see the
 * real content", the same complaint `panAxis` answers for a placed lens, arriving here by a
 * different route. Unclamped, the point under the cursor is at the lens's centre at every position,
 * so the edge is reached by putting the pointer on it and the corner by putting the pointer in it.
 *
 * The cost is stated: at an edge, part of the lens shows the area BEYOND the page, which is blank.
 * That is honest — there is nothing there — and it is how a pointer-anchored OS magnifier behaves.
 * Showing blank where there is nothing beats hiding content that exists.
 *
 * A region larger than the viewport (reachable below 1x zoom) needs no special case here for the
 * same reason: centring it on the cursor is exactly right, and it was the clamp — not the size —
 * that ever made a branch necessary.
 */
function cursorAxis(lensPos: number, lensSize: number, regionSize: number): number {
  return lensPos + lensSize / 2 - regionSize / 2
}

/**
 * What the stage's `transform` must be. The stage is an ORDINARY in-flow child of the frame, so
 * with `transform-origin: 0 0` its untransformed origin sits at the frame's CONTENT-box origin —
 * viewport `(lens.x + borderWidth, lens.y + borderWidth)` — not the viewport origin. Within the
 * stage, a page coordinate P renders at stage-local coordinate P (it is a clone of the page).
 * So `scale(s) translate(tx, ty)` puts stage-local point p at viewport
 * `contentOrigin + s * (p + t)`, and putting the source region's top-left at the content-box
 * top-left means `t = -source.origin`.
 *
 * `anchor` is forwarded to `sourceRect` untouched — a placed lens (the default `'pan'`) and the
 * cursor-following one (`'cursor'`) render through the exact same scale/translate shape, they
 * just disagree on which region that shape points at.
 */
export function stageTransform(lens: LensStyle & { x: number; y: number }, vp: Viewport, anchor: SourceAnchor = 'pan'): { scale: number; tx: number; ty: number } {
  const s = sourceRect(lens, vp, anchor)
  return { scale: lens.zoom, tx: -s.x, ty: -s.y }
}

/**
 * The inverse of what `stageTransform` + `sourceRect` render: given a point inside the lens's own
 * FRAME (`localX`/`localY`, relative to the frame's top-left — i.e. `clientX - lens.x`,
 * `clientY - lens.y`), returns the viewport point the lens is showing there.
 *
 * Forward direction (see `stageTransform`'s own derivation): a viewport point `p` renders at
 * viewport position `contentOrigin + zoom * (p - source.origin)`, where `contentOrigin =
 * (lens.x + borderWidth, lens.y + borderWidth)`. A point at frame-local `(localX, localY)` sits at
 * viewport position `(lens.x + localX, lens.y + localY)`. Setting the two equal and solving for
 * `p`:
 *
 *   lens.x + localX = lens.x + borderWidth + zoom * (px - source.x)
 *   px = source.x + (localX - borderWidth) / zoom
 *
 * and the same for `y`. This is an exact algebraic inverse, not a re-derivation — the round-trip
 * test renders a page point through the SAME terms `Lens.tsx` uses (content origin + stage
 * transform) and feeds the result back through this function.
 *
 * `anchor` must match whichever one rendered the lens — see `SourceAnchor` — or this inverts a
 * region the lens never actually showed.
 */
export function lensPointToPage(
  lens: MagnifierLens,
  viewport: Viewport,
  localX: number,
  localY: number,
  anchor: SourceAnchor = 'pan',
): { x: number; y: number } {
  const s = sourceRect(lens, viewport, anchor)
  return {
    x: s.x + (localX - lens.borderWidth) / lens.zoom,
    y: s.y + (localY - lens.borderWidth) / lens.zoom,
  }
}

/**
 * Keeps a lens usable: on screen, within the size floor/ceiling, within the zoom bounds. Applied
 * after EVERY edit — drag, resize, keypress, window resize — because a lens parked outside the
 * viewport is one no gesture can reach again.
 */
export function clampLens(lens: MagnifierLens, vp: Viewport): MagnifierLens {
  const maxW = Math.max(LENS_MIN_PX, Math.min(LENS_MAX_PX, vp.width))
  const maxH = Math.max(LENS_MIN_PX, Math.min(LENS_MAX_PX, vp.height))

  let width: number
  let height: number
  if (lens.shape === 'circle') {
    const d = Math.min(Math.max(lens.width, LENS_MIN_PX), Math.min(maxW, maxH))
    width = d
    height = d
  } else {
    width = Math.min(Math.max(lens.width, LENS_MIN_PX), maxW)
    height = Math.min(Math.max(lens.height, LENS_MIN_PX), maxH)
  }

  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, lens.zoom))
  const x = Math.min(Math.max(lens.x, 0), Math.max(0, vp.width - width))
  const y = Math.min(Math.max(lens.y, 0), Math.max(0, vp.height - height))
  return { ...lens, width, height, zoom, x, y }
}

/**
 * The keyboard reducer. Returns `null` when the key was not ours — the caller MUST then let the
 * event through, or the dashboard stops responding to its own shortcuts. Clamping is the caller's
 * job (it owns the viewport).
 */
export function applyLensKey(lens: MagnifierLens, key: string, mods: KeyMods): LensKeyResult {
  // A ctrl/meta chord belongs to the browser or to the app, never to a lens.
  if (mods.ctrl || mods.meta) return null

  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  const dir = arrows[key]
  if (dir) {
    const [dx, dy] = dir
    if (mods.shift) {
      if (lens.shape === 'circle') {
        // One dimension, so every arrow has to act on it: right/up grow, left/down shrink.
        const delta = (dx !== 0 ? dx : -dy) * RESIZE_STEP_PX
        return { ...lens, width: lens.width + delta, height: lens.height + delta }
      }
      return {
        ...lens,
        width: lens.width + dx * RESIZE_STEP_PX,
        height: lens.height + dy * RESIZE_STEP_PX,
      }
    }
    const step = mods.alt ? MOVE_FINE_PX : MOVE_STEP_PX
    return { ...lens, x: lens.x + dx * step, y: lens.y + dy * step }
  }

  if (key === '+' || key === '=') return { ...lens, zoom: lens.zoom + ZOOM_STEP }
  if (key === '-' || key === '_') return { ...lens, zoom: lens.zoom - ZOOM_STEP }
  if (key === 'p' || key === 'P') return { ...lens, pinned: !lens.pinned }
  if (key === 'Delete' || key === 'Backspace') return 'remove'
  if (key === 'Escape') return 'deselect'
  return null
}

export type LensControl = 'drag' | 'config' | 'pin' | 'remove' | 'zoomOut' | 'zoomIn' | 'zoomLabel'

/**
 * Which controls fit in a lens this wide, most important first — the same problem the TUI's
 * `fitColumns` solves for a table row, applied to the lens header strip.
 *
 * `drag` is never dropped: without it the lens cannot be moved, and a clipped strip is one no
 * gesture can repair. `config` sits second, right after `drag`, on purpose: it opens the lens's
 * own menu, which reaches EVERY other setting here (zoom, size, shape, border, pin, duplicate,
 * remove) — so a lens narrow enough to show only two controls still gives the user full command
 * of it, where dropping `config` first would leave that lens movable but unconfigurable except by
 * a right-click nobody is told exists. `zoomOut`/`zoomIn` are added as a PAIR or not at all — a
 * lone zoom button would let you go one way and not the other, which is a worse control than
 * neither.
 */
export function lensControls(innerWidthPx: number, controlPx: number, labelPx: number): LensControl[] {
  const controls: LensControl[] = ['drag']
  // The drag handle costs about one control's worth of width in the header strip.
  let used = controlPx

  if (innerWidthPx - used < controlPx) return controls
  controls.push('config')
  used += controlPx

  if (innerWidthPx - used < controlPx) return controls
  controls.push('pin')
  used += controlPx

  if (innerWidthPx - used < controlPx) return controls
  controls.push('remove')
  used += controlPx

  if (innerWidthPx - used < controlPx * 2) return controls
  controls.push('zoomOut', 'zoomIn')
  used += controlPx * 2

  if (innerWidthPx - used < labelPx) return controls
  controls.push('zoomLabel')

  return controls
}

/** How the current selection was made. The pointer and the keyboard do NOT reach a pinned lens
 *  alike — see `lensInteractive`. */
export type SelectionSource = 'keyboard' | 'pointer'

/**
 * Whether a lens may be MOVED and RESIZED right now — and therefore whether its control strip is
 * drawn at all.
 *
 * PINNED MEANS IMMOVABLE TO THE POINTER. That is the whole of what the user asked the pin for:
 * once a lens is placed and sized, "simplesmente não sofre efeito de cliques". Selection alone
 * used to lift it, and every pointer path selects — right-clicking a pinned lens to reach its menu
 * (the one way a mouse reaches unpin and remove) handed the strip and the drag straight back, so
 * the gesture for reading a pinned lens's settings was also the gesture that un-pinned it in
 * practice: the next drag moved it.
 *
 * The KEYBOARD is the exception, and it has to be: `Tab` and `Ctrl+Shift+M` cycle every lens
 * including the pinned ones, because keyboard is the only way they are reachable at all, and a
 * selection a person had to press a key to make is not one they make by accident while aiming at
 * something else. So the reveal follows the SOURCE of the selection, never the selection itself.
 */
export function lensInteractive(
  lens: Pick<MagnifierLens, 'pinned'>,
  selected: boolean,
  via: SelectionSource,
): boolean {
  if (!lens.pinned) return true
  return selected && via === 'keyboard'
}

/** A new lens, centred in the viewport, with an id no sibling holds. */
export function newLens(style: LensStyle, vp: Viewport, taken: Set<string>): MagnifierLens {
  return {
    ...style,
    id: mintLensId(taken),
    x: Math.round(vp.width / 2 - style.width / 2),
    y: Math.round(vp.height / 2 - style.height / 2),
    pinned: false,
  }
}

/**
 * Where a WINDOW-scrolled `position: sticky` copy must be painted inside the stage, as a
 * stage-local translate.
 *
 * A sticky copy inside the clone has no scrolling ancestor, so it never engages: it paints at its
 * ordinary FLOW position, which — the clone root being offset by `-scroll` — lands at stage-local
 * `flow - scroll`, where `flow` is the element's position in DOCUMENT coordinates. The LIVE element
 * is wherever the browser is actually painting it right now, in VIEWPORT coordinates, which is the
 * same frame stage-local coordinates live in. So the correction is simply the gap between the two:
 *
 *     offset = live − (flow − scroll)
 *
 * **The live position must be MEASURED, never extrapolated from a scroll delta.** The previous rule
 * took the offset computed at the last full sync and added however far the page had scrolled since,
 * which holds the copy still on screen — exactly right while the element is STUCK (its viewport
 * position genuinely does not change as you scroll) and exactly wrong while it is not. In its
 * UNSTUCK phase a sticky element flows with the page like any other, so `live = flow − scroll` and
 * the offset is ZERO; the delta rule instead returned the scroll distance, freezing the copy where
 * the last sync left it while the real element scrolled away. The header of this dashboard is
 * sticky on every page, so that is a lens showing a header nailed to the wrong place, and it
 * stayed wrong until the next full sync happened to land.
 *
 * Both phases, and the crossing between them, come out right here for the same reason: nothing is
 * assumed about which phase the element is in. That is what makes the sticky term correct on the
 * frame it changes rather than a heartbeat later.
 */
export function stickyOffset(
  flow: { x: number; y: number },
  live: { left: number; top: number },
  scroll: { x: number; y: number },
): { dx: number; dy: number } {
  return {
    dx: live.left - (flow.x - scroll.x),
    dy: live.top - (flow.y - scroll.y),
  }
}
