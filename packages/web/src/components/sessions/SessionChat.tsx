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
import { ArrowDown, ChevronUp, CornerUpLeft, History, Loader, Mic, Paperclip, RotateCcw, Send, SlidersHorizontal, Square, X } from 'lucide-react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { FleetActionId, FleetRow } from '../../lib/fleet'
import { modeStyle } from '../../lib/modeStyle'
import { ApprovalCard } from './ApprovalCard'
import { ChatBubble, type ChatTurn } from './ChatBubble'
import { WorkingNote } from './WorkingNote'
import { useTerminalStream } from '../../hooks/useTerminalStream'
import { isImagePath, openComposerLightbox } from '../../lib/attachmentPreview'
import { splitImageAttachments } from '../../lib/attachmentPreview'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { AttachmentLightbox } from './AttachmentLightbox'
import { liveTurnText, stripAnsi } from '../../lib/liveTurn'
import { scratchKey, sessionScratch } from '../../lib/sessionScratch'
import { chatReadAt, firstFrameStale, refreshChat, subscribeChat } from '../../lib/chatFeed'
import { composerMaxHeight } from '../../lib/composerHeight'
import { artifactsFromTurns, hasUnlistedWrites, type Artifact } from '../../lib/sessionArtifacts'
import type { LiveTurn } from '../../lib/artifactTabs'
import { MAX_ATTACHMENTS, attachmentRoom, planPaste } from '../../lib/pastePlan'
import { appendDictation, dictationError, dictationLocale, dictationSupport, insecureAlternative, splitDictation } from '../../lib/dictation'
import { modelSwitchLine, modelSwitchReason } from '../../lib/modelSwitch'
import {
  applySkill, emptyPickerReason, filterSkills, flattenGroups, groupSkills, slashMisplaced,
  slashQuery, stepSkill,
} from '../../lib/skillMenu'
import { composeReply, markExcerpt, quoteFor, replyAuthor, replyPreview, type ReplyTarget } from '../../lib/replyQuote'
import { pendingEchoes } from '@agentistics/core'
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

import type { AttachmentSend } from '@agentistics/core'

interface ChatPayload {
  turns: ChatTurn[]
  unavailable?: string
  live: boolean
  /** Already-localized: these turns are the END of a longer conversation. See `chat-web.ts`. */
  older?: string
  /** Messages the SERVER is holding for this conversation — see `pending-prompts.ts`. */
  pending?: { text: string; at: number }[]
  /**
   * What agentop typed into this session's pane, and when — so a `[Image #N]` marker the harness
   * substituted for a path can find its file again. Absent when nothing was ever attached here.
   */
  attachmentSends?: AttachmentSend[]
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

// How often the conversation is re-read — and for how long it keeps being read after you leave —
// belongs to `chatFeed.ts`, which is the one place that decides it for every surface.

/** How long a stale first frame goes unannounced before the "updating" line appears. */
const REFRESH_NOTICE_MS = 400

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
  /**
   * The frame on screen is one this session cached a while ago, and a fresh read is on its way.
   *
   * Only ever true for a first frame that is genuinely BEHIND (`firstFrameStale`) — the tab was
   * hidden, or the warm window closed while you were away. Saying nothing there is what makes the
   * conversation appear to change on its own; saying it on every mount would be a label that
   * flashes for 150 ms and means nothing, which is why the marker itself also waits (see
   * `showRefreshing`).
   */
  const [refreshing, setRefreshing] = useState(() => firstFrameStale(chatReadAt(scratchId), Date.now()))
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


  /**
   * A KEY CHANGE IS NOT ALWAYS A SESSION CHANGE, and treating it as one is what took the focus.
   *
   * `scratchKey` answers `row:<id>` while a row has no `conversationId` and `conv:<id>` once it
   * learns one — and a live session learns it MID-USE, the moment the poller can prove the link.
   * The reload then ran while somebody was typing: every read moved to a slot holding nothing, so
   * `payload` came back `null`, the composer's whole subtree was replaced by the "loading"
   * paragraph, and the focused textarea left the DOM — taking the half-written draft with it.
   * Reported as "eu to digitando e do nada o foco sai do campo de input".
   *
   * The ROW is what says whether this is the same session. When it is, the scratch is CARRIED to
   * the new key and nothing else moves, so the change becomes invisible — which is what it always
   * should have been.
   *
   * ONE effect decides this, not two: a second effect on the same key cannot ask "is this a switch"
   * after the first has already recorded the answer.
   */
  const shownId = useRef(scratchId)
  const shownRow = useRef(session.id)
  useEffect(() => {
    if (shownId.current === scratchId) return
    const sameSession = shownRow.current === session.id
    if (sameSession) sessionScratch.migrate(shownId.current, scratchId)
    shownId.current = scratchId
    shownRow.current = session.id
    if (sameSession) return
    // A GENUINE switch. Everything per-conversation is read back from the other session's own slot;
    // the scroll position is the one thing not restored, because opening mid-history is
    // disorienting.
    landedRef.current = false
    setAtTail(true)
    setPayload(sessionScratch.readChat(scratchId) as ChatPayload | null)
    setRefreshing(firstFrameStale(chatReadAt(scratchId), Date.now()))
    setDraft(sessionScratch.readDraft(scratchId))
    setReplyTo(sessionScratch.readReply(scratchId))
    setEcho(sessionScratch.readEchoes(scratchId))
    setAttached(sessionScratch.readAttachments(scratchId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scratchId])
  const [sending, setSending] = useState(false)
  /** Dictation. `recognitionRef` holds the live recogniser so a second click stops it. */
  const [listening, setListening] = useState(false)
  /**
   * What the recogniser is hearing RIGHT NOW, before it has settled on it.
   *
   * Shown beside the field and never written into the draft: an interim result is a guess the
   * recogniser replaces as it hears more. It is the whole of "see the capture happening" — with
   * `interimResults` off, a person speaking saw an unchanged field and concluded the microphone was
   * broken, which is exactly what was reported.
   */
  const [heard, setHeard] = useState('')
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
      // ON. See `heard`: without it nothing reaches the screen until a phrase is over.
      rec.interimResults = true
      // Both decisions are PURE and tested (`dictation.ts`): which results this event contributed,
      // and where they land in what is already typed. This loop used to read `e.results` from index
      // 0 on every event while `continuous` is true — and that list is CUMULATIVE, so every event
      // re-emitted the whole session and the draft grew "one", "one one two", "one one two one two
      // three". `resultIndex` is the index of the first result the event changed, which is exactly
      // what this event contributed.
      rec.onresult = e => {
        const { final, interim } = splitDictation(e)
        // Only the settled half is kept. The rest is shown and thrown away on the next event.
        if (final !== '') editDraft(d => appendDictation(d, final))
        setHeard(interim)
      }
      // Both end the same way. A recogniser that stopped on its own (a timeout, a denied
      // permission) must not leave the button lit — a control that says it is listening when it
      // is not is worse than one that never started.
      rec.onend = () => { setListening(false); setHeard(''); recognitionRef.current = null }
      rec.onerror = e => {
        setListening(false)
        setHeard('')
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
   * Which attached image the composer is showing full-size, or `null`.
   *
   * A thumbnail here was a picture you could not open — reported exactly that way — while the very
   * same square in a SENT message opens `AttachmentLightbox`. The component is reused rather than
   * copied: what you attached and what you sent are the same picture, so they get the same viewer.
   * Its scope is what is attached RIGHT NOW, which is the caller's decision to make (see that
   * component's header) and is the only list this control can honestly step through.
   */
  const [composerLightbox, setComposerLightbox] = useState<number | null>(null)
  /**
   * The images among what is attached, in the order the strip draws them.
   *
   * Only images: a text attachment has no picture to step to, and including it would make
   * `ArrowRight` land on a blank frame. Derived at the render rather than stored, so removing one
   * cannot leave this disagreeing with the strip beside it.
   */
  const composerImages = attached.filter(a => isImagePath(a.path)).map(a => a.path)
  /** …and the index that survives an edit made while the overlay is open. See `openComposerLightbox`. */
  const composerLightboxAt = openComposerLightbox(composerLightbox, composerImages.length)

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

  /**
   * Ask for the transcript NOW, outside the interval.
   *
   * The interval is tuned for watching (`CHAT_POLL_MS`), and the two moments a reader is actually
   * waiting are not on it: the instant a message is sent, and the instant a turn ends. On both, the
   * answer changed and the next scheduled read is up to three seconds away — which is the whole of
   * "as mensagens chegam de forma travada". A ref rather than state, so nudging never re-renders
   * and never restarts the interval it lives beside.
   */
  const nudgeChat = useRef<() => void>(() => {})

  /*
   * THE CONVERSATION IS READ BY `chatFeed`, NOT BY THIS COMPONENT.
   *
   * The poll used to live here, which meant it existed only while this view was mounted — and
   * mounting is what returning to a session IS. So the cached first frame was exactly as old as
   * the time spent elsewhere: leave mid-turn, come back two minutes later, and the conversation
   * on screen was the one you left, ending at your own last message, with every reply since
   * arriving in one jump a moment later. Reported as "por um instante fica meu último prompt ali
   * e, do nada, carrega todas as novas mensagens".
   *
   * The feed keeps reading it for a few minutes after the last watcher leaves, so the frame this
   * mount paints from the cache is current. Everything else is unchanged: it still asks on mount,
   * still polls at the same cadence while watched, and a failed read still keeps the conversation
   * on screen rather than blanking it.
   *
   * A BACKGROUND TAB still does not poll — Chrome throttles a hidden tab's timers to roughly once
   * a minute, and the warm read stands down there too — so coming back into view asks immediately,
   * which is the exact moment somebody wants what they missed.
   */
  useEffect(() => {
    const stop = subscribeChat({ id: session.id, key: scratchId, lang }, next => {
      setPayload(next as unknown as ChatPayload)
      setRefreshing(false)
    })
    nudgeChat.current = () => { refreshChat(session.id) }
    const onVisible = () => { if (document.visibilityState === 'visible') refreshChat(session.id) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      nudgeChat.current = () => {}
      document.removeEventListener('visibilitychange', onVisible)
      stop()
    }
  }, [session.id, lang, scratchId])

  /**
   * THE MARKER WAITS, and that is what keeps it from being noise.
   *
   * The read answers in 66-143 ms on this machine, so a label rendered the instant a mount starts
   * would appear and vanish inside a blink on almost every visit — a flicker announcing a flicker.
   * It is shown only once the wait is long enough to be felt, which on a phone reaching a member
   * machine over the LAN with a long transcript is where it actually earns its place.
   */
  const [showRefreshing, setShowRefreshing] = useState(false)
  useEffect(() => {
    if (!refreshing) { setShowRefreshing(false); return }
    const t = setTimeout(() => setShowRefreshing(true), REFRESH_NOTICE_MS)
    return () => clearTimeout(t)
  }, [refreshing])

  /**
   * IS THE LIVE SCREEN WORTH WATCHING RIGHT NOW?
   *
   * `session.state` alone was the answer, and it is up to a FLEET poll late — five seconds, plus
   * the confirmation `attention-confirm.ts` requires. So every turn began with a dead window: the
   * message was already in the pane and the assistant already producing, while the chat had not
   * opened the stream that shows it. Measured why it matters: Claude writes its JSONL once a
   * message is FINISHED (the file grows in one ~5 KB jump and then sits still for eight seconds),
   * so the transcript can never stream — the screen is the only place the text exists as it is
   * typed, and being late to it is being late to all of it.
   *
   * A PENDING ECHO is the signal the fleet does not have yet: we typed into that pane ourselves a
   * moment ago. It clears exactly when the transcript catches up, so this needs no timer and cannot
   * leak a capture loop — and the case where it holds longest, a message sitting in the harness's
   * queue, is precisely the one somebody is watching the screen to understand.
   */
  const working = session.state === 'working'
  const { state: term } = useTerminalStream(working || echo.length > 0 ? session.id : null)

  // A turn just ENDED. The live bubble is gone the moment `working` drops, and the real one is up
  // to `CHAT_POLL_MS` away — a gap where neither source is showing the answer that just finished.
  const wasWorking = useRef(working)
  useEffect(() => {
    if (wasWorking.current && !working) nudgeChat.current()
    wasWorking.current = working
  }, [working])

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

  // DECLARED AFTER `echoSeen`, and that is not cosmetic. `useMemo` runs its factory DURING the
  // render, at the point it is called — so a memo that reads `echoSeen.current` written above the
  // `useRef` reads a binding still in its temporal dead zone. It threw
  // `ReferenceError: Cannot access 'W' before initialization` the moment `echo` had anything in
  // it, which is to say the moment a message was sent, and the error boundary caught it AFTER the
  // message had already gone — "dá esse erro (mas envia)". Hooks read like declarations and are
  // executed like statements; order is part of the meaning.
  /**
   * WHAT IS STILL WAITING, from BOTH sides, and the server's copy wins on age.
   *
   * The local echo is what makes a sent message appear instantly — it exists before any poll — and
   * the server's list is what makes it appear on every OTHER device, and survive this one being
   * closed and reopened. Neither replaces the other: without the local half the sender waits a poll
   * to see their own message, without the server half nobody else ever sees it.
   *
   * The union is by TEXT, which is the same key both sides already retire on. Where both have it,
   * the server's `at` is used: it is when the message was actually handed over, while the local
   * timestamp is when THIS tab first drew it — and after a reload the local one is the reload, which
   * is exactly how a queued message became a bubble with no age and no way to tell it from a lost
   * one. `at` may still be undefined for a purely local entry that has not been through a poll yet,
   * and the bubble then shows no age rather than inventing one.
   */
  const queued = useMemo(() => {
    const out: { text: string; at?: number }[] = []
    const server = new Map((payload?.pending ?? []).map(p => [p.text, p.at]))
    const seen = new Set<string>()
    for (const text of echo) {
      if (seen.has(text)) continue
      seen.add(text)
      const at = server.get(text) ?? echoSeen.current.get(text)
      out.push(at === undefined ? { text } : { text, at })
    }
    for (const p of payload?.pending ?? []) {
      if (seen.has(p.text)) continue
      seen.add(p.text)
      out.push({ text: p.text, at: p.at })
    }
    return out
  }, [echo, payload?.pending])

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
    // Choosing a message to answer IS starting to write one. Asked for, and it is the same call the
    // skill picker already makes after inserting: the next thing the person does is type.
    textareaRef.current?.focus()
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
    textareaRef.current?.focus()
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

  /**
   * IS THE PERSON TYPING RIGHT NOW.
   *
   * It exists for one rule, asked for in these words: "enquanto eu estiver digitando no input NADA
   * tira o foco dele". A `disabled` attribute is not a style — the browser BLURS an element the
   * moment it becomes disabled — and this field was disabled from `canPrompt`, which is recomputed
   * on every 5s fleet poll. So a poll that briefly reported the session blocked, or not live, or
   * mid-send took the caret out from under someone mid-sentence, and they had to tap back in. "Do
   * nada o foco sai do input."
   *
   * DECLARED HERE, above everything that reads it, because it now guards more than `disabled`:
   * `showReopen` reads it too, and a rule about the caret that half the file cannot see is a rule
   * that gets forgotten by the next thing that hides the composer.
   */
  const [typing, setTyping] = useState(false)

  const blocked = (session.approvalLines?.length ?? 0) > 0
  const loading = payload === null

  /**
   * ANSWERING THE QUESTION IN THE COMPOSER, rather than in a field of its own.
   *
   * Asked for in these words: "ao clicar na opção de digitar o input fica disponível pro usuário
   * usar (pq daí consigo usar recurso de voz, ctrl+v, anexos etc.)". The card used to grow its own
   * one-line `<input>`, which is a second composer with none of the composer's features — no
   * dictation, no paste-an-image, no attachments, no auto-grow, and its own separate rules about
   * what Enter does.
   *
   * It holds the option's NUMBER because that is what the server needs (`approve` with a `choice`),
   * its LABEL so the banner can name what is being answered, and the dialog's SHAPE so the mode
   * cannot outlive the question: a dialog that changes under it would leave the composer sending an
   * answer to a question nobody asked.
   */
  const [answering, setAnswering] = useState<{ number: number; label: string; shape: string } | null>(null)
  /** The dialog's identity — the same string `ApprovalCard` compares, for the same reason. */
  const dialogShape = useMemo(
    () => (row?.dialogOptions ?? []).map(o => `${o.number}:${o.label}`).join('\n'),
    [row?.dialogOptions],
  )
  useEffect(() => {
    // The question went away, or became a different question. Either way this is no longer an
    // answer to it, and the composer goes back to being a composer.
    setAnswering(a => (a === null || (blocked && a.shape === dialogShape) ? a : null))
  }, [blocked, dialogShape])

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

  /**
   * The composer is being used to answer the dialog, so it must accept text.
   *
   * `blocked` normally denies `canPrompt`, and that rule stays exactly as it was: a PROMPT typed
   * into a session sitting on a dialog goes into that dialog's own filter and the submit takes the
   * highlighted option. This is not a prompt. `send()` routes an answer through `approve` with the
   * option's number, which is the one path the server has verified for it — the invariant is kept,
   * and what changes is only which field the words are typed into.
   */
  const answeringNow = blocked && answering !== null
  const canPrompt = !loading && session.actionable && (!blocked || answeringNow) && payload.live !== false
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
  /**
   * WHILE THE FIELD HAS THE CARET, NOTHING MAY REPLACE IT — the rule `typing` was invented for,
   * applied to the one place it did not reach.
   *
   * `typing` already stops `disabled` blurring the field on a poll. It did NOT stop the composer's
   * whole row being `display: none`'d, and `display: none` on an ANCESTOR blurs just as hard —
   * harder, because the node leaves the layout with the half-written draft in it. The condition was
   * `!canPrompt && !blocked && reopen`, and every term of `canPrompt` is recomputed on the 5s fleet
   * poll (`loading`, `session.actionable`, `payload.live`), while `reopen` is a `find` that never
   * checks `.enabled` — so any single poll reporting the session momentarily not live swapped the
   * focused composer for the reopen block. Reported, again, as "do nada o foco sai do input".
   *
   * ONE expression decides it, read by BOTH the reopen block and the composer's `display`, so the
   * two can never be shown at once or hidden at once.
   */
  const showReopen = !canPrompt && !blocked && !!reopen && !typing

  const stopVerb = row?.verbs.find(v => v.action === 'interrupt')
  /**
   * Is the one button showing STOP right now?
   *
   * `working` and a stop the row actually offers are the preconditions — a stop on an idle session
   * sends Escape into its prompt, which is why the row gates `interrupt` at all. The DRAFT is what
   * decides between the two faces: nothing written means there is nothing to send, so the only
   * thing left to do to a working session is stop it; a single character means the opposite.
   * Attachments count as something written — a message that is only files is still a message.
   */
  const stopShown = working && !!stopVerb?.enabled && draft.trim() === '' && attached.length === 0
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
      // Which session this is going into. The server records it, so a `[Image #N]` marker the
      // harness substitutes when it QUEUES the message can still find the file it stands for.
      body.append('session', session.id)
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
    // `canPrompt` is checked HERE now rather than only on the field's `disabled`, which no longer
    // follows it — see the note on the textarea. This is where it belonged anyway: the rule is
    // about what may be DELIVERED, not about what may be typed.
    if ((text === '' && attached.length === 0) || sending) return
    /**
     * A REFUSAL IS SAID, NEVER RETURNED IN SILENCE.
     *
     * This read `|| !canPrompt) return`, so pressing Enter on a session the poll had just reported
     * not-live, not-actionable or newly blocked did NOTHING AT ALL — no send, no sentence, the text
     * still sitting there. That is indistinguishable from a broken key, and it is the same
     * complaint the approval card produced from its own side ("simplesmente não envia"). There is
     * nothing to say when the field is EMPTY — that is not a refusal, it is nothing to send.
     */
    if (!canPrompt) {
      setNotice(blocked
        ? (pt
          ? 'Esta sessão está esperando uma resposta à pergunta acima. Escolha uma opção, ou a opção de escrever, para responder daqui.'
          : 'This session is waiting on an answer to the question above. Pick an option, or the write-your-own one, to answer from here.')
        : (pt
          ? 'Esta sessão não está aceitando mensagens agora. Se ela parou, use Reabrir.'
          : 'This session is not taking messages right now. If it has stopped, use Reopen.'))
      return
    }
    // Paths first, on their own lines, then what was typed — the assistant reads the files it is
    // pointed at, and burying the paths inside a sentence makes them easy to miss.
    // Quote first, then the paths, then what was typed. The quote is trimmed to a few lines: a
    // reply that repeats forty lines back at the session costs it context for no benefit.
    const quote = replyTo ? quoteFor(replyTo) : ''
    // `composeReply` puts a BLANK LINE between the blocks, and that is not formatting: joined with a
    // single newline, CommonMark's lazy continuation pulls what was typed into the blockquote, and
    // the person's own words render inside the grey bar as if the session had said them.
    const full = composeReply({ quote, paths: attached.map(a => a.path), text })
    /**
     * THE COMPOSER EMPTIES ON THE KEYSTROKE, NOT ON THE ANSWER.
     *
     * It used to `await act(...)` and only then clear the draft and draw the echo, so the whole
     * round trip was visible as the field sitting there full with nothing happening. Reported as
     * "a partir do momento que eu dou enter numa mensagem ela está demorando pra ser enviada", and
     * the delivery was never the slow part — the WAIT FOR THE ANSWER was, and the browser has
     * nothing to learn from it that changes what it should draw.
     *
     * The echo already carries the honesty this needs: it renders as an UNREAD message with the
     * wait said in words, and it is retired the instant the transcript carries it. So drawing it
     * before the answer is not a claim that it landed — it is the same claim it was already making
     * one round trip later.
     *
     * A FAILURE PUTS IT BACK, exactly as it was: the text, the attachments and the reply target.
     * The one thing a person must never lose is what they wrote, and an optimistic clear that
     * cannot undo itself is how that happens.
     */
    const restore = { draft, attached, replyTo }
    setSending(true)
    editEcho(list => [...list, full])
    setDraft('')
    sessionScratch.clearDraft(scratchId)
    setAttached([])
    sessionScratch.writeAttachments(scratchId, [])
    editReply(null)
    setAtTail(true)
    toTail()
    setNotice(null)

    /**
     * AN ANSWER IS NOT A PROMPT, and it goes down the route the server verified for it.
     *
     * `approve` with the option's `choice` AND the text: the digit selects the write-your-own row
     * and turns it into a field, then the words go in, then the return. Those three steps are the
     * server's (`answerSession`), and sending this as a `prompt` would type it into the dialog's
     * own filter instead — which is exactly what `canPrompt`'s `blocked` rule exists to prevent.
     *
     * The ATTACHMENTS still ride along, because that is half of why the composer is the field here:
     * their paths are part of the answer's text. And the optimistic clear above covers this path
     * unchanged: `restore` puts back the words, the files AND the reply target if it does not go.
     */
    const out = answeringNow && answering
      ? await act({ id: session.id, action: 'approve', choice: answering.number, text: full })
      : await act({ id: session.id, action: 'prompt', text: full })
    setSending(false)
    if (out.ok) {
      // Ask for the transcript at once. The harness writes the user turn as soon as it takes the
      // message, and the next scheduled read is up to `CHAT_POLL_MS` away — three seconds in which
      // the echo sits there labelled as undelivered when it has in fact already landed.
      nudgeChat.current()
      // The question has been answered; the composer stops being an answer field. The card itself
      // goes when the row stops reporting the dialog, which is the server's answer and not ours.
      // Everything else was already cleared on the keystroke — see the optimistic clear above.
      setAnswering(null)
      return
    }
    // It did not go. Take the echo back out — leaving it would show a message that is waiting for
    // a session that never received it — and give the person their words back untouched.
    editEcho(list => list.filter(t => t !== full))
    setDraft(restore.draft)
    sessionScratch.writeDraft(scratchId, restore.draft)
    setAttached(restore.attached)
    sessionScratch.writeAttachments(scratchId, restore.attached)
    editReply(restore.replyTo)
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
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '20px 20px 8px',
          // A flick that reaches the top of the conversation stops HERE. Without it the
          // gesture chains to the document, which has nothing to scroll and rubber-bands the
          // whole page instead — reported as "ele roda a página inteira e não deixa scrollar",
          // with the header dragged out from under the status bar. The document lock in
          // App.tsx is the other half; this is the half that keeps the gesture where it began.
          overscrollBehavior: 'contain',
        }}
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
              {...(payload?.attachmentSends ? { attachmentSends: payload.attachmentSends } : {})}
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
          {queued.map((q, i) => (
            <ChatBubble
              key={`echo-${i}`}
              turn={{ role: 'user', text: q.text }}
              lang={lang}
              harness={session.harness}
              {...(payload?.attachmentSends ? { attachmentSends: payload.attachmentSends } : {})}
              anchorId={turnAnchorId('echo', i)}
              awaiting
              awaitingWorking={working}
              {...(q.at !== undefined ? { awaitingSinceMs: Math.max(0, now - q.at) } : {})}
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

          {/* The conversation on screen is one this tab cached before you left, and the current one
              is on its way. AT THE TAIL rather than the top: the view lands at the end, which is
              where the reader is looking and where the messages that changed will appear. */}
          {showRefreshing && (
            <p role="status" style={{
              margin: 0, textAlign: 'center', fontSize: 11, lineHeight: 1.5,
              color: 'var(--text-tertiary)',
            }}>{pt ? 'Atualizando a conversa…' : 'Updating this conversation…'}</p>
          )}

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
          {blocked && row && (
            <ApprovalCard
              row={row}
              lang={lang}
              act={act}
              answering={answering?.number ?? null}
              onWrite={o => {
                setAnswering({ ...o, shape: dialogShape })
                // The point of handing the composer over is that it is READY — the caret in it, on
                // the next frame, so the next thing the person does is type. Same call the skill
                // picker and the reply buttons already make, for the same reason.
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
            />
          )}
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
              {/* WHAT THE MICROPHONE IS HEARING, live. Interim results are a guess the recogniser
                  keeps revising, so they are shown here and never written into the field — the
                  settled words land in the draft on their own. `role="status"` so it is announced,
                  and it disappears the moment listening stops. */}
              {listening && (
                <p role="status" style={{
                  margin: '0 0 8px', padding: '6px 10px', borderRadius: 9,
                  background: 'var(--bg-elevated)', borderLeft: '3px solid var(--accent-red)',
                  fontSize: 12, lineHeight: 1.45, color: 'var(--text-secondary)',
                  fontStyle: heard === '' ? 'italic' : 'normal',
                }}>
                  {heard === ''
                    ? (pt ? 'ouvindo…' : 'listening…')
                    : heard}
                </p>
              )}

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
                      {/* The picture OPENS. It is a button and not a click handler on the `img`,
                          so it is reachable by keyboard and announced as something that does
                          something — and it stays a SIBLING of the remove control rather than its
                          parent, because a button inside a button is invalid and the inner one
                          stops being clickable in some browsers. */}
                      <button
                        type="button"
                        onClick={() => setComposerLightbox(composerImages.indexOf(a.path))}
                        aria-label={pt ? `Ver ${a.name}` : `View ${a.name}`}
                        style={{
                          display: 'block', width: '100%', height: '100%', padding: 0,
                          border: 'none', background: 'transparent', cursor: 'zoom-in',
                        }}
                      >
                        <img
                          src={attachmentUrl(a.path)} alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      </button>
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
              {showReopen && reopen && (
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

              {/* WHAT THIS FIELD IS ABOUT TO DO. While the composer is answering a dialog, the
                  Enter key does something different from what it does every other minute of the
                  day, and a field that changes meaning without saying so is how somebody sends an
                  answer they meant as a message. It names the option by NUMBER and LABEL — the same
                  two things the card shows — and carries the way out. */}
              {answeringNow && answering && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
                  padding: '7px 10px', borderRadius: 10, minWidth: 0,
                  border: '1px solid var(--anthropic-orange)',
                  background: 'var(--anthropic-orange-dim)',
                }}>
                  <span style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                    background: 'var(--anthropic-orange)', color: '#fff',
                    fontSize: 10, fontWeight: 700,
                  }}>{answering.number}</span>
                  <span style={{
                    minWidth: 0, flex: 1, fontSize: 11.5, lineHeight: 1.45,
                    color: 'var(--anthropic-orange)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {pt
                      ? `Respondendo à pergunta — ${answering.label}`
                      : `Answering the question — ${answering.label}`}
                  </span>
                  <button
                    onClick={() => setAnswering(null)}
                    aria-label={pt ? 'Cancelar a resposta' : 'Cancel answering'}
                    title={pt ? 'Cancelar (Esc)' : 'Cancel (Esc)'}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 24, height: 24, borderRadius: 6, border: 'none', flexShrink: 0,
                      background: 'transparent', color: 'var(--anthropic-orange)', cursor: 'pointer',
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}

              {/* Loose on the composer's own surface — no second card behind it. It used to sit in
                  its own `--bg-base` box with a border, which read as a field floating inside the
                  field that holds it; dropping both leaves it the same colour as its container. */}
              <div style={{
                // NEVER hidden while the field has the caret — see `showReopen`.
                display: showReopen ? 'none' : 'flex',
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
                  onFocus={() => setTyping(true)}
                  onBlur={e => {
                    setTyping(false)
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
                      if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
                        e.preventDefault()
                        const picked = slashFlat[Math.min(slashIndex, slashFlat.length - 1)]
                        if (picked) insertSkill(picked.name)
                        return
                      }
                    }
                    // Escape closes the picker BEFORE it reaches the stop verb: a person dismissing
                    // a list they opened by accident must not interrupt the session's turn.
                    if (e.key === 'Escape' && skillPickerOpen) { e.preventDefault(); setSlashDismissed(true); return }
                    // ON A PHONE, ENTER BREAKS THE LINE. Asked for directly, and it is the
                    // convention every messaging app on a touch keyboard follows: the return key is
                    // the only way to write a second line there, because `shift+enter` needs a
                    // shift key the software keyboard does not have. Sending is the ✈ button, which
                    // is a 44px target sitting right beside the field. On a hardware keyboard the
                    // rule is the opposite one and unchanged — enter sends, shift+enter breaks —
                    // and the picker above follows the same split for the same reason.
                    if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); void send() }
                    // ANSWERING MODE LETS GO FIRST. Escape here means "I am not answering with my
                    // own words after all" — the draft is kept, because it is what was typed and
                    // may well be the next message. Only once that is off does Escape reach the
                    // stop verb; a single key doing both at once is the double-booking the tab bar
                    // was fixed for.
                    if (e.key === 'Escape' && answeringNow) { e.preventDefault(); setAnswering(null); return }
                    // The composer's own "esc": stops the CURRENT turn without touching the draft
                    // or the field's own ability to keep taking text — see `stopNow`.
                    if (e.key === 'Escape' && stopVerb?.enabled) { e.preventDefault(); void stopNow() }
                  }}
                  // NEVER WHILE IT HAS THE CARET. `disabled` blurs, so making it depend on a
                  // 5s poll makes the poll able to interrupt a sentence. What the state actually
                  // has to stop is SENDING, and `send()` refuses on its own — a field that accepts
                  // text it cannot deliver yet costs nothing, while a field that empties your focus
                  // mid-word costs the sentence.
                  disabled={!typing && (!canPrompt || sending)}
                  rows={1}
                  placeholder={answeringNow
                    ? (pt ? 'Escreva a sua resposta…' : 'Write your own answer…')
                    : canPrompt
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
                {/* ANSWERING A QUESTION IS NOT WRITING A PROMPT, so the row is not the same row.
                    An answer travels a different route — `answerSession` presses the option's
                    digit, waits for the field to open, then types ONE line and returns — and an
                    attachment is a PATH on a line of its own, so what would reach the dialog is a
                    path submitted as the answer. The control is removed rather than disabled: a
                    greyed button in a mode a person entered on purpose reads as something broken.
                    Asked for in these words: the prompt input, "removendo alguns botões APENAS PRA
                    RESPONDER A QUESTAO FEITA PELO LLM". */}
                {!answeringNow && (
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
                )}

                {/* DICTATION, beside attach — the pair that PREPARES a message, which is what the
                    left of this row is. It was reachable only through the "more" menu, and two
                    clicks for a control used mid-sentence is one too many.
                    ONLY WHEN IT CAN WORK. Its refusal needs a LINE, not a `title` — the Web Speech
                    API needs a secure context, so a dashboard opened over plain HTTP on a LAN has
                    no microphone at all — and that line only fits in the menu, where the control
                    stays in that case. A control that is present and silently does nothing is the
                    thing this codebase refuses everywhere else.
                    IT IS NO LONGER HIDDEN ON A PHONE. That was a WIDTH argument, written when this
                    was one row holding the field and the buttons together; it became a column, and
                    the row now has the space. Reported as the composer not looking like the
                    desktop's — the microphone was the whole of the difference. Where it cannot
                    work it is still in the menu, on a phone exactly as anywhere else, because there
                    is the only place the reason fits. */}
                {dictation.state === 'ready' && (
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
                    {/* PULSING WHILE IT LISTENS. A microphone button that only changes tint looks
                        the same as one that did nothing, which is how "o mic não funciona" starts:
                        the recogniser was running and nothing on screen said so. The ring is the
                        state, the words below are the evidence. */}
                    <span style={{ position: 'relative', display: 'flex' }}>
                      {listening && (
                        <span
                          aria-hidden
                          className="ag-mic-pulse"
                          style={{
                            position: 'absolute', inset: -5, borderRadius: 12,
                            border: '1.5px solid var(--accent-red)', pointerEvents: 'none',
                          }}
                        />
                      )}
                      <Mic size={15} />
                    </span>
                  </button>
                )}

                {/* Mode · Stop · Recall · Send · More, held together at the far end, in that
                    order: the two that act on the RUNNING TURN, then the two about the message you
                    are writing, then the menu. `marginLeft: auto` on the GROUP rather than on send,
                    so they keep their order and their spacing whether or not the conditional two
                    are there — a margin on send alone would push the more button off to the right
                    on its own the moment a turn ended. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                {/* THE HARNESS MODE, and the one control that changes it.
                    Asked for: "nao consigo alternar entre os modos que os harnesses possuem (auto
                    mode, plan mode etc)", to sit left of the recent-message button.

                    IT CYCLES, and the label says which mode it is IN — not which one it would move
                    to. The harness offers one keystroke and no way to jump to a named mode, so a
                    menu of four would reach three of them by luck; `mode-spec.ts` records the key
                    and the order, driven against a live session.

                    ABSENT when the row carries no mode: a harness nobody has probed, or a frame
                    whose footer has not been read. A chip naming the wrong mode is worse than no
                    chip — it is read at a glance and believed. */}
                {/* NOT WHILE ANSWERING A QUESTION. Asked for: the mode, the model and the last
                    prompt come off the row for as long as the composer is an answer field. They are
                    about the next TURN, and this is not one — cycling the harness's mode with a
                    dialog open sends a keystroke into that dialog. */}
                {row?.mode && !answeringNow && (
                  <button
                    onClick={() => void act({ id: session.id, action: 'cycleMode' })
                      .then(out => setNotice(out.message))}
                    disabled={!canPrompt}
                    aria-label={pt ? `Modo: ${row.mode.label}. Trocar para o próximo.` : `Mode: ${row.mode.label}. Switch to the next.`}
                    title={pt
                      ? `${row.mode.label} — clique para ir ao próximo modo`
                      : `${row.mode.label} — click to move to the next mode`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 9px',
                      borderRadius: 9, flexShrink: 0, maxWidth: 150,
                      // The colour IS the mode — see `modeStyle.ts`. Ordered by how much the
                      // session proceeds without asking, and never the fault colour: `auto` is how
                      // this product is normally used, and a red ordinary state is the cry-wolf
                      // this codebase avoids everywhere else.
                      border: `1px solid ${modeStyle(row.mode.id).border}`,
                      background: modeStyle(row.mode.id).bg,
                      color: modeStyle(row.mode.id).fg,
                      fontFamily: 'inherit', fontSize: 11.5,
                      cursor: canPrompt ? 'pointer' : 'default',
                      opacity: canPrompt ? 1 : 0.55,
                    }}
                  >
                    <SlidersHorizontal size={13} style={{ flexShrink: 0 }} />
                    <span style={{
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{row.mode.label}</span>
                  </button>
                )}

                {/* THE LAST MESSAGE YOU SENT. ABSENT until there is one — `lastSent` is null on a
                    conversation nobody has written into yet, and a control whose only outcome is a
                    modal saying "nothing" is one that exists to refuse. It sits with the acting
                    group because it is about what you have already sent, not about composing.
                    NOT WHILE ANSWERING A QUESTION, with the mode chip and the model: all three are
                    about the next TURN, and this is an answer to a dialog already open. */}
                {lastSent && !answeringNow && (
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

                {/* ONE SLOT: STOP WHILE IT WORKS, SEND WHEN IT DOES NOT.
                    A stop on an idle session would send Escape into its prompt, which is the row's
                    own gate on `interrupt`.

                    This supersedes an earlier reorder of mine and does its job better. The
                    complaint was that stop appeared and disappeared in the MIDDLE of the group, so
                    every time a turn ended send jumped left under a thumb already moving toward it;
                    moving stop to the head of the group only shortened the jump. Sharing one slot
                    removes it: the control under your thumb is always the one you want, and
                    nothing else shifts at all. */}
                {working && stopVerb?.enabled ? (
                  <button
                    onClick={() => void stopNow()}
                    disabled={stopping}
                    title={stopVerb!.label}
                    aria-label={stopVerb!.label}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, borderRadius: 9, flexShrink: 0, border: 'none',
                      cursor: stopping ? 'default' : 'pointer',
                      // Filled, not outlined: this is the one control in the row that ENDS
                      // something, and an outline reads as the same weight as the others.
                      background: 'var(--accent-red)',
                      color: '#fff',
                    }}
                  >
                    {stopping ? <Loader size={14} className="ag-working-spin" /> : <Square size={13} fill="currentColor" />}
                  </button>
                ) : (
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
                )}

                {/* Mic and model live behind ONE button. Four controls plus the field on a
                    390px screen is a row where the buttons win, and these two are the pair a person
                    reaches for occasionally — attach and send are the ones used every turn.
                    A menu, not a second row: another row costs height, which is the thing a phone
                    has least of. */}
                {/* AND THE MENU GOES TOO. What is behind it — the model and the session's mode —
                    is about the NEXT prompt, not about the answer to a question already on screen;
                    changing the model does not change what the dialog does with the line it is
                    waiting for. Dictation stays, because it only puts words in the field, and the
                    field is the one thing this mode is FOR. */}
                {!answeringNow && (
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
                          say why. The `isMobile` half of this condition is gone with the one on the
                          row: the two are the SAME switch, and leaving one of them would put the
                          microphone in both places on a phone, which is the bug below.
                          It was `hidden` and that did nothing: the row sets `display: flex` inline,
                          and an inline style beats the user-agent rule `[hidden] { display: none }`
                          without `!important`. So the microphone appeared TWICE — reported as
                          exactly that. A conditional render has no such loophole. */}
                      {/* IT IS ONLY EVER DISABLED HERE, and the compiler is what said so: this
                          branch is reached only when the state is NOT `ready`, so the enabled half
                          of this row — its click, its cursor, its "Parar de ouvir" — was code that
                          could not run. It existed for the phone, which used to be sent here even
                          when dictation worked. The row is now what it always was in practice: the
                          REASON dictation is unavailable, said where there is room to say it. */}
                      {dictation.state !== 'ready' && <div
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                          minHeight: 40, padding: '6px 8px', borderRadius: 7,
                          color: 'var(--text-tertiary)', fontFamily: 'inherit', fontSize: 12.5,
                        }}
                      >
                        <Mic size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <span>{pt ? 'Ditar' : 'Dictate'}</span>
                          {dictation.reason && (
                            <span style={{ fontSize: 10.5, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                              {dictation.reason}
                            </span>
                          )}
                        </span>
                      </div>}

                      {/* The address that WOULD work, when there is one.
                          `localhost` is a secure context and `http://192.168.x.y:47292` is not, so
                          a member machine's dashboard has an exact equivalent one click away —
                          naming it is more useful than naming the rule. Only a literal IPv4 host is
                          rewritten (see `insecureAlternative`): sending someone from a hostname to
                          `localhost` would be a guess about which machine they are sitting at, so
                          where there is no answer this row is simply absent. */}
                      {dictation.state === 'insecure' && (() => {
                        // `!isMobile` is the "am I sitting at the machine serving this page" the
                        // rewrite needs. A phone reaches the dashboard by its LAN address and
                        // nothing else, so `localhost` there is the PHONE — a link to a page that
                        // cannot load, offered on the one device where this refusal always fires.
                        const alt = typeof window === 'undefined'
                          ? null
                          : insecureAlternative(window.location.href, !isMobile)
                        return alt === null
                          ? (
                            // Said rather than left blank: "the microphone needs HTTPS" with no
                            // follow-up reads as a bug in this product, and it is a rule of the
                            // browser that nothing here can lift.
                            <p style={{
                              margin: 0, padding: '4px 8px 8px 30px', fontSize: 10.5,
                              lineHeight: 1.45, color: 'var(--text-tertiary)',
                            }}>
                              {pt
                                ? 'Num celular não há alternativa: o navegador só libera o microfone em HTTPS, e este painel está em HTTP na rede local. Dite no computador ou sirva o painel por HTTPS.'
                                : 'On a phone there is no alternative: the browser only allows the microphone over HTTPS, and this dashboard is on plain HTTP over the local network. Dictate on the computer, or serve it over HTTPS.'}
                            </p>
                          )
                          : (
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
                          offering a control that answers nothing.
                          ABSENT WHILE ANSWERING A QUESTION, with the mode chip and the recall
                          button: choosing a model is a decision about the next turn, and this is an
                          answer to a dialog that is already open. */}
                      {answeringNow ? null : modelReason ? (
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

                      {/* THE SKILLS LIST LIVED HERE AND IS GONE. It was the only place to see
                          them; there is a dedicated view now, and two lists of one thing are two
                          places for them to disagree about what is installed. What stays is the
                          `/` picker IN THE FIELD, which is a different gesture — completing what
                          you are already typing, not browsing. */}
                    </div>
                  )}
                </div>
                )}

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

      {/* THE ATTACHED PICTURE, full size. The same component a sent message opens, over the images
          attached right now — reused rather than reimplemented, so what you attached and what you
          sent are viewed the same way. `composerLightboxAt` is what keeps it honest when the list
          is edited underneath it. */}
      {composerLightboxAt !== null && (
        <AttachmentLightbox
          paths={composerImages}
          index={composerLightboxAt}
          onIndexChange={setComposerLightbox}
          onClose={() => setComposerLightbox(null)}
          lang={lang}
        />
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
