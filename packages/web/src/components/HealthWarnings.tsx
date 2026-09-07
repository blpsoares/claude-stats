import React, { useState, useEffect, useRef } from 'react'
import { AlertTriangle, AlertCircle, Info, X, ChevronDown, ChevronUp, CheckCircle } from 'lucide-react'
import type { HealthIssue } from '@agentistics/core'
import { createSharedPref } from '../lib/sharedPref'

// SHARED: dismissing a warning is a statement about the machine, which is the same machine from
// every device. It was per browser, so a warning waved away at the desk was still shouting on the
// phone. See `sharedPref.ts` for the first-paint and arming rules.
const dismissedStore = createSharedPref<string[]>({
  key: 'claude-stats-dismissed-health',
  prefKey: 'dismissedHealth',
  fallback: [],
  parse: raw => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null),
})

function getDismissed(): Set<string> {
  return new Set(dismissedStore.get())
}

function saveDismissed(ids: Set<string>) {
  dismissedStore.set(Array.from(ids))
}

type Severity = HealthIssue['severity']

const SEV: Record<Severity, { color: string; bg: string; border: string; Icon: React.ElementType; label: string }> = {
  error: {
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.08)',
    border: 'rgba(239,68,68,0.25)',
    Icon: AlertCircle,
    label: 'Error',
  },
  warning: {
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.25)',
    Icon: AlertTriangle,
    label: 'Warning',
  },
  info: {
    color: '#6366f1',
    bg: 'rgba(99,102,241,0.08)',
    border: 'rgba(99,102,241,0.25)',
    Icon: Info,
    label: 'Info',
  },
}

export function HealthWarnings({ issues, lang }: { issues: HealthIssue[]; lang: 'pt' | 'en' }) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => getDismissed())
  const [open, setOpen] = useState(false)
  const [expandedGuides, setExpandedGuides] = useState<Set<string>>(new Set())
  const wrapperRef = useRef<HTMLDivElement>(null)
  const pt = lang === 'pt'

  const activeIssues = issues.filter(i => !dismissed.has(i.id))
  const hasError = activeIssues.some(i => i.severity === 'error')
  const hasWarning = activeIssues.some(i => i.severity === 'warning')
  const dotColor = hasError ? '#ef4444' : hasWarning ? '#f59e0b' : '#6366f1'

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function dismiss(id: string) {
    const next = new Set(dismissed)
    next.add(id)
    setDismissed(next)
    saveDismissed(next)
  }

  function toggleGuide(id: string) {
    setExpandedGuides(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (activeIssues.length === 0) return null

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <style>{`
        @keyframes cs-health-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.4); }
        }
      `}</style>

      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        title={`${activeIssues.length} ${pt ? 'problema(s) de compatibilidade' : 'compatibility issue(s)'}`}
        style={{
          position: 'relative',
          width: 32, height: 32,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 8,
          border: `1px solid ${dotColor}60`,
          background: dotColor + '18',
          color: dotColor,
          cursor: 'pointer',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => {
          ;(e.currentTarget as HTMLButtonElement).style.background = dotColor + '30'
        }}
        onMouseLeave={e => {
          ;(e.currentTarget as HTMLButtonElement).style.background = dotColor + '18'
        }}
      >
        <AlertTriangle size={14} />
        {/* Pulsing dot */}
        <span style={{
          position: 'absolute',
          top: 5, right: 5,
          width: 6, height: 6,
          borderRadius: '50%',
          background: dotColor,
          border: '1.5px solid var(--bg-card)',
          animation: 'cs-health-pulse 2s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 8px)',
          right: 0,
          width: 380,
          maxHeight: 520,
          overflowY: 'auto',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-elevated)',
          zIndex: 400,
        }}>
          {/* Header */}
          <div style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.06em' }}>
              {pt ? 'AVISOS DE COMPATIBILIDADE' : 'COMPATIBILITY WARNINGS'} ({activeIssues.length})
            </span>
            <button
              onClick={() => setOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 2, display: 'flex', lineHeight: 1 }}
            >
              <X size={12} />
            </button>
          </div>

          {/* Issues */}
          {activeIssues.map((issue, idx) => {
            const cfg = SEV[issue.severity]
            const guideOpen = expandedGuides.has(issue.id)
            return (
              <div
                key={issue.id}
                style={{
                  padding: '12px 14px',
                  borderBottom: idx < activeIssues.length - 1 ? '1px solid var(--border)' : 'none',
                  background: cfg.bg,
                }}
              >
                <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  {/* Severity icon */}
                  <cfg.Icon
                    size={13}
                    style={{ color: cfg.color, flexShrink: 0, marginTop: 2 }}
                  />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Title */}
                    <div style={{
                      fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                      marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5,
                    }}>
                      {issue.auto_fixed && (
                        <CheckCircle size={11} style={{ color: '#10b981', flexShrink: 0 }} />
                      )}
                      {issue.title}
                    </div>

                    {/* Description */}
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                      {issue.description}
                    </div>

                    {/* Guide toggle */}
                    {issue.guide && !issue.auto_fixed && (
                      <div style={{ marginTop: 7 }}>
                        <button
                          onClick={() => toggleGuide(issue.id)}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            fontSize: 11, color: cfg.color, padding: 0,
                            display: 'flex', alignItems: 'center', gap: 3, fontFamily: 'inherit',
                          }}
                        >
                          {guideOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                          {guideOpen
                            ? (pt ? 'Ocultar guia' : 'Hide guide')
                            : (pt ? 'Como resolver' : 'How to fix')}
                        </button>
                        {guideOpen && (
                          <div style={{
                            marginTop: 6,
                            padding: '8px 10px',
                            background: 'var(--bg-secondary)',
                            border: `1px solid ${cfg.border}`,
                            borderRadius: 6,
                            fontSize: 11, color: 'var(--text-secondary)',
                            lineHeight: 1.65,
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'monospace',
                          }}>
                            {issue.guide}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Dismiss button (not for auto-fixed) */}
                  {!issue.auto_fixed && (
                    <button
                      onClick={() => dismiss(issue.id)}
                      title={pt ? 'Dispensar' : 'Dismiss'}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-tertiary)', padding: 2, display: 'flex',
                        flexShrink: 0, lineHeight: 1,
                      }}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
