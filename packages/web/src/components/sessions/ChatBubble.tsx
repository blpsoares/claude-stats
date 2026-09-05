/**
 * ChatBubble — one turn of a session's conversation.
 *
 * IT SHOWS WHAT WAS SAID, AND NOTHING ELSE. The transcript also carries the assistant's reasoning
 * and every tool call it made, and an earlier pass rendered both. It was wrong: a session that runs
 * forty commands produces forty entries nobody asked to read, and the two or three sentences that
 * were actually addressed to the user are lost in them. The reasoning is not a message either — it
 * is the assistant thinking, which the terminal view shows in full for anyone who wants it.
 *
 * So a turn with no text renders NOTHING. A turn that is only tool calls is work in progress, and
 * the state on the row already says the session is working.
 *
 * Both sides get a surface. An assistant turn rendered as bare text on the page background reads as
 * the page itself talking; the two sides are told apart by alignment and colour rather than by one
 * having a box and the other not.
 *
 * WIDE CONTENT SCROLLS INSIDE ITS OWN BOX. A code fence, a table or a long URL is routinely wider
 * than the bubble, and letting it set the width is how a message ends up outside its own card.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
// A single newline is a LINE BREAK here. Without this plugin markdown collapses it to a space, so a
// message written across several lines renders as one run-on paragraph — which is what "the
// messages are not formatted" turned out to mean. `HarnessChat` has always used it.
import remarkBreaks from 'remark-breaks'
import { Check, Clock, CornerUpLeft, Loader, User } from 'lucide-react'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { splitSlashLine } from '../../lib/slashLine'
import { splitImageAttachments } from '../../lib/attachmentPreview'
import { echoStatus } from '../../lib/echoStatus'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { AttachmentLightbox } from './AttachmentLightbox'
import { HarnessMark } from './HarnessMark'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
  /**
   * A background TASK this turn started, by the label the assistant gave it.
   *
   * A watcher is the one tool call worth a line in a conversation: it is long, it is usually the
   * thing the reader is waiting for, and its END is already reported. Rendered as a status line and
   * never as a message — nobody said it.
   */
  task?: { label: string; running: boolean }
  /**
   * This sat under the `user` role and no person wrote it — a background task reporting back, an
   * injected reminder, a `!` command's stdout. The value NAMES the kind; it is never the body.
   *
   * It may not render as a message: it went out over the user's own avatar, and one of them was
   * circled in a screenshot with "I didn't send that". See `chat-envelope.ts`.
   */
  system?: string
  /** Carried by the transcript; deliberately not rendered here. See the header. */
  tools?: Array<{ name: string; detail?: string }>
  /** Carried by the transcript; deliberately not rendered here. See the header. */
  thinking?: string
}

export interface ChatBubbleProps {
  turn: ChatTurn
  lang: 'pt' | 'en'
  /** Which assistant said it, for the mark beside an assistant turn. */
  harness: string
  /** Read off the terminal screen and not yet committed to the transcript. Labelled as such. */
  provisional?: boolean
  /**
   * SENT, and the session has not taken it yet.
   *
   * The echo already knew this — it is retired the moment the transcript carries the same text —
   * and drew a bubble identical to a delivered one, so a message queued behind a working turn was
   * indistinguishable from one already read. On a session mid-turn that wait is minutes, and the
   * reader's only options were to assume or to send it again. Dim plus a word, never a spinner:
   * the message IS there, it is the reading that has not happened.
   */
  awaiting?: boolean
  /** How long ago the message was handed to the session, ms. Absent when that is not known. */
  awaitingSinceMs?: number
  /** Whether the session is mid-turn — the reason an unread message is normal rather than stuck. */
  awaitingWorking?: boolean
  /**
   * Quote THIS turn in the composer. Absent where the session cannot be written to — a reply
   * control on a row that will refuse the message is a control that teaches the wrong thing.
   *
   * Takes the turn rather than closing over it, so the PARENT can hand every bubble the SAME
   * function reference (one `useCallback`, not one closure per row) — the memo above only pays off
   * if `onReply` is actually stable across a re-render caused by something unrelated, like typing.
   */
  onReply?: (turn: ChatTurn) => void
  /**
   * Reply to the SELECTED PART of this turn.
   *
   * Offered only on the assistant's own messages, and only while a selection actually sits inside
   * this bubble. Same stability requirement as `onReply` — see the note above.
   */
  onReplyExcerpt?: (turn: ChatTurn, excerpt: string) => void
  /**
   * A DOM id for this bubble, so something outside the conversation can scroll to it.
   *
   * The id is composed by `lastSent.ts`'s `turnAnchorId` — one rule shared by whatever renders the
   * bubble and whatever goes looking for it, so "go to message" can never hunt an id nothing wrote.
   */
  anchorId?: string
}

/**
 * Memoized: a long conversation renders hundreds of these, and every one of them re-rendered on
 * every keystroke in the composer, because `draft` lives in the same component as the turns list —
 * a state change anywhere re-renders every child unless the child says it doesn't need to. That is
 * what "typing is slow and stuck" turned out to mean on a session with a real amount of history.
 * `onReply` is a fresh closure per render in the parent, so this alone would not have been enough —
 * see `SessionChat.tsx`'s `useCallback` on it.
 */
/**
 * The Portuguese for each note `chat-envelope.ts` produces.
 *
 * The server composes these in English because it has no language — every other already-localized
 * refusal in this product is worded by the machine, but a note like this is chrome, not a machine's
 * answer. An unmapped note falls through untranslated rather than being dropped: a missing
 * translation is a small thing, a missing line is the defect this exists to fix.
 */
const SYSTEM_NOTE_PT: Record<string, string> = {
  'background task reported back': 'tarefa em segundo plano respondeu',
  'system reminder': 'lembrete do sistema',
  'local-command caveat': 'aviso de comando local',
  'command output': 'saída de comando',
  'slash command': 'comando de barra',
  'shell command': 'comando de shell',
  // The untagged `isMeta` entries — see `chat-envelope.ts`'s second measurement.
  'a skill was loaded': 'uma skill foi carregada',
  'a skill was re-invoked': 'uma skill foi reinvocada',
  'a message from another session': 'uma mensagem de outra sessão',
  'the conversation was compacted': 'a conversa foi compactada — o resumo do que veio antes',
  'an image was attached': 'uma imagem foi anexada',
  'the session was resumed': 'a sessão foi retomada',
  'an idle notice about another session': 'aviso de ociosidade sobre outra sessão',
  'a context-usage report': 'relatório de uso de contexto',
  'injected by the assistant': 'injetado pelo assistente',
}

export const ChatBubble = memo(function ChatBubble({ turn, lang, harness, provisional, awaiting, awaitingWorking, awaitingSinceMs, onReply, onReplyExcerpt, anchorId }: ChatBubbleProps) {
  const pt = lang === 'pt'
  const mine = turn.role === 'user'
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  /**
   * The RIGHT-CLICK menu, positioned where the click landed inside this bubble.
   *
   * The hover control is the discoverable way in and stays exactly where it was; this is the one
   * every messaging application has taught, and it is reachable without first finding a 24px
   * button that only appears when the pointer is over the right message.
   *
   * ONE ENTRY, deliberately. A context menu offered on a conversation invites "copy", "quote",
   * "open in the terminal" and four more, and each of those is a decision about what a session can
   * do that has not been made. Reply is the one this file already supports.
   */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (menuAt === null) return
    const close = () => setMenuAt(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuAt(null) }
    // `mousedown` rather than `click`, so it closes on the press; and on SCROLL too, because the
    // menu is anchored to a bubble that moves while the conversation does.
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menuAt])

  /**
   * The floating "reply to this excerpt" control, anchored where the selection ended.
   *
   * WHY IT EXISTS: a reply quotes the message, and the assistant's messages are long. Somebody
   * answering one sentence of a forty-line answer pays for the other thirty-nine in context they
   * are asking about nothing. Selecting the sentence is what they already do to read it.
   *
   * THE SELECTION MUST BE INSIDE THIS BUBBLE, both ends of it. A drag that starts in one message
   * and ends in another has a `toString()` that reads perfectly and belongs to neither turn, and
   * attributing it to one of them is inventing a quote. Containment is asked of the DOM rather
   * than by matching text: the bubble renders markdown, so what was selected legitimately differs
   * from `turn.text`, which is also why `markExcerpt` marks an unlocatable excerpt at both ends.
   *
   * THE TEXT IS CAPTURED NOW, not when the button is pressed: pressing a button collapses the
   * selection in some browsers, so reading it at click time reads an empty one.
   */
  const [excerpt, setExcerpt] = useState<{ x: number; y: number; text: string } | null>(null)
  const readSelection = useCallback(() => {
    if (!onReplyExcerpt || provisional) return
    const sel = window.getSelection()
    const body = bodyRef.current
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !body) { setExcerpt(null); return }
    if (!body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) { setExcerpt(null); return }
    const text = sel.toString().trim()
    if (text === '') { setExcerpt(null); return }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const box = body.getBoundingClientRect()
    setExcerpt({
      // Below the selection's own end, clamped inside the bubble so a selection at the right edge
      // does not put the control off the pane.
      x: Math.max(0, Math.min(rect.right - box.left, box.width - 150)),
      y: Math.min(rect.bottom - box.top + 6, box.height),
      text,
    })
  }, [onReplyExcerpt, provisional])
  useEffect(() => {
    if (excerpt === null) return
    // It goes away when the selection does — clicking elsewhere, or a keystroke that moves the
    // caret. A control offering to quote a selection that no longer exists quotes the old one.
    const check = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') setExcerpt(null)
    }
    document.addEventListener('selectionchange', check)
    window.addEventListener('scroll', () => setExcerpt(null), true)
    return () => {
      document.removeEventListener('selectionchange', check)
      window.removeEventListener('scroll', () => setExcerpt(null), true)
    }
  }, [excerpt])

  // An attachment is a PATH the composer typed into the pane (see `attachmentPreview.ts`'s header),
  // so it arrives in `turn.text` like any other line — pulled out here rather than at the source, so
  // the SAME rule reads an echoed message and its later transcript copy identically.
  const { images, text } = splitImageAttachments(turn.text)

  // A turn that said nothing AND attached nothing is not a message. Tool calls and reasoning are
  // the work between messages, and the row's state already reports that the session is working.
  if (text.trim() === '' && images.length === 0) return null

  // NOT a message, and not drawn as one: no avatar, no bubble, no side. A dim centred note naming
  // what the harness put in the transcript, so the reply below it still has something above it
  // while nobody is credited with having typed it.
  // A BACKGROUND TASK: a dim line, unattributed, that says whether it is still going. Drawn before
  // the system note below because it is the same kind of thing — a fact about the session rather
  // than something either side said — and it carries no bubble for the same reason.
  if (turn.task) {
    const running = turn.task.running
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 10.5, lineHeight: 1.4,
          color: running ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          padding: '3px 10px', borderRadius: 999,
          background: 'var(--bg-elevated)',
          border: `1px solid ${running ? 'color-mix(in srgb, var(--anthropic-orange) 40%, transparent)' : 'var(--border-subtle)'}`,
          maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {running
            ? <Loader size={11} className="ag-working-spin" style={{ flexShrink: 0 }} />
            : <Check size={11} style={{ flexShrink: 0 }} />}
          <span>
            {running
              ? (pt ? `em segundo plano: ${turn.task.label}` : `in the background: ${turn.task.label}`)
              : (pt ? `terminou: ${turn.task.label}` : `finished: ${turn.task.label}`)}
          </span>
        </span>
      </div>
    )
  }

  if (turn.system) {
    return (
      <div style={{
        display: 'flex', justifyContent: 'center', padding: '2px 0',
      }}>
        <span style={{
          fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)',
          padding: '3px 10px', borderRadius: 999,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {pt ? SYSTEM_NOTE_PT[turn.system] ?? turn.system : turn.system}
        </span>
      </div>
    )
  }

  const color = (HARNESS_COLORS as Record<string, string>)[harness] ?? 'var(--text-secondary)'
  const name = (HARNESS_LABELS as Record<string, string>)[harness] ?? harness

  return (
    <div className="ag-bubble" {...(anchorId ? { id: anchorId } : {})} style={{
      display: 'flex', gap: 10, minWidth: 0,
      flexDirection: mine ? 'row-reverse' : 'row',
      alignItems: 'flex-start',
    }}>
      {mine ? (
        <span
          aria-hidden
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: 26, height: 26, borderRadius: 7, marginTop: 2,
            background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
            color: 'var(--text-tertiary)',
          }}
        >
          <User size={13} />
        </span>
      ) : (
        <span style={{ marginTop: 2, display: 'flex' }}>
          <HarnessMark harness={harness} />
        </span>
      )}

      <div
        ref={bodyRef}
        onMouseUp={readSelection}
        onTouchEnd={readSelection}
        onContextMenu={e => {
          // Only where a reply is actually possible. Swallowing the browser's own menu to offer
          // one entry that is not there would be a control that teaches the wrong thing.
          if (!onReply || provisional) return
          e.preventDefault()
          const r = bodyRef.current?.getBoundingClientRect()
          setMenuAt(r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 8, y: 8 })
        }}
        style={{
        // `minWidth: 0` is what actually keeps wide content inside the card: without it a flex item
        // refuses to shrink below its content, and a long line pushes the bubble off the pane.
        minWidth: 0, maxWidth: mine ? '82%' : '100%',
        display: 'flex', flexDirection: 'column', gap: 6,
        background: mine ? 'var(--bg-elevated)' : 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 14, padding: '11px 14px', position: 'relative',
        // Faded while the session has not read it. The TEXT stays fully legible — this is a
        // statement about delivery, not about the message being less important to read back.
        opacity: awaiting ? 0.62 : 1,
        transition: 'opacity 0.2s',
      }}>
        {!mine && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
            color: provisional ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          }}>
            <span style={{ color }}>{name}</span>
            {provisional && (
              <>
                <span style={{ opacity: 0.4 }}>·</span>
                {/* Said in words: this text was read off a terminal screen, and the transcript's
                    own version replaces it the moment the turn lands. */}
                <span>{pt ? 'escrevendo — lido da tela' : 'writing — read from the screen'}</span>
              </>
            )}
          </div>
        )}

        {/* Reply. Revealed with the bubble rather than standing on every message — a column of
            controls down a conversation competes with the words. Always reachable by keyboard. */}
        {onReply && !provisional && (
          <button
            className="ag-bubble-reply"
            // THE SELECTION WINS. Reported: three words selected, reply pressed, and the whole
            // message was quoted — because this button and the excerpt pill were two controls and
            // the reader used the one that was already there. A selection inside this bubble is a
            // more specific statement of what is being answered than "this message", so it is what
            // gets quoted; with nothing selected the button means what it always meant.
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              if (excerpt && onReplyExcerpt) { const t = excerpt.text; setExcerpt(null); onReplyExcerpt(turn, t); return }
              onReply(turn)
            }}
            aria-label={pt ? 'Responder' : 'Reply'}
            title={excerpt
              ? (pt ? 'Responder ao trecho selecionado' : 'Reply to the selected excerpt')
              : (pt ? 'Responder' : 'Reply')}
            // POSITION only. Everything else — the size, the surface, and the `opacity: 0` the
            // hover reveals — lives in `.ag-bubble-reply`, because an inline style beats a
            // stylesheet rule without `!important`: written here, the reveal could never fire and
            // the control was invisible on every message, at every width, forever.
            style={{ position: 'absolute', top: 6, [mine ? 'left' : 'right']: 6 } as React.CSSProperties}
          >
            <CornerUpLeft size={12} />
          </button>
        )}

        {/* The right-click menu. Anchored inside the bubble at the point that was clicked. */}
        {menuAt && onReply && (
          <div
            role="menu"
            onMouseDown={e => e.stopPropagation()}
            style={{
              position: 'absolute', top: menuAt.y, left: menuAt.x, zIndex: 40,
              minWidth: 130, padding: 4, borderRadius: 9,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            }}
          >
            <button
              role="menuitem"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                setMenuAt(null)
                if (excerpt && onReplyExcerpt) { const t = excerpt.text; setExcerpt(null); onReplyExcerpt(turn, t); return }
                onReply(turn)
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                minHeight: 34, padding: '6px 8px', borderRadius: 6, border: 'none',
                background: 'transparent', color: 'var(--text-primary)',
                fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              <CornerUpLeft size={13} style={{ flexShrink: 0 }} />
              {excerpt
                ? (pt ? 'Responder ao trecho' : 'Reply to excerpt')
                : (pt ? 'Responder' : 'Reply')}
            </button>
          </div>
        )}

        {/* Reply to just what is selected. It is the only control that appears ON a selection, so
            it says which of the two replies it is in words — an icon alone here reads as the same
            button that is already sitting in the bubble's corner. */}
        {excerpt && onReplyExcerpt && (
          <button
            onMouseDown={e => {
              // The press must not collapse the selection before the click lands, and must not
              // reach the document listener that closes the menu.
              e.preventDefault(); e.stopPropagation()
            }}
            onClick={() => { const t = excerpt.text; setExcerpt(null); onReplyExcerpt(turn, t) }}
            style={{
              position: 'absolute', top: excerpt.y, left: excerpt.x, zIndex: 41,
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 9px', borderRadius: 8, minHeight: 30,
              background: 'var(--bg-elevated)', border: '1px solid var(--anthropic-orange)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <CornerUpLeft size={12} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
            {pt ? 'Responder ao trecho' : 'Reply to excerpt'}
          </button>
        )}

        {/* Small squares ABOVE the text — what was attached, rendered rather than left as a bare
            path nobody can read at a glance. Absent rows carry no rule of their own: an image that
            fails to load (moved, or outside `ATTACHMENT_DIR`) falls back to a plain chip with its
            name, never a broken-image icon with nothing to click. */}
        {images.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {images.map((path, i) => (
              <AttachmentThumb key={path} path={path} onOpen={() => setLightboxIndex(i)} />
            ))}
          </div>
        )}

        {text.trim() !== '' && (
          <div
            className="ag-chat-md"
            style={{
              // The base is inline as well as in the sheet: a bubble whose stylesheet failed should
              // still read as a message rather than as unstyled 14px page text.
              minWidth: 0, overflowWrap: 'anywhere',
              fontSize: 13.5, lineHeight: 1.65, color: 'var(--text-primary)',
            }}
          >
            {/* AN INVOCATION IS NOT PROSE. A message that opens with `/name` is a command to the
                harness, and in a column of prose it reads as prose. It is split off and drawn in
                the accent — the same colour the panel's "use this skill" button wears, so the
                thing you pressed and the thing that appears are visibly the same act. The rule is
                `slashLine.ts` and it is anchored: a `/home/...` path is not a command. */}
            {(() => {
              const { command, rest } = splitSlashLine(text)
              if (command === '') {
                return <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
              }
              return (
                <>
                  <span style={{
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontWeight: 650, color: 'var(--anthropic-orange)',
                  }}>{command}</span>
                  {rest.trim() !== '' && (
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{rest}</ReactMarkdown>
                  )}
                </>
              )
            })()}
          </div>
        )}

        {/* The label sits INSIDE the bubble, under the text: it is a fact about this message, and
            a line floating beside the bubble would read as another message. `role="status"` so a
            screen reader is told, since the fading alone says nothing to one. */}
        {awaiting && (() => {
          // The wording is `echoStatus`'s, not this file's — see it for why the sentence leads with
          // DELIVERY rather than with waiting.
          const st = echoStatus(awaitingSinceMs ?? null, awaitingWorking === true, pt ? 'pt' : 'en')
          return (
            <div role="status" style={{
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 10,
              // A wait long enough to be worth a second look is the ONLY one that changes colour.
              // Colouring every unread message would make the ordinary case look like a fault,
              // which is the mistake the old wording already made.
              color: st.notable ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              alignSelf: mine ? 'flex-end' : 'flex-start',
            }}>
              <Clock size={10} style={{ flexShrink: 0 }} />
              <span>{st.text}</span>
            </div>
          )
        })()}
      </div>

      {lightboxIndex !== null && (
        <AttachmentLightbox
          paths={images}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          lang={lang}
        />
      )}
    </div>
  )
})

/** One attachment, as a small square. Falls back to a plain chip when the image fails to load. */
function AttachmentThumb({ path, onOpen }: { path: string; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  const name = path.split('/').pop() ?? path

  if (broken) {
    return (
      <span
        title={path}
        style={{
          display: 'inline-flex', alignItems: 'center', maxWidth: 160,
          padding: '5px 8px', borderRadius: 8, minWidth: 0,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          fontSize: 11, color: 'var(--text-tertiary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
    )
  }

  return (
    <button
      onClick={onOpen}
      title={name}
      aria-label={name}
      style={{
        display: 'block', width: 72, height: 72, padding: 0, borderRadius: 9, overflow: 'hidden',
        border: '1px solid var(--border-subtle)', cursor: 'pointer', flexShrink: 0,
        background: 'var(--bg-elevated)',
      }}
    >
      <img
        src={attachmentUrl(path)}
        alt=""
        onError={() => setBroken(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </button>
  )
}
