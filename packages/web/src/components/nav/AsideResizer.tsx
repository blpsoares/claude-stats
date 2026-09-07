/**
 * AsideResizer — the drag handle on the sidebar's right edge.
 *
 * A 5px hit area over a 1px line: the line is what you should see, and 1px is not something a
 * pointer can reliably land on. The cursor changes on hover, which is the only affordance a resize
 * edge gets and therefore has to be right.
 *
 * It is also operable from the KEYBOARD. `separator` with arrow keys is what the role is for, and a
 * control that can only be dragged is a control some people cannot use at all. Home and End jump to
 * the bounds, which is faster than holding an arrow across 300px.
 *
 * The clamp is not here — it is in `asideWidth.ts`, so there is one answer to how wide the sidebar
 * may be and it is testable without a pointer.
 */

import { useCallback, useEffect, useRef } from 'react'
import { ASIDE_MAX, ASIDE_MIN, clampAsideWidth } from '../../lib/asideWidth'

export interface AsideResizerProps {
  width: number
  onResize: (width: number) => void
  /** Fired when a drag ends, so the caller persists once rather than on every pointer move. */
  onCommit?: (width: number) => void
  lang: 'pt' | 'en'
}

const STEP = 16

export function AsideResizer({ width, onResize, onCommit, lang }: AsideResizerProps) {
  const dragging = useRef(false)
  const latest = useRef(width)
  latest.current = width

  const set = useCallback((next: number) => {
    const clamped = clampAsideWidth(next, window.innerWidth)
    latest.current = clamped
    onResize(clamped)
  }, [onResize])

  // Bound to the WINDOW, not to the handle: the pointer routinely outruns a 5px strip during a
  // drag, and a listener on the element itself would drop the gesture the moment it did.
  useEffect(() => {
    const move = (e: MouseEvent) => { if (dragging.current) set(e.clientX) }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onCommit?.(latest.current)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [set, onCommit])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={lang === 'pt' ? 'Redimensionar barra lateral' : 'Resize sidebar'}
      aria-valuenow={width}
      aria-valuemin={ASIDE_MIN}
      aria-valuemax={ASIDE_MAX}
      tabIndex={0}
      onMouseDown={e => {
        e.preventDefault()
        dragging.current = true
        // On the BODY for the duration: without it the cursor reverts and the text under the
        // pointer selects the moment the drag leaves the handle.
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onDoubleClick={() => { set(300); onCommit?.(300) }}
      onKeyDown={e => {
        const delta = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0
        if (delta !== 0) { e.preventDefault(); set(width + delta); onCommit?.(clampAsideWidth(width + delta, window.innerWidth)); return }
        if (e.key === 'Home') { e.preventDefault(); set(ASIDE_MIN); onCommit?.(ASIDE_MIN) }
        if (e.key === 'End') { e.preventDefault(); set(ASIDE_MAX); onCommit?.(clampAsideWidth(ASIDE_MAX, window.innerWidth)) }
      }}
      style={{
        position: 'absolute', top: 0, right: -3, bottom: 0, width: 6,
        cursor: 'col-resize', zIndex: 5,
        // The visible line is the aside's own border; this strip is the hit area and stays
        // transparent until it is being pointed at.
        background: 'transparent',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--anthropic-orange-dim)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      onFocus={e => { e.currentTarget.style.background = 'var(--anthropic-orange-dim)' }}
      onBlur={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {/* The GRIP. A resize edge whose only affordance is a cursor change is one nobody discovers:
          you have to already suspect it is draggable to put the pointer there and find out. So the
          edge says so — a small rounded bar at the vertical middle, dim until pointed at. */}
      <span
        aria-hidden
        style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 4, height: 34, borderRadius: 2,
          background: 'var(--border)', pointerEvents: 'none',
          transition: 'background 0.15s',
        }}
        className="ag-aside-grip"
      />
    </div>
  )
}
