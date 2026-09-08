/**
 * formBits — the small pieces every session dialog is built from.
 *
 * They were local to `NewSessionModal`, which made the SECOND dialog either import from a modal or
 * restate them. Restating them is how two screens of one product start looking like two products:
 * the picker shipped with its own hand-rolled field and its own idea of a label, and read as
 * foreign next to the wizard one click away.
 */
import React from 'react'

/** A search/text field. The left padding is the magnifier's; see the callers. */
export const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '9px 12px 9px 30px', borderRadius: 9,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, outline: 'none',
}

export function Field({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <span style={{
        fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
        color: 'var(--text-tertiary)',
      }}>
        {label}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{hint}</span>
      )}
    </div>
  )
}

export function Muted({ text }: { text: string }) {
  return <p style={{ margin: 0, padding: '6px 4px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{text}</p>
}

/**
 * The segmented tab strip both dialogs file their list with.
 *
 * The COUNT is dimmed and never coloured — it is a size, not a state — and it is what makes an
 * empty tab read as "nothing of this kind matched" rather than as a broken filter.
 */
export function TabStrip<T extends string>({ tabs, value, onPick, label, count }: {
  tabs: readonly T[]
  value: T
  onPick: (t: T) => void
  label: (t: T) => string
  count: (t: T) => number
}) {
  return (
    <div role="tablist" style={{
      display: 'flex', gap: 3, marginBottom: 8, padding: 3, borderRadius: 9,
      background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
    }}>
      {tabs.map(id => {
        const on = value === id
        return (
          <button
            key={id}
            role="tab"
            aria-selected={on}
            onClick={() => onPick(id)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 5, minHeight: 30, borderRadius: 7, border: 'none', cursor: 'pointer',
              background: on ? 'var(--bg-surface)' : 'transparent',
              color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              fontFamily: 'inherit', fontSize: 11.5, fontWeight: on ? 650 : 500,
              minWidth: 0,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label(id)}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>{count(id)}</span>
          </button>
        )
      })}
    </div>
  )
}
