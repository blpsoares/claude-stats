/**
 * SessionChat — one live session, read as a conversation.
 *
 * TWO SOURCES, each used for what it is good at, because neither can do the whole job:
 *
 * - The TRANSCRIPT (`/api/fleet/chat`) is the truth — role-tagged, complete, exactly what the
 *   assistant wrote. It arrives per TURN, because Claude writes a message to its JSONL once the
 *   message is finished. It can never stream token by token.
 * - The FRAME (`/api/fleet/stream`, captured twice a second) is live — it is the terminal, and the
 *   text appears on it as it is produced. But it is a rendered TUI, wrapped to the pane width with
 *   a status strip and an input box in it.
 *
 * So completed turns are bubbles from the transcript, and the turn IN FLIGHT is drawn from the
 * frame and replaced by the transcript's version the moment it lands. The live bubble is labelled
 * as read-from-the-screen and never becomes history: a misread frame is corrected within seconds,
 * while a misread turn kept as history would be wrong forever.
 *
 * A SENT MESSAGE IS ECHOED IMMEDIATELY. It reaches the session the instant it is typed into the
 * pane, but it only enters the transcript when the harness writes it, which is a poll or two later
 * — so pressing enter appeared to do nothing while the message had in fact been delivered. That was
 * reported. The echo is dropped as soon as the transcript carries the same text, so it can never
 * become a duplicate or survive a send that silently failed.
 *
 * WHERE IT CANNOT EXIST IT SAYS SO. The link from a live session to its transcript is exact only
 * for Claude Code, which names our tmux session in its own record. Everywhere else the server
 * refuses in words rather than showing some other conversation from the same directory under this
 * session's name — a confident wrong answer the reader has no way to detect.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronUp, CornerUpLeft, History, Loader, Mic, Paperclip, RotateCcw, Send, Square, X } from 'lucide-react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { FleetActionId, FleetRow } from '../../lib/fleet'
import { ApprovalCard } from './ApprovalCard'
import { ChatBubble, type ChatTurn } from './ChatBubble'
import { WorkingNote } from './WorkingNote'
import { useTerminalStream } from '../../hooks/useTerminalStream'
import { isImagePath } from '../../lib/attachmentPreview'
import { splitImageAttachments } from '../../lib/attachmentPreview'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { liveTurnText, stripAnsi } from '../../lib/liveTurn'
import { scratchKey, sessionScratch, type CachedChat } from '../../lib/sessionScratch'
import { composerMaxHeight } from '../../lib/composerHeight'
import { artifactsFromTurns, hasUnlistedWrites, type Artifact } from '../../lib/sessionArtifacts'
import type { LiveTurn } from '../../lib/artifactTabs'
import { MAX_ATTACHMENTS, attachmentRoom, planPaste } from '../../lib/pastePlan'
import { appendDictation, dictatedText, dictationError, dictationLocale, dictationSupport, insecureAlternative } from '../../lib/dictation'
import { modelSwitchLine, modelSwitchReason } from '../../lib/modelSwitch'
import {
  applySkill, emptyPickerReason, filterSkills, flattenGroups, groupSkills, slashMisplaced,
  slashQuery, stepSkill,
} from '../../lib/skillMenu'
import { markExcerpt, quoteFor, replyAuthor, replyPreview, type ReplyTarget } from '../../lib/replyQuote'
import { pendingEchoes } from '../../lib/echoMatch'
import {
  applyDraftRequest, consumeDraftRequest, getDraftRequest, useDraftRequest,
} from '../../lib/composerStore'
import { splitSlashLine } from '../../lib/slashLine'
import { lastSentMessage, turnAnchorId } from '../../lib/lastSent'
import { goToTurn } from '../../lib/turnScroll'
import { attachmentName, isImageAttachment, splitMessage } from '../../lib/messageAttachments'
import { overlayPadding } from '../../lib/mobileOverlay'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'

interface ChatPayload {
  turns: ChatTurn[]
  unavailable?: string
  live: boolean
  /** Already-localized: these turns are the END of a longer conversation. See `chat-web.ts`. */
  older?: string
}

export interface SessionChatProps {
  session: ControlSession
  /** The shaped row, which carries the parsed dialog and what may be done about it. */
  row?: FleetRow
  lang: 'pt' | 'en'
  act: (req: { id: string; action: FleetActionId; text?: string; choice?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
  /**
   * The files this session has touched, reported up as the conversation is read.
   *
   * The artifacts panel is a sibling of this component, not a child, and the list is derived from
   * the very turns this one already polls. Fetching the conversation a second time to build the
   * same list would be two pollers disagreeing about one session — so it is handed over instead.
   */
  onArtifacts?: (a: {
    artifacts: Artifact[]
    loading: boolean
    unavailable?: string
    /**
     * Already-localized: the conversation is a WINDOW onto a longer one.
     *
     * Handed over for the same reason the turns are: every list the panel builds is built from
     * these turns and inherits their cap, so the panel has to be able to say so instead of showing
     * an empty gallery that reads as "there was never anything here".
     */
    older?: string
    /** Writes this reader cannot name — see `hasUnlistedWrites`. */
    unlisted: boolean
    /** The turns themselves, for the panel's LIVE tab. Handed over rather than re-fetched. */
    turns: readonly LiveTurn[]
  }) => void
}

/** Matches the fleet poll. The transcript only changes when a turn lands, so faster buys nothing. */
const CHAT_POLL_MS = 3000

// How tall the composer's field may grow is `composerHeight.ts` — a share of the viewport rather
// than a constant, because a fixed number is most of a phone and a sliver of a desktop.

/**
 * How far from the bottom still counts as "at the tail", in px.
 *
 * Kept small on purpose: a working session's live terminal frame re-renders this view on every
 * frame the SSE channel delivers (`useTerminalStream`), and each one re-runs the follow effect
 * below. At the old 120px, scrolling up by less than one ordinary message bubble still read as
 * "at the tail" — so the very next frame yanked the reader straight back down mid-reply, which is
 * exactly the thing this whole mechanism exists to prevent.
 */
const TAIL_SLACK = 24

interface Attachment { name: string; path: string }

export function SessionChat({ session, row, lang, act, onArtifacts }: SessionChatProps) {
  const pt = lang === 'pt'
  /** Touch targets grow on a phone and nowhere else — 44px on a desktop is a row of buttons. */
  const isMobile = useIsMobile()
  /**
   * Both of these OUTLIVE this component, in `sessionScratch` — see that module for why they get
   * different storage.
   *
   * The conversation starts from the cache so returning to a session paints immediately instead of
   * showing an empty column while a fetch that reads a local file completes. The poll below still
   * fires on mount and replaces it, so the cache is never the answer, only the first frame.
   *
   * The draft starts from the person's own words. Losing typed text to a click is the one thing
   * here that cannot be recovered from anywhere — a conversation re-fetches, a paragraph does not.
   */
  /**
   * WHAT THE SCRATCH BELONGS TO — the conversation, never this row.
   *
   * One conversation is reachable through several rows: an `exited` managed row deliberately does
   * not cover its conversation, so the same conversation is also listed as a `closed:<id>` row you
   * can reopen, and every reopen mints a new managedId for it. Keyed on the row, closing a session
   * threw away its cached turns and the paragraph somebody had typed into it. See `scratchKey`.
   */
  const scratchId = scratchKey(session)

  const [payload, setPayload] = useState<ChatPayload | null>(() => sessionScratch.readChat(scratchId) as ChatPayload | null)
  const [draft, setDraft] = useState(() => sessionScratch.readDraft(scratchId))

  /**
   * Every change to the draft, PERSISTED against the session it belongs to.
   *
   * A `useEffect` on `[session.id, draft]` was the obvious shape and is wrong: on a switch it runs
   * once with the NEW id and the OLD draft still in state, which writes one session's half-written
   * prompt into another's slot. Naming the session at the moment of the edit removes that window
   * entirely — the id and the text are read together, so they can never disagree.
   */
  const editDraft = useCallback((next: string | ((prev: string) => string)) => {
    setDraft(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      sessionScratch.writeDraft(scratchId, v)
      return v
    })
  }, [scratchId])


  const shownId = useRef(scratchId)
  useEffect(() => {
    if (shownId.current === scratchId) return
    shownId.current = scratchId
    setPayload(sessionScratch.readChat(scratchId) as ChatPayload | null)
    setDraft(sessionScratch.readDraft(scratchId))
    setReplyTo(sessionScratch.readReply(scratchId))
  }, [scratchId])
  const [sending, setSending] = useState(false)
  /** Dictation. `recognitionRef` holds the live recogniser so a second click stops it. */
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  const dictation = useMemo(
    () => dictationSupport(typeof window === 'undefined' ? undefined : (window as never), pt ? 'pt' : 'en'),
    [pt],
  )
  /** The composer's "more options" menu — dictation and the model live in it. */
  const [moreOpen, setMoreOpen] = useState(false)
  /** The menu AND its button, so an outside-click handler can tell "inside" from "outside". */
  const moreMenuRef = useRef<HTMLDivElement | null>(null)

  /**
   * Start or stop dictation.
   *
   * The recognised text is APPENDED to the draft and nothing is sent: what reaches the session is
   * still what the user chose to send, exactly as if they had typed it. No audio leaves the
   * browser — the recognition is the browser's own, and this product uploads nothing.
   */
  const toggleDictation = useCallback(() => {
    if (listening) { recognitionRef.current?.stop(); return }
    const w = window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return
    try {
      const rec = new Ctor() as unknown as {
        lang: string; continuous: boolean; interimResults: boolean
        start: () => void; stop: () => void
        onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
        onend: (() => void) | null
        onerror: ((e: { error?: string }) => void) | null
      }
      rec.lang = dictationLocale(pt ? 'pt' : 'en')
      rec.continuous = true
      rec.interimResults = false
      // Both decisions are PURE and tested (`dictation.ts`): which results this event contributed,
      // and where they land in what is already typed. This loop used to read `e.results` from index
      // 0 on every event while `continuous` is true — and that list is CUMULATIVE, so every event
      // re-emitted the whole session and the draft grew "one", "one one two", "one one two one two
      // three". `resultIndex` is the index of the first result the event changed, which is exactly
      // what this event contributed.
      rec.onresult = e => { editDraft(d => appendDictation(d, dictatedText(e))) }
      // Both end the same way. A recogniser that stopped on its own (a timeout, a denied
      // permission) must not leave the button lit — a control that says it is listening when it
      // is not is worse than one that never started.
      rec.onend = () => { setListening(false); recognitionRef.current = null }
      rec.onerror = e => {
        setListening(false)
        recognitionRef.current = null
        // The REASON reaches the screen. This handler used to discard its event, so a refused
        // permission, an unreachable recognition service, a missing microphone and a moment of
        // silence all looked identical: the button lit up and went out. A button that fails
        // silently is indistinguishable from a broken one.
        setNotice(dictationError(e?.error ?? 'unknown', pt ? 'pt' : 'en'))
      }
      rec.start()
      recognitionRef.current = rec
      setListening(true)
    } catch {
      setListening(false)
    }
  }, [listening, pt])

  // A click anywhere else closes the model menu. Requiring a second click on the button is the
  // behaviour of a toggle, and a dropdown is not one — every menu in this app and every menu the
  // reader has used elsewhere dismisses on an outside click, so needing to find the button again
  // reads as the menu being stuck. `mousedown` rather than `click`, so it closes on the press
  // instead of waiting for a release that may land somewhere else.
  useEffect(() => {
    if (!moreOpen) return
    const close = (e: MouseEvent) => {
      // A click INSIDE the menu (picking a model) must not be eaten by this — that path closes the
      // menu itself, and closing here first would cancel the pick.
      if (moreMenuRef.current?.contains(e.target as Node)) return
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', close)
    // Escape too: a menu that can only be dismissed with the mouse is one a keyboard cannot leave.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  // A recogniser left running after this panel unmounts keeps the tab's microphone indicator on
  // for a session nobody is looking at.
  useEffect(() => () => { recognitionRef.current?.stop() }, [])

  /**
   * The models this harness offers, from `/api/fleet/new` — the SAME source the New session wizard
   * reads, so the two lists cannot disagree about what a harness accepts. Fetched once when the
   * picker is first opened rather than on mount: most sessions are read, not re-modelled.
   *
   * The LABEL is displayed and the ID is sent. `modelSwitch.ts` records what happens if that is
   * reversed: `/model` matches the id, so "Opus 5" typed into a live session answers
   * `Model 'Opus 5' not found` — a silent no-op the user reads as a successful switch.
   *
   * TWO SHAPES, because the labelled one may not be there. A server carrying `models`
   * (`{ id, label }`) is read as such; one that only knows `modelSuggestions` (bare ids) is read
   * as ids labelled by themselves, which is exactly today's behaviour. The web bundle can be newer
   * than the server it is talking to — that is the same reasoning `chatEnabled` and the BSON date
   * readers already follow — and the wrong answer here would be an EMPTY picker on a machine whose
   * `/model` works perfectly.
   */
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const modelReason = useMemo(() => modelSwitchReason(row?.harness ?? '', pt ? 'pt' : 'en'), [row, pt])
  useEffect(() => {
    if (modelReason || !row?.harness) return
    let alive = true
    fetch(`/api/fleet/new?lang=${pt ? 'pt' : 'en'}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: {
        harnesses?: { id: string; models?: { id: string; label: string }[]; modelSuggestions?: string[] }[]
      } | null) => {
        if (!alive || !d?.harnesses) return
        const h = d.harnesses.find(x => x.id === row.harness)
        setModels(h?.models ?? (h?.modelSuggestions ?? []).map(id => ({ id, label: id })))
      })
      .catch(() => { /* no list, no picker — the control simply does not appear */ })
    return () => { alive = false }
  }, [row?.harness, modelReason, pt])

  /**
   * The session's skills. Fetched when the menu is FIRST opened, not on mount: most sessions are
   * read rather than driven, and answering this walks directories on the host.
   *
   * `null` means "not asked yet" and is not the same as `[]`, which is a real "this harness has
   * none" — the same distinction the fleet's own pollers keep between a failed read and an empty
   * one. `skillsNote` carries the server's sentence when there is one.
   */
  const [skills, setSkills] = useState<{ name: string; description: string }[] | null>(null)
  const [skillsNote, setSkillsNote] = useState<string | null>(null)

  /**
   * TYPING `/` OPENS THE PICKER. Every decision it can get wrong is in `skillMenu.ts` — when the
   * trigger is live, how the list groups, how it filters, and what an insertion writes.
   *
   * The caret is tracked because the trigger is read from the text BEFORE it, not from the whole
   * draft: a `/` typed into the middle of a paragraph is not an invocation, and a picker that
   * opened there would take the arrow keys from someone writing prose.
   */
  const [caret, setCaret] = useState(0)
  /**
   * Escape closes the picker while the `/word` it was triggered by is still on screen. Reset when
   * the trigger goes away, so the NEXT command opens it again — a picker dismissed once and
   * permanently is a control that stops working with no way to tell why.
   */
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const skillPickerRef = useRef<HTMLDivElement | null>(null)
  const slashText = useMemo(() => slashQuery(draft.slice(0, caret)), [draft, caret])
  useEffect(() => { if (slashText === null) setSlashDismissed(false) }, [slashText])
  // A new query is a new list; keeping the old index would leave the highlight on whichever entry
  // happens to sit at that position now, which is not the one anybody was looking at.
  useEffect(() => { setSlashIndex(0) }, [slashText])
  const slashGroups = useMemo(() => {
    if (slashText === null || skills === null) return []
    return groupSkills(filterSkills(skills, slashText), pt ? 'pt' : 'en')
  }, [skills, slashText, pt])
  const slashFlat = useMemo(() => flattenGroups(slashGroups), [slashGroups])
  // Keep the highlighted entry in view. The list scrolls internally, so a cursor stepped past the
  // fold is invisible and still the thing enter acts on — the same defect the cockpit's own lists
  // record. `nearest`, so it never yanks the list around for an entry already on screen.
  useEffect(() => {
    const el = skillPickerRef.current?.querySelector(`[data-skill-index="${slashIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashGroups])
  /**
   * Narrow the skill list.
   *
   * A real machine here has 49 of them, in a box 180px tall — scrolling that to find one is the
   * same as not having the list. Matching is on the NAME and the DESCRIPTION, because half of these
   * are named for what they are (`superpowers:brainstorming`) and half for a tool
   * (`wrangler`), and only the description tells you which is which.
   */
  const [skillQuery, setSkillQuery] = useState('')
  const shownSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase()
    if (q === '' || skills === null) return skills ?? []
    return skills.filter(sk =>
      sk.name.toLowerCase().includes(q) || sk.description.toLowerCase().includes(q))
  }, [skills, skillQuery])
  useEffect(() => {
    // `session.id`, never `row?.id`: `row` is an OPTIONAL prop and its absence silently skipped the
    // fetch, so the menu sat on "Reading…" forever and looked like a machine with no skills
    // installed. The route takes a session id, and `session` is the required prop — there is no
    // reason for this to depend on the other one being present.
    // TWO ways in now: the menu, and a `/` typed into the field. The list is the same list, so it
    // is read once and shared — a second fetch per door would walk the host's directories twice.
    if ((!moreOpen && slashText === null) || skills !== null) return
    let alive = true
    fetch(`/api/fleet/skills?id=${encodeURIComponent(session.id)}&lang=${pt ? 'pt' : 'en'}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { skills?: { name: string; description: string }[]; reason?: string } | null) => {
        if (!alive) return
        setSkills(d?.skills ?? [])
        setSkillsNote(d?.reason ?? null)
      })
      .catch(() => { if (alive) setSkills([]) })
    return () => { alive = false }
  }, [moreOpen, slashText, skills, session.id, pt])

  /** Switch the model mid-conversation by TYPING the harness's own command — see modelSwitch.ts. */
  const switchModel = useCallback(async (model: string) => {
    const line = modelSwitchLine(row?.harness ?? '', model)
    setMoreOpen(false)
    if (!line) return
    await act({ id: row!.id, action: 'prompt', text: line })
  }, [row, act])

  const [notice, setNotice] = useState<string | null>(null)
  const [atTail, setAtTail] = useState(true)
  /**
   * THE LAST MESSAGE YOU SENT — the modal, and which of its two faces is showing.
   *
   * `null` is closed. `'ask'` is the three options; `'text'` is the message itself, read inside the
   * modal rather than by hunting for it in the conversation.
   */
  const [recall, setRecall] = useState<'ask' | 'text' | null>(null)
  // Escape closes it. A dialog that can only be dismissed with the mouse is one a keyboard cannot
  // leave — the same rule the composer's "more options" menu already follows.
  useEffect(() => {
    if (recall === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRecall(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [recall])
  /** Messages sent from here and not yet seen in the transcript. See the header. */
  const [echo, setEcho] = useState<string[]>(() => sessionScratch.readEchoes(scratchId))

  /**
   * Every change to the echo list, persisted against the session it belongs to.
   *
   * Same shape as `editDraft`, and the same reason: a message that was DELIVERED and has not
   * reached the transcript yet has no other copy anywhere. Losing it to a navigation is losing the
   * only record that it was sent — reported as "mandei pela interface e ele simplesmente sumiu".
   */
  const editEcho = useCallback((next: string[] | ((prev: string[]) => string[])) => {
    setEcho(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      sessionScratch.writeEchoes(scratchId, v)
      return v
    })
  }, [scratchId])

  /**
   * The message being replied to.
   *
   * There is no reply THREAD to send: the transport types a line into a pane, and these CLIs have
   * one linear conversation. So a reply is a QUOTE — the quoted lines are prefixed with `> ` and
   * sent above what you write, which is what the assistant will actually see and is the same thing
   * mail has always done. Saying it plainly beats a UI that implies threading the session cannot do.
   */
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(
    () => sessionScratch.readReply(scratchId),
  )

  /**
   * Every change to the reply target, PERSISTED against the session it belongs to.
   *
   * IT IS KEPT, and that is a decision rather than an oversight: the quote is PREPENDED at send
   * time, so a draft restored without its target sends a different message from the one that was
   * composed — the same half-restore the attachments already avoid. It is safe to keep because it
   * is TEXT and not a pointer: the quote is a copy of what the turn said, so nothing has to resolve
   * against a transcript that has since been re-fetched. Same shape as `editDraft`, and the same
   * reason for that shape — the id and the value are read together, so a session switch can never
   * write one conversation's reply into another's slot.
   */
  const editReply = useCallback((next: ReplyTarget | null) => {
    sessionScratch.writeReply(scratchId, next)
    setReplyTo(next)
  }, [scratchId])
  /**
   * Files written to THIS MACHINE, whose paths go into the message.
   *
   * That is what an attachment can be here: the composer types a line into a tmux pane, so there is
   * no channel a byte array could travel down — but every one of these CLIs reads a file it is
   * pointed at. The chip says the name; the message carries the path.
   */
  const [attached, setAttached] = useState<Attachment[]>(() => sessionScratch.readAttachments(scratchId))

  /**
   * Every change to the attachment list, persisted against the session it belongs to — the same
   * shape and the same reason as `editDraft`. An attachment IS part of what somebody composed:
   * restoring the words and dropping the image is a half-restore, reported as exactly that.
   */
  const editAttached = useCallback((next: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
    setAttached(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      sessionScratch.writeAttachments(scratchId, v)
      return v
    })
  }, [scratchId])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** Has this conversation been placed at its end yet? Opening mid-history is disorienting. */
  const landedRef = useRef(false)

  /**
   * Insert the picked skill into the draft. IT DOES NOT SEND — that rule already exists in the
   * "more options" menu and does not change here: most skills take an argument, and what reaches
   * the session is what the person chose to send.
   *
   * The caret is restored on the NEXT frame because React has to have written the new value into
   * the field before a selection range inside it means anything.
   */
  const insertSkill = useCallback((name: string) => {
    const at = textareaRef.current?.selectionStart ?? caret
    const out = applySkill(draft, at, name)
    editDraft(out.text)
    setCaret(out.caret)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(out.caret, out.caret)
    })
  }, [draft, caret, editDraft])

  /**
   * A different session is a different conversation — but "different" is not "unknown".
   *
   * This used to blank everything, INCLUDING the payload, and it ran on mount as well as on a
   * switch: so a cached conversation was wiped one tick after it was read, and the empty column the
   * cache exists to remove came straight back. It restores from `sessionScratch` instead, which is
   * the single place a switch is handled now.
   *
   * What is genuinely per-conversation and NOT restorable still goes: the scroll position, because
   * opening mid-history is disorienting. Everything else is READ BACK from the other session's own
   * slot — including the reply target, which used to be blanked here: it names a turn in the OTHER
   * conversation, so it may never survive the switch, but each session keeps its own and gets it
   * back. What must never happen is one session's quote appearing under another's name, and a
   * per-id read is what rules that out.
   */
  useEffect(() => {
    landedRef.current = false
    setAtTail(true)
    setReplyTo(sessionScratch.readReply(scratchId))
    setEcho(sessionScratch.readEchoes(scratchId))
    setPayload(sessionScratch.readChat(scratchId) as ChatPayload | null)
    setDraft(sessionScratch.readDraft(scratchId))
    setAttached(sessionScratch.readAttachments(scratchId))
  }, [scratchId])

  /** The ceiling, re-measured when the window changes size. */
  const [maxComposerH, setMaxComposerH] = useState(() => composerMaxHeight(
    typeof window === 'undefined' ? 0 : window.innerHeight,
  ))
  useEffect(() => {
    const read = () => setMaxComposerH(composerMaxHeight(window.innerHeight))
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])

  /**
   * Grow the field WITH the draft, up to the ceiling, then let it scroll internally.
   *
   * `rows={1}` plus a CSS `maxHeight` alone never grows: a textarea's own height stays fixed at
   * its `rows` unless something sets it explicitly, so a multi-line draft either scrolled inside a
   * single visible line or was invisible past it — "I can't see my own prompt". Resetting to
   * `'auto'` before reading `scrollHeight` is required: skip it and a field that GREW once can only
   * ever read its own (already tall) scrollHeight back, so deleting text never shrinks it again.
   */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxComposerH)}px`
  }, [draft, maxComposerH])

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch(`/api/fleet/chat?id=${encodeURIComponent(session.id)}&lang=${lang}`)
        if (!res.ok || !alive) return
        const next = await res.json() as ChatPayload
        setPayload(next)
        // Write through, so the NEXT visit starts where this one ended.
        sessionScratch.writeChat(scratchId, next as unknown as CachedChat)
      } catch { /* transient — keep the last conversation rather than blanking it */ }
    }
    void poll()
    const t = setInterval(poll, CHAT_POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [session.id, lang])

  const working = session.state === 'working'
  const { state: term } = useTerminalStream(working ? session.id : null)

  const turns = useMemo(() => payload?.turns ?? [], [payload])

  /**
   * The last message the PERSON sent, echoes included. Every exclusion is in `lastSent.ts` — the
   * transcript files things nobody typed under the user's own role, and recalling one of those as
   * "your last message" is the defect `chat-envelope.ts` already exists to have fixed once.
   *
   * `null` means they have not sent one, and the control is then ABSENT rather than inert: a button
   * whose only outcome is a modal saying "nothing" is a control that exists to refuse.
   */
  const lastSent = useMemo(() => lastSentMessage(turns, echo), [turns, echo])

  /**
   * When each echo was first seen, so its bubble can say how long it has been waiting.
   *
   * Not persisted, and that is deliberate: an echo restored from storage after a reload has an
   * age this tab cannot know, and `echoStatus` shows none rather than measuring from the reload —
   * a duration that restarts when you refresh is worse than no duration at all.
   */
  const echoSeen = useRef(new Map<string, number>())
  useEffect(() => {
    const m = echoSeen.current
    for (const t of echo) if (!m.has(t)) m.set(t, Date.now())
    for (const t of [...m.keys()]) if (!echo.includes(t)) m.delete(t)
  }, [echo])

  /** A clock, so an ageing echo ages on screen instead of freezing at its first render. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (echo.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [echo.length])

  // Retire an echo the moment the transcript carries it — CONTAINMENT, not equality, because a
  // busy harness commits its whole queue as ONE user turn and each message is then a substring of
  // what was stored. See `echoMatch.ts` for the measurement that forced this.
  useEffect(() => {
    if (echo.length === 0) return
    const userTurns = turns.filter(t => t.role === 'user').map(t => t.text)
    editEcho(list => {
      const kept = pendingEchoes(list, userTurns)
      return kept.length === list.length ? list : kept
    })
  }, [turns, echo.length, editEcho])

  // A finished background-task line is `role: 'assistant'` and carries no `pending` any more, so it
  // would otherwise be taken as the assistant's last MESSAGE — and its label would be compared
  // against the live terminal frame. It is a status line; nobody said it.
  const lastAssistant = [...turns].reverse()
    .find(t => t.role === 'assistant' && !t.pending && !t.task && t.text.trim() !== '')

  const live = useMemo(() => {
    if (!term.frame) return null
    return liveTurnText({
      // The frame carries the emulator's escape sequences; the chat wants the words.
      lines: stripAnsi(term.frame.content).split('\n'),
      ...(lastAssistant ? { lastCommitted: lastAssistant.text } : {}),
      working,
    })
  }, [term.frame, lastAssistant, working])

  const toTail = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  /**
   * Take the reader to the recalled message and MARK it.
   *
   * A scroll on its own answers nothing on a column of similar-looking bubbles — "it moved, to
   * which one?" — so the bubble flashes and the class is removed afterwards, leaving nothing on the
   * page marked. If the element is not there (the transcript was re-fetched between opening the
   * modal and pressing the button, and the turn is no longer rendered) the modal SAYS so instead of
   * a button that silently does nothing.
   */
  const goToMessage = useCallback(() => {
    if (!lastSent) return
    setAtTail(false)
    // `goToTurn` is the ONE implementation of this gesture — the gallery's right-click menu offers
    // it too, and two copies would be two chances to disagree about which element they look for.
    if (!goToTurn(lastSent.kind, lastSent.index)) {
      setNotice(pt
        ? 'Essa mensagem não está mais na conversa carregada.'
        : 'That message is no longer in the loaded conversation.')
    }
  }, [lastSent, pt])

  /**
   * A line the PANEL asked this composer to hold — the skills tab's "use this skill".
   *
   * Keyed on the STAMP, so asking twice for the same skill works; scoped to the session it named,
   * so a request can never land in another conversation's box. It APPENDS and never sends: what
   * reaches a session is what the person pressed enter on.
   */
  /** The leading `/skill` of what is typed, for the field's own marker. See `slashLine.ts`. */
  const slashDraft = useMemo(() => splitSlashLine(draft), [draft])
  /**
   * A `/` typed where a command cannot be — see `slashMisplaced`.
   *
   * The picker not opening there is CORRECT; the silence is what made it read as unreliable
   * ("nem sempre ele ta identificando"). One line, only while the slash is the last thing typed,
   * and it disappears the moment anything else is.
   */
  const slashHint = useMemo(() => slashMisplaced(draft.slice(0, caret)), [draft, caret])
  const underlayRef = useRef<HTMLDivElement | null>(null)

  const draftReq = useDraftRequest()
  const draftReqAt = draftReq?.sessionId === session.id ? draftReq.at : undefined
  /**
   * The stamp this composer arrived with, so a request made BEFORE it existed is never applied.
   *
   * Two guards, because they cover different halves of the same accident. The store is cleared when
   * a request is taken (`consumeDraftRequest`), which stops it being re-applied on every remount —
   * and mounting is what going back to a session is. This ref covers the moment before that: a
   * composer that mounts while a request is still in flight for ANOTHER session, or an ask that
   * was never consumed because nothing was mounted to take it.
   */
  const seenReqAt = useRef<number | undefined>(getDraftRequest()?.at)
  useEffect(() => {
    if (draftReqAt === undefined || !draftReq) return
    if (seenReqAt.current === draftReqAt) return
    seenReqAt.current = draftReqAt
    editDraft(d => applyDraftRequest(d, draftReq.text))
    textareaRef.current?.focus()
    consumeDraftRequest(draftReqAt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftReqAt])

  /** ONE stable reference for every bubble's reply button — see `ChatBubble`'s memo. */
  const onReplyToTurn = useCallback((t: ChatTurn) => {
    editReply({ role: t.role, text: t.text }); setAtTail(true); toTail()
  }, [toTail, editReply])

  /**
   * Reply to the SELECTED PART of an assistant turn.
   *
   * The same act as `onReplyToTurn` with a different target, so it goes through the same composer
   * bar and the same send path — what changes is decided in `replyQuote.ts`: the excerpt travels
   * whole rather than capped at four lines, and is marked at whichever ends it does not reach.
   *
   * A selection that trims to nothing is dropped rather than clearing an existing reply target: a
   * stray drag must not throw away the message the user had already chosen to answer.
   */
  const onReplyToExcerpt = useCallback((t: ChatTurn, selected: string) => {
    const text = markExcerpt(t.text, selected)
    if (text === '') return
    editReply({ role: t.role, text, excerpt: true }); setAtTail(true); toTail()
  }, [toTail, editReply])

  /**
   * Land at the END on first paint, then follow the tail only while the reader is already there.
   *
   * `useLayoutEffect` for the landing: with a plain effect the conversation paints at the top and
   * then jumps, which is exactly the flash this exists to avoid. Following is conditional because
   * yanking the view down while somebody reads earlier history is the worst thing a live view does.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || payload === null) return
    if (!landedRef.current) { el.scrollTop = el.scrollHeight; landedRef.current = true; return }
    if (atTail) el.scrollTop = el.scrollHeight
  }, [turns.length, live, payload, atTail, echo.length])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtTail(el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_SLACK)
  }, [])

  const blocked = (session.approvalLines?.length ?? 0) > 0
  const loading = payload === null

  /**
   * Hand the artifact list to whoever is drawing the panel.
   *
   * Derived from the same `turns` the conversation renders, so the two can never disagree about
   * what this session wrote.
   */
  const artifacts = useMemo(() => artifactsFromTurns(turns), [turns])
  useEffect(() => {
    onArtifacts?.({
      artifacts,
      loading,
      unlisted: hasUnlistedWrites(turns),
      turns,
      ...(payload?.unavailable ? { unavailable: payload.unavailable } : {}),
      ...(payload?.older ? { older: payload.older } : {}),
    })
  }, [artifacts, loading, turns, payload?.unavailable, payload?.older, onArtifacts])

  const canPrompt = !loading && session.actionable && !blocked && payload.live !== false
  /**
   * The `/` picker is open.
   *
   * It inherits the `prompt` action's refusals exactly as the menu's list does — a slash typed
   * into a session sitting on a permission prompt goes into that dialog's own filter, and the
   * submit takes the highlighted option. Where it cannot be offered it is ABSENT: the field itself
   * is already disabled there, so there is nothing to type a `/` into and no control left inert.
   */
  const skillPickerOpen = canPrompt && !blocked && !slashDismissed && slashText !== null
  /** The row's own reopen verb, if it has one. Enabled by the server, never inferred here. */
  const reopen = row?.verbs.find(v => v.action === 'resume')
  const [reopening, setReopening] = useState(false)
  /**
   * Stop the CURRENT turn, without ending the session — the composer's own "esc". Lives here, next
   * to the field, rather than in the panel's header: it is the one thing reached for WHILE something
   * is running, and it does not touch `canPrompt` — typing and sending stay live the whole time, so
   * a reply queued while it works is not blocked on stopping it first. Absent unless the row can
   * take it, since a stop control on an idle session would send Escape into its prompt.
   */
  const stopVerb = row?.verbs.find(v => v.action === 'interrupt')
  const [stopping, setStopping] = useState(false)
  async function stopNow() {
    if (!stopVerb?.enabled || stopping) return
    setStopping(true)
    const out = await act({ id: session.id, action: 'interrupt' })
    setStopping(false)
    if (!out.ok) setNotice(out.message)
  }

  async function reopenNow() {
    if (!reopen?.enabled || reopening) return
    setReopening(true)
    const out = await act({ id: session.id, action: 'resume' })
    setReopening(false)
    setNotice(out.message)
    // The new row arrives on the next fleet poll under a NEW id; the page follows it there. Nothing
    // to do here but say what happened — navigating from inside the composer would be this
    // component deciding where the app goes.
  }

  /**
   * What the session is DOING, from the newest ASSISTANT turn.
   *
   * The newest turn of all is frequently the user's own message, which carries no tools — reading
   * it meant the actions vanished the instant you sent something.
   */
  const newestAssistant = useMemo(
    () => [...turns].reverse().find(t => t.role === 'assistant'),
    [turns],
  )

  /**
   * The working note shows whenever the session is busy, INCLUDING while there is live text.
   *
   * They are different facts: the live bubble is what the assistant is SAYING, the note is what it
   * is DOING. Gating the note on the absence of live text hid the actions for exactly as long as
   * the screen had anything on it, which is most of the time a session is working.
   */
  const showWorking = working && !loading

  async function upload(files: readonly File[]): Promise<void> {
    if (files.length === 0) return
    setUploading(true)
    for (const file of files) {
      const body = new FormData()
      body.append('file', file)
      try {
        const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body })
        const json = await res.json() as { ok: boolean; path?: string; name?: string; message?: string }
        if (json.ok && json.path && json.name) {
          editAttached(a => [...a, { name: json.name!, path: json.path! }])
        } else {
          setNotice(json.message ?? (pt ? 'O anexo falhou.' : 'The attachment failed.'))
        }
      } catch {
        setNotice(pt ? 'Erro de rede ao enviar o anexo.' : 'Network error uploading the attachment.')
      }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  function pick(list: FileList | null): void {
    if (!list) return
    const room = attachmentRoom(attached.length)
    const files = Array.from(list).slice(0, room)
    if (files.length < list.length) {
      setNotice(pt
        ? `No máximo ${MAX_ATTACHMENTS} anexos por mensagem.`
        : `At most ${MAX_ATTACHMENTS} attachments per message.`)
    }
    void upload(files)
  }

  /**
   * A paste is three different things and `planPaste` decides which — see that module.
   *
   * The handler only PREVENTS the default when it is doing something else with the clipboard; an
   * ordinary paste falls through to the textarea, which handles the caret and the undo stack better
   * than any manual insert.
   */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    if (!canPrompt) return
    const plan = planPaste({
      files: Array.from(e.clipboardData.files),
      text: e.clipboardData.getData('text/plain'),
      existing: attached.length,
    })
    if (plan.kind === 'text') return
    e.preventDefault()
    if (plan.kind === 'files') { void upload(plan.files); return }
    if (plan.kind === 'textFile') {
      // Too big to type into a pane. Attached as a file instead, and the chip says so.
      void upload([new File([plan.text], plan.name, { type: 'text/plain' })])
      setNotice(pt
        ? 'O texto colado era grande demais para digitar na sessão, então foi anexado como arquivo.'
        : 'The pasted text was too large to type into the session, so it was attached as a file.')
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!canPrompt) return
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    pick(e.dataTransfer.files)
  }

  async function send() {
    const text = draft.trim()
    // A message that is ONLY attachments is still a message: the paths are the content.
    if ((text === '' && attached.length === 0) || sending) return
    // Paths first, on their own lines, then what was typed — the assistant reads the files it is
    // pointed at, and burying the paths inside a sentence makes them easy to miss.
    // Quote first, then the paths, then what was typed. The quote is trimmed to a few lines: a
    // reply that repeats forty lines back at the session costs it context for no benefit.
    const quote = replyTo ? quoteFor(replyTo) : ''
    const full = [quote, ...attached.map(a => a.path), text].filter(x => x !== '').join('\n')
    setSending(true)
    const out = await act({ id: session.id, action: 'prompt', text: full })
    setSending(false)
    if (out.ok) {
      // Echoed straight away. It is already in the session; the transcript catches up in a poll or
      // two, and this is what makes pressing enter visibly do something.
      editEcho(list => [...list, full])
      setDraft('')
      sessionScratch.clearDraft(scratchId)
      setAttached([])
      sessionScratch.writeAttachments(scratchId, [])
      editReply(null)
      setAtTail(true)
      toTail()
      setNotice(null)
      return
    }
    setNotice(out.message)
  }

  if (payload?.unavailable) {
    return (
      <Centered>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
          {payload.unavailable}
        </p>
        <p style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--text-tertiary)', opacity: 0.8 }}>
          {pt
            ? 'A visão de terminal continua disponível para esta sessão.'
            : 'The terminal view is still available for this session.'}
        </p>
      </Centered>
    )
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      onDragOver={e => { if (canPrompt && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={onDrop}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '20px 20px 8px' }}
      >
        <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {loading ? (
            <Loading pt={pt} />
          ) : turns.length === 0 && live === null && echo.length === 0 ? (
            <Muted text={pt ? 'Esta conversa ainda não tem mensagens.' : 'This conversation has no messages yet.'} />
          ) : null}

          {/* Where the window BEGINS, said at the top of the scroll — the one place a reader looks
              when they wonder where the rest went. Everything derived from these turns (the
              gallery, Files, Live) inherits the same cap and says so in its own panel. */}
          {!loading && payload?.older && (
            <p style={{
              margin: 0, textAlign: 'center', fontSize: 11, lineHeight: 1.5,
              color: 'var(--text-tertiary)',
            }}>{payload.older}</p>
          )}

          {turns.map((t, i) => (
            <ChatBubble
              key={i}
              turn={t}
              lang={lang}
              harness={session.harness}
              anchorId={turnAnchorId('turn', i)}
              {...(canPrompt ? { onReply: onReplyToTurn } : {})}
              {
                // Only on the assistant's side: quoting a fragment of your OWN message back at the
                // session says nothing it did not already read from you a moment ago.
                ...(canPrompt && t.role === 'assistant' ? { onReplyExcerpt: onReplyToExcerpt } : {})
              }
            />
          ))}

          {/* An echo IS an unread message by definition — it is retired the instant the transcript
              carries the same text — so it is drawn as one: faded, with the wait said in words
              under it. It used to be indistinguishable from a delivered message, and on a session
              mid-turn the wait is minutes. */}
          {echo.map((text, i) => (
            <ChatBubble
              key={`echo-${i}`}
              turn={{ role: 'user', text }}
              lang={lang}
              harness={session.harness}
              anchorId={turnAnchorId('echo', i)}
              awaiting
              awaitingWorking={working}
              {...(echoSeen.current.get(text) !== undefined
                ? { awaitingSinceMs: now - echoSeen.current.get(text)! }
                : {})}
            />
          ))}

          {/* `live` (the screen read off the terminal frame) is deliberately NOT rendered here any
              more — it used to show as a full-size bubble, and a CLI's own screen carries its own
              chrome (a footer like "auto mode on · esc to interrupt") that `liveTurn.ts`'s line
              filter cannot promise to catch for every harness, so a raw, oversized read-from-the-
              screen block was both the wrong SIZE for a "something is happening" signal and the
              wrong PLACE for whatever chrome slipped through. `live` still drives the follow-the-
              tail effect below (new screen content is a sign to keep scrolling), and `WorkingNote`
              is the one and only "the session is busy" indicator now — small, grey, no raw text. */}

          {/* The quiet line saying the session is busy. AFTER the messages, deliberately not styled
              as one — it is the only place the reasoning and the tool calls surface, and rendering
              those as chat entries buried the sentences actually addressed to the user. */}
          {showWorking && (
            <WorkingNote
              lang={lang}
              {...(newestAssistant?.tools ? { tools: newestAssistant.tools } : {})}
              thinking={Boolean(newestAssistant?.thinking)}
            />
          )}

          {/* The question, at the BOTTOM of the conversation, where the next thing to happen goes.
              It is not in the transcript — a dialog lives on the screen and is never written to the
              JSONL — so it arrives on the fleet row instead. */}
          {blocked && row && <ApprovalCard row={row} lang={lang} act={act} />}
        </div>
      </div>

      {/* PINNED, and on its OWN surface. It never scrolls with the conversation — replying to
          something further up used to mean scroll down, write, scroll back — and it is a shade
          apart from the bubbles, which are `--bg-card` on `--bg-base`: at the same value it read as
          another message rather than as the place you type. */}
      <div className="ag-composer-ground" style={{
        // `sticky` alongside `flexShrink:0` for the same reason the header above takes both — a
        // scroll-away ancestor anywhere between here and the viewport must not carry this off with
        // it, and sticky is the guarantee that holds even then.
        position: 'sticky', bottom: 0, flexShrink: 0,
        // NO border and NO surface of its own. This used to be a full-width footer bar with a rule
        // across the top, which read as a region of the page rather than as a control — and the
        // thing people recognise as "where I type" is a bounded field, not a strip. The FIELD
        // below carries the border now; this element only positions it.
        //
        // `background: transparent` is what left the conversation CUT here rather than passing
        // under: transparent is not a ground, it is the absence of one, so a message simply ended
        // at this element's top edge. `.ag-composer-ground` draws the blur-and-fade behind it. The
        // FIELD keeps its own opaque surface and border — that is deliberate and recorded above.
        padding: '10px 20px 16px',
        background: 'transparent',
      }}>
        {/* Back to the end. Only while the reader has actually scrolled away — a control that is
            always there teaches nothing about where you are. */}
        {!atTail && !loading && (
          <button
            onClick={() => { setAtTail(true); toTail() }}
            aria-label={pt ? 'Ir para a última mensagem' : 'Jump to the latest message'}
            title={pt ? 'Ir para a última mensagem' : 'Jump to the latest message'}
            style={{
              position: 'absolute', top: -46, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 34, height: 34, borderRadius: 17, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)', boxShadow: 'var(--ag-shadow-pop)',
            }}
          >
            <ArrowDown size={16} />
          </button>
        )}

        {/* `relative` so the `/` picker can float ABOVE the field instead of pushing it down —
            growing the composer under somebody's fingers moves the field they are typing in. */}
        <div style={{ maxWidth: 820, margin: '0 auto', position: 'relative' }}>
          {/* THE SKILL PICKER, opened by typing `/` at the start of a line. Above the field, over
              the conversation, listing what this session can be asked to run — GROUPED BY PACKAGE,
              because 49 flat entries is the same as not having a list. It writes `/<name> ` into
              the draft and does not send. */}
          {skillPickerOpen && (
            <div
              ref={skillPickerRef}
              role="listbox"
              aria-label="Skills"
              style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 60,
                marginBottom: 8, padding: 4, borderRadius: 12,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                boxShadow: '0 10px 30px rgba(0,0,0,0.38)',
                maxHeight: isMobile ? '50vh' : 300, overflowY: 'auto', overscrollBehavior: 'contain',
              }}
            >
              {skills === null ? (
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  {pt ? 'Lendo as skills…' : 'Reading the skills…'}
                </p>
              ) : skillsNote ? (
                /* The PERMANENT fact, in the machine's own words: a harness that can never take a
                   skill is told so rather than shown an empty list it will read as a broken
                   install. */
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                  {skillsNote}
                </p>
              ) : slashFlat.length === 0 ? (
                <p style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                  {emptyPickerReason(skills.length, slashText ?? '', pt ? 'pt' : 'en')}
                </p>
              ) : (
                <>
                  {slashGroups.map(group => (
                    <div key={group.label}>
                      {/* The package's name. `pkg` is what the plugin is called; the loose group
                          carries a SENTENCE instead, never a blank heading. */}
                      <p style={{
                        margin: '4px 8px 2px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: group.pkg === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)',
                      }}>
                        {group.label}
                      </p>
                      {group.skills.map(sk => {
                        const at = slashFlat.indexOf(sk)
                        const active = at === Math.min(slashIndex, slashFlat.length - 1)
                        return (
                          <button
                            key={sk.name}
                            role="option"
                            aria-selected={active}
                            data-skill-index={at}
                            title={sk.description}
                            // The press must not blur the field: focus is what holds the caret the
                            // insertion writes against.
                            onMouseDown={e => e.preventDefault()}
                            onMouseEnter={() => setSlashIndex(at)}
                            onClick={() => insertSkill(sk.name)}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              minHeight: isMobile ? 44 : 34, padding: '6px 8px', borderRadius: 8,
                              border: 'none', background: active ? 'var(--bg-surface)' : 'transparent',
                              color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12.5,
                              cursor: 'pointer', minWidth: 0,
                            }}
                          >
                            <span style={{
                              display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              /{sk.name}
                            </span>
                            {/* One line of what it does. The name alone does not tell you whether
                                `wrangler` is a tool or a topic. */}
                            <span style={{
                              display: 'block', fontSize: 10.5, lineHeight: 1.35, color: 'var(--text-tertiary)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {sk.description}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  <p style={{ margin: '4px 8px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                    {pt
                      ? '↑↓ escolhe · enter escreve no campo · esc fecha. Não envia.'
                      : '↑↓ to move · enter writes it into the field · esc closes. It does not send.'}
                  </p>
                </>
              )}
            </div>
          )}
          {/* NO COMPOSER UNTIL THE CONVERSATION IS THERE. A field offered over a conversation still
              loading invites a message into a session whose state is not yet known — including one
              sitting in a dialog, where the text would go into the dialog's own filter. */}
          {loading ? (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
              {pt ? 'Carregando a conversa…' : 'Loading the conversation…'}
            </p>
          ) : (
            <>
              {blocked && (
                <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'var(--anthropic-orange)', lineHeight: 1.5 }}>
                  {pt
                    ? 'Esta sessão está esperando resposta a uma pergunta dela. Responda no card acima — o que você digitar aqui iria para o filtro do diálogo.'
                    : 'This session is waiting on an answer to a question of its own. Answer it in the card above — anything typed here would go into the dialog’s own filter.'}
                </p>
              )}

              {/* WHO is being replied to, and the first line or two of what they said, with an x
                  that drops it. The name is the whole point of this bar: "Replying to" over an
                  excerpt leaves the reader to work out from the wording whether they are quoting
                  themselves or the assistant, and on a short line those look identical. Both
                  decisions — the name and how much of the message is shown — are in
                  `replyQuote.ts`, which is also what composes the `> ` block that actually
                  travels. */}
              {replyTo && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8,
                  padding: '7px 10px', borderRadius: 9, minWidth: 0,
                  background: 'var(--bg-elevated)',
                  borderLeft: '3px solid var(--anthropic-orange)',
                }}>
                  <CornerUpLeft size={13} style={{ flexShrink: 0, marginTop: 3, color: 'var(--anthropic-orange)' }} />
                  <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--anthropic-orange)' }}>
                      {replyTo.excerpt
                        ? (pt ? 'Respondendo a um trecho de' : 'Replying to an excerpt from')
                        : (pt ? 'Respondendo a' : 'Replying to')}
                      {' '}
                      {replyAuthor(
                        replyTo.role,
                        (HARNESS_LABELS as Record<string, string>)[session.harness],
                        pt ? 'pt' : 'en',
                      )}
                    </span>
                    <span style={{
                      fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-tertiary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {replyPreview(replyTo.text)}
                    </span>
                  </span>
                  <button
                    onClick={() => editReply(null)}
                    aria-label={pt ? 'Cancelar resposta' : 'Cancel reply'}
                    title={pt ? 'Cancelar resposta' : 'Cancel reply'}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: 'none', background: 'transparent', padding: 2, flexShrink: 0,
                      // 44px of finger on a phone; the icon inside stays the same size.
                      minWidth: isMobile ? 44 : 22, minHeight: isMobile ? 44 : 22,
                      color: 'var(--text-tertiary)', cursor: 'pointer',
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}

              {attached.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {attached.map(a => isImagePath(a.path) ? (
                    // The same square the sent message will wear (see ChatBubble's AttachmentThumb)
                    // — what you see here is what the session's reply will show.
                    <span key={a.path} title={a.name} style={{
                      position: 'relative', display: 'block', width: 48, height: 48,
                      borderRadius: 8, overflow: 'hidden', flexShrink: 0,
                      border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                    }}>
                      <img
                        src={attachmentUrl(a.path)} alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                      <button
                        onClick={() => editAttached(list => list.filter(x => x.path !== a.path))}
                        aria-label={pt ? `Remover ${a.name}` : `Remove ${a.name}`}
                        style={{
                          position: 'absolute', top: 2, right: 2,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          width: 16, height: 16, borderRadius: '50%', border: 'none', padding: 0,
                          background: 'rgba(0,0,0,0.55)', color: '#fff', cursor: 'pointer',
                        }}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ) : (
                    <span key={a.path} title={a.path} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                      padding: '5px 8px', borderRadius: 8, minWidth: 0,
                      background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                      fontSize: 11.5, color: 'var(--text-secondary)',
                    }}>
                      <Paperclip size={11} style={{ flexShrink: 0 }} />
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.name}
                      </span>
                      <button
                        onClick={() => editAttached(list => list.filter(x => x.path !== a.path))}
                        aria-label={pt ? `Remover ${a.name}` : `Remove ${a.name}`}
                        style={{
                          display: 'flex', border: 'none', background: 'transparent', padding: 0,
                          color: 'var(--text-tertiary)', cursor: 'pointer', flexShrink: 0,
                        }}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  {/* Said plainly, because it is NOT what attach means in a chat application: the
                      file is on the machine running the session, and the path is what is sent. */}
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', alignSelf: 'center' }}>
                    {pt
                      ? 'gravados nesta máquina; o caminho vai na mensagem'
                      : 'stored on this machine; the path goes in the message'}
                  </span>
                </div>
              )}

              {/* A session that is not running cannot be written to, and a disabled field is a dead
                  end. The conversation is still fully readable above; what is offered here is the
                  way BACK INTO it. The verb is the row's own `resume`, which the server enables only
                  when it has a conversation to reopen — where it does not, the sentence says why
                  rather than a button that fails. */}
              {!canPrompt && !blocked && reopen && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  padding: '10px 12px', borderRadius: 12,
                  background: 'var(--bg-base)', border: '1px solid var(--border)',
                }}>
                  <span style={{ flex: 1, minWidth: 160, fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
                    {pt
                      ? 'Esta sessão não está rodando, então não dá para escrever nela.'
                      : 'This session is not running, so there is nothing to write to.'}
                  </span>
                  <button
                    onClick={() => void reopenNow()}
                    disabled={!reopen.enabled || reopening}
                    title={reopen.reason}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0,
                      padding: '9px 14px', borderRadius: 9, border: 'none',
                      background: reopen.enabled ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
                      color: reopen.enabled ? '#fff' : 'var(--text-tertiary)',
                      cursor: reopen.enabled && !reopening ? 'pointer' : 'default',
                      fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
                    }}
                  >
                    {reopening ? <Loader size={14} className="ag-working-spin" /> : <RotateCcw size={14} />}
                    {reopen.label}
                  </button>
                  {/* Why it cannot be reopened, in the row's own words. */}
                  {!reopen.enabled && reopen.reason && (
                    <span style={{ width: '100%', fontSize: 11, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                      {reopen.reason}
                    </span>
                  )}
                </div>
              )}

              {/* Loose on the composer's own surface — no second card behind it. It used to sit in
                  its own `--bg-base` box with a border, which read as a field floating inside the
                  field that holds it; dropping both leaves it the same colour as its container. */}
              <div style={{
                display: (!canPrompt && !blocked && reopen) ? 'none' : 'flex',
                // A COLUMN: the text gets the whole width, the controls sit under it.
                //
                // As one row the buttons and the field competed for the same line and the buttons
                // always won — they are `flex-shrink: 0` and the textarea is not. Measured on an
                // iPhone 12: 174px of typing space against ~180px of chrome, so a sentence wrapped
                // at roughly half the width of a box that looked twice as wide. Stacking is what
                // every chat composer does, and it is the only arrangement where the text gets the
                // room the field appears to promise.
                flexDirection: 'column', alignItems: 'stretch', gap: 2,
                // THE FIELD. A rounded, bordered, inset box — the shape a person recognises as
                // somewhere to type. It was previously borderless and flush to the page edges,
                // which is why it read as a footer.
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 14,
                padding: '5px 6px 5px 8px',
                opacity: canPrompt ? 1 : 0.55,
                transition: 'border-color 0.15s',
              }}>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  onChange={e => pick(e.target.files)}
                  style={{ display: 'none' }}
                />
                {/* THE INVOCATION IS MARKED IN THE FIELD ITSELF.
                    A textarea cannot hold coloured spans, so this is the standard underlay: a div
                    with the SAME typography and padding, behind the field, drawing the command as a
                    highlighted block with transparent text. The field above keeps its own colour
                    and its own caret — which is the reason it is a BACKGROUND and not a colour
                    swap: `color: transparent` on the textarea would take the selection highlight
                    and the caret with it, and a millimetre of metric drift would then be unreadable
                    text rather than a marker sitting slightly off.
                    It scrolls with the field, is `aria-hidden` (the text is already in the field,
                    and a screen reader must not hear it twice) and takes no pointer events. */}
                <div style={{ position: 'relative' }}>
                  {slashDraft.command !== '' && (
                    <div
                      aria-hidden
                      ref={underlayRef}
                      style={{
                        position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none',
                        boxSizing: 'border-box', padding: '6px 6px',
                        fontFamily: 'inherit', fontSize: 13.5, lineHeight: 1.5,
                        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'transparent',
                      }}
                    >
                      <span style={{
                        background: 'var(--anthropic-orange-dim)',
                        boxShadow: '0 0 0 1px var(--anthropic-orange)',
                        borderRadius: 4,
                      }}>{slashDraft.command}</span>
                      {slashDraft.rest}
                    </div>
                  )}
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={e => { editDraft(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length) }}
                  // Every caret move, not only every keystroke: clicking into the middle of a
                  // written prompt changes whether the caret is inside a `/command`, and a picker
                  // that only listened to typing would answer for wherever the caret used to be.
                  onSelect={e => setCaret(e.currentTarget.selectionStart ?? 0)}
                  onBlur={e => {
                    // Leaving the field closes the picker — unless the focus went INTO it, which
                    // is what a keyboard user tabbing onto an entry does.
                    if (!skillPickerRef.current?.contains(e.relatedTarget as Node | null)) setSlashDismissed(true)
                  }}
                  onPaste={onPaste}
                  onKeyDown={e => {
                    // THE PICKER OWNS THESE KEYS WHILE IT IS OPEN, and gives them all back the
                    // moment it closes. Enter must not send: the person is choosing a skill, and a
                    // half-typed `/bra` reaching the session is a message nobody wrote.
                    if (skillPickerOpen && slashFlat.length > 0) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => stepSkill(i, slashFlat.length, 1)); return }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => stepSkill(i, slashFlat.length, -1)); return }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        const picked = slashFlat[Math.min(slashIndex, slashFlat.length - 1)]
                        if (picked) insertSkill(picked.name)
                        return
                      }
                    }
                    // Escape closes the picker BEFORE it reaches the stop verb: a person dismissing
                    // a list they opened by accident must not interrupt the session's turn.
                    if (e.key === 'Escape' && skillPickerOpen) { e.preventDefault(); setSlashDismissed(true); return }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                    // The composer's own "esc": stops the CURRENT turn without touching the draft
                    // or the field's own ability to keep taking text — see `stopNow`.
                    if (e.key === 'Escape' && stopVerb?.enabled) { e.preventDefault(); void stopNow() }
                  }}
                  disabled={!canPrompt || sending}
                  rows={1}
                  placeholder={canPrompt
                    ? (pt ? 'Escreva para esta sessão…' : 'Write to this session…')
                    : (pt ? 'Indisponível para esta sessão' : 'Not available for this session')}
                  style={{
                    // NO `flex: 1`. In a COLUMN container that sets `flex-basis: 0` on the HEIGHT
                    // axis, which beats the explicit height the auto-grow effect writes — so the
                    // field never grew past its one row however much was typed, and a prompt could
                    // only be read two lines at a time. It was correct while the composer was a
                    // ROW and was left behind when it became a column.
                    width: '100%', display: 'block', boxSizing: 'border-box',
                    resize: 'none', border: 'none', outline: 'none', background: 'transparent',
                    color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13.5,
                    lineHeight: 1.5, maxHeight: maxComposerH, overflowY: 'auto', padding: '6px 6px',
                    // Above the underlay, and transparent so the mark shows through.
                    position: 'relative', zIndex: 1,
                  }}
                  onScroll={e => {
                    const u = underlayRef.current
                    if (u) u.scrollTop = (e.target as HTMLTextAreaElement).scrollTop
                  }}
                />
                </div>

                {slashHint && (
                  <p role="status" style={{
                    margin: '2px 6px 0', fontSize: 10.5, lineHeight: 1.5,
                    color: 'var(--text-tertiary)',
                  }}>
                    {pt
                      ? 'Uma skill só vale no começo da linha — apague o que está antes, ou quebre a linha.'
                      : 'A skill only counts at the start of a line — clear what is before it, or break the line.'}
                  </p>
                )}

                {/* The controls, on their own line under the text. ATTACH opens the row on the
                    left and the acting group closes it on the right — the two halves are what the
                    control does: attach only prepares a message, the group at the other end sends
                    it, stops the turn, or opens what is used rarely.
                    The gap is 6 rather than 4, and the two halves are separated by the whole
                    remaining width: asked for a row where the controls "nao fiquem entulhados". A
                    row of touching 34px squares reads as one object with lines in it. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={!canPrompt || uploading}
                  aria-label={pt ? 'Anexar arquivo' : 'Attach file'}
                  title={pt ? 'Anexar arquivo' : 'Attach file'}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 34, height: 34, borderRadius: 9, border: 'none', flexShrink: 0,
                    background: 'transparent', color: 'var(--text-tertiary)',
                    cursor: canPrompt && !uploading ? 'pointer' : 'default',
                  }}
                >
                  {uploading ? <Loader size={15} className="ag-working-spin" /> : <Paperclip size={15} />}
                </button>

                {/* DICTATION, beside attach — the pair that PREPARES a message, which is what the
                    left of this row is. It was reachable only through the "more" menu; on a desktop
                    there is room for it and two clicks for a control used mid-sentence is one too
                    many.
                    ONLY WHEN IT CAN WORK, and only off a phone. Its refusal needs a LINE, not a
                    `title` — the Web Speech API needs a secure context, so a dashboard opened over
                    plain HTTP on a LAN has no microphone at all — and that line only fits in the
                    menu, where the row stays. A control that is present and silently does nothing
                    is the thing this codebase refuses everywhere else. */}
                {!isMobile && dictation.state === 'ready' && (
                  <button
                    onClick={toggleDictation}
                    disabled={!canPrompt}
                    aria-pressed={listening}
                    aria-label={listening ? (pt ? 'Parar de ouvir' : 'Stop listening') : (pt ? 'Ditar' : 'Dictate')}
                    title={listening ? (pt ? 'Parar de ouvir' : 'Stop listening') : (pt ? 'Ditar' : 'Dictate')}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, borderRadius: 9, border: 'none', flexShrink: 0,
                      background: listening
                        ? 'color-mix(in srgb, var(--accent-red) 14%, transparent)'
                        : 'transparent',
                      color: listening ? 'var(--accent-red)' : 'var(--text-tertiary)',
                      cursor: canPrompt ? 'pointer' : 'default',
                    }}
                  >
                    <Mic size={15} />
                  </button>
                )}

                {/* Stop · Send · More, held together at the far end. `marginLeft: auto` on the
                    GROUP rather than on send, so the three keep their order and their spacing
                    whether or not the stop is there — a margin on send alone would push the more
                    button off to the right on its own the moment a turn ended. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                {/* THE LAST MESSAGE YOU SENT. ABSENT until there is one — `lastSent` is null on a
                    conversation nobody has written into yet, and a control whose only outcome is a
                    modal saying "nothing" is one that exists to refuse. It sits with the acting
                    group because it is about what you have already sent, not about composing. */}
                {lastSent && (
                  <button
                    onClick={() => setRecall('ask')}
                    aria-label={pt ? 'Sua última mensagem' : 'Your last message'}
                    title={pt ? 'Sua última mensagem' : 'Your last message'}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, borderRadius: 9, border: 'none', flexShrink: 0,
                      background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
                    }}
                  >
                    <History size={15} />
                  </button>
                )}
                {/* Working's own stop, right beside the field it does not block. Absent the moment
                    the turn ends — a stop control on an idle session would send Escape into its
                    prompt, which is exactly the row's own gate on `interrupt`. */}
                {working && stopVerb?.enabled && (
                  <button
                    onClick={() => void stopNow()}
                    disabled={stopping}
                    title={stopVerb.label}
                    aria-label={stopVerb.label}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, borderRadius: 9, flexShrink: 0, cursor: stopping ? 'default' : 'pointer',
                      border: '1px solid color-mix(in srgb, var(--accent-red) 45%, transparent)',
                      background: 'color-mix(in srgb, var(--accent-red) 12%, transparent)',
                      color: 'var(--accent-red)',
                    }}
                  >
                    {stopping ? <Loader size={14} className="ag-working-spin" /> : <Square size={13} fill="currentColor" />}
                  </button>
                )}
                <button
                  onClick={() => void send()}
                  disabled={!canPrompt || sending || (draft.trim() === '' && attached.length === 0)}
                  aria-label={pt ? 'Enviar' : 'Send'}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 34, height: 34, borderRadius: 9, border: 'none', flexShrink: 0,
                    background: (draft.trim() === '' && attached.length === 0) || !canPrompt ? 'transparent' : 'var(--anthropic-orange)',
                    color: (draft.trim() === '' && attached.length === 0) || !canPrompt ? 'var(--text-tertiary)' : '#fff',
                    cursor: (draft.trim() === '' && attached.length === 0) || !canPrompt ? 'default' : 'pointer',
                  }}
                >
                  {sending ? <Loader size={15} className="ag-working-spin" /> : <Send size={15} />}
                </button>

                {/* Mic and model live behind ONE button. Four controls plus the field on a
                    390px screen is a row where the buttons win, and these two are the pair a person
                    reaches for occasionally — attach and send are the ones used every turn.
                    A menu, not a second row: another row costs height, which is the thing a phone
                    has least of. */}
                <div ref={moreMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
                  <button
                    onClick={() => setMoreOpen(v => !v)}
                    disabled={!canPrompt || sending}
                    aria-label={pt ? 'Mais opções' : 'More options'}
                    aria-expanded={moreOpen}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, borderRadius: 9, border: 'none',
                      background: moreOpen ? 'var(--bg-surface)' : 'transparent',
                      color: 'var(--text-tertiary)',
                      cursor: canPrompt ? 'pointer' : 'default',
                    }}
                  >
                    <ChevronUp size={15} style={{ transform: moreOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                  </button>

                  {moreOpen && (
                    <div style={{
                      // Anchored on its RIGHT edge: the button now sits at the end of the row, and
                      // a menu opening rightwards from there would leave the screen.
                      position: 'absolute', bottom: 40, right: 0, zIndex: 50,
                      minWidth: 210, maxWidth: 260, padding: 4, borderRadius: 10,
                      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                    }}>
                      {/* DICTATION. Its refusal is a LINE, not a `title`: a phone has no hover, and
                          this is exactly where it is refused most — the Web Speech API needs a
                          secure context, so a dashboard reached over plain HTTP on a LAN never has
                          a microphone. A control that silently does nothing there is one people
                          report as broken, which is what happened. */}
                      {/* NOT RENDERED where the standalone button above is shown, so dictation is
                          in ONE place at a time — two controls for one act is two states to keep in
                          agreement. Where it cannot work it lives here, because only here can it
                          say why.
                          It was `hidden` and that did nothing: the row sets `display: flex` inline,
                          and an inline style beats the user-agent rule `[hidden] { display: none }`
                          without `!important`. So the microphone appeared TWICE — reported as
                          exactly that. A conditional render has no such loophole. */}
                      {(isMobile || dictation.state !== 'ready') && <button
                        onClick={() => { if (dictation.state === 'ready') { setMoreOpen(false); toggleDictation() } }}
                        disabled={dictation.state !== 'ready'}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                          minHeight: 40, padding: '6px 8px', borderRadius: 7, border: 'none',
                          background: listening ? 'color-mix(in srgb, var(--accent-red) 12%, transparent)' : 'transparent',
                          color: listening ? 'var(--accent-red)' : 'var(--text-primary)',
                          fontFamily: 'inherit', fontSize: 12.5,
                          cursor: dictation.state === 'ready' ? 'pointer' : 'default',
                          opacity: dictation.state === 'ready' ? 1 : 0.55,
                        }}
                      >
                        <Mic size={14} style={{ flexShrink: 0 }} />
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <span>{listening ? (pt ? 'Parar de ouvir' : 'Stop listening') : (pt ? 'Ditar' : 'Dictate')}</span>
                          {dictation.reason && (
                            <span style={{ fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>
                              {dictation.reason}
                            </span>
                          )}
                        </span>
                      </button>}

                      {/* The address that WOULD work, when there is one.
                          `localhost` is a secure context and `http://192.168.x.y:47292` is not, so
                          a member machine's dashboard has an exact equivalent one click away —
                          naming it is more useful than naming the rule. Only a literal IPv4 host is
                          rewritten (see `insecureAlternative`): sending someone from a hostname to
                          `localhost` would be a guess about which machine they are sitting at, so
                          where there is no answer this row is simply absent. */}
                      {dictation.state === 'insecure' && (() => {
                        const alt = typeof window === 'undefined' ? null : insecureAlternative(window.location.href)
                        return alt === null ? null : (
                          <a
                            href={alt}
                            style={{
                              display: 'block', padding: '4px 8px 8px 30px', fontSize: 11,
                              lineHeight: 1.4, color: 'var(--anthropic-orange)',
                              overflowWrap: 'anywhere', textDecoration: 'none',
                            }}
                          >
                            {pt ? `Abrir em ${alt}` : `Open at ${alt}`}
                          </a>
                        )
                      })()}

                      {/* MODEL. Same treatment: where it cannot work, the menu says why instead of
                          offering a control that answers nothing. */}
                      {modelReason ? (
                        <p style={{ margin: 0, padding: '6px 8px', fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                          {modelReason}
                        </p>
                      ) : models.length > 0 && (
                        <>
                          <div style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
                          <p style={{
                            margin: '2px 8px 4px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                            letterSpacing: '0.06em', color: 'var(--text-tertiary)',
                          }}>
                            {pt ? 'Modelo' : 'Model'}
                          </p>
                          {/* The LABEL is what you read; the ID is what gets typed into the
                              session. Where the server has no labels the two are the same string,
                              which is what this menu showed before. */}
                          {models.map(m => (
                            <button
                              key={m.id}
                              onClick={() => { setMoreOpen(false); void switchModel(m.id) }}
                              style={{
                                display: 'block', width: '100%', textAlign: 'left',
                                minHeight: 36, padding: '6px 8px', borderRadius: 7, border: 'none',
                                background: 'transparent', color: 'var(--text-primary)',
                                fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
                              }}
                            >
                              {m.label}
                            </button>
                          ))}
                          <p style={{ margin: '2px 8px 4px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                            {pt ? 'Envia /model para a sessão.' : 'Sends /model to the session.'}
                          </p>
                        </>
                      )}

                      {/* SKILLS. The picker INSERTS `/<name> ` into the draft and focuses the
                          field — it does not send. Two reasons: most skills take an argument, and
                          the composer's whole contract is that what reaches the session is what the
                          person chose to send.

                          It inherits the `prompt` action's refusals and STATES them: the session
                          must be running, and it is refused while a DIALOG is open, because a slash
                          command typed into a permission prompt goes into that dialog's own filter
                          and the submit takes the highlighted option. Same rule `promptSession` and
                          `rename` already enforce, said here rather than discovered by doing it. */}
                      {(skills === null || skills.length > 0 || skillsNote) && (
                        <>
                          <div style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
                          <p style={{
                            margin: '2px 8px 4px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                            letterSpacing: '0.06em', color: 'var(--text-tertiary)',
                          }}>
                            Skills
                          </p>
                          {/* The PERMANENT fact first. A harness that can never do this is told so,
                              rather than being told it is not running — which is true, irrelevant,
                              and would change to a different refusal if it started. */}
                          {skillsNote ? (
                            <p style={{ margin: 0, padding: '6px 8px', fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                              {skillsNote}
                            </p>
                          ) : !canPrompt || blocked ? (
                            <p style={{ margin: 0, padding: '6px 8px', fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                              {blocked
                                ? (pt
                                    ? 'Esta sessão está numa pergunta. Responda primeiro — uma barra digitada aí entra no filtro do diálogo.'
                                    : 'This session is on a question. Answer it first — a slash typed there goes into the dialog’s own filter.')
                                : (pt
                                    ? 'Esta sessão não está rodando, então não dá para escrever nela.'
                                    : 'This session is not running, so there is nothing to write to.')}
                            </p>
                          ) : skills === null ? (
                            <p style={{ margin: 0, padding: '6px 8px', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                              {pt ? 'Lendo…' : 'Reading…'}
                            </p>
                          ) : (
                            <>
                              {skills.length > 6 && (
                                <input
                                  value={skillQuery}
                                  onChange={e => setSkillQuery(e.target.value)}
                                  placeholder={pt ? `Filtrar ${skills.length} skills…` : `Filter ${skills.length} skills…`}
                                  style={{
                                    width: '100%', boxSizing: 'border-box', margin: '2px 0 4px',
                                    padding: '5px 8px', borderRadius: 6, fontSize: 11.5,
                                    border: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
                                    color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none',
                                  }}
                                />
                              )}
                              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                                {shownSkills.length === 0 && (
                                  <p style={{ margin: 0, padding: '6px 8px', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                                    {pt ? 'Nenhuma skill com esse nome.' : 'No skill by that name.'}
                                  </p>
                                )}
                                {shownSkills.map(sk => (
                                  <button
                                    key={sk.name}
                                    title={sk.description}
                                    onClick={() => {
                                      setMoreOpen(false)
                                      setSkillQuery('')
                                      editDraft(d => (d.trim() === '' ? `/${sk.name} ` : `${d.replace(/\s+$/, '')} /${sk.name} `))
                                      textareaRef.current?.focus()
                                    }}
                                    style={{
                                      display: 'block', width: '100%', textAlign: 'left',
                                      minHeight: 36, padding: '6px 8px', borderRadius: 7, border: 'none',
                                      background: 'transparent', color: 'var(--text-primary)',
                                      fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
                                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}
                                  >
                                    /{sk.name}
                                  </button>
                                ))}
                              </div>
                              <p style={{ margin: '2px 8px 4px', fontSize: 10, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                                {pt ? 'Escreve no campo; não envia.' : 'Types into the field; does not send.'}
                              </p>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                </div>
                </div>
              </div>
              {notice && (
                <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  {notice}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* THE RECALL MODAL. Exactly three options, because there are exactly three things somebody
          asking "what did I send?" wants: to be taken to it, to read it here, or to have asked
          nothing. Full-screen on a phone — a centred fixed-width dialog is pushed off-screen by
          iOS Safari the moment the page overflows horizontally. */}
      {recall && lastSent && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={pt ? 'Sua última mensagem' : 'Your last message'}
          onClick={() => setRecall(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            // The status bar's inset on a full-screen phone dialog — see `mobileOverlay.ts`.
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
              <History size={15} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
              <h3 style={{ margin: 0, flex: 1, fontSize: 14, fontWeight: 650, color: 'var(--text-primary)' }}>
                {pt ? 'Sua última mensagem' : 'Your last message'}
              </h3>
              {/* Said plainly: a message this session has not read yet is a different fact from one
                  already in its transcript, and the reader is about to be sent to a faded bubble. */}
              {lastSent.kind === 'echo' && (
                <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                  {pt ? 'ainda não lida' : 'not read yet'}
                </span>
              )}
            </div>

            {recall === 'ask' ? (
              <p style={{
                margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-tertiary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {replyPreview(lastSent.text)}
              </p>
            ) : (
              // The WHOLE message, wrapped and scrolling inside its own box: a prompt here is
              // routinely forty lines, and a modal that grows with it would run off the screen.
              <pre style={{
                margin: 0, flex: isMobile ? 1 : '0 1 auto', minHeight: 0,
                maxHeight: isMobile ? 'none' : '46vh', overflow: 'auto',
                padding: 12, borderRadius: 10,
                background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
                fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.6,
                color: 'var(--text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              }}>
                {splitMessage(lastSent.text).text}
              </pre>
            )}

            {/* THE IMAGES IT CARRIED. A sent message is paths plus words joined by newlines, so
                showing it raw rendered the paths as the first lines of the prose — a message with
                an image in it read as one that began with a filename. Split by the SAME rule the
                chat bubbles use (`splitImageAttachments`), never a second one: the two are reading
                the identical text, and two rules over one string is how they come to disagree. */}
            {/* THE FILES IT CARRIED, split by PROVENANCE rather than by looks: `splitMessage`
                answers "which leading lines did the composer send", which is the question a recall
                is asking, while `splitImageAttachments` answers "which lines can I preview". An
                image is shown; anything else is named. */}
            {splitMessage(lastSent.text).attachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {splitMessage(lastSent.text).attachments.map(a => isImageAttachment(a) ? (
                  <img
                    key={a}
                    src={attachmentUrl(a)}
                    alt={attachmentName(a)}
                    title={a}
                    style={{
                      height: 72, width: 'auto', maxWidth: 160, objectFit: 'cover',
                      borderRadius: 8, border: '1px solid var(--border-subtle)',
                      background: 'var(--bg-base)',
                    }}
                  />
                ) : (
                  <span key={a} title={a} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px',
                    borderRadius: 8, background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)', fontSize: 11.5,
                    maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    <Paperclip size={11} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                    {attachmentName(a)}
                  </span>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setRecall(null); goToMessage() }}
                style={recallButton(isMobile, 'primary')}
              >
                {pt ? 'Ir para a mensagem' : 'Go to message'}
              </button>
              {/* Once the text is on screen, offering "view" again would be a button that does
                  nothing — so it becomes the way back to the three options. */}
              <button
                onClick={() => setRecall(recall === 'text' ? 'ask' : 'text')}
                style={recallButton(isMobile, 'plain')}
              >
                {recall === 'text'
                  ? (pt ? 'Voltar' : 'Back')
                  : (pt ? 'Ver mensagem' : 'View message')}
              </button>
              <button onClick={() => setRecall(null)} style={recallButton(isMobile, 'plain')}>
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** The recall modal's buttons. 44px of finger on a phone, and nowhere else. */
function recallButton(isMobile: boolean, kind: 'primary' | 'plain'): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: isMobile ? 44 : 34, padding: '0 14px', borderRadius: 9,
    border: kind === 'primary' ? 'none' : '1px solid var(--border)',
    background: kind === 'primary' ? 'var(--anthropic-orange)' : 'transparent',
    color: kind === 'primary' ? '#fff' : 'var(--text-secondary)',
    fontFamily: 'inherit', fontSize: 12.5, fontWeight: kind === 'primary' ? 650 : 500,
    cursor: 'pointer', flexGrow: isMobile ? 1 : 0,
  }
}

/** Whitespace-insensitive, because the harness re-wraps what it stores. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function Loading({ pt }: { pt: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      padding: '48px 0', color: 'var(--text-tertiary)', fontSize: 12.5,
    }}>
      <Loader size={16} className="ag-working-spin" />
      {pt ? 'Lendo a conversa…' : 'Reading the conversation…'}
    </div>
  )
}

function Muted({ text }: { text: string }) {
  return <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{text}</p>
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', minHeight: 260, padding: 32, textAlign: 'center', maxWidth: 460, margin: '0 auto',
    }}>
      {children}
    </div>
  )
}
