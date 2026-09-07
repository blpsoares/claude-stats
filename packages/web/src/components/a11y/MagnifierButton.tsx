/**
 * MagnifierButton.tsx — the header icon.
 *
 * Desktop: left click makes a lens; right click opens the general menu, which is the only way a
 * MOUSE can reach a pinned lens again (a pinned lens takes no pointer events at all — that is what
 * pinning means). There is no keyboard way in yet — that is Task 10.
 *
 * Touch: there is no right click. A long-press MIGHT fire `contextmenu` (Android Chrome does;
 * iOS Safari is inconsistent and may show the system callout instead), and nothing on screen
 * advertises that gesture — `title` never surfaces on touch. So on a COARSE pointer a tap opens
 * the menu directly instead of creating a lens; "New lens" is the menu's first item, so nothing is
 * lost, and a pinned lens (which takes no pointer events) stays reachable through the menu's own
 * list. This is decided by `useIsCoarsePointer()` (`(pointer: coarse)`), NOT `useIsMobile()`'s
 * width breakpoint: a touch tablet at 1024px is not "mobile" by width but has no right click
 * either, and would otherwise have NO WAY to reach the general menu at all — the exact hole this
 * behaviour exists to close. `useIsMobile()` still drives sizing on this button (touch targets,
 * icon size) — that stays a width question, and the two must not be conflated.
 */
import React, { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ZoomIn } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile, useIsCoarsePointer } from '../../hooks/useIsMobile'
import { fmtZoom } from '../../lib/magnifier'
import { a11yText } from './i18n'

/** Clearance kept from the viewport edge the dropdown opens towards. */
const EDGE_MARGIN = 12
/** Never let the dropdown shrink to something unusable, even wedged into a tiny gap. */
const MIN_DROPDOWN_HEIGHT = 120

interface DropdownPos {
  /** True when there is less room below the trigger than above it. */
  up: boolean
  maxHeight: number
}

export function MagnifierButton({ ctx }: { ctx: AppContext }) {
  const { a11y, lang } = ctx
  const text = useMemo(() => a11yText(lang), [lang])
  const isMobile = useIsMobile()
  // GESTURE, not sizing — see the module header. A tap opens the menu (never a lens) on a coarse
  // pointer, whatever the window width; `isMobile` below stays reserved for touch-target sizing.
  const isCoarse = useIsCoarsePointer()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // The list grows with the number of lenses on the page, and the trigger is not always near the
  // top: the mobile floating fallback sits at the vertical centre (MagnifierLayer.tsx), which
  // halves the room a downward-opening dropdown used to assume. Decided once, at the moment the
  // menu opens, from the trigger's actual position — never guessed from where the button
  // "usually" is, or a header-anchored placement (which has always opened downward, and must
  // keep doing so while there is room) would flip for no reason.
  const [dropdownPos, setDropdownPos] = useState<DropdownPos | null>(null)

  const toggleOpen = () => {
    setOpen(v => {
      const next = !v
      if (next) {
        const rect = wrapRef.current?.getBoundingClientRect()
        if (rect) {
          const spaceBelow = window.innerHeight - rect.bottom - EDGE_MARGIN
          const spaceAbove = rect.top - EDGE_MARGIN
          const up = spaceBelow < spaceAbove
          setDropdownPos({ up, maxHeight: Math.max(MIN_DROPDOWN_HEIGHT, up ? spaceAbove : spaceBelow) })
        }
      }
      return next
    })
  }

  if (!a11y.prefs.enabled) return null

  const item: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: isMobile ? '12px 10px' : '7px 10px', minHeight: isMobile ? 44 : undefined,
    borderRadius: 8, border: 'none', background: 'transparent',
    color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer',
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => (isCoarse ? toggleOpen() : a11y.addLens())}
        onContextMenu={e => { e.preventDefault(); toggleOpen() }}
        title={isCoarse ? text.headerTitleMobile : `${text.headerTitle} — ${text.headerHint}`}
        aria-label={isCoarse ? text.headerTitleMobile : text.headerTitle}
        aria-haspopup="dialog"
        style={{
          width: isMobile ? 44 : 32, height: isMobile ? 44 : 32,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--anthropic-orange)', cursor: 'pointer', position: 'relative', flexShrink: 0,
        }}
      >
        <ZoomIn size={isMobile ? 18 : 14} />
        {a11y.lenses.length > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, padding: '0 4px',
            borderRadius: 8, background: 'var(--anthropic-orange)', color: '#fff',
            fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{a11y.lenses.length}</span>
        )}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 2147483100 }} />
          <div role="dialog" aria-label={text.headerTitle} style={{
            position: 'absolute', right: 0, width: 290, zIndex: 2147483200,
            // Opens downward by default (unchanged for every header-anchored placement, which
            // always has room below). Flips upward only when `toggleOpen` measured less room
            // below than above — the case the vertically-centred mobile fallback creates — and
            // either way is capped to the room actually available, with its own scrollbar, so a
            // long lens list can never run off the screen.
            ...(dropdownPos?.up
              ? { bottom: '100%', marginBottom: 6 }
              : { top: '100%', marginTop: 6 }),
            maxHeight: dropdownPos?.maxHeight, overflowY: 'auto',
            padding: 8, borderRadius: 12, background: 'var(--bg-elevated)',
            border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
          }}>
            <button style={item} onClick={() => { a11y.addLens(); setOpen(false) }}>{text.newLens}</button>
            <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '2px 10px 6px' }}>{text.lensesHere}</div>
            {a11y.lenses.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '0 10px 8px' }}>{text.noLensesHere}</div>
            )}
            {a11y.lenses.map((l, i) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px' }}>
                {/* Same overflow risk as LensMenu's rows (a flex row with one `flex: 1` child and
                    fixed siblings): a flex item's default `min-width: auto` floors it at its own
                    content width. This label is plain text so it can already wrap at a space
                    before it overflows, but the PT string is longer than the EN one ("Fixar"
                    appended), so `minWidth: 0` removes the floor rather than relying on that. */}
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
                  {/* The lens's own id ("lens-2") is internal and must never reach a person — the
                     same ordinal label MagnifierLayer's announcements and Lens.tsx's aria-label use. */}
                  {text.lensLabel(i + 1)} · {fmtZoom(l.zoom)}×{l.pinned ? ` · ${text.pin}` : ''}
                </span>
                <button style={{ ...item, width: 'auto', padding: '6px 8px', flexShrink: 0 }}
                  onClick={() => { a11y.select(l.id); setOpen(false) }}>{text.select}</button>
                {l.pinned && (
                  <button style={{ ...item, width: 'auto', padding: '6px 8px', flexShrink: 0 }}
                    onClick={() => a11y.updateLens(l.id, { pinned: false })}>{text.unpin}</button>
                )}
              </div>
            ))}
            <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
            <button style={item} onClick={() => { a11y.setAllPinned(false); setOpen(false) }}>{text.unpinAll}</button>
            <button style={item} onClick={() => { a11y.setAllPinned(true); setOpen(false) }}>{text.pinAll}</button>
            <button style={{ ...item, color: 'var(--accent-red)' }}
              onClick={() => { a11y.removePage(a11y.page); setOpen(false) }}>{text.removeAllHere}</button>
            <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
            <button style={item} onClick={() => { a11y.toggleFollow(); setOpen(false) }}>
              {a11y.followOn ? text.followOff : text.followOn}
            </button>
            <button style={item} onClick={() => { navigate('/settings/accessibility'); setOpen(false) }}>
              {text.openSettings}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
