/**
 * GalleryTab — the files a person SENT this session, grouped by the message that carried them.
 *
 * The opposite direction from the panel's other three tabs. Files, Docs and Live all answer "what
 * did this session DO"; this answers "what did I give it" — and the grouping is the whole point:
 * three screenshots of one broken layout went up together, about one thing, under one sentence, and
 * a flat wall of thumbnails throws that away.
 *
 * IT DECIDES NOTHING. `gallery.ts` says which messages carried files, in what order, and what a
 * file's format is; `useAttachmentSizes` asks the server for the sizes and leaves out the ones it
 * could not get. This file draws them.
 *
 * TWO VIEWS OF ONE LIST. The grid shows the picture plus everything the list shows; the list drops
 * the picture and keeps the name, the size and the format. They are not two arrangements of
 * different material — the same groups, in the same order, under the same headings.
 *
 * CLICKING AN IMAGE OPENS IT LARGE, and the lightbox's scope here is the WHOLE gallery rather
 * than one message — in the chat it is the turn that opened it, because there you are reading a
 * conversation, and here the pictures ARE the content, so "the next one" plainly means the next one
 * on the screen. `AttachmentLightbox` is the same component both use; a second one would be a
 * second set of keys for one gesture.
 *
 * RIGHT-CLICKING OFFERS THE MESSAGE — the composer recall modal's own three options, for THAT
 * file's message: go to it, read it here, or cancel. It is offered on every file and not only on
 * the images, because the menu is about the message rather than the picture. On touch there is no
 * second button, so a long press is the same gesture — the one the session rows already teach.
 * "Go to the message" resolves through the shared `goToTurn`, and SAYS so when the bubble is not on
 * the page (the reader is on the terminal view, or the transcript moved on) rather than doing
 * nothing.
 *
 * A FILE THAT CANNOT BE PREVIEWED SAYS SO. It is never a broken image: the format is read from the
 * name before anything is requested, and a request that fails anyway (the file was deleted, the
 * route refused it) falls back to the same card. An absent thumbnail is a fact; a broken one is a
 * bug the reader has to diagnose.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileQuestion, Grid2x2, Images, List, Paperclip } from 'lucide-react'
import { agoLabel } from '../../lib/artifactTabs'
import {
  effectiveScope, filterGallery, formatBytes, galleryImageKey, galleryImages,
  galleryMenuEntries,
  gallerySides, type GalleryFile, type GalleryScope,
  type GalleryGroup, type GalleryView,
} from '../../lib/gallery'
import { galleryFileUrl } from '../../lib/attachmentUrl'
import { overlayPadding } from '../../lib/mobileOverlay'
import { goToTurn } from '../../lib/turnScroll'
import { useAttachmentSizes } from '../../hooks/useAttachmentSizes'
import { useIsMobile } from '../../hooks/useIsMobile'
import { AttachmentLightbox } from './AttachmentLightbox'
import { SessionRowMenu } from './SessionRowMenu'

export interface GalleryTabProps {
  /** The session these files belong to — what a PRODUCED file's URL is resolved against. */
  sessionId: string
  groups: readonly GalleryGroup[]
  lang: 'pt' | 'en'
  view: GalleryView
  onViewChange: (view: GalleryView) => void
  /** Which side is shown — see `GalleryScope`. */
  scope: GalleryScope
  onScopeChange: (scope: GalleryScope) => void
  /**
   * Already-localized: the conversation these groups came from is a WINDOW onto a longer one.
   *
   * The gallery lists the files of the turns it was given, and that list is capped at the end of
   * the transcript — so on a long conversation it empties itself, which reads as "everything
   * disappeared" unless the panel says what actually happened. Reported exactly that way.
   */
  older?: string
}

/** How long a touch has to hold to mean "right-click". The same 500ms the session rows use. */
const LONG_PRESS_MS = 500

export function GalleryTab({
  sessionId, groups: allGroups, lang, view, onViewChange, scope, onScopeChange, older,
}: GalleryTabProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  /**
   * WHO PUT IT THERE. Asked for: what the assistant produced must be separable from what a person
   * sent — the two are different kinds of thing sharing one grid.
   *
   * The switch is drawn only when BOTH sides have something: a three-way control where two options
   * are empty is a control that mostly refuses, which is the same rule the Chat/Terminal toggle
   * keeps. And an empty SIDE says so in its own words rather than falling back to the "nothing sent
   * yet" sentence, which would be false.
   */
  const sides = useMemo(() => gallerySides(allGroups), [allGroups])
  // What is actually applied — see `effectiveScope`. A stored side that no longer has files falls
  // back to everything rather than emptying a gallery whose switch is not even drawn.
  const shown = effectiveScope(scope, sides)
  const groups = useMemo(() => filterGallery(allGroups, shown), [allGroups, shown])

  /** The flat run the lightbox steps through — the WHOLE gallery, see `galleryImages`. */
  const images = useMemo(() => galleryImages(groups), [groups])
  // SENT files only: the size is answered by a `HEAD` on the attachments route, which knows
  // nothing about a file the session wrote somewhere else. A produced row shows no size rather
  // than a wrong one — the same rule the rest of this panel keeps.
  const names = useMemo(
    () => groups.flatMap(g => g.files.filter(f => f.image && f.origin !== 'produced').map(f => f.name)),
    [groups],
  )
  const sizes = useAttachmentSizes(names)

  /** A clock, so "3m" ages while the panel is open rather than freezing at its first render. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  const [lightbox, setLightbox] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; group: GalleryGroup } | null>(null)
  const [viewing, setViewing] = useState<GalleryGroup | null>(null)
  /** Said when "go to the message" has nowhere to go. Never a button that silently does nothing. */
  const [notice, setNotice] = useState<string | null>(null)

  /** A preview the browser could not load after all — the file is gone, or was never one. */
  const [broken, setBroken] = useState<Record<string, true>>({})
  const markBroken = useCallback((name: string) => {
    setBroken(prev => (prev[name] ? prev : { ...prev, [name]: true }))
  }, [])

  /**
   * Open the lightbox on ONE file, found by its key rather than its path.
   *
   * The same file sent in two messages is two entries sharing a path, so a path lookup opened the
   * first of them whichever was clicked. A key that cannot be found opens nothing — better than
   * opening some other picture.
   */
  const openLightbox = useCallback((key: string) => {
    const at = images.findIndex(im => im.key === key)
    if (at >= 0) setLightbox(at)
  }, [images])

  const openMenu = useCallback((x: number, y: number, group: GalleryGroup) => {
    setNotice(null)
    setMenu({ x, y, group })
  }, [])

  const pick = useCallback((action: string, group: GalleryGroup) => {
    if (action === 'view') { setViewing(group); return }
    if (action !== 'goto') return
    // The lightbox has to close first, or the reader is taken to a bubble underneath a full-screen
    // black overlay — a scroll they cannot see is a button that appears to do nothing.
    setLightbox(null)
    if (!goToTurn('turn', group.index)) {
      setNotice(pt
        ? 'Essa mensagem não está na conversa carregada — abra a aba de chat da sessão.'
        : 'That message is not in the loaded conversation — open the session\'s chat view.')
    }
  }, [pt])

  if (allGroups.length === 0) {
    // The window outranks the "nothing yet" sentence, which would be FALSE on a long conversation:
    // files were sent, they are simply older than the turns this view holds.
    return (
      <Empty text={older
        ? `${older} ${pt
          ? 'Arquivos enviados antes disso não estão nesta lista.'
          : 'Files sent before that are not in this list.'}`
        : pt
          ? 'Nada enviado nesta conversa ainda. Imagens e arquivos que você anexar a uma mensagem aparecem aqui, agrupados pela mensagem que os levou.'
          : 'Nothing sent in this conversation yet. Images and files you attach to a message appear here, grouped by the message that carried them.'} />
    )
  }

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: '6px 8px', borderBottom: '1px solid var(--border-subtle)',
      }}>
        {sides.user > 0 && sides.llm > 0 ? (
          <div role="tablist" style={{
            display: 'flex', gap: 2, padding: 2, borderRadius: 8, marginRight: 'auto',
            background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          }}>
            {([
              ['all', pt ? 'Tudo' : 'All', sides.user + sides.llm],
              ['user', pt ? 'Você' : 'You', sides.user],
              ['llm', pt ? 'Assistente' : 'Assistant', sides.llm],
            ] as const).map(([id, label, n]) => (
              <button
                key={id}
                role="tab"
                aria-selected={shown === id}
                onClick={() => onScopeChange(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  minHeight: isMobile ? 44 : 24, padding: '0 8px', borderRadius: 6,
                  border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
                  background: shown === id ? 'var(--bg-elevated)' : 'transparent',
                  color: shown === id ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                  fontWeight: shown === id ? 650 : 400,
                }}
              >
                {label}<span style={{ opacity: 0.7 }}>{n}</span>
              </button>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginRight: 'auto' }}>
            {groups.length} {pt
              ? (groups.length === 1 ? 'mensagem' : 'mensagens')
              : (groups.length === 1 ? 'message' : 'messages')}
          </span>
        )}
        <ViewButton
          on={view === 'list'} isMobile={isMobile}
          label={pt ? 'Lista' : 'List'} icon={<List size={13} />}
          onClick={() => onViewChange('list')}
        />
        <ViewButton
          on={view === 'grid'} isMobile={isMobile}
          label={pt ? 'Grade' : 'Grid'} icon={<Grid2x2 size={13} />}
          onClick={() => onViewChange('grid')}
        />
      </div>

      {/* The window, stated ONCE at the top of a NON-empty gallery too: a list showing four files
          out of forty is a wrong answer nobody can see is wrong, which is worse than an empty one. */}
      {older && (
        <p style={{
          margin: 0, padding: '6px 10px', flexShrink: 0,
          fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-tertiary)',
          borderBottom: '1px solid var(--border-subtle)',
        }}>{older}</p>
      )}

      {notice && (
        <p role="status" style={{
          margin: 0, padding: '6px 10px', flexShrink: 0,
          fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)',
          borderBottom: '1px solid var(--border-subtle)',
        }}>{notice}</p>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '6px 8px 12px' }}>
        {groups.map(group => (
          <section key={group.index} style={{ marginBottom: 14, minWidth: 0 }}>
            <GroupHeading group={group} pt={pt} now={now} />
            {view === 'grid' ? (
              <div style={{
                display: 'grid', gap: 8,
                // `auto-fill` with a minimum, so the same rule holds at 390px (one or two columns)
                // and at a 900px-wide panel. Nothing here has a fixed width, so the page can never
                // be made to scroll sideways by a picture.
                gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))',
              }}>
                {group.files.map((file, i) => (
                  <Tile
                    key={`${file.path}-${i}`}
                    file={file} sessionId={sessionId} pt={pt} isMobile={isMobile}
                    size={sizes[file.name]}
                    broken={broken[file.name] === true}
                    onBroken={() => markBroken(file.name)}
                    {...(file.image && broken[file.name] !== true
                      ? { onOpen: () => openLightbox(galleryImageKey(group.index, i)) }
                      : {})}
                    onMenu={(x, y) => openMenu(x, y, group)}
                  />
                ))}
              </div>
            ) : (
              group.files.map((file, i) => (
                <RowItem
                  key={`${file.path}-${i}`}
                  file={file} pt={pt} isMobile={isMobile}
                  size={sizes[file.name]}
                  {...(file.image && broken[file.name] !== true
                    ? { onOpen: () => openLightbox(galleryImageKey(group.index, i)) }
                    : {})}
                  onMenu={(x, y) => openMenu(x, y, group)}
                />
              ))
            )}
          </section>
        ))}
      </div>

      {lightbox !== null && images[lightbox] !== undefined && (
        <AttachmentLightbox
          paths={images.map(im => im.path)}
          index={lightbox}
          onIndexChange={setLightbox}
          onClose={() => setLightbox(null)}
          lang={lang}
          onImageMenu={(x, y, at) => {
            const hit = images[at]
            if (hit) openMenu(x, y, hit.group)
          }}
          // The lightbox steps across BOTH halves of the gallery, so the route differs per image.
          // Resolved from the file the path belongs to, never guessed from the path itself.
          srcFor={path => {
            const file = groups.flatMap(g => g.files).find(f => f.path === path)
            return file ? galleryFileUrl(file, sessionId) : galleryFileUrl({ path, name: path.split('/').pop() ?? path }, sessionId)
          }}
        />
      )}

      {menu && (
        <SessionRowMenu
          x={menu.x} y={menu.y}
          entries={galleryMenuEntries(pt, menu.group).map(e => ({ action: e.action, label: e.label, enabled: e.enabled }))}
          onPick={action => pick(action, menu.group)}
          onClose={() => setMenu(null)}
        />
      )}

      {viewing && (
        <MessageDialog
          group={viewing} pt={pt} isMobile={isMobile} now={now}
          onGoTo={() => { const g = viewing; setViewing(null); pick('goto', g) }}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}

/** The heading over one message's files: when it was sent, how many, and what was typed. */
function GroupHeading({ group, pt, now }: { group: GalleryGroup; pt: boolean; now: number }) {
  const when = agoLabel(group.at, now, pt)
  const n = group.files.length
  return (
    <div style={{ margin: '2px 2px 6px', minWidth: 0 }}>
      <p style={{
        margin: 0, display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}>
        <Paperclip size={10} style={{ flexShrink: 0 }} />
        {n} {pt ? (n === 1 ? 'arquivo' : 'arquivos') : (n === 1 ? 'file' : 'files')}
        {/* WHEN it was sent. Absent when the transcript carried no timestamp — nothing invented,
            the same rule the live feed follows. */}
        {when !== '' && (
          <span
            title={group.at ? new Date(group.at).toLocaleString() : undefined}
            style={{ fontWeight: 600, letterSpacing: 0.3, textTransform: 'none' }}
          >· {when}</span>
        )}
      </p>
      {/* What was typed with them. A message with files and NO words is kept (the files are the
          message) and simply has no line here. */}
      {group.text !== '' && (
        <p style={{
          margin: '3px 0 0', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-secondary)',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden', overflowWrap: 'anywhere',
        }}>{group.text}</p>
      )}
    </div>
  )
}

/** The right-click, and its touch equivalent — a phone has no second button. */
function useMenuHandlers(onMenu: (x: number, y: number) => void) {
  // A ref, not state: the pending timer is not something the row renders, and clearing it inside a
  // state updater would be a side effect React is free to run twice.
  const timer = useRef<number | null>(null)
  const clear = useCallback(() => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
  }, [])
  useEffect(() => clear, [clear])
  return {
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onMenu(e.clientX, e.clientY) },
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      const x = t.clientX
      const y = t.clientY
      timer.current = window.setTimeout(() => onMenu(x, y), LONG_PRESS_MS)
    },
    onTouchMove: clear,
    onTouchEnd: clear,
    onTouchCancel: clear,
  }
}

/** NAME, SIZE, FORMAT — the list row, and the bottom half of every tile. */
function FileFacts({ file, size, pt }: { file: GalleryFile; size: number | undefined; pt: boolean }) {
  const bytes = formatBytes(size)
  return (
    <>
      <span style={{
        display: 'block', fontSize: 12, color: 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{file.name}</span>
      <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
        {/* The FORMAT is read from the name, so it is always there when the name has one. The SIZE
            comes from the server and is simply ABSENT when it could not be obtained — never a `0 B`
            standing in for "not known". */}
        {file.format !== '' && file.format}
        {file.format !== '' && bytes !== '' && ' · '}
        {bytes}
        {!file.image && (
          <span style={{ marginLeft: file.format !== '' || bytes !== '' ? 6 : 0 }}>
            {pt ? '· sem prévia' : '· no preview'}
          </span>
        )}
      </span>
    </>
  )
}

function RowItem({ file, size, pt, isMobile, onOpen, onMenu }: {
  file: GalleryFile
  size: number | undefined
  pt: boolean
  isMobile: boolean
  onOpen?: () => void
  onMenu: (x: number, y: number) => void
}) {
  const handlers = useMenuHandlers(onMenu)
  return (
    <div
      {...handlers}
      {...(onOpen ? { onClick: onOpen, role: 'button', tabIndex: 0 } : {})}
      title={file.path}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0,
        minHeight: isMobile ? 44 : 0, padding: '6px 6px', borderRadius: 8,
        cursor: onOpen ? 'pointer' : 'default',
      }}
    >
      <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', display: 'flex' }}>
        {file.image ? <Images size={14} /> : <FileQuestion size={14} />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <FileFacts file={file} size={size} pt={pt} />
      </span>
    </div>
  )
}

function Tile({ file, sessionId, size, pt, isMobile, broken, onBroken, onOpen, onMenu }: {
  file: GalleryFile
  sessionId: string
  size: number | undefined
  pt: boolean
  isMobile: boolean
  broken: boolean
  onBroken: () => void
  onOpen?: () => void
  onMenu: (x: number, y: number) => void
}) {
  const handlers = useMenuHandlers(onMenu)
  const previewable = file.image && !broken
  return (
    <div
      {...handlers}
      {...(onOpen ? { onClick: onOpen, role: 'button', tabIndex: 0 } : {})}
      title={file.path}
      style={{
        display: 'flex', flexDirection: 'column', minWidth: 0,
        border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden',
        background: 'var(--bg-elevated)', cursor: onOpen ? 'pointer' : 'default',
      }}
    >
      <div style={{
        aspectRatio: '4 / 3', display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: isMobile ? 44 : 0, background: 'var(--bg-base)', overflow: 'hidden',
      }}>
        {previewable ? (
          <img
            src={galleryFileUrl(file, sessionId)}
            alt={file.name}
            loading="lazy"
            // A preview that fails is not left as a broken image: the tile falls back to the same
            // card a non-image gets, which says in words that there is nothing to show.
            onError={onBroken}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            padding: 8, textAlign: 'center', color: 'var(--text-tertiary)',
          }}>
            <FileQuestion size={18} />
            <span style={{ fontSize: 10, lineHeight: 1.3 }}>
              {broken
                ? (pt ? 'não está mais no disco' : 'no longer on disk')
                : (pt ? 'sem prévia' : 'no preview')}
            </span>
          </span>
        )}
      </div>
      <div style={{ padding: '6px 7px', minWidth: 0 }}>
        <FileFacts file={file} size={size} pt={pt} />
      </div>
    </div>
  )
}

/**
 * The message, read here.
 *
 * The composer's own recall modal is bound to `lastSent` and its two-face state machine inside
 * `SessionChat`; this is the same three options asked of ANY message in the gallery, so it draws
 * the one face it needs and offers the same way out. Full-screen on a phone — a centred fixed-width
 * dialog is pushed off-screen by iOS Safari the moment the page overflows horizontally.
 */
function MessageDialog({ group, pt, isMobile, now, onGoTo, onClose }: {
  group: GalleryGroup
  pt: boolean
  isMobile: boolean
  now: number
  onGoTo: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const when = agoLabel(group.at, now, pt)
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={pt ? 'A mensagem que levou este arquivo' : 'The message that carried this file'}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: overlayPadding(isMobile, 24), background: 'rgba(0,0,0,0.55)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0,
          width: isMobile ? '100%' : 'min(520px, 100%)',
          height: isMobile ? '100%' : 'auto',
          maxHeight: isMobile ? '100%' : '80vh',
          padding: isMobile ? '18px 16px' : 20,
          borderRadius: isMobile ? 0 : 16,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Paperclip size={15} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
          <h3 style={{ margin: 0, flex: 1, fontSize: 14, fontWeight: 650, color: 'var(--text-primary)' }}>
            {pt ? 'A mensagem que levou este arquivo' : 'The message that carried this file'}
          </h3>
          {when !== '' && (
            <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{when}</span>
          )}
        </div>

        {/* The words, or the absence of them said plainly — a message can be a screenshot dropped
            in with nothing typed, and an empty box would read as a failure to load. */}
        <pre style={{
          margin: 0, flex: isMobile ? 1 : '0 1 auto', minHeight: 0,
          maxHeight: isMobile ? 'none' : '46vh', overflow: 'auto',
          padding: 12, borderRadius: 10,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.6,
          color: group.text === '' ? 'var(--text-tertiary)' : 'var(--text-primary)',
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        }}>
          {group.text === ''
            ? (pt ? 'Você enviou só os arquivos, sem escrever nada.' : 'You sent the files with nothing typed.')
            : group.text}
        </pre>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {group.files.map((f, i) => (
            <span key={`${f.path}-${i}`} title={f.path} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px',
              borderRadius: 8, background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)', fontSize: 11.5,
              maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              <Paperclip size={11} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
              {f.name}
            </span>
          ))}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onGoTo} style={dialogButton(isMobile, 'primary')}>
            {pt ? 'Ir para a mensagem' : 'Go to message'}
          </button>
          <button onClick={onClose} style={dialogButton(isMobile, 'plain')}>
            {pt ? 'Fechar' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 44px of finger on a phone, and nowhere else — the same rule the recall modal's buttons follow. */
function dialogButton(isMobile: boolean, kind: 'primary' | 'plain'): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: isMobile ? 44 : 34, padding: '0 14px', borderRadius: 9,
    border: kind === 'primary' ? 'none' : '1px solid var(--border)',
    background: kind === 'primary' ? 'var(--anthropic-orange)' : 'transparent',
    color: kind === 'primary' ? '#fff' : 'var(--text-secondary)',
    fontFamily: 'inherit', fontSize: 12.5, fontWeight: kind === 'primary' ? 650 : 500,
    cursor: 'pointer',
  }
}

function ViewButton({ on, isMobile, label, icon, onClick }: {
  on: boolean; isMobile: boolean; label: string; icon: React.ReactNode; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        minHeight: isMobile ? 44 : 26, minWidth: isMobile ? 44 : 0,
        padding: '4px 9px', borderRadius: 7, border: 'none', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 11.5, fontWeight: on ? 700 : 500,
        background: on ? 'var(--bg-elevated)' : 'transparent',
        color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px 18px',
    }}>
      <p style={{
        margin: 0, fontSize: 12, lineHeight: 1.6, textAlign: 'center', color: 'var(--text-tertiary)',
      }}>{text}</p>
    </div>
  )
}
