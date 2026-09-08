import React from 'react'
import { Maximize2 } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  title: React.ReactNode
  children: React.ReactNode
  action?: React.ReactNode
  onExpand?: () => void
  flashId?: string
  style?: React.CSSProperties
}

export function Section({ title, children, action, onExpand, flashId, style: extraStyle }: Props) {
  const isMobile = useIsMobile()
  return (
    <div
      data-flash-id={flashId}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: isMobile ? '14px 14px' : '20px 22px',
        boxSizing: 'border-box',
        // Column flex so a card given an explicit height (e.g. two cards stretched to the same row
        // height) hands the leftover space to its CONTENT instead of leaving a dead band under it.
        display: 'flex',
        flexDirection: 'column',
        ...extraStyle,
      }}
    >
      {/* `flexWrap` and not a mobile branch: what decides this is whether the ACTION fits beside the
          title, which is a question about the two contents and the column they are in — a 390px
          phone with a bare title has room, and a laptop showing a filter row plus a search field
          does not. Without it the two were squeezed against each other and the title broke into
          two lines while the action's own controls wrapped beside it (the Repositories header:
          "20 / repositories" stacked next to a search box). `minWidth: 0` on each side is what
          lets either one give way; `flex: 1` on the action keeps it right-aligned on one line and
          full-width once it has wrapped under. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        columnGap: 12,
        rowGap: 10,
        marginBottom: 18,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flex: '1 1 auto', minWidth: 0 }}>
          {action}
          {onExpand && (
            <button
              onClick={onExpand}
              title="Expandir"
              style={{
                width: 24, height: 24,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                transition: 'all 0.15s',
                padding: 0,
              }}
              onMouseEnter={e => {
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'
                ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-tertiary)'
              }}
              onMouseLeave={e => {
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)'
                ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'
              }}
            >
              <Maximize2 size={12} />
            </button>
          )}
        </div>
      </div>
      {/* minHeight:0 so a scrollable/looser child can shrink inside the flex column rather than
          overflowing it. */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{children}</div>
    </div>
  )
}
