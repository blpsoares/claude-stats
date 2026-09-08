/**
 * SessionsPage — the CENTRE of the sessions workspace.
 *
 * On DESKTOP the list is not here: it is the aside's body (`SessionsAside`), because in this
 * workspace the sidebar IS the list, the way the chat applications this is shaped after do it. So
 * the page has two states — nothing selected, which shows what the fleet is doing, and one session
 * selected, which shows that session as a conversation or as its terminal.
 *
 * On MOBILE there is no aside at all — `App.tsx` renders `SideNav` only above the breakpoint — so
 * the page carries both halves and shows ONE AT A TIME, which is the convention every other
 * full-screen surface here follows. Nothing selected is the list; a selection is the session, with
 * a way back. The same components either way: a phone-only list would be a second implementation of
 * the arrangement, and it would drift.
 *
 * What it does NOT do is fetch. `useFleet` is a shared, refcounted store: the aside and this page
 * read the same snapshot from the same poll, so a list and a detail pane can never disagree about
 * a session's state by one poll interval — which is a bug people report as flicker.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, FileText, MessagesSquare, Plus, TerminalSquare } from 'lucide-react'
import type { AppContext } from '../lib/app-context'
import { useFleet, useFleetIndex, type FleetActionId } from '../lib/fleet'
import { useIsMobile } from '../hooks/useIsMobile'
import { FleetOverview } from '../components/sessions/FleetOverview'
import { SessionCreating } from '../components/sessions/SessionCreating'

/**
 * How long a navigation may keep claiming its session is still coming.
 *
 * `NewSessionModal.waitForRow` already gave the SERVER 6s to hold the row; this covers the poll
 * that brings it to THIS browser afterwards. Past it the page stops asserting and says the id
 * names nothing here, which is the honest answer and the one that can be acted on — a loader with
 * no end cannot be told from a session that never started.
 */
const CREATE_WAIT_MS = 20_000
import { SessionStatsMenu } from '../components/sessions/SessionStatsMenu'
import { MagnifierButton } from '../components/a11y/MagnifierButton'
import { HideLensesButton } from '../components/a11y/HideLensesButton'
import { ArtifactsAside } from '../components/sessions/ArtifactsAside'
import {
  ASIDE_ANIM_MS, ASIDE_EASE, edgeHint, panelWidth, resolveArtifactLayout,
  type ArtifactLayout,
} from '../lib/artifactLayout'
import { closeArtifacts, openArtifacts, setArtifactCount, useArtifacts } from '../lib/artifactsStore'
import type { Artifact } from '../lib/sessionArtifacts'
import { liveEvents, type LiveTurn } from '../lib/artifactTabs'
import { FiltersBar } from '../components/FiltersBar'
import { SessionPanel, type SessionView } from '../components/sessions/SessionPanel'
import { SessionsAside } from '../components/nav/SessionsAside'
import { SessionActions } from '../components/sessions/SessionActions'
import { filterFleet } from '../lib/fleetFilter'
import { FiltersSheet } from '../components/sessions/FiltersSheet'
import { sessionPath } from '../lib/sessionRoute'

/** The dimensions a live fleet row can be narrowed by — the same set on both layouts. */
const FLEET_FILTER_DIMS: Array<'harnesses' | 'repos' | 'projects' | 'models'> =
  ['harnesses', 'repos', 'projects', 'models']

export default function SessionsPage() {
  const ctx = useOutletContext<AppContext>()
  const {
    lang, isCentral, theme, filters, setFilters, activeOnly, setActiveOnly,
    availableProjects, sessionCountByProject, models, availableHarnesses, derived,
    data, currency, brlRate,
  } = ctx
  const pt = lang === 'pt'
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  /**
   * Which of the phone's two screens is showing when no session is open.
   *
   * `list` by default: a phone opens this page to reach a session, and the metrics are the thing
   * you go and look at. Not in the URL — it is a view preference on one screen, not a place.
   */
  const [mobileTab, setMobileTab] = useState<'list' | 'overview'>('list')
  /**
   * The mobile filters live in a SHEET, and this is whether it is open.
   *
   * Both mobile bars — the list's and the open session's — raise the same one: which filters are on
   * is a property of the workspace, not of the screen you happen to be on, and two sheets would be
   * two states to keep in step.
   */
  const [sheetOpen, setSheetOpen] = useState(false)

  // Never on a central: it aggregates many machines and hosts none of their sessions, so the only
  // fleet it could read is its own box's, drawn under someone else's rows.
  const { fleet, loading, unsupported: pollUnsupported, stale, act, refresh } = useFleet(pt ? 'pt' : 'en')
  /**
   * A CENTRAL cannot list a fleet, and must SAY so.
   *
   * `useFleet`'s second argument only stops the polling, and its `unsupported` is reported as false
   * whenever polling is off — so on a central the page fell through every branch to "No sessions on
   * this machine yet.", which is false twice over: a central hosts no sessions, and the machines'
   * sessions it CAN reach are one screen away in Settings → Machines. The one sentence that would
   * have said the true thing was switched off by the very flag that makes it true.
   *
   * The same N/A-versus-a-confident-0 rule the dashboard applies to harness capabilities: an empty
   * list may never stand in for "this install cannot answer".
   */
  // NOT `|| isCentral` any more: on a central the fleet is answered by the RELAY for the machine
  // the aside's picker has chosen, so `unsupported` is again exactly what the poller reports —
  // including the machine's own named refusal.
  const unsupported = pollUnsupported
  const rowIndex = useFleetIndex(fleet.sessions)

  // Matched on BOTH ids for the same reason `fleetIndex` is keyed on both: a managed row is named
  // by its tmux session, while a closed conversation is named by its own conversation id, and a
  // link may carry either.
  const selected = sessionId === undefined
    ? undefined
    : fleet.rows.find(r => r.id === sessionId || r.conversationId === sessionId)

  /**
   * A SESSION THAT IS ON ITS WAY IS NOT A SESSION THAT IS MISSING.
   *
   * `NewSessionModal` navigates here the moment the spawn returns, and this browser's fleet does
   * not hold the row until its next poll — so `selected` is undefined and this page fell through
   * to its "nothing selected" branch, which is the fleet OVERVIEW. Creating a session therefore
   * flashed the metrics screen and jumped to the session a poll later. The overview was not wrong
   * about anything; it was answering a question nobody had asked.
   *
   * The router state is what tells the two apart, and it is BOUNDED: past the budget this stops
   * claiming the session is coming and the page says what it has always said — that the id names
   * nothing here. A loader with no end is the worse failure, because it cannot be told from a
   * session that simply never started.
   */
  const creatingState = (useLocation().state as { creating?: { harness?: string; label?: string } } | null)?.creating
  const [creatingSince] = useState(() => Date.now())
  const arriving = creatingState !== undefined
    && sessionId !== undefined
    && Date.now() - creatingSince < CREATE_WAIT_MS
  const creating = arriving && selected === undefined
  /**
   * ONE FRAME, and only so the finish is real.
   *
   * The bar can only reach 100 and turn orange on `ready`, and `ready` is the row arriving — which
   * is the same instant this page would swap in the session. Handing over on the next animation
   * frame lets that state be painted instead of existing only in the types. It is a frame, not a
   * beat: nothing here is watched to the end, and showing the session fast is the whole point.
   */
  const [handedOver, setHandedOver] = useState(false)
  const finishing = arriving && selected !== undefined && !handedOver
  useEffect(() => {
    if (!finishing) return
    const raf = requestAnimationFrame(() => setHandedOver(true))
    return () => cancelAnimationFrame(raf)
  }, [finishing])

  // The Chat/Terminal choice, in the URL — the SAME `?view=` the shared header in `App.tsx` reads
  // and writes on desktop. Independent `useSearchParams()` calls on the one search string, not a
  // prop threaded down from there: the header and this page can never disagree about which view is
  // showing without a context wire built just to carry two strings.
  const [viewParams, setViewParams] = useSearchParams()
  const sessionView: SessionView = viewParams.get('view') === 'terminal' ? 'terminal' : 'chat'
  const setSessionView = (v: SessionView) => setViewParams(prev => {
    const next = new URLSearchParams(prev)
    if (v === 'chat') next.delete('view')
    else next.set('view', v)
    return next
  }, { replace: true })

  /** The fleet as the aside is showing it — one narrowing, read by both. */
  const overviewRows = useMemo(
    () => filterFleet({ rows: fleet.rows, filters, activeOnly }).rows,
    [fleet.rows, filters, activeOnly],
  )

  /**
   * THE ARTIFACTS PANEL.
   *
   * The list arrives from `SessionChat`, which already polls the conversation it is derived from —
   * a second poller for the same turns would be two readers disagreeing about one session. The open
   * flag lives in `artifactsStore` because the BUTTON is in the header, which is not an ancestor of
   * this page.
   */
  const [artifacts, setArtifacts] = useState<readonly Artifact[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(true)
  const [artifactsUnavailable, setArtifactsUnavailable] = useState<string | undefined>(undefined)
  /** The conversation behind these lists is the END of a longer one — see `chat-web.ts`'s `older`. */
  const [artifactsOlder, setArtifactsOlder] = useState<string | undefined>(undefined)
  const [artifactsUnlisted, setArtifactsUnlisted] = useState(false)
  /** The conversation's turns, for the LIVE tab — the same ones the chat renders. */
  const [artifactTurns, setArtifactTurns] = useState<readonly LiveTurn[]>([])

  /**
   * WHICH of the recorded paths are still readable files with content — the server's answer, because
   * only it can look at the disk. A transcript records temporary files that were deleted, writes by
   * commands that failed, and redirections into directories that never existed; all three read like
   * a file somebody would want to open, and all three refuse when clicked.
   *
   * Keyed by the path AS RECORDED, which is the key the browser's own list is built on.
   */
  const [onDisk, setOnDisk] = useState<Map<string, { bytes: number; scope: 'project' | 'temp' }>>(new Map())
  /**
   * Already-localized: files this session wrote OUTSIDE its own folder, which the list cannot offer.
   *
   * Reported as the panel missing a file the session had just written. It had not missed it — the
   * list drops what the read route would refuse, because a row whose only outcome is a refusal is
   * worse than no row. What was wrong is that the drop was SILENT, and a silent drop reads as a bug
   * in the panel. A count and a sentence say the list is complete for what it can serve, and that
   * something else was written elsewhere; the paths themselves stay off the screen, or explaining
   * the guard would undo it.
   */
  const [outsideNote, setOutsideNote] = useState<string | null>(null)
  useEffect(() => {
    if (!selected) { setOnDisk(new Map()); setOutsideNote(null); return }
    let alive = true
    const read = async () => {
      try {
        const r = await fetch(`/api/fleet/artifacts?id=${encodeURIComponent(selected.id)}&lang=${pt ? 'pt' : 'en'}`)
        if (!r.ok || !alive) return
        const d = await r.json() as {
          files?: { raw: string; bytes: number; scope: 'project' | 'temp' }[]
          outside?: string
        }
        setOnDisk(new Map((d.files ?? []).map(f => [f.raw, { bytes: f.bytes, scope: f.scope }])))
        setOutsideNote(d.outside ?? null)
      } catch { /* the list simply stays as it was */ }
    }
    void read()
    // Slower than the conversation poll: a file's EXISTENCE changes far less often than the
    // conversation does, and this one stats every recorded path.
    const t = setInterval(read, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [selected?.id, pt])

  /**
   * The panel's width, dragged and remembered — the right aside was fixed while the left one has
   * always been resizable, and a reader comparing a file with the conversation needs to choose
   * which of the two gets the room.
   */
  const [artWidth, setArtWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('agentistics:artifacts-w'))
    // 620 by default, not 440: the panel's job is reading a FILE, and code at 440px wraps or
    // scrolls sideways on nearly every line. A reader who wants the conversation wider can drag it
    // back, and that choice is remembered.
    return Number.isFinite(v) && v >= 280 ? Math.min(v, 900) : 620
  })
  const dragArt = useRef<{ x: number; w: number } | null>(null)
  /** A resize in progress. Only used to suspend the open/close animation — see `asideMotion`. */
  const [artDragging, setArtDragging] = useState(false)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragArt.current) return
      // The panel grows as the pointer moves LEFT, so the delta is inverted.
      const next = Math.max(280, Math.min(900, dragArt.current.w + (dragArt.current.x - e.clientX)))
      setArtWidth(next)
    }
    const up = () => {
      if (!dragArt.current) return
      dragArt.current = null
      setArtDragging(false)
      document.body.style.userSelect = ''
      try { localStorage.setItem('agentistics:artifacts-w', String(artWidth)) } catch { /* private mode */ }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [artWidth])
  const art = useArtifacts()
  const onArtifacts = useCallback((a: { artifacts: Artifact[]; loading: boolean; unavailable?: string; older?: string; unlisted: boolean; turns: readonly LiveTurn[] }) => {
    setArtifacts(a.artifacts)
    setArtifactsUnlisted(a.unlisted)
    setArtifactTurns(a.turns)
    setArtifactsLoading(a.loading)
    setArtifactsUnavailable(a.unavailable)
    setArtifactsOlder(a.older)
    if (selected) setArtifactCount(selected.id, a.artifacts.length)
  }, [selected])

  /**
   * NOTHING OPENS THIS PANEL BUT A PERSON.
   *
   * It used to open itself when a file started being written — asked for, in those words, and then
   * asked to stop: "a barra de contents ta abrindo sozinha as vezes, nao quero que isso aconteça".
   * Both asks are the same underlying want, and the second one names the part that matters: what a
   * reader wants is to KNOW something is happening, not to have the conversation they are reading
   * shoved aside by a panel taking half the screen.
   *
   * The strip carries that now. It appears while the session is writing or running, says what and
   * where, and opens the panel on the live feed when it is pressed — an announcement, and then a
   * choice, instead of an interruption. `shouldAutoOpen` is gone rather than left unused: a rule
   * nothing calls is a rule that gets called again by somebody who finds it. The strip's own
   * condition is `edgeHint` further down, over the live EVENTS — a broader signal than "a file is
   * being written", which is what makes it able to announce a command and its output too.
   */

  const artLayout = resolveArtifactLayout({
    open: art.open && selected !== undefined,
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    isMobile,
    // Phase B ships without the reversal control; the split-rail default is what the plan measured.
    listExpandedByUser: false,
  })

  /**
   * THE PANEL SLIDES, and it slides like the nav does.
   *
   * Two things are needed for a width to animate, and the panel had neither: the element must be
   * MOUNTED while it shrinks (a closed panel was returning a different tree entirely, so closing
   * was an unmount and nothing could tween), and it must OPEN from a width it was rendered at
   * (mounting straight at 620px is a jump, not a transition).
   *
   * So `asideAlive` keeps it on screen for the length of the animation after it is closed, and
   * `asideIn` is flipped a frame LATER, which is what gives the browser a from-value. Two frames,
   * not one: React can commit the mount and the flag in the same paint, and then there is nothing
   * to interpolate between.
   *
   * `ASIDE_ANIM_MS` is read for BOTH the transition and the unmount delay — a second constant is a
   * second chance for the content to vanish while its box is still shrinking.
   */
  const asideShown = artLayout.layout !== 'closed'
  const [asideAlive, setAsideAlive] = useState(asideShown)
  const [asideIn, setAsideIn] = useState(asideShown)
  useEffect(() => {
    if (asideShown) {
      setAsideAlive(true)
      let inner = 0
      const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setAsideIn(true)) })
      return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
    }
    setAsideIn(false)
    const t = setTimeout(() => setAsideAlive(false), ASIDE_ANIM_MS)
    return () => clearTimeout(t)
  }, [asideShown])
  /**
   * WHICH exit to play. A layout is decided by the window width, so a panel closed after the window
   * narrowed must not slide out as the layout it is no longer in — the split shrinks its width and
   * the overlay slides off the right edge, and playing the wrong one leaves the panel jumping to
   * full width before it goes. Held in a ref, so remembering it never costs a render.
   */
  const closingAs = useRef<ArtifactLayout>('split')
  if (asideShown) closingAs.current = artLayout.layout
  /** The width the split animates between. Zero while closing; the drag suspends the tween. */
  const asideMotion = artDragging ? 'none' : `width ${ASIDE_ANIM_MS}ms ${ASIDE_EASE}`
  /**
   * The room the split actually has, MEASURED — not `window.innerWidth` minus a guess at the nav.
   *
   * It is what `panelWidth` clamps the stored width against, and it has to be observed rather than
   * computed once: the nav collapses, the fleet list becomes a rail when the panel opens, and the
   * window is resized. Each of those changes the room without changing anything this component
   * renders, so a value read at mount would be wrong by the second frame.
   */
  const splitRef = useRef<HTMLDivElement | null>(null)
  const [splitRoom, setSplitRoom] = useState(0)
  useEffect(() => {
    const el = splitRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setSplitRoom(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  })
  /** What the panel may take here, as opposed to what it remembers wanting. See `panelWidth`. */
  const shownArtWidth = panelWidth(splitRoom, artWidth)

  /**
   * THE EDGE MARKER — what the harness is doing right now, with the panel shut.
   *
   * Asked for directly: a session that starts working should say so from the edge of the screen,
   * and clicking it should open the live view. `edgeHint` decides whether there is anything worth
   * saying; this only draws it.
   */
  const hint = edgeHint({
    open: art.open,
    events: liveEvents(artifactTurns),
    isMobile,
  })
  const HINT_VERB: Record<string, string> = {
    wrote: pt ? 'escrevendo' : 'writing',
    read: pt ? 'lendo' : 'reading',
    ran: pt ? 'rodando' : 'running',
    thought: pt ? 'pensando' : 'thinking',
    delegated: pt ? 'delegando' : 'delegating',
  }
  const edgeMarker = hint === null || selected === undefined ? null : (
    <button
      // LIVE, not wherever the panel was last left: this control says the harness is running
      // something, so the answer to pressing it is the feed of what it is doing.
      // LIVE, and ON THE ACTION IT NAMES. Landing on the top of the feed made the strip a
      // navigation control rather than an answer: it says "running bun test", and the row saying
      // so is somewhere in a list the reader then has to search. `hint.ref` is absent for an event
      // with no step behind it (reasoning carries its own text), and then this opens the feed
      // exactly as it did before.
      onClick={() => openArtifacts('live', hint.ref)}
      title={`${HINT_VERB[hint.kind]} · ${hint.text}`}
      style={{
        // THIRD PLACE, and the first two were both wrong for the same reason: it FLOATED.
        // Hanging off the middle of the right edge it covered the conversation's text; sitting
        // above the composer it covered the composer — "ficou ULTRA em cima do input de prompt".
        // Anything absolutely positioned over a chat is over SOMETHING, because a chat has no
        // reliably empty region: the messages grow up from the composer and the gap between them
        // closes as soon as there is anything to read.
        // So it stopped floating. It is a strip at the TOP of the conversation, in the flow, under
        // the header — the place a status line lives in every application that has one, pushing
        // the messages down by its own height instead of hiding one of them. It is also where the
        // eye goes when something changes, which is the whole reason it exists.
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        width: '100%', padding: '7px 14px', textAlign: 'left', cursor: 'pointer',
        border: 'none', borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--anthropic-orange-dim)', color: 'var(--text-primary)',
        fontFamily: 'inherit', fontSize: 11.5,
      }}
    >
      {/* It PULSES, because the fact it reports is that something is happening right now — a
          static dot beside a static line is indistinguishable from a label. */}
      <span aria-hidden className="ag-hint-pulse" style={{
        width: 7, height: 7, borderRadius: 4, flexShrink: 0,
        background: 'var(--anthropic-orange)',
      }} />
      <span style={{ fontWeight: 700, color: 'var(--anthropic-orange)', flexShrink: 0 }}>
        {HINT_VERB[hint.kind]}
      </span>
      {/* The THING, not a count: a path or a command says whether this is worth watching. */}
      <span style={{
        minWidth: 0, flex: 1, color: 'var(--text-tertiary)', fontSize: 11,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
      }}>{hint.text}</span>
      <span style={{ flexShrink: 0, color: 'var(--anthropic-orange)', fontSize: 11 }}>
        {pt ? 'acompanhar →' : 'follow →'}
      </span>
    </button>
  )

  const artifactsPane = selected === undefined ? null : (
    <ArtifactsAside
      sessionId={selected.id}
      // The MCP tab's per-directory scopes are resolved against this; with no directory they are
      // absent from the picker rather than silently widened to "this machine".
      {...(selected.cwd ? { cwd: selected.cwd } : {})}
      lang={pt ? 'pt' : 'en'}
      // Only what the server confirmed is still a file with content. Until it has answered the
      // list is shown as recorded, so the panel is never empty for the length of a request.
      artifacts={onDisk.size === 0 ? artifacts : artifacts.filter(a => onDisk.has(a.path))}
      facts={onDisk}
      {...(outsideNote ? { outsideNote } : {})}
      loading={artifactsLoading}
      {...(artifactsUnavailable ? { unavailable: artifactsUnavailable } : {})}
      {...(artifactsOlder ? { older: artifactsOlder } : {})}
      unlistedWrites={artifactsUnlisted}
      turns={artifactTurns}
      tabRequest={art.tabRequest}
      // The session itself, for the TASKS tab: what it is filed under, and the composer that files
      // it somewhere new without leaving the session you are sitting in.
      session={{
        id: selected.id,
        title: selected.title,
        harness: selected.harness,
        ...(selected.task ? { task: selected.task } : {}),
      }}
      onOpenTask={taskId => navigate(`/tasks/${encodeURIComponent(taskId)}`)}
      // The badge on the row is the fleet's; re-poll so it agrees with what the tab just did.
      onTaskChanged={refresh}
      onClose={closeArtifacts}
    />
  )

  const panel = selected === undefined ? null : (
    <SessionPanel
      session={selected}
      {...(rowIndex.get(selected.id) ? { row: rowIndex.get(selected.id)! } : {})}
      lang={pt ? 'pt' : 'en'}
      theme={theme === 'light' ? 'light' : 'dark'}
      act={act}
      onGone={() => navigate('/sessions')}
      // Follow a reopen to the row it created. Without it the panel keeps an id the fleet no longer
      // carries — see `SessionPanel`'s own `onOpened`.
      onOpened={id => navigate(sessionPath(id))}
      // CONTROLLED on both layouts now. Passing `onViewChange` is what suppresses SessionPanel's
      // own header, and mobile draws the same three things in the row that already holds the back
      // button — one bar instead of two stacked ones saying overlapping things.
      view={sessionView}
      onViewChange={setSessionView}
      onArtifacts={onArtifacts}
    />
  )

  /**
   * How many dimensions are narrowing the list — the badge on the filter icon.
   *
   * `activeOnly` counts. It is not a `Filters` dimension (see `FiltersBar`'s doc comment on
   * `onActiveOnlyChange`) but it is the one that removes the most rows, and a badge that ignored it
   * would read `0` on the arrangement the workspace SHIPS with, which is the arrangement people
   * would be trying to explain to themselves.
   */
  const filterCount =
    (activeOnly ? 1 : 0) +
    [
      (filters.harnesses?.length ?? 0) > 0,
      (filters.repos?.length ?? 0) > 0,
      filters.projects.length > 0,
      (filters.models?.length ?? 0) > 0,
    ].filter(Boolean).length

  /** The filter icon both mobile bars carry. Same sheet, same count, same target size. */
  /**
   * THE SAME CONTROL THE DESKTOP HAS, said the same way.
   *
   * It was a sliders icon, which is the shape every other product uses for SETTINGS — and this page
   * already has a settings gear elsewhere, so the one control that narrows the list read as the one
   * that configures it. The desktop bar has always called it `+ Filtro`; asked for, and it is the
   * cheaper half of "make the two layouts the same feature".
   *
   * The 44px height stays — it is the mobile target this repo holds everything to — and the label
   * only costs width, which this bar has once the sliders icon's dead space is spent on it.
   */
  /**
   * THE MAGNIFIER, IN THE BAR — it was floating over the middle of the conversation.
   *
   * `MagnifierLayer` draws its own fixed button at `top: 50%` when no chrome offers it a slot, and
   * this workspace was the one mobile screen that offered none (`headerHostsMagnifier` excludes it
   * by name). So on a phone it sat in the vertical centre, over the message somebody was reading —
   * reported as "ta perdida no meio da tela", with a screenshot of it on top of a paragraph.
   *
   * It belongs in the bar for the same reason it is in the desktop's strip, and it costs this bar
   * nothing when it is not wanted: `MagnifierButton` returns null unless the magnifiers have been
   * turned on, so a phone that never enabled them never gives up the width.
   */
  const magnifierButton = isMobile
    ? (
      <>
        <MagnifierButton ctx={ctx} />
        {/* Its pair. The floating fallback drew BOTH, and taking over the slot means taking over
            both — a phone that had opened lenses here would otherwise have no way to hide them,
            because a pinned lens takes no pointer events of its own. It renders nothing until
            there is a lens to hide. */}
        <HideLensesButton ctx={ctx} />
      </>
    )
    : null

  const filterButton = (
    <button
      onClick={() => setSheetOpen(true)}
      aria-label={pt ? 'Filtros' : 'Filters'}
      aria-haspopup="dialog"
      style={{
        display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
        height: 44, padding: '0 10px',
        border: 'none', background: 'transparent',
        color: filterCount > 0 ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
        fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
      }}
    >
      <Plus size={15} style={{ flexShrink: 0 }} />
      <span>{pt ? 'Filtro' : 'Filter'}</span>
      {filterCount > 0 && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, flexShrink: 0,
          background: 'var(--anthropic-orange)', color: '#fff', fontSize: 10, fontWeight: 700,
        }}>{filterCount}</span>
      )}
    </button>
  )

  /**
   * The sheet itself — rendered by BOTH mobile branches, built once here.
   *
   * The bar inside is the ordinary `compact` `FiltersBar`, unchanged, on the same shared state the
   * desktop strip edits. `Clear` is offered only when there is something set, and it clears the
   * fleet's own dimension too: leaving "active only" on after a "clear" that says nothing about it
   * is a filter still narrowing the list under a control that claims to have stopped.
   */
  const filtersSheet = (
    <FiltersSheet
      open={sheetOpen}
      onClose={() => setSheetOpen(false)}
      {...(filterCount > 0
        ? {
            onClear: () => {
              setActiveOnly(false)
              setFilters({ ...filters, harnesses: [], repos: [], projects: [], models: [] })
            },
          }
        : {})}
      lang={pt ? 'pt' : 'en'}
    >
      <FiltersBar
        compact
        only={FLEET_FILTER_DIMS}
        activeOnly={activeOnly}
        onActiveOnlyChange={setActiveOnly}
        filters={filters}
        onChange={setFilters}
        projects={availableProjects}
        sessionCountByProject={sessionCountByProject}
        models={models}
        harnesses={availableHarnesses}
        users={[]}
        lang={lang}
      />
    </FiltersSheet>
  )

  // ---------------------------------------------------------------------------
  // Mobile: one column at a time.
  // ---------------------------------------------------------------------------
  if (isMobile) {
    // A session that is on its way owns the whole surface — before the panel branch, because
  // `finishing` is the one moment BOTH are true, and before the overview branch, which is the
  // metrics screen this replaced. One rule, both layouts: the loader is the same on a phone.
  if (creating || finishing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <SessionCreating
          lang={pt ? 'pt' : 'en'}
          ready={finishing}
          {...(creatingState?.harness ? { harness: creatingState.harness } : {})}
          {...(creatingState?.label ? { label: creatingState.label } : {})}
        />
      </div>
    )
  }

  if (panel && selected) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* ONE bar. It used to be two: this back row, and SessionPanel's own header directly
              under it carrying the title, the tabs and the verbs. On a 390px screen that spent
              ~100px of a 664px viewport on chrome before a single message — and the back arrow
              already says where you are, so the word beside it was the least useful thing there.
              The arrow keeps its own 44px target; the title takes the room the label gave up. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            minHeight: 44, padding: '0 10px', flexShrink: 0,
            // Installed as a PWA this is the topmost thing on the screen, so it carries the
            // status-bar band itself — without it the arrow and the tabs sat under the clock and
            // the taps went to the status bar. See `--safe-top`.
            paddingTop: 'var(--safe-top)',
            borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)',
          }}>
            <button
              onClick={() => navigate('/sessions')}
              aria-label={pt ? 'Voltar para as sessões' : 'Back to sessions'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                // 44px is the mobile figure, and this is the only way back from this screen.
                width: 44, height: 44, flexShrink: 0, marginLeft: -6,
                border: 'none', background: 'transparent', color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              <ChevronLeft size={20} />
            </button>

            <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span style={{
                fontSize: 13, fontWeight: 650, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {selected.title}
              </span>
              {/* The state stays, on its own line: it is the one fact that changes while you read,
                  and the row below is a conversation that does not repeat it. */}
              <span style={{
                fontSize: 10.5, color: 'var(--text-tertiary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {selected.stateLabel}
                {selected.project ? ` · ${selected.project}` : ''}
              </span>
            </div>

            {/* ONLY THE TITLE AND THE METRICS, and that is the whole of this bar's rule.
                It carried the back arrow, `+ Filtro` with its word and badge, the view toggle, the
                metrics with their percentage, the panel button and the verbs — about 382px of a
                390px screen. The title block is `flex: 1, minWidth: 0`, so it was squeezed to
                nothing and the one thing saying WHICH session you are looking at was not on screen.

                Everything that is not the title or the metrics moved into the verbs' OWN menu —
                not a second popover beside it, which would be the same accumulation rearranged.
                The METRICS stay out here because the context percentage is read at a GLANCE and
                changes what you do next: a conversation near its window is one to finish rather
                than extend, and a figure you have to open a menu for is a figure nobody watches.
                The view toggle went in with the rest: asked for directly, after it had been left
                out here on the argument that two taps per switch was too many. */}
            {magnifierButton}
            {/* THE ONE CONTROL THAT STAYS BESIDE THE TITLE. Its own button, its own percentage —
                the figure is the reason it is out here rather than in the menu. */}
            {selected.conversationId !== undefined && (
              <SessionStatsMenu
                harness={selected.harness}
                sessionId={selected.conversationId}
                meta={data?.sessions?.find(x => x.session_id === selected.conversationId)}
                lang={pt ? 'pt' : 'en'}
                currency={currency}
                brlRate={brlRate}
                touch
                {...(selected.model ? { startedModel: selected.model } : {})}
                {...(selected.effort ? { startedEffort: selected.effort } : {})}
              />
            )}

            {rowIndex.get(selected.id) && (
              <SessionActions
                row={rowIndex.get(selected.id)!}
                lang={pt ? 'pt' : 'en'}
                act={act}
                onGone={() => navigate('/sessions')}
                onOpened={id => navigate(sessionPath(id))}
                /* THE VIEW SWITCH, AS THE SWITCH IT IS. It came off the bar and was briefly two
                   rows in this list, which is a different statement: two rows read as two things
                   you could pick, while a segmented control says they are ALTERNATIVES and which
                   one you are in. It is the same control the bar carried, with its labels back —
                   there is room for words in a 240px menu and there was none in a 390px bar.
                   Absent for a harness that can never name its conversation, exactly as before. */
                /* `!isCentral` is dev's gate, kept: on a central the conversation is not relayed, so a
                   Chat tab there cannot do what it says. It moves with the control. */
                {...(!isCentral && selected.conversationBlind === undefined ? {
                  extraTop: (close: () => void) => (
                    <div role="tablist" style={{
                      display: 'flex', gap: 3, padding: 3, borderRadius: 10,
                      background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                    }}>
                      {([
                        ['chat', pt ? 'Conversa' : 'Chat', <MessagesSquare key="c" size={15} />],
                        ['terminal', 'Terminal', <TerminalSquare key="t" size={15} />],
                      ] as const).map(([id, label, icon]) => (
                        <button
                          key={id}
                          role="tab"
                          aria-selected={sessionView === id}
                          onClick={() => { setSessionView(id); close() }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                            // 44px, the figure this repo holds every mobile target to — and this
                            // menu is opened with a thumb.
                            flex: 1, minHeight: 44, borderRadius: 8, border: 'none',
                            cursor: 'pointer', minWidth: 0,
                            background: sessionView === id ? 'var(--bg-surface)' : 'transparent',
                            color: sessionView === id ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                            fontFamily: 'inherit', fontSize: 12.5,
                            fontWeight: sessionView === id ? 650 : 400,
                          }}
                        >
                          {icon}
                          <span style={{
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{label}</span>
                        </button>
                      ))}
                    </div>
                  ),
                } : {})}
                extra={[
                  {
                    id: 'filters',
                    label: pt ? 'Filtros' : 'Filters',
                    icon: <Plus size={15} />,
                    ...(filterCount > 0 ? { badge: String(filterCount) } : {}),
                    on: filterCount > 0,
                    onSelect: () => setSheetOpen(true),
                  },
                  {
                    id: 'artifacts',
                    label: pt ? 'Conteúdos da sessão' : 'Session contents',
                    icon: <FileText size={15} />,
                    on: art.open,
                    onSelect: () => (art.open ? closeArtifacts() : openArtifacts()),
                  },
                ]}
              />
            )}
          </div>
          {/* `display: flex` is the load-bearing part, not `flex: 1`.
              This div had `flex: 1, minHeight: 0` and no display, so it was a BLOCK. Its child —
              SessionPanel's own `flex: 1 1 0%` column — was therefore not a flex item at all, and
              a block child ignores its parent's height and grows to its content. Measured on an
              iPhone 12 viewport: this div sat at the correct 620px while the panel inside it was
              40.319px tall, which put the composer 40.305px down the page. The input was not
              hidden — it was rendered far below the fold, and the conversation could not scroll
              because the box that was supposed to scroll had no bounded height to scroll within.
              `flex: 1` on a child means nothing until its PARENT is a flex container. */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{panel}</div>

          {/* FULLSCREEN, over everything, with its own close.
              A phone has one column: the panel and the conversation cannot share 390px, and
              `resolveArtifactLayout` already says so. It sits above the bar too — the bar's back
              arrow would leave the session entirely, and the way out of the panel is the panel's
              own close, which `ArtifactsAside` draws. */}
          {/* IT SLIDES, and that needs it MOUNTED while it moves — a conditional render returns a
              different tree and there is nothing left to animate, which is why it appeared instantly
              and the desktop's does not. Same easing and duration as the "more" sheet, so the two
              surfaces on this layout move alike. `visibility` is what keeps a closed panel out of
              the tab order without taking the transition with it. */}
          {artifactsPane && (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 70,
              display: 'flex', flexDirection: 'column',
              paddingTop: 'var(--safe-top)',
              background: 'var(--bg-surface)',
              transform: artLayout.layout === 'fullscreen' ? 'translateX(0)' : 'translateX(100%)',
              visibility: artLayout.layout === 'fullscreen' ? 'visible' : 'hidden',
              transition: 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), visibility 0.28s',
            }}>{artifactsPane}</div>
          )}
          {filtersSheet}
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {/* ONE bar, matching the open-session one above it. The filters used to be a fixed band
            here — two or three rows of controls that are consulted occasionally and read never,
            out of a 664px viewport — so they moved into a sheet that costs nothing until it is
            asked for and has the whole screen once it is. */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          minHeight: 44, padding: '0 10px', flexShrink: 0,
          // Same reason as the open-session bar: the shared header is hidden on this layout, so
          // this row IS the top of the screen and owns the status-bar band.
          paddingTop: 'var(--safe-top)',
          borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)',
        }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>
            {pt ? 'Sessões' : 'Sessions'}
          </span>
          {filterButton}
          {magnifierButton}
        </div>
        {/* `display: flex` again, and for the third time in this file's history the SAME rule:
            `flex: 1` on a child means nothing until its PARENT is a flex container. This div had
            `flex: 1, minHeight: 0` and no display, so `SessionsAside`'s own `flex: 1 1 0%` column
            was an ordinary block that grew to its content — and with it the scrolling box inside.
            Measured on an iPhone 12 with "Active only" off: the scroller reported
            clientHeight 16.567px against a 664px viewport, `scrollTop` could not move, and the 306
            inactive rows sat below the fold with no way to reach them. The band heading counted
            them correctly the whole time, which is what made it read as "the rows are missing"
            rather than "the list cannot scroll". */}
        {/* TWO SCREENS, one bar. The list is what a phone opens on — it is why you came — and the
            OVERVIEW is the same cards the desktop draws in the centre when nothing is selected.
            Asked for: "a tela inicial de quando n tem sessao selecionada que mostra as metricas,
            quero isso tbm na versao mobile".

            A segmented control rather than a scroll: the cards are tall, and putting them above 300
            rows would make the list unreachable on the screen whose whole problem is height. Both
            read the SAME `overviewRows` the desktop uses, so the two layouts can never count
            different sets — the defect this page has already hit twice. */}
        <div role="tablist" style={{
          display: 'flex', gap: 2, padding: '6px 12px 0', flexShrink: 0,
        }}>
          {([
            ['list', pt ? 'Sessões' : 'Sessions'],
            ['overview', pt ? 'Métricas' : 'Metrics'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mobileTab === id}
              onClick={() => setMobileTab(id)}
              style={{
                flex: 1, minHeight: 40, borderRadius: 9, border: 'none', cursor: 'pointer',
                background: mobileTab === id ? 'var(--bg-elevated)' : 'transparent',
                color: mobileTab === id ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                fontFamily: 'inherit', fontSize: 13,
                fontWeight: mobileTab === id ? 650 : 400,
              }}
            >{label}</button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 12px' }}>
          {mobileTab === 'overview' ? (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              <FleetOverview
                lang={pt ? 'pt' : 'en'}
                rows={overviewRows}
                loading={loading}
                unsupported={unsupported}
                heatmap={derived.heatmapData}
                heatmapByHarness={derived.heatmapByHarness}
                {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
              />
            </div>
          ) : (
            <SessionsAside
              lang={pt ? 'pt' : 'en'}
              rows={fleet.rows}
              finishedTasks={fleet.finishedTasks}
              loading={loading}
              unsupported={unsupported}
              filters={filters}
              activeOnly={activeOnly}
              {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
              stale={stale}
              rowsById={rowIndex}
              act={req => act({ ...req, action: req.action as FleetActionId })}
            />
          )}
        </div>
        {filtersSheet}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Desktop: the aside holds the list; this is the centre.
  // ---------------------------------------------------------------------------
  if (panel) {
    // A panel that is closing is still a panel: while `asideAlive` holds it, the branch below keeps
    // drawing it so the width can run down to zero. The edge marker waits for it to finish — the
    // control and the thing it opens live in the same place, and both being there at once reads as
    // two panels.
    if ((artLayout.layout === 'closed' && !asideAlive) || !artifactsPane) {
      // The panel is shut. The marker rides the right edge of the session, which is where the panel
      // it opens will appear — so the control and its result are in the same place.
      // THE WRAPPER IS UNCONDITIONAL, and that is a focus bug rather than a style.
      //
      // It used to be `edgeMarker === null ? panel : <div>{edgeMarker}{panel}</div>`. React
      // reconciles by POSITION: swapping the root between `panel` and a div CONTAINING it changes
      // the shape of the tree, so the whole panel is unmounted and a new one mounted — every DOM
      // node recreated, the composer's textarea among them. Typing while a session worked lost the
      // caret the moment the strip appeared, and lost it AGAIN when it went away, which is exactly
      // how it was reported: "quando essa barra aparece ele desfoca e quando ela some o input
      // tambem desfoca".
      //
      // Rendering the wrapper always keeps `panel` at the same position under the same parent, so it
      // survives the strip coming and going. `{null}` occupies the slot without drawing anything,
      // which is what makes the two cases the same SHAPE.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {edgeMarker}
          {panel}
        </div>
      )
    }
    // FULLSCREEN and OVERLAY both cover the conversation; the difference is that the overlay leaves
    // the page under it visible at its edge, which is the only affordance saying what closing
    // returns you to.
    const exiting = artLayout.layout === 'closed'
    const shape = exiting ? closingAs.current : artLayout.layout
    // `split-rail` is a SPLIT — it differs only in the fleet list collapsing to a rail — so it
    // falls through to the resizable branch below, which is the one that animates. Routing it here
    // made the panel appear full-bleed with no tween, which is how this was caught.
    if (shape === 'fullscreen') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {artifactsPane}
        </div>
      )
    }
    if (shape === 'overlay') {
      return (
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {panel}
          <div style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(440px, 88%)', zIndex: 20,
            background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)',
            boxShadow: '-12px 0 32px rgba(0,0,0,0.45)',
            display: 'flex', flexDirection: 'column', minHeight: 0,
            // It covers the page, so it slides ACROSS rather than growing: `transform` is the one
            // property that animates without laying the page out again on every frame, which is
            // what a width tween on a floating panel costs.
            transform: asideIn ? 'translateX(0)' : 'translateX(100%)',
            transition: `transform ${ASIDE_ANIM_MS}ms ${ASIDE_EASE}`,
            willChange: 'transform',
          }}>
            {artifactsPane}
          </div>
        </div>
      )
    }
    // The split. BOTH wrappers keep `display: flex; flexDirection: column` — this file has recorded
    // the same bug twice: `flex: 1` on a child means nothing until its PARENT is a flex container.
    return (
      <div ref={splitRef} style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
          {panel}
        </div>
        {/* The handle. Four pixels of hit area over a one-pixel rule — the rule is what you see,
            the area is what you can grab, and matching them makes a divider people miss.
            It goes with the panel: a grab handle for something that is halfway out of the room is
            a control that resizes nothing. */}
        {asideIn && <div
          onMouseDown={e => {
            // From the width on screen, not the remembered one: a clamped panel would otherwise
            // jump to its stored width the moment the handle is touched.
            dragArt.current = { x: e.clientX, w: shownArtWidth }
            setArtDragging(true)
            document.body.style.userSelect = 'none'
          }}
          style={{
            width: 4, flexShrink: 0, cursor: 'col-resize', background: 'transparent',
            borderLeft: '1px solid var(--border)',
          }}
        />}
        <div style={{
          display: 'flex', flexDirection: 'column', width: asideIn ? shownArtWidth : 0,
          flexShrink: 0, minHeight: 0, background: 'var(--bg-surface)',
          // The contents keep their full width while the box shrinks, so the panel slides out of
          // view instead of reflowing itself smaller on the way — text rewrapping mid-animation is
          // what makes a collapse look like a stutter.
          overflow: 'hidden',
          transition: asideMotion,
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', width: shownArtWidth, flexShrink: 0,
            height: '100%', minHeight: 0,
          }}>
            {artifactsPane}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* A link to a session that is no longer in the list is not the same as no link at all, and
          the overview would silently swallow the difference — so it is said, once, above it. */}
      {sessionId !== undefined && !loading && (
        <p role="status" style={{
          margin: 0, padding: '12px 20px', fontSize: 12, lineHeight: 1.5,
          color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)',
        }}>
          {pt
            ? 'Essa sessão não está mais na lista desta máquina.'
            : 'That session is no longer in this machine’s list.'}
        </p>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <FleetOverview
          lang={pt ? 'pt' : 'en'}
          // THE SAME ROWS THE ASIDE IS SHOWING, through the same `filterFleet`.
          //
          // It used to be the whole fleet, so the cards described a set the reader could not see:
          // "5 running of 306 in this list" beside an aside listing five, and a project count of
          // every project in the history. Two regions of one screen counting two different sets is
          // the defect this page has now hit twice — the second time was the cards holding still
          // while the heatmap emptied.
          //
          // The date range is deliberately not among the dimensions `filterFleet` applies: a live
          // session is happening now, and "last 7 days" would hide one that started eight days ago
          // and is still working. The note above the cards says exactly that, so the one filter
          // that does not move them is named rather than left to be discovered.
          rows={overviewRows}
          loading={loading}
          unsupported={unsupported}
          heatmap={derived.heatmapData}
          heatmapByHarness={derived.heatmapByHarness}
          {...(fleet.unavailable ? { unavailable: fleet.unavailable } : {})}
        />
      </div>
    </div>
  )
}
