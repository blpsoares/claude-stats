/**
 * SessionDrilldownModal — the dialog SHELL around `SessionDrilldown`.
 *
 * The panels themselves moved to `SessionDrilldown.tsx`, because the sessions workspace draws the
 * same reading as a tab in the right aside and a second copy would be a second set of answers
 * about one session. What is left here is what a DIALOG is and the aside is not: the overlay, the
 * card, the sticky header and the close button.
 *
 * It survives — rather than everything becoming the aside tab — because the three surfaces that
 * open it have no aside to open. The dashboard's "who leads" board, a repository's Actions tab and
 * a custom layout are pages, not the sessions workspace; there is nothing beside them to put this
 * next to, so a centred dialog is the shape, and removing it would have left those rows inert.
 */

import React, { useEffect } from 'react'
import { X } from 'lucide-react'
import type { SessionMeta, Lang, WorkflowRun } from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'
import { OVERLAY_TOP } from '../lib/mobileOverlay'
import {
  SessionDrilldownBody, SessionDrilldownHead, type GlobalModelUsage,
} from './SessionDrilldown'

interface Props {
  session: SessionMeta
  globalModelUsage: GlobalModelUsage
  currency: 'USD' | 'BRL'
  brlRate: number
  lang: Lang
  /** All dynamic-workflow runs (from /api/data); this modal shows the ones for THIS session. */
  workflows?: WorkflowRun[]
  onClose: () => void
}

export function SessionDrilldownModal({ session, globalModelUsage, currency, brlRate, lang, workflows, onClose }: Props) {
  const isMobile = useIsMobile()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 350,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        padding: isMobile ? OVERLAY_TOP : 24,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 14,
          width: '100%',
          maxWidth: isMobile ? '100%' : 980,
          maxHeight: isMobile ? '100%' : '90vh',
          height: isMobile ? '100%' : undefined,
          // Vertical scroll only — never let a dense inner grid push the whole
          // modal (and its sticky header) sideways on a narrow phone.
          overflowY: 'auto',
          overflowX: 'hidden',
          boxShadow: isMobile ? 'none' : '0 8px 40px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div style={{
          position: 'sticky',
          top: 0,
          background: 'var(--bg-card)',
          borderBottom: '1px solid var(--border)',
          padding: isMobile ? '14px 16px' : '18px 22px',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          zIndex: 10,
        }}>
          <SessionDrilldownHead session={session} lang={lang} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              onClick={onClose}
              style={{
                width: 30, height: 30,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid var(--border)', borderRadius: 8,
                background: 'transparent', color: 'var(--text-tertiary)',
                cursor: 'pointer', flexShrink: 0,
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <SessionDrilldownBody
          session={session}
          globalModelUsage={globalModelUsage}
          currency={currency}
          brlRate={brlRate}
          lang={lang}
          {...(workflows ? { workflows } : {})}
        />
      </div>
    </div>
  )
}
