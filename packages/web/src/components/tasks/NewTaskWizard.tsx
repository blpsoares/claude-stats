/**
 * NewTaskWizard — `TaskComposer` in a dialog.
 *
 * The form itself lives in `TaskComposer`, because the same question is asked from four places (the
 * board, a session's three-dot menu, a right-click on a session card, and the session's own Tasks
 * tab) and two of those want it INLINE. Keeping the chrome here and the questions there is what
 * stops a task created from a session menu having fewer fields than one created from the board.
 *
 * It is a dialog and not a block on the page: it asks a question with an answer, and the board
 * behind it must not scroll away underneath a half-filled form.
 */

import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'
import { microLabel, surface } from './board'
import { TaskComposer } from './TaskComposer'
import { BetaTag } from '../BetaTag'

export interface NewTaskWizardProps {
  onDone: (taskId: string) => void | Promise<void>
  onClose: () => void
  /** Opens the existing session wizard. The task is created first and handed over. */
  onCreateSession: (taskId: string, title: string) => void
  /** Opened FROM a session — it arrives pre-linked. See `TaskComposer`. */
  session?: { id: string; title: string; harness?: string }
}

export function NewTaskWizard({ onDone, onClose, onCreateSession, session }: NewTaskWizardProps) {
  const isMobile = useIsMobile()
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 999, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
        // The shared rule: a full-screen mobile overlay that pads with a bare zero puts its own
        // close button under the status bar.
        padding: overlayPadding(isMobile, 16),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          ...surface, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-elevated)',
          padding: 16, display: 'grid', gap: 13, gridTemplateRows: 'auto 1fr',
          ...(isMobile
            ? { width: '100%', height: '100%', borderRadius: 0, overflowY: 'auto', alignContent: 'start' }
            : { width: 'min(520px, 92vw)', maxHeight: '82vh', overflowY: 'auto' }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={microLabel}>{session ? 'New task for this session' : 'New task'}</span>
          <BetaTag what="The delivery board" />
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              ...(isMobile ? { minWidth: 44, minHeight: 44 } : {}),
            }}
          ><X size={16} /></button>
        </div>
        <TaskComposer
          {...(session ? { session } : {})}
          onDone={taskId => onDone(taskId)}
          onCancel={onClose}
          onCreateSession={onCreateSession}
        />
      </div>
    </div>,
    document.body,
  )
}
