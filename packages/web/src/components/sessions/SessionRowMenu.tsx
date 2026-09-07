/**
 * SessionRowMenu — the right-click menu on a session row.
 *
 * A portal, so it escapes the aside's `overflow` clipping, positioned at the pointer and flipped
 * when it would leave the viewport. It closes on an outside `mousedown` (on the press, not on a
 * release that may land somewhere else), on `Escape`, and after any entry is taken; focus returns
 * to the row.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { MenuEntry } from '../../lib/rowMenu'
import { useIsMobile } from '../../hooks/useIsMobile'

export interface SessionRowMenuProps {
  x: number
  y: number
  entries: MenuEntry[]
  onPick: (action: string) => void
  onClose: () => void
}

export function SessionRowMenu({ x, y, entries, onPick, onClose }: SessionRowMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  // 44px of finger on a phone, and nowhere else. This menu is reached by a LONG PRESS on touch,
  // so every one of its entries is a touch target by construction.
  const isMobile = useIsMobile()

  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  // Flipped rather than clamped: a menu pinned to the viewport edge covers the row it belongs to.
  const w = 210
  const rowH = isMobile ? 44 : 34
  const left = x + w > window.innerWidth ? Math.max(4, x - w) : x
  const top = y + entries.length * rowH + 12 > window.innerHeight
    ? Math.max(4, y - (entries.length * rowH + 12))
    : y

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed', top, left, width: w, zIndex: 600,
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
        padding: 4, boxShadow: 'var(--ag-shadow-pop)',
      }}
    >
      {entries.map(e => (
        <button
          key={e.action}
          role="menuitem"
          disabled={!e.enabled}
          // The reason is on the entry itself, so a disabled row explains itself on hover instead
          // of leaving the reader to guess.
          title={e.reason}
          onClick={() => { if (e.enabled) { onPick(e.action); onClose() } }}
          style={{
            display: 'flex', alignItems: 'center', width: '100%', gap: 8,
            minHeight: isMobile ? 44 : 0,
            padding: '8px 10px', borderRadius: 7, border: 'none', textAlign: 'left',
            background: 'transparent', fontFamily: 'inherit', fontSize: 12.5,
            color: e.enabled ? 'var(--text-primary)' : 'var(--text-tertiary)',
            cursor: e.enabled ? 'pointer' : 'default',
          }}
          onMouseEnter={ev => { if (e.enabled) ev.currentTarget.style.background = 'var(--bg-elevated)' }}
          onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
        >
          {e.label}
        </button>
      ))}
      {/* A row with a refused verb says why here too, not only on hover: a tooltip is a fact only
          a mouse can reach. */}
      {entries.some(e => !e.enabled && e.reason) && (
        <p style={{
          margin: '4px 6px 2px', fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)',
        }}>
          {entries.find(e => !e.enabled && e.reason)!.reason}
        </p>
      )}
    </div>,
    document.body,
  )
}
