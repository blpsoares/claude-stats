/**
 * RailSection — one foldable block of the task's right rail.
 *
 * The rail had grown to seven stacked cards, all open, all the time: plan, delivery stats, tokens,
 * status, links, blockers, actions. Every one of them earns its place SOMETIMES and almost none of
 * them earns it at once, so the page became a scroll whose bottom half you learn to skip — and the
 * things people actually reach for (the status, the claim) sat below the fold.
 *
 * So each block folds, and a SHUT one keeps its NAME and its COUNT — the rule the terminal
 * cockpit's menu already follows: a section closed to a bare heading still says what is inside it,
 * while one cut to two rows says no more than its heading did and costs the space anyway. The count
 * goes away once the section is OPEN, where the content states it better and the badge would be the
 * same figure twice on two adjacent lines.
 *
 * The open set is remembered per browser (`boardPrefs`), so a rail arranged once stays arranged —
 * the same reason the board's columns and folds are remembered.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { microLabel, numeric, surface } from './board'
import { railOpen, setRailOpen } from './boardPrefs'

export function RailSection({ id, title, badge, defaultOpen = false, children }: {
  /** Stable key for the remembered open state. */
  id: string
  title: string
  /** Shown while the section is SHUT, so a fold never hides a count. */
  badge?: string | number
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(() => railOpen(id, defaultOpen))
  return (
    <div style={{ ...surface, overflow: 'hidden' }}>
      <button
        onClick={() => { setOpen(v => !v); setRailOpen(id, !open) }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: isMobile ? '12px 14px' : '10px 14px',
          minHeight: isMobile ? 44 : undefined,
        }}
      >
        {open
          ? <ChevronDown size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          : <ChevronRight size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
        <span style={{ ...microLabel, flex: 1 }}>{title}</span>
        {!open && badge !== undefined && badge !== '' && (
          <span style={{ ...numeric, fontSize: 11.5, color: 'var(--text-tertiary)' }}>{badge}</span>
        )}
      </button>
      {open && <div style={{ padding: '0 14px 14px', display: 'grid', gap: 10 }}>{children}</div>}
    </div>
  )
}
