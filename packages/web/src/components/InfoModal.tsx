import React, { useEffect, useCallback } from 'react'
import { X, ChevronLeft, ChevronRight, FolderOpen } from 'lucide-react'

interface InfoItem {
  label: string
  source: string
  formula?: string
  note?: string
}

interface Props {
  items: InfoItem[]
  currentIndex: number
  onClose: () => void
  onNavigate: (index: number) => void
  lang: 'pt' | 'en'
}

export function InfoModal({ items, currentIndex, onClose, onNavigate, lang }: Props) {
  const item = items[currentIndex]
  if (!item) return null
  const total = items.length

  const goLeft = useCallback(() => {
    onNavigate((currentIndex - 1 + total) % total)
  }, [currentIndex, total, onNavigate])

  const goRight = useCallback(() => {
    onNavigate((currentIndex + 1) % total)
  }, [currentIndex, total, onNavigate])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') goLeft()
      else if (e.key === 'ArrowRight') goRight()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, goLeft, goRight])

  const t = {
    source: lang === 'pt' ? 'Fonte dos dados' : 'Data source',
    formula: lang === 'pt' ? 'Fórmula' : 'Formula',
    note: lang === 'pt' ? 'Observação' : 'Note',
    counter: lang === 'pt'
      ? `${currentIndex + 1} de ${total}`
      : `${currentIndex + 1} of ${total}`,
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--bg-elevated, #1a1a1a)',
          border: '1px solid var(--border, var(--ag-tint-4))',
          borderRadius: 14,
          boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
          overflow: 'hidden',
          opacity: 1,
          transition: 'opacity 0.15s ease',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 18px 14px',
          borderBottom: '1px solid var(--border-subtle, var(--ag-tint-3))',
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary, #e8e8e8)',
            letterSpacing: '0.01em',
          }}>
            {item.label}
          </span>

          <button
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-tertiary, #666)',
              padding: 0,
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget
              el.style.background = 'var(--ag-tint-4)'
              el.style.color = 'var(--text-primary, #e8e8e8)'
            }}
            onMouseLeave={e => {
              const el = e.currentTarget
              el.style.background = 'transparent'
              el.style.color = 'var(--text-tertiary, #666)'
            }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Navigation dots */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '12px 18px 0',
        }}>
          {items.map((_, i) => (
            <button
              key={i}
              onClick={() => onNavigate(i)}
              style={{
                width: i === currentIndex ? 18 : 6,
                height: 6,
                borderRadius: 3,
                background: i === currentIndex
                  ? 'var(--anthropic-orange, #e8925a)'
                  : 'var(--ag-tint-5)',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                transition: 'width 0.2s ease, background 0.2s ease',
              }}
              aria-label={`Go to item ${i + 1}`}
            />
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: '16px 18px 14px' }}>
          {/* Source */}
          <div style={{ marginBottom: item.formula || item.note ? 14 : 0 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 6,
            }}>
              <FolderOpen size={13} style={{ color: 'var(--text-tertiary, #666)', flexShrink: 0 }} />
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--text-tertiary, #666)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}>
                {t.source}
              </span>
            </div>
            <p style={{
              margin: 0,
              fontSize: 13,
              color: 'var(--text-secondary, #aaa)',
              lineHeight: 1.5,
              paddingLeft: 19,
            }}>
              {item.source}
            </p>
          </div>

          {/* Formula */}
          {item.formula && (
            <div style={{ marginBottom: item.note ? 14 : 0 }}>
              <div style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--text-tertiary, #666)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 6,
              }}>
                {t.formula}
              </div>
              <code style={{
                display: 'block',
                fontSize: 12,
                color: 'var(--anthropic-orange, #e8925a)',
                background: 'rgba(232, 146, 90, 0.08)',
                border: '1px solid rgba(232, 146, 90, 0.15)',
                borderRadius: 6,
                padding: '8px 10px',
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.6,
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace',
              }}>
                {item.formula}
              </code>
            </div>
          )}

          {/* Note */}
          {item.note && (
            <div style={{
              borderTop: '1px solid var(--border-subtle, var(--ag-tint-3))',
              paddingTop: 12,
              marginTop: item.formula ? 0 : 0,
            }}>
              <div style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--text-tertiary, #666)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 5,
              }}>
                {t.note}
              </div>
              <p style={{
                margin: 0,
                fontSize: 12,
                color: 'var(--text-tertiary, #666)',
                fontStyle: 'italic',
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
              }}>
                {item.note.split(/(anthropic\.com\/pricing#api)/g).map((part, i) =>
                  part === 'anthropic.com/pricing#api'
                    ? <a key={i} href="https://www.anthropic.com/pricing#api" target="_blank" rel="noopener noreferrer"
                        style={{ color: 'var(--anthropic-orange, #e8925a)', textDecoration: 'underline' }}>
                        {part}
                      </a>
                    : part
                )}
              </p>
            </div>
          )}
        </div>

        {/* Footer with navigation */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px 14px',
          borderTop: '1px solid var(--border-subtle, var(--ag-tint-3))',
        }}>
          <button
            onClick={goLeft}
            disabled={total <= 1}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'var(--ag-tint-2)',
              border: '1px solid var(--border, var(--ag-tint-4))',
              cursor: total <= 1 ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: total <= 1 ? 'var(--text-tertiary, #555)' : 'var(--text-secondary, #aaa)',
              padding: 0,
              opacity: total <= 1 ? 0.4 : 1,
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              if (total > 1) {
                e.currentTarget.style.background = 'var(--ag-tint-4)'
                e.currentTarget.style.color = 'var(--text-primary, #e8e8e8)'
              }
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'var(--ag-tint-2)'
              e.currentTarget.style.color = total <= 1 ? 'var(--text-tertiary, #555)' : 'var(--text-secondary, #aaa)'
            }}
          >
            <ChevronLeft size={16} />
          </button>

          <span style={{
            fontSize: 12,
            color: 'var(--text-tertiary, #666)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {t.counter}
          </span>

          <button
            onClick={goRight}
            disabled={total <= 1}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'var(--ag-tint-2)',
              border: '1px solid var(--border, var(--ag-tint-4))',
              cursor: total <= 1 ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: total <= 1 ? 'var(--text-tertiary, #555)' : 'var(--text-secondary, #aaa)',
              padding: 0,
              opacity: total <= 1 ? 0.4 : 1,
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              if (total > 1) {
                e.currentTarget.style.background = 'var(--ag-tint-4)'
                e.currentTarget.style.color = 'var(--text-primary, #e8e8e8)'
              }
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'var(--ag-tint-2)'
              e.currentTarget.style.color = total <= 1 ? 'var(--text-tertiary, #555)' : 'var(--text-secondary, #aaa)'
            }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
