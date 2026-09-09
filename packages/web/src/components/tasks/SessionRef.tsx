/**
 * SessionRef — how a session is NAMED wherever a board surface points at one.
 *
 * It used to be the id, cut to eight characters: `612ff065`. That is not a reference, it is a
 * receipt — nobody recognises their own work in it, and the one thing it is good for (pasting into
 * `agentop session attach`) is not what a person reading a subtask wants.
 *
 * So: the harness's own mark, the session's TITLE, and the whole thing is a control that opens it.
 * The id survives as the `title` attribute, because it is still the handle every CLI verb takes.
 */

import { ExternalLink, X } from 'lucide-react'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'

export interface SessionRefProps {
  id: string
  /** What the session calls itself. Absent falls back to the handle — never to nothing. */
  title?: string
  harness?: string
  /** Open the session. Absent renders a label rather than a control that goes nowhere. */
  onOpen?: (id: string) => void
  /** Unfile it from here. Absent = this surface does not offer that. */
  onUnfile?: (id: string) => void
  lang?: 'pt' | 'en'
}

export function SessionRef({ id, title, harness, onOpen, onUnfile, lang = 'en' }: SessionRefProps) {
  const colour = harness ? (HARNESS_COLORS as Record<string, string>)[harness] : undefined
  const label = title?.trim() || id.slice(0, 8)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%' }}>
      <span
        {...(onOpen
          ? {
            role: 'button',
            tabIndex: 0,
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); onOpen(id) },
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpen(id) }
            },
          }
          : {})}
        title={`${label}\n${id}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0,
          padding: '2px 8px', borderRadius: 999, maxWidth: 260,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-secondary)', fontSize: 11.5,
          cursor: onOpen ? 'pointer' : undefined,
        }}
      >
        {/* The harness, as a mark AND a word on hover — a colour alone names nothing. */}
        {harness && (
          <span
            aria-hidden
            title={(HARNESS_LABELS as Record<string, string>)[harness] ?? harness}
            style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: colour ?? 'var(--text-tertiary)' }}
          />
        )}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {onOpen && <ExternalLink size={10} style={{ flexShrink: 0, opacity: 0.6 }} />}
      </span>
      {onUnfile && (
        <button
          onClick={e => { e.stopPropagation(); onUnfile(id) }}
          title={lang === 'pt' ? 'Desfiliar desta subtarefa' : 'Unfile from this subtask'}
          className="ag-tap-icon"
          style={{
            background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18,
          }}
        ><X size={11} /></button>
      )}
    </span>
  )
}
