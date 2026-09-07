/**
 * AttachmentLightbox — one image attachment, full-size, with a way to step through its siblings.
 *
 * THE CALLER OWNS THE SCOPE, and the two callers choose differently on purpose. In the CHAT it is
 * the message that opened it: "if there's more than one" (the ask this answers) means more than one
 * attachment on THIS turn, and jumping to some other message's picture while somebody reads a
 * conversation would answer a question nobody asked. In the GALLERY it is every image on the
 * screen, because there the pictures ARE the content and "the next one" plainly means the next one.
 */

import { useEffect } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { attachmentKind } from '../../lib/messageAttachments'

export interface AttachmentLightboxProps {
  paths: readonly string[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
  lang: 'pt' | 'en'
  /**
   * A right-click ON THE IMAGE, for a caller that offers something about it.
   *
   * Optional, and absent in the chat: there the lightbox is scoped to one message and the reader is
   * already looking at it, so "go to the message it was sent in" would take them where they are.
   * The GALLERY steps across messages, so the picture on screen is routinely not from the message
   * the reader last saw — which is the whole reason its menu exists here too.
   */
  onImageMenu?: (x: number, y: number, index: number) => void
  /**
   * How to turn a path into a URL, when the default is not right.
   *
   * The default is the attachments route, which is what the chat and the sent half of the gallery
   * need. A file the SESSION produced lives wherever the session put it and is served by a
   * different route bound to that session, so the caller that knows which is which resolves it —
   * this component never guesses from the path.
   */
  srcFor?: (path: string) => string
}

export function AttachmentLightbox({
  paths, index, onIndexChange, onClose, lang, onImageMenu, srcFor,
}: AttachmentLightboxProps) {
  const pt = lang === 'pt'
  const many = paths.length > 1

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (many && e.key === 'ArrowLeft') onIndexChange((index - 1 + paths.length) % paths.length)
      else if (many && e.key === 'ArrowRight') onIndexChange((index + 1) % paths.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, many, paths.length, onIndexChange, onClose])

  const path = paths[index]
  if (path === undefined) return null

  const src = srcFor ? srcFor(path) : attachmentUrl(path)
  const kind = attachmentKind(path)
  const frameStyle: React.CSSProperties = {
    maxWidth: '90vw', maxHeight: '86vh', objectFit: 'contain',
    borderRadius: 8, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  }
  // The INDEX, not the path: the same file sent in two messages is two entries sharing a path, and
  // the caller's menu is about the MESSAGE — resolving by path would offer the wrong one.
  const menuProps = onImageMenu
    ? {
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
          onImageMenu(e.clientX, e.clientY, index)
        },
      }
    : {}

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.82)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <button
        onClick={onClose}
        aria-label={pt ? 'Fechar' : 'Close'}
        style={{
          position: 'absolute', top: 16, right: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 38, height: 38, borderRadius: 10, cursor: 'pointer',
          border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.08)',
          color: '#fff',
        }}
      >
        <X size={18} />
      </button>

      {many && (
        <>
          <NavButton
            side="left"
            label={pt ? 'Anterior' : 'Previous'}
            onClick={e => { e.stopPropagation(); onIndexChange((index - 1 + paths.length) % paths.length) }}
          />
          <NavButton
            side="right"
            label={pt ? 'Próxima' : 'Next'}
            onClick={e => { e.stopPropagation(); onIndexChange((index + 1) % paths.length) }}
          />
        </>
      )}

      {/* THREE KINDS, ONE FRAME. The component is named for the picture it began as, and it steps
          across whatever the gallery can show — so what changes here is the ELEMENT, not the
          stepping, the counter or the menu. A video that could only be a still `<img>` was a black
          rectangle; a PDF was the same rectangle with a filename under it. */}
      {kind === 'video' ? (
        <video
          src={src}
          controls
          autoPlay
          playsInline
          onClick={e => e.stopPropagation()}
          {...menuProps}
          style={frameStyle}
        />
      ) : kind === 'pdf' ? (
        // The browser's OWN viewer, in an iframe on this origin. `#view=FitH` opens it fitted to
        // the width rather than at whatever zoom the viewer remembers, which on a phone is the
        // difference between a page and a corner of one. iOS Safari renders only the first page
        // inside a frame, which is why the link below it is not a nicety — it is the way to read
        // the rest, and it says so in words rather than leaving a reader stuck on page one.
        <div
          onClick={e => e.stopPropagation()}
          style={{ ...frameStyle, width: '90vw', height: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}
        >
          <iframe
            src={`${src}#view=FitH`}
            title={pt ? 'Documento' : 'Document'}
            style={{ flex: 1, width: '100%', border: 'none', borderRadius: '8px 8px 0 0' }}
          />
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            style={{
              flexShrink: 0, padding: '9px 12px', textAlign: 'center',
              fontSize: 12.5, fontWeight: 600, color: 'var(--anthropic-orange)',
              textDecoration: 'none', borderTop: '1px solid var(--border)',
            }}
          >
            {pt ? 'Abrir em uma aba' : 'Open in a tab'}
          </a>
        </div>
      ) : (
        <img
          src={src}
          alt=""
          onClick={e => e.stopPropagation()}
          {...menuProps}
          style={frameStyle}
        />
      )}

      {many && (
        <div style={{
          position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          padding: '5px 12px', borderRadius: 999,
          background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.85)',
          fontSize: 12, fontWeight: 600,
        }}>
          {index + 1} / {paths.length}
        </div>
      )}
    </div>
  )
}

function NavButton({ side, label, onClick }: {
  side: 'left' | 'right'; label: string; onClick: (e: React.MouseEvent) => void
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        position: 'absolute', [side]: 16, top: '50%', transform: 'translateY(-50%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 44, height: 44, borderRadius: '50%', cursor: 'pointer',
        border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.08)',
        color: '#fff',
      } as React.CSSProperties}
    >
      {side === 'left' ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
  )
}
