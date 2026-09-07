/**
 * Lens.tsx — one magnifier.
 *
 * Four elements, in two layers. The OUTER wrapper is `position: fixed` at the lens's bounds and
 * carries only position/size/pointer-events — it is deliberately NEVER clipped. Inside it, the
 * "viewport" is the element that actually looks like a lens: the orange border, the shape
 * (rounded corner or circle) and `overflow: hidden`, holding the mirror stage. The control strip
 * and the resize handle are siblings of the viewport, not children of it — so no lens SHAPE can
 * ever clip them away. That split exists because it used to be one clipped element: on a circle,
 * a full-width strip pinned to the frame's top edge sits almost entirely in the bounding box's
 * corners, which the circular `overflow: hidden` swallowed to an unusable sliver — the controls
 * were never removed, they were being masked off by the lens's own shape. See where the strip is
 * placed for a circle, below.
 *
 * Pinned is glass: controls gone, but the magnified area still FORWARDS interaction (see below) —
 * pinning removes the ability to move/alter the lens, never the ability to work through it.
 *
 * FORWARDING. The mirror is a picture: clicking it does nothing on its own. So the viewport div
 * (the magnified area, never the control strip or resize handle — those are siblings, outside it)
 * carries click/wheel/mousemove handlers that map the local point back to the page point it
 * represents (`lensPointToPage`) and re-dispatch the interaction THERE, on the live DOM. This also
 * closes a worse bug than "reading only": a pinned lens used to be `pointerEvents: 'none'` on the
 * whole frame, so a click "passed through" to whatever was PHYSICALLY under the cursor — not the
 * element the user sees magnified at that spot. Forwarding by coordinate replaces that silent
 * mis-click with the correct one. Finding that element (`elementBehindLens`) has to look past the
 * WHOLE magnifier layer, not just this viewport — see there for why.
 *
 * RIGHT CLICK is the one exception, and it is unconditional: left click, wheel and hover go to the
 * PAGE the lens is showing, right click goes to the LENS (`onContextMenu`, wired regardless of pin
 * state) — it is the only door left into a pinned lens's own menu, which is where Fixar/Desfixar
 * and Remover live.
 */
import React, { useEffect, useRef } from 'react'
import { Pin, PinOff, Move, X, Plus, Minus, Sliders, Globe } from 'lucide-react'
import type { MagnifierLens } from '@agentistics/core'
import { stageTransform, lensControls, lensPointToPage, lensInteractive, fmtZoom, ZOOM_STEP, MAGNIFIER_LAYER_ID } from '../../lib/magnifier'
import type { SelectionSource } from '../../lib/magnifier'
import { createMirrorHost, type MirrorScheduler } from '../../lib/magnifierMirror'
import type { A11yText } from './i18n'

const ORANGE = 'var(--anthropic-orange)'

/** The zoom readout's `minWidth`, in the same unit `lensControls` measures against. */
const ZOOM_LABEL_PX = 30

/** True when `el` is a REAL scrolling container (an overflow of `auto`/`scroll` that actually
 *  overflows) — the same test `magnifierMirror.ts`'s `scrolls()` applies, `hidden` excluded on
 *  purpose because it clips but can never be scrolled by a wheel event. */
function isScrollable(el: Element): boolean {
  const style = getComputedStyle(el)
  const y = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
  const x = (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth
  return y || x
}

/** The nearest scrolling ancestor of `el` (inclusive), or `null` — read by the caller as "scroll
 *  the window instead", which is what a wheel event over ordinary in-flow content does natively. */
function findScrollableAncestor(el: Element | null): Element | null {
  let node: Element | null = el
  while (node && node !== document.documentElement) {
    if (isScrollable(node)) return node
    node = node.parentElement
  }
  return null
}

/**
 * A real click at `(x, y)` on `target`, so React's delegated handlers fire — `target.click()`
 * carries no coordinates and skips the pointerdown/mousedown pair some controls key their press
 * state or focus behaviour off. This mirrors the sequence a genuine mouse click actually produces:
 * pointerdown, mousedown, pointerup, mouseup, click, each bubbling with the mapped page point as
 * its coordinates.
 */
function dispatchClickAt(target: Element, x: number, y: number): void {
  const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }
  target.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
  target.dispatchEvent(new MouseEvent('mousedown', base))
  target.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
  target.dispatchEvent(new MouseEvent('mouseup', base))
  target.dispatchEvent(new MouseEvent('click', base))
}

interface Props {
  lens: MagnifierLens
  /** 1-based position among this page's lenses — what a listener hears, never the internal id. */
  index: number
  selected: boolean
  /** How the current selection was made — a PINNED lens is revealed for the keyboard and never
   *  for the pointer. See `lensInteractive`. */
  selectedVia: SelectionSource
  /** True while `lens` lives in `globalLenses` — it follows the user across every page. */
  global: boolean
  text: A11yText
  isMobile: boolean
  scheduler: MirrorScheduler
  onChange(patch: Partial<MagnifierLens>): void
  onSelect(): void
  onRemove(): void
  onContextMenu(e: React.MouseEvent): void
  /** Opens the SAME menu `onContextMenu` opens — the visible `config` control's whole job. */
  onOpenMenu(e: React.MouseEvent): void
}

export function Lens({
  lens, index, selected, selectedVia, global, text, isMobile, scheduler, onChange, onSelect, onRemove, onContextMenu, onOpenMenu,
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  // The magnified area's own frame — see `elementBehindLens` below for why forwarding needs it.
  const frameRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ mode: 'move' | 'resize'; px: number; py: number; from: MagnifierLens } | null>(null)
  // The scheduler asks "is this on screen?" every frame; reading the live lens through a ref
  // avoids re-registering the mirror on every pointermove.
  const lensRef = useRef(lens)
  lensRef.current = lens

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const host = createMirrorHost(stage)
    const onScreen = () => {
      const l = lensRef.current
      return l.x < window.innerWidth && l.y < window.innerHeight && l.x + l.width > 0 && l.y + l.height > 0
    }
    scheduler.register(lens.id, host, onScreen)
    host.syncNow()
    return () => {
      scheduler.unregister(lens.id)
      host.destroy()
    }
  }, [lens.id, scheduler])

  const t = stageTransform(lens, { width: window.innerWidth, height: window.innerHeight })
  const interactive = lensInteractive(lens, selected, selectedVia)
  const control = isMobile ? 44 : 26
  // The header strip is `overflow: hidden` inside the frame, so on a small lens the rightmost
  // controls (pin, remove) would otherwise be clipped away — invisible and unreachable, not
  // merely cramped. `lensControls` decides what fits, most-important-first; we only decide the
  // left-to-right order below.
  const innerWidth = lens.width - 2 * lens.borderWidth
  const shown = new Set(lensControls(innerWidth, control, ZOOM_LABEL_PX))

  const startDrag = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!interactive) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { mode, px: e.clientX, py: e.clientY, from: lens }
    onSelect()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    // Self-heal a dropped pointer stream: if the browser loses both `pointerup` and
    // `pointercancel` for a captured pointer — an OS focus steal (alt-tab, a system dialog) while
    // the button is physically down — `drag.current` would otherwise stay set forever, and the
    // next `pointermove` over the frame would resume dragging with no button held, teleporting
    // the lens to wherever the cursor happens to be. `e.buttons === 0` is true for a released
    // mouse button; a touch contact reports a non-zero `buttons` while it is down, so this never
    // fires mid-drag on touch — only once the drag should already have ended.
    if (e.buttons === 0) { endDrag(); return }
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    if (d.mode === 'move') onChange({ x: d.from.x + dx, y: d.from.y + dy })
    else if (d.from.shape === 'circle') onChange({ width: d.from.width + dx, height: d.from.width + dx })
    else onChange({ width: d.from.width + dx, height: d.from.height + dy })
  }

  const endDrag = () => { drag.current = null }

  /**
   * `document.elementFromPoint` returns the TOPMOST element at that point — which, without help,
   * is some part of the magnifier layer itself, since it paints over the page it magnifies. Hiding
   * only THIS lens's own viewport (`frameRef`) is not enough: the layer's WRAPPER (the `fixed`
   * element `frameRef` sits inside) is `pointerEvents: 'auto'` too, and so is every other lens's
   * wrapper — with lenses stacked, hiding just the top one hands the click to the one beneath it
   * instead of the page. So this hides hit-testing on every element child of the layer container
   * (`#ag-magnifiers`: the lens wrappers, the follow lens, the live region) for the duration of the
   * lookup, then restores each one EXACTLY as it was — an element with no inline `pointerEvents`
   * goes back to `''`, never to `'none'`. The restore runs in a `finally` so a throw mid-lookup
   * cannot leave the whole layer permanently click-through, silently and totally. Delete this and
   * every forwarded interaction hits the magnifier layer instead of the magnified element —
   * including a lens re-entering itself or one lens shadowing another.
   */
  const elementBehindLens = (viewportX: number, viewportY: number): Element | null => {
    const container = document.getElementById(MAGNIFIER_LAYER_ID)
    const restore: Array<{ el: HTMLElement; prev: string }> = []
    try {
      if (container) {
        for (const child of Array.from(container.children)) {
          const el = child as HTMLElement
          restore.push({ el, prev: el.style.pointerEvents })
          el.style.pointerEvents = 'none'
        }
      }
      return document.elementFromPoint(viewportX, viewportY)
    } finally {
      for (const { el, prev } of restore) el.style.pointerEvents = prev
    }
  }

  const forwardPoint = (clientX: number, clientY: number) =>
    lensPointToPage(lens, { width: window.innerWidth, height: window.innerHeight }, clientX - lens.x, clientY - lens.y)

  // The magnified area becomes interactive — deliberately independent of `interactive` above,
  // which gates DRAGGING and CONFIGURING (the strip/handle, only rendered when unpinned or
  // revealed). Forwarding must keep working on a pinned, non-revealed lens too: that is the whole
  // fix for the pass-through bug (see this file's header comment).
  const onMagnifiedClick = (e: React.MouseEvent) => {
    if (drag.current) return
    const p = forwardPoint(e.clientX, e.clientY)
    const target = elementBehindLens(p.x, p.y)
    if (target) dispatchClickAt(target, p.x, p.y)
  }

  const onMagnifiedWheel = (e: React.WheelEvent) => {
    const p = forwardPoint(e.clientX, e.clientY)
    const target = elementBehindLens(p.x, p.y)
    // Without this, the wheel event ALSO reaches the real page underneath (the lens frame does not
    // stop native wheel propagation to whatever is physically beneath the cursor), scrolling twice
    // — once forwarded here, once natively — in what would usually be the same direction but by a
    // different amount, which reads as janky double-scrolling.
    e.preventDefault()
    const scrollable = findScrollableAncestor(target)
    if (scrollable) scrollable.scrollBy({ top: e.deltaY, left: e.deltaX })
    else window.scrollBy({ top: e.deltaY, left: e.deltaX })
  }

  const onMagnifiedMove = (e: React.MouseEvent) => {
    if (drag.current) return
    const p = forwardPoint(e.clientX, e.clientY)
    const target = elementBehindLens(p.x, p.y)
    // Cheap on purpose: one hidden-frame lookup, one synthetic event, no state and no rAF
    // batching. This lights up a JS-driven hover state (an `onMouseMove`/`onMouseEnter` listener
    // reacting to the dispatched event exactly as it would to a native one) but CANNOT force a
    // CSS-only `:hover` — the browser's own hit-test for that pseudo-class still finds the lens
    // frame (aria-hidden, unstyled) sitting physically under the cursor, not the target underneath
    // it. Stated here rather than silently half-working.
    target?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x, clientY: p.y }))
  }

  const btn: React.CSSProperties = {
    width: control, height: control, display: 'flex', alignItems: 'center',
    justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent',
    color: '#fff', cursor: 'pointer', padding: 0,
  }

  return (
    <div
      role="group"
      aria-label={text.lensLabel(index, global)}
      // Left click, wheel and hover go to the PAGE the lens is showing. Right click goes to the
      // LENS. So this is wired unconditionally, pinned or not: a pinned lens has no strip/handle
      // to right-click on, and it is exactly there that the menu — the only way to unpin or
      // remove it — has to be reachable.
      onContextMenu={onContextMenu}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: 'fixed',
        left: lens.x,
        top: lens.y,
        width: lens.width,
        height: lens.height,
        // ALWAYS 'auto', pinned or not: the magnified area must keep forwarding interaction even
        // when pinning has removed every control. Only the strip/handle below (rendered solely
        // when `interactive`) can ever move or resize the lens.
        pointerEvents: 'auto',
        zIndex: 2147483000,
        boxSizing: 'border-box',
      }}
    >
      {/* The viewport: the ONLY element that clips. Its border/shape/shadow are the lens's whole
          visible identity, and everything about defect 1 was this element clipping siblings it
          did not yet have separated from it. It is also the magnified area's own hit target:
          click/wheel/mousemove here are forwarded by coordinate, in every pin state. */}
      <div
        ref={frameRef}
        onClick={onMagnifiedClick}
        onWheel={onMagnifiedWheel}
        onMouseMove={onMagnifiedMove}
        style={{
          position: 'absolute',
          inset: 0,
          // The colour is the product's, in every state. Only the thickness is the user's.
          border: `${lens.borderWidth}px solid ${ORANGE}`,
          borderRadius: lens.shape === 'circle' ? '50%' : lens.cornerRadius,
          overflow: 'hidden',
          background: 'var(--bg-base)',
          boxShadow: selected ? `0 0 0 3px ${ORANGE}55` : '0 6px 24px rgba(0,0,0,0.35)',
          boxSizing: 'border-box',
          cursor: 'pointer',
        }}
      >
        <div
          ref={stageRef}
          aria-hidden="true"
          style={{
            width: '100vw',
            height: '100vh',
            transformOrigin: '0 0',
            transform: `scale(${t.scale}) translate(${t.tx}px, ${t.ty}px)`,
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* The global marker — a sibling of the viewport, exactly like the control strip and the
          resize handle above, for the same reason: the viewport is the only element that clips,
          so anything meant to stay visible regardless of shape (and regardless of pin state —
          this renders whether or not `interactive` does) cannot live inside it. Subtle on
          purpose: this states a fact about the lens, it is not a warning. `pointerEvents: 'none'`
          and `aria-hidden` because the SAME fact is already in the group's own `aria-label`
          (`text.lensLabel(index, global)`) — a screen reader would otherwise hear it twice. */}
      {global && (
        <div aria-hidden="true" style={{
          position: 'absolute', top: -6, left: -6, width: isMobile ? 18 : 14, height: isMobile ? 18 : 14,
          borderRadius: '50%', background: ORANGE, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 1px 4px rgba(0,0,0,0.4)', pointerEvents: 'none',
        }}>
          <Globe size={isMobile ? 12 : 9} />
        </div>
      )}

      {interactive && (
        <>
          <div
            onPointerDown={startDrag('move')}
            style={{
              position: 'absolute',
              // A rectangle keeps the strip exactly where the old clipped layout put it — inset
              // by the border on all three sides, pixel-for-pixel unchanged. A circle's bounding
              // box has empty corners the disc never reaches, so the same inset strip would sit
              // mostly outside the circle and get clipped to a sliver by the viewport above —
              // that was defect 1. The wrapper here is never clipped, so for a circle the strip
              // is lifted clear ABOVE the frame's top edge instead: fully visible, fully
              // clickable, and covering none of the magnified content (rather than overlapping
              // the disc's own top arc, which would cost more of the image than moving the strip
              // costs of screen space).
              top: lens.shape === 'circle' ? -(control + 4) : lens.borderWidth,
              left: lens.borderWidth, right: lens.borderWidth, height: control,
              display: 'flex', alignItems: 'center', gap: 2, padding: '0 4px',
              background: 'rgba(0,0,0,0.55)', cursor: 'move', touchAction: 'none',
              borderRadius: lens.shape === 'circle' ? 6 : undefined,
            }}
          >
            <Move size={14} color="#fff" />
            <span style={{ flex: 1 }} />
            {shown.has('config') && (
              <button style={btn} aria-label={text.config}
                onPointerDown={e => e.stopPropagation()}
                onClick={onOpenMenu}><Sliders size={14} /></button>
            )}
            {shown.has('zoomOut') && (
              <button style={btn} aria-label={text.zoomOut}
                onPointerDown={e => e.stopPropagation()}
                onClick={() => onChange({ zoom: lens.zoom - ZOOM_STEP })}><Minus size={14} /></button>
            )}
            {shown.has('zoomLabel') && (
              <span style={{ color: '#fff', fontSize: 11, fontWeight: 700, minWidth: ZOOM_LABEL_PX, textAlign: 'center' }}>
                {fmtZoom(lens.zoom)}×
              </span>
            )}
            {shown.has('zoomIn') && (
              <button style={btn} aria-label={text.zoomIn}
                onPointerDown={e => e.stopPropagation()}
                onClick={() => onChange({ zoom: lens.zoom + ZOOM_STEP })}><Plus size={14} /></button>
            )}
            {shown.has('pin') && (
              <button style={btn} aria-label={lens.pinned ? text.unpin : text.pin}
                onPointerDown={e => e.stopPropagation()}
                onClick={() => onChange({ pinned: !lens.pinned })}>
                {lens.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
            )}
            {shown.has('remove') && (
              <button style={btn} aria-label={text.remove}
                onPointerDown={e => e.stopPropagation()}
                onClick={onRemove}><X size={14} /></button>
            )}
          </div>

          <div
            onPointerDown={startDrag('resize')}
            aria-hidden="true"
            style={{
              // Same reasoning as the strip: the bottom-right corner of a circle's bounding box
              // is outside the disc, so a handle drawn INSIDE the clipped viewport was clipped
              // there too. As a sibling of the viewport it stays visible for every shape; the
              // `borderWidth` inset keeps a rectangle's handle exactly where it always was.
              position: 'absolute', right: lens.borderWidth, bottom: lens.borderWidth,
              width: control, height: control,
              background: `linear-gradient(135deg, transparent 50%, ${ORANGE} 50%)`,
              cursor: 'nwse-resize', touchAction: 'none',
            }}
          />
        </>
      )}
    </div>
  )
}
