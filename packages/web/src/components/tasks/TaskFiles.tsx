/**
 * TaskFiles — the task's attachments, as a LIST or a GRID.
 *
 * Two shapes because there are two kinds of attachment. A spec is a name and a size, which a list
 * reads best; a screenshot is a picture, and a list of filenames is the one presentation that hides
 * what a picture is. The grid therefore renders a real preview, and clicking one opens a lightbox
 * that walks between the IMAGES only — stepping from a screenshot into a `.md` would be arrows that
 * sometimes navigate and sometimes do nothing.
 *
 * What is previewable is decided by the mime type the browser will actually paint, never by the
 * extension: a `.png` that is really a text file draws a broken icon, and a broken icon is
 * indistinguishable from a failed download.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft, ChevronRight, Download, FileText, Grid3x3, ImageIcon, List, Paperclip, Trash2, X,
} from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { button, fmtBytes, microLabel, pill, surface } from './board'
import { fileUrl, type TaskFile } from '../../lib/tasks'

/** Extensions a browser paints inline. Kept small and explicit — a guess here draws a broken icon. */
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

const isImage = (f: TaskFile) => IMAGE.test(f.name)

function Lightbox({ files, index, onIndex, onClose }: {
  files: TaskFile[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}) {
  const step = useCallback((by: number) => {
    // Wraps, because a gallery is a ring — reaching the last picture and finding a dead arrow reads
    // as broken rather than as an edge.
    onIndex((index + by + files.length) % files.length)
  }, [index, files.length, onIndex])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [step, onClose])

  const f = files[index]
  if (!f) return null

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.86)',
        display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 10, padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} onClick={e => e.stopPropagation()}>
        <span style={{ fontSize: 12.5, color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {f.name}
        </span>
        <span style={{ ...microLabel }}>{index + 1} / {files.length}</span>
        <span style={{ flex: 1 }} />
        <a href={fileUrl(f.id)} style={{ color: 'var(--text-secondary)', display: 'flex' }} title="Download">
          <Download size={17} />
        </a>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' }}>
          <X size={19} />
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 0 }}>
        <button
          onClick={e => { e.stopPropagation(); step(-1) }}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' }}
        ><ChevronLeft size={30} /></button>
        <img
          src={fileUrl(f.id)} alt={f.name}
          onClick={e => e.stopPropagation()}
          style={{ flex: 1, minWidth: 0, maxHeight: '100%', objectFit: 'contain' }}
        />
        <button
          onClick={e => { e.stopPropagation(); step(1) }}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' }}
        ><ChevronRight size={30} /></button>
      </div>

      <div style={{ ...microLabel, textAlign: 'center' }}>← → to walk · Esc to close</div>
    </div>,
    document.body,
  )
}

export function TaskFiles({ files, onUpload, onRemove }: {
  files: TaskFile[]
  onUpload: (f: File) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
}) {
  const isMobile = useIsMobile()
  const [view, setView] = useState<'list' | 'grid'>('grid')
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [dropping, setDropping] = useState(false)

  // The lightbox walks IMAGES only, so its index is into this list and not into `files`.
  const images = useMemo(() => files.filter(isImage), [files])

  const seg = (active: boolean): React.CSSProperties => ({
    ...button(isMobile), height: isMobile ? 36 : 26, border: 'none', fontSize: 11.5,
    background: active ? 'var(--bg-elevated)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
  })

  const openImage = (f: TaskFile) => {
    const i = images.findIndex(x => x.id === f.id)
    if (i >= 0) setLightbox(i)
  }

  return (
    <div
      style={{
        ...surface, padding: 13, display: 'grid', gap: 11,
        outline: dropping ? '1px dashed var(--anthropic-orange)' : 'none',
      }}
      onDragOver={e => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={e => {
        e.preventDefault(); setDropping(false)
        for (const f of Array.from(e.dataTransfer?.files ?? [])) void onUpload(f)
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={microLabel}>{files.length} file{files.length === 1 ? '' : 's'}</span>
        <span style={{ flex: 1 }} />
        <div style={{ ...surface, display: 'flex', padding: 3, gap: 2 }}>
          <button style={seg(view === 'grid')} onClick={() => setView('grid')}><Grid3x3 size={13} /></button>
          <button style={seg(view === 'list')} onClick={() => setView('list')}><List size={13} /></button>
        </div>
        <label style={{ ...button(isMobile), cursor: 'pointer' }}>
          <Paperclip size={13} /> Attach
          <input
            type="file" multiple style={{ display: 'none' }}
            onChange={e => { for (const f of Array.from(e.target.files ?? [])) void onUpload(f) }}
          />
        </label>
      </div>

      {files.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          No files yet. Paste or drop one here — specs, plans and screenshots an assistant writes
          belong on the task.
        </div>
      )}

      {view === 'grid' && files.length > 0 && (
        <div style={{
          display: 'grid', gap: 10,
          gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
        }}>
          {files.map(f => {
            const img = isImage(f)
            return (
              <div key={f.id} style={{ ...surface, overflow: 'hidden', display: 'grid', gridTemplateRows: '104px auto' }}>
                <button
                  onClick={() => img && openImage(f)}
                  style={{
                    border: 'none', padding: 0, background: 'var(--bg-base)',
                    cursor: img ? 'zoom-in' : 'default',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                  }}
                >
                  {img
                    ? <img src={fileUrl(f.id)} alt={f.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <FileText size={26} style={{ color: 'var(--text-tertiary)' }} />}
                </button>
                <div style={{ padding: '7px 9px', display: 'grid', gap: 3 }}>
                  <span style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ ...microLabel, fontSize: 10 }}>{fmtBytes(f.size)}</span>
                    <span style={{ flex: 1 }} />
                    <a href={fileUrl(f.id)} style={{ color: 'var(--text-tertiary)', display: 'flex' }} title="Download">
                      <Download size={12} />
                    </a>
                    <button
                      onClick={() => void onRemove(f.id)} title="Remove"
                      style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
                    ><Trash2 size={12} /></button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {view === 'list' && files.length > 0 && (
        <div style={{ display: 'grid', gap: 7 }}>
          {files.map(f => {
            const img = isImage(f)
            return (
              <div key={f.id} style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: isMobile ? 44 : 26 }}>
                {img
                  ? <ImageIcon size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  : <FileText size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
                <button
                  onClick={() => img && openImage(f)}
                  style={{
                    flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none',
                    color: 'var(--text-secondary)', fontSize: 12.5,
                    cursor: img ? 'zoom-in' : 'default',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >{f.name}</button>
                {f.author && <span style={pill('var(--accent-blue)')}>{f.author}</span>}
                <span style={{ ...microLabel, fontSize: 10.5 }}>{fmtBytes(f.size)}</span>
                <a href={fileUrl(f.id)} style={{ color: 'var(--text-tertiary)', display: 'flex' }} title="Download">
                  <Download size={13} />
                </a>
                <button
                  onClick={() => void onRemove(f.id)} title="Remove"
                  style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
                ><Trash2 size={13} /></button>
              </div>
            )
          })}
        </div>
      )}

      {lightbox !== null && images.length > 0 && (
        <Lightbox files={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  )
}
