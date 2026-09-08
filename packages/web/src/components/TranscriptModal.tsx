import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_LABELS, HARNESS_COLORS } from '../lib/harness'
import { HarnessChat } from './HarnessChat'
import { useIsMobile } from '../hooks/useIsMobile'
import { OVERLAY_TOP } from '../lib/mobileOverlay'

interface TranscriptTarget {
  harness: HarnessId
  sessionId: string
  project?: { path: string; name: string; encodedDir: string }
}

export function TranscriptModal({ lang }: { lang: 'pt' | 'en' }) {
  const isMobile = useIsMobile()
  const [target, setTarget] = useState<TranscriptTarget | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<TranscriptTarget>).detail
      setTarget(detail)
    }
    window.addEventListener('agentistics:open-transcript', handler)
    return () => window.removeEventListener('agentistics:open-transcript', handler)
  }, [])

  useEffect(() => {
    if (!target) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setTarget(null) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [target])

  if (!target) return null

  const harnessColor = HARNESS_COLORS[target.harness] ?? 'var(--text-secondary)'
  const harnessLabel = HARNESS_LABELS[target.harness]

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 600,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: isMobile ? OVERLAY_TOP : 24,
        animation: 'ttyChatFadeIn 0.15s ease-out',
      }}
      onClick={(e) => { if (!isMobile && e.target === e.currentTarget) setTarget(null) }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: isMobile ? '100%' : 780,
          height: isMobile ? '100%' : '80vh',
          background: 'var(--bg-surface)',
          border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 14,
          boxShadow: isMobile ? 'none' : '0 10px 48px rgba(0,0,0,0.45)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          animation: 'ttyChatSlideIn 0.18s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: isMobile ? '12px 16px' : '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-card)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              background: harnessColor, flexShrink: 0,
              opacity: 0.85,
            }} />
            <div>
              <div style={{ fontSize: isMobile ? 15 : 13, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                {harnessLabel}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                {lang === 'pt' ? 'Transcrição' : 'Transcript'}
              </div>
            </div>
          </div>
          <button
            onClick={() => setTarget(null)}
            style={{
              background: 'none', border: '1px solid var(--border)', cursor: 'pointer',
              color: 'var(--text-secondary)',
              padding: isMobile ? '8px 12px' : 4,
              borderRadius: isMobile ? 8 : 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: isMobile ? 4 : 0,
            }}
            title={lang === 'pt' ? 'Fechar' : 'Close'}
          >
            <X size={isMobile ? 18 : 16} />
            {isMobile && (
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {lang === 'pt' ? 'Fechar' : 'Close'}
              </span>
            )}
          </button>
        </div>

        {/* Transcript content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <HarnessChat
            key={target.harness + '-' + target.sessionId}
            harness={target.harness}
            lang={lang}
            initialSessionId={target.sessionId}
            initialProject={target.project ?? null}
          />
        </div>
      </div>
    </div>
  )
}
