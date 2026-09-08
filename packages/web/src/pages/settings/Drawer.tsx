import React from 'react'
import { X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { ConfirmModal } from './primitives'

// Right-side slide-in panel + backdrop, full-screen on mobile.
// Shared by the governance settings pages (Users / Teams). Extracted from the
// old combined governance page so both split pages reuse the same panel.
export function Drawer({ open, title, onClose, children, footer, dirty = false, lang = 'en' }: {
  open: boolean; title: string; onClose: () => void; children: React.ReactNode
  /** Optional action bar pinned to the bottom of the panel — for a drawer-wide save button. */
  footer?: React.ReactNode
  /** When true, closing (backdrop / X / Escape) or leaving the tab asks to confirm first, so
   *  unsaved edits are never silently discarded. Drawers compute this from their form state. */
  dirty?: boolean
  lang?: 'pt' | 'en'
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)

  // Any close attempt goes through here: warn first if there are unsaved changes.
  const attemptClose = React.useCallback(() => {
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }, [dirty, onClose])

  // Escape closes (via the same guard); native tab-close/refresh gets the browser's leave prompt.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') attemptClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, attemptClose])

  React.useEffect(() => {
    if (!open || !dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [open, dirty])

  if (!open) return null
  return (
    <>
    <div
      onClick={attemptClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
        justifyContent: 'flex-end', background: 'rgba(0,0,0,0.5)',
        // On a phone the panel is the full height, so its title bar and its close button start at
        // y=0 — under the status bar in an installed PWA, where the taps do not reach them. The
        // inset goes on the OVERLAY: the dark ground keeps covering the band, and the panel starts
        // below it. `--safe-top` is 0 in a browser tab.
        paddingTop: isMobile ? 'var(--safe-top)' : 0,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: isMobile ? '100%' : 'min(680px, 94vw)',
          height: '100%',
          background: 'var(--bg-card)',
          borderLeft: isMobile ? 'none' : '1px solid var(--border)',
          boxShadow: '-12px 0 40px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column',
          // The PANEL is the frame and must not scroll: it and the list below it were two nested
          // scrollers, and the outer one absorbed the drag while the inner one was capped at a
          // fixed height, leaving dead space under a row cut in half. Only the body moves now, so
          // the title bar and the footer actions genuinely stay put.
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 18px', borderBottom: '1px solid var(--border)',
          background: 'var(--bg-card)', zIndex: 1, flexShrink: 0,
        }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
          <button
            onClick={attemptClose}
            style={{
              border: 'none', background: 'transparent', color: 'var(--text-tertiary)',
              cursor: 'pointer', display: 'inline-flex', padding: 4,
            }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {/* `minHeight: 0` is what lets this shrink below its content and scroll, instead of
            pushing the panel open and taking the footer off the bottom of the screen. */}
        <div style={{
          padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
          flex: 1, minHeight: 0, overflowY: 'auto',
        }}>
          {children}
        </div>
        {footer && (
          <div style={{
            zIndex: 1, flexShrink: 0,
            padding: '12px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-card)',
            display: 'flex', gap: 8, justifyContent: 'flex-end',
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
    {/* Rendered as a sibling (not inside the backdrop) so its clicks don't bubble to attemptClose. */}
    <ConfirmModal
      open={confirmDiscard}
      title={pt ? 'Descartar alterações?' : 'Discard changes?'}
      message={pt
        ? 'Você tem alterações não salvas. Se sair agora, elas serão perdidas.'
        : 'You have unsaved changes. If you leave now, they will be lost.'}
      confirmLabel={pt ? 'Descartar' : 'Discard'}
      cancelLabel={pt ? 'Continuar editando' : 'Keep editing'}
      onConfirm={() => { setConfirmDiscard(false); onClose() }}
      onCancel={() => setConfirmDiscard(false)}
    />
    </>
  )
}

export default Drawer
