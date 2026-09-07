/**
 * FiltersSheet — the filters, on a phone, out of the way until asked for.
 *
 * The mobile sessions page used to spend a fixed band of a 664px viewport on a filter row that is
 * consulted occasionally and read never. A sheet costs nothing until it is opened, and opened it
 * has the whole screen — which is the only place these controls have ever had enough room.
 *
 * It is the SAME `FiltersBar` in `compact` mode, passed in as children, not a second
 * implementation: the dimensions, the pickers and the chips are one control everywhere, and a
 * phone-only copy would drift.
 *
 * There is deliberately no "Apply". `FiltersBar` writes straight through to the shared filter
 * state, so every change is already live behind the sheet — a button promising to apply what is
 * applied is a button that teaches people the filters do not take until they press it. The footer
 * says `Done`, which is what it does, beside a `Clear` that is absent when there is nothing to
 * clear.
 */

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

export function FiltersSheet({ open, onClose, onClear, lang, children }: {
  open: boolean
  onClose: () => void
  /** Absent when nothing is set — a control that cannot change anything is not offered. */
  onClear?: () => void
  lang: 'pt' | 'en'
  children: React.ReactNode
}) {
  /**
   * Focus goes back where it came from.
   *
   * A sheet that closes leaving focus on `document.body` strands a keyboard or switch user at the
   * top of the page, several tab stops from the control they just used.
   */
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      opener.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  const pt = lang === 'pt'
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={pt ? 'Filtros' : 'Filters'}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, background: 'var(--ag-scrim)',
        display: 'flex', alignItems: 'flex-end',
      }}
    >
      <div style={{
        width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', borderTopLeftRadius: 16, borderTopRightRadius: 16,
        borderTop: '1px solid var(--border)',
        // The sheet reaches the bottom edge of the screen, so it owns the home-indicator band —
        // the same inset `.mobile-bottom-nav` pads itself with.
        paddingBottom: 'var(--mobile-nav-inset)',
        boxSizing: 'border-box',
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', flexShrink: 0,
          borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            {pt ? 'Filtros' : 'Filters'}
          </h2>
          <button
            onClick={onClose}
            aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 44, height: 44, marginRight: -8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 0 16px' }}>
          {children}
        </div>

        <footer style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', flexShrink: 0,
          borderTop: '1px solid var(--border)',
        }}>
          {onClear && (
            <button
              onClick={onClear}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 44, padding: '0 16px', borderRadius: 9,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 14,
                fontWeight: 600, cursor: 'pointer',
              }}
            >
              {pt ? 'Limpar' : 'Clear'}
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              minHeight: 44, borderRadius: 9, border: 'none',
              background: 'var(--anthropic-orange)', color: '#fff',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {pt ? 'Pronto' : 'Done'}
          </button>
        </footer>
      </div>
    </div>
  )
}
