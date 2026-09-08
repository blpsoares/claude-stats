/**
 * Sessions.tsx — the fleet, on one screen.
 *
 * This screen knows nothing about tmux, `/proc` or what a harness prints: every session and every
 * word describing it arrives from `host.sessions()` already decided and already localized, exactly
 * as the services list arrives from `host.refresh()`. What it owns is the arrangement — which rows
 * fit, how they group, which one the cursor is on — and all of that arithmetic lives in the pure
 * `sessions.ts` beside it.
 *
 * The screen exists to answer one question at a glance: which of these is waiting for me. So the
 * ordering puts that first, the state word is the last cell given up under width pressure, and the
 * counter it feeds is drawn in the header where it is readable from every other tab.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSessionsMenuHidden, setSessionsMenuHidden } from '../ephemeral'
import { Box, Text, useInput } from 'ink'
import type {
  ActionResult, ControlExit, ControlHost, ControlSession, ControlSessions, RestoreCandidate,
  SessionState, SessionViewPrefs,
  TranscriptSearch,
} from '../types'
import type { ControlStrings } from '../i18n'
import {
  activeScopes, allState, selectionFromScopes, selectionToScopes, toggleAllScopes, toggleScope,
  transcriptScopeOn, SEARCH_TOGGLES, searchDepthText,
  type SearchScopeSelection, type SearchToggle,
} from '../search-scope'
import { searchDepth } from '../sessions'
import { sessionWordBook } from '../i18n'
import type { TabChrome } from '../ControlCenter'
import { DEFAULT_SESSION_VIEW } from '../types'
import { resolveListKey, resolveScrollKey, windowOffset, type NavKey } from '../nav'
import { ACTION_SEP, actionAtColumn, fitActionRow } from '../chrome.ts'
import { Divider } from '../Surface'
import { PANE_MIN_ROWS, paneBadgeRoom, paneTitleRoom } from '../chrome.ts'
import { Pane, paneBody, paneRows } from '../Pane'
import { profileLines } from '../profile-lines'

/** Columns a pane spends on its left edge: one of border, one of padding. */
const PANE_EDGE_X = 2

/**
 * What one level of the CASCADE indents a heading by.
 *
 * Two columns: enough to read as a level, cheap enough that a deep branch does not eat the width
 * its own name needs. The rows under a heading are NOT indented — the cursor moves over them and a
 * row that shifts sideways with its branch is a column that stops lining up.
 */
const INDENT = '  '

/**
 * A stored grouping, as this build understands it.
 *
 * `tree` was a grouping before the cascade became a view: it meant "no bands, cascade on". The menu
 * no longer offers it, so a preference still carrying it is rewritten rather than left selecting a
 * row that does not exist — the caller turns the cascade on beside this.
 */
function groupingOf(stored: SessionGrouping): SessionGrouping {
  return stored === 'tree' ? 'none' : stored
}

/**
 * How far down a scrolling region is, one cell per drawn row.
 *
 * A window with no bar is a list whose length is a secret: you cannot tell whether the row under
 * the cursor is the last one or the tenth of ninety, and the only way to find out is to keep
 * pressing down until it stops moving. Drawn only when there IS more — see `scrollBar`.
 */
function ScrollBar({ cells }: { cells: readonly string[] }) {
  if (cells.length === 0) return null
  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {cells.map((c, i) => (
        <Text key={i} color={c === THUMB ? COLORS.accent : COLORS.border}>{c}</Text>
      ))}
    </Box>
  )
}
import { ConfirmPrompt, TextPrompt } from '../Prompt'
import { Menu } from '../Menu'
// Aliased: this file has its own `Question` component, which is the whole question PANE. This one
// is the shared wrapped-sentence primitive `ConfirmPrompt` draws its label with.
import { Question as WrappedText } from '../Surface'
import { SessionWizard } from './SessionWizard'
import { TaskChoice } from '../TaskChoice'
import {
  GROUPINGS, breadcrumb, detailLines, groupSessions, selectableIndexes, selectedRow, idAtRow, searchArrangement, sessionCells, sessionRows,
  QUESTION_ROWS, askRows, fitApprovalPreview, actionLabels, asideRows, asideSelectable,
  asideRowKey, resolveAsideCursor,
  enabledActionIndexes, filterSessions,
  actionWords as ACTION_WORDS,
  sessionActions, sessionsCockpit, summaryCells, sessionColumns, padCell,
  taskCounts, projectCounts, sessionMetric, sessionContext, contextLevel,
  sessionHandle, worktreeName, sessionRunning,
  sessionAge, sessionKeyHelp, keyHelpColumn, keyHelpLines, closeCellWidth, canClose, CLOSE_CELL,
  BULK_STOP_OFF, bulkStopToggle, bulkStopPick, stopTargets, type BulkStop,
  treeGuides, notifyCellWidth, sessionNotify,
  DEFAULT_ORDER, ACTIVE_STATES, OFF_STATE, type SessionOrder, type SessionLayout,
  cardGrid, cardPages, pageOfCard, cardBadges, cardLines, fitCardLines, cardStateCells, cardBand,
  cardHit, cardStep, cardPageRows, cardLabelWidth, CARD_LABEL_GAP, pagerCells, pagerHit,
  type CardBand, type CardGrid, type CardLabels, type CardLine, type CardPage, type PagerCells,
  asideSections, asideFold, scrollBar, THUMB,
  sessionNamed,
  type AsideRow, type OfferedAction, type SessionColumns, type SessionToggle,
  type DetailLine, type SessionAction, type SessionGrouping, type SessionRow,
  applyShortcut,
  DEFAULT_MARKED,
  migrateSessionFilters,
  sessionKept,
  shortcutOn,
  storedFilters,
  toggleValue,
  type SessionDimensionId,
  type SessionFilters,
  type StatusShortcut,
} from '../sessions'
import { isActivation, wheelDelta } from '../mouse'
import { usePointer } from '../pointer'
import { truncate } from '../../components/Primitives'
import { COLORS, HARNESS_COLOR } from '../../theme'
import type { ContextLevel } from '../sessions'

/**
 * The gauge's colour by level, mirroring `session-table.ts`'s ANSI table.
 *
 * `ok` is `undefined` and rendered `dimColor`, which is how every other neutral fact on the row is
 * drawn: a bar that is coloured at 12% has spent the attention it needs at 95%, and the whole
 * reason to colour this cell at all is that "nearly full" must be readable without reading.
 */
const CONTEXT_COLOR: Record<ContextLevel, string | undefined> = {
  ok: undefined,
  warn: COLORS.accent,
  full: COLORS.danger,
}

const SESSION_FOCUS_ACCENT = COLORS.info

/** The colour each state wears. Paired with a WORD everywhere it is drawn — a fleet state announced
 *  in colour alone is unreadable on a terminal with a flattened palette, and this is the one screen
 *  whose whole purpose is that single fact. */
const STATE_COLOR: Record<SessionState, string | undefined> = {
  'waiting-approval': COLORS.danger,
  // Amber is also the selection colour, which they can share: a selected row already carries the
  // `❯` cursor and a bold title, so the two never have to be told apart by hue alone.
  waiting: COLORS.accent,
  working: COLORS.running,
  exited: COLORS.muted,
  lost: COLORS.muted,
  unknown: COLORS.muted,
  closed: COLORS.muted,
}


/**
 * A question this screen is asking. While one is open it reports `capture`, so the global keys stand
 * down — typing a session name would otherwise quit the app on the `q` and refresh it on the `r`.
 */
type Ask =
  /** Everything about WHAT the list shows, in one vertical panel. */
  | { kind: 'view' }
  | { kind: 'search' }
  /** The whole key list. Its own kind because it answers nothing and acts on nothing. */
  | { kind: 'keys' }
  /** Finishing or reopening a TASK — the session is only how the task was named. */
  | { kind: 'finishTask'; session: ControlSession }
  | { kind: 'deleteTask'; name: string; count: number }
  | { kind: 'task'; session: ControlSession }
  | { kind: 'openTask'; session: ControlSession }
  | { kind: 'resume'; session: ControlSession }
  | { kind: 'rename'; session: ControlSession }
  | { kind: 'note'; session: ControlSession }
  | { kind: 'kill'; session: ControlSession }
  /** Typing a line into a session without entering it. */
  | { kind: 'prompt'; session: ControlSession }
  /**
   * Answering the dialog a session is blocked on.
   *
   * The only question on this screen that carries EVIDENCE: the dialog itself is drawn above the
   * confirmation, because the keystroke takes whichever option is highlighted and nothing but the
   * screen can say which that is.
   */
  | { kind: 'approve'; session: ControlSession }
  /** Reopening everything the machine took at once — a FLEET question, so it names no session. */
  | { kind: 'reopenFell' }
  /** Starting a new one — the only question that needs no selected row. */
  | { kind: 'new' }
  /** Warning when attempting to reopen sessions that are already open. */
  | { kind: 'openWarning'; openSessions: string[] }
  /** Sending prompt to multiple selected sessions. */
  | { kind: 'batchPrompt'; sessions: ControlSession[] }
  /** Killing multiple selected sessions. */
  /**
   * The bulk-stop confirmation — the sessions PICKED inside the mode, never the pinned ones.
   *
   * It replaced `batchKill`, which was armed by the pinned set: pinning a row is how you keep it,
   * and `x` then offered to stop everything you had kept. The set this carries can only have been
   * built inside a mode the person deliberately entered with `ctrl+x`.
   */
  | { kind: 'bulkStop'; sessions: ControlSession[] }

/** How long the typing must settle before the disk is walked. */
const TRANSCRIPT_DEBOUNCE_MS = 300

export function Sessions({
  host, fleet, strings: s, width, height, isActive, run, onChrome, onExit, onRefreshFleet,
  view, onView,
}: {
  host: ControlHost
  /** `null` until the first poll lands, `undefined` when the host has no fleet at all. The two are
   *  different sentences and the screen must not collapse them. */
  fleet: ControlSessions | null | undefined
  strings: ControlStrings
  width: number
  height: number
  isActive: boolean
  /** The shell's single funnel for performing anything — spinner, status line, refresh. */
  run: (fn: () => Promise<ActionResult>, label?: string) => Promise<ActionResult>
  onChrome: (chrome: TabChrome) => void
  onExit: (exit: ControlExit) => void
  /** Re-poll immediately rather than waiting out the interval — an action the user just took must
   *  be visible in the list before the next tick, or the screen looks like it ignored them. */
  onRefreshFleet: () => void
  /** How the list was arranged last time, as the host remembered it. */
  view: SessionViewPrefs | undefined
  /** Store the arrangement, so a restart does not throw away what the user chose. */
  onView: (v: SessionViewPrefs) => void
}) {
  // A stored `grouping: 'tree'` predates the cascade being a view: it meant "no bands, cascade on",
  // which is exactly `none` + cascade. Rewritten on the way in rather than left as a grouping the
  // menu no longer offers — a machine that had it selected would otherwise be stuck in an
  // arrangement it cannot see a row for.
  const [grouping, setGrouping] = useState<SessionGrouping>(
    groupingOf(view?.grouping ?? DEFAULT_SESSION_VIEW.grouping),
  )
  /** The directory cascade, drawn INSIDE whatever the bands are. See `groupSessions`. */
  const [cascade, setCascade] = useState<boolean>(
    view?.cascade ?? view?.grouping === 'tree',
  )
  /** A list of rows, or a grid of cards. See `cardGrid` for why the grid may refuse. */
  const [layout, setLayout] = useState<SessionLayout>(
    view?.layout ?? DEFAULT_SESSION_VIEW.layout ?? 'list',
  )
  /**
   * The session at the top of the open card page.
   *
   * The page itself is DERIVED from the cursor, so there is no second position to keep in sync —
   * but it still has to survive a restart, and a page NUMBER would name different sessions by the
   * next poll. Held in state rather than read back off `view`, so switching to the list and back
   * does not lose the page.
   */
  const [cardAnchor, setCardAnchor] = useState<string | undefined>(view?.cardAnchor)
  const [cursor, setCursor] = useState(0)
  /**
   * The session id the cursor is GLUED to — the selection's identity, not its position.
   *
   * The list re-sorts under the cursor every five seconds (a poll) and the instant a row is marked
   * (the marked band lifts it to the top). A cursor kept only as a number therefore names a
   * DIFFERENT session one frame later, and `x` — which kills, silently — fired in that frame hit the
   * wrong one. `marked` is kept by id for exactly this reason; the cursor now is too. Held in a ref,
   * not state: it must be readable at the moment of the keypress and updating it must never itself
   * force a render.
   */
  const glueRef = useRef<string | undefined>(undefined)
  /**
   * Send the cursor to the TOP and drop the glue, so the top row is selected by position again.
   *
   * The gesture behind every filter/grouping/search change: those reset to the top, and keeping the
   * old glue would hold the selection on the previous session wherever it now sits instead. The
   * reconcile effect re-adopts the top session's id immediately after, so the cursor still follows
   * THAT row through the next reorder.
   */
  const toTop = useCallback(() => {
    setCursor(0)
    glueRef.current = undefined
  }, [])
  const [ask, setAsk] = useState<Ask | null>(null)
  const [query, setQuery] = useState('')
  /**
   * The deep half of the search — conversation ids whose TEXT carries the query.
   *
   * Held apart from `query` because it arrives LATER: the rows filter on the six in-memory scopes
   * the instant you type, and the transcript hits fold in when the disk answers. `null` means the
   * question has not been answered yet for the current query, which is why the depth line says
   * "reading transcripts…" instead of a `0` that becomes 47 a moment later.
   */
  const [transcript, setTranscript] = useState<TranscriptSearch | null>(null)
  const [searchingText, setSearchingText] = useState(false)
  /**
   * Which search DEPTHS are active — title, first prompt, transcription — cumulative and persisted.
   *
   * Restored from `view.searchScopes` below (absent reads as the default: title + first prompt on,
   * transcription off). The active SCOPE set derived from it gates both what the rows filter on and
   * whether the expensive disk read runs at all.
   */
  const [scopes, setScopes] = useState<SearchScopeSelection>(() => selectionFromScopes(view?.searchScopes))
  const active = useMemo(() => activeScopes(scopes), [scopes])
  // The disk read below keys on THIS boolean, not the whole `scopes` object. Toggling title or
  // first prompt makes a new `scopes` (they are in-memory scopes, searched instantly), and depending
  // on the object re-fired the ~255 ms transcript grep on those cheap toggles for no new result. The
  // deep read only has to re-run when the transcription depth itself flips — which is exactly what
  // this value tracks.
  const transcriptSearchOn = transcriptScopeOn(scopes)

  /**
   * Ask the disk, once the typing settles.
   *
   * DEBOUNCED because each run walks the transcript roots (475 MB on the machine this was measured
   * on, ~255 ms through grep), and firing per keystroke would queue a run for every character of a
   * word. The reply is DISCARDED when the query has moved on — `cancelled` rather than a bare
   * `setState`, or a slow answer for `doc` lands on top of the answer for `docker` and the depth
   * line reports the wrong search.
   */
  useEffect(() => {
    const q = query.trim()
    // The disk read is GATED on the transcription toggle — this is the performance answer. Reading
    // hundreds of megabytes of transcripts on every query is what would hang the TUI, so it runs
    // only when the user has switched that depth on; with it off, the in-memory scopes alone answer
    // instantly and `transcript` stays null (the depth line then omits the transcript count rather
    // than reporting a stale one).
    if (q === '' || !host.searchTranscripts || !transcriptSearchOn) {
      setTranscript(null); setSearchingText(false); return
    }

    let cancelled = false
    setSearchingText(true)
    const timer = setTimeout(() => {
      host.searchTranscripts!(q)
        .then(r => { if (!cancelled) { setTranscript(r); setSearchingText(false) } })
        // A failed deep search must not take the list with it: the in-memory scopes are still
        // a perfectly good search, so the row count stays right and only the transcript half is lost.
        .catch(() => { if (!cancelled) { setTranscript(null); setSearchingText(false) } })
    }, TRANSCRIPT_DEBOUNCE_MS)

    return () => { cancelled = true; clearTimeout(timer); }
    // Keyed on `transcriptSearchOn`, NOT `scopes`: a title/first-prompt toggle must not re-run the
    // disk read, only a change to the transcription depth (or the query/host) may. See F2.
  }, [query, host, transcriptSearchOn])
  const [showDone, setShowDone] = useState(view?.showDone ?? DEFAULT_SESSION_VIEW.showDone ?? false)
  /**
   * What the list is narrowed to, per dimension — the ONE source, and the whole answer.
   *
   * There used to be four independent pieces of state for one question: `onlyActive`, `states`,
   * `showClosed` and `showExited`, of which `states` silently won whenever it was present. The
   * switches went on drawing their own on/off while changing nothing — the screen said "only
   * active" over 62 of 65 sessions, nearly all of them closed or ended. Ordering the switches
   * differently does not fix a control that lies; having one source does.
   *
   * The switches below are SHORTCUTS derived from it, both ways: they write into it, and they read
   * their own state back OUT of it. See `session-dimensions.ts`.
   */
  const [filters, setFilters] = useState<SessionFilters>(() => migrateSessionFilters(view).filters)
  /** Whether a row the user NAMED survives a status filter that would otherwise drop it. */
  const [showNamed, setShowNamed] = useState(() => migrateSessionFilters(view).showNamed)
  const [order, setOrder] = useState<SessionOrder>(
    (view?.sort as SessionOrder | undefined) ?? DEFAULT_ORDER,
  )
  // Derived, never stored beside the selection: a switch that keeps its own copy of what it
  // describes is a switch that can disagree with the list.
  const status = filters.status ?? ACTIVE_STATES
  const onlyActive = shortcutOn(status, 'active')
  // ONE switch, because there was one question. `closed` and `exited` both meant "it is not
  // running", so ticking either while the other was on appeared to do nothing.
  const showHistory = shortcutOn(status, 'history')
  const taskFilter = filters.task?.[0] ?? null
  const projectFilter = filters.project?.[0] ?? null
  const pressShortcut = useCallback((k: StatusShortcut) => {
    setFilters(f => ({ ...f, status: applyShortcut(f.status ?? ACTIVE_STATES, k) }))
    toTop()
  }, [toTop])
  /** Pick ONE value on a dimension, or clear it — the task and project sections' gesture. */
  const scopeTo = useCallback((id: SessionDimensionId, value: string | null) => {
    setFilters(f => {
      const next = { ...f }
      if (value === null) delete next[id]
      else next[id] = [value]
      return next
    })
    toTop()
  }, [toTop])
  const [hideDetail, setHideDetail] = useState(view?.hideDetail ?? false)
  /**
   * The rows the user MARKED — a highlighter, not a selection.
   *
   * Kept by session id rather than by position, because the list re-sorts under it every five
   * seconds: a mark that meant "the third row" would be on someone else's session by the next poll.
   */
  const [marked, setMarked] = useState<ReadonlySet<string>>(
    () => new Set(migrateSessionFilters(view).marked),
  )
  /**
   * The bulk-stop mode and the rows picked inside it — EPHEMERAL, and deliberately so.
   *
   * It sits beside `marked` and shares nothing with it. `marked` is the pin: it goes through
   * `storedFilters` into `preferences.json` on every change and comes back on the next run. This
   * one is held here and nowhere else — no persist effect reads it, no host method is handed it,
   * and `bulkStopToggle` empties it on the way out. A set of sessions armed for killing must not be
   * something you can find still armed tomorrow morning.
   */
  const [bulk, setBulk] = useState<BulkStop>(BULK_STOP_OFF)
  /**
   * Whether the menu is folded away entirely, for when the list is what you came to read.
   *
   * Not persisted to disk, unlike the rest of the arrangement: it is a gesture you make to look at
   * something, not a setting, and a menu still hidden three days later is a feature nobody can find
   * their way back out of. But "not forever" was implemented as "not at all", and that cost the one
   * round trip people make dozens of times an hour: attaching to a session REMOUNTS this app, so
   * folding the menu, entering a session and leaving it found the menu open again, every time.
   *
   * It lives in module state (`ephemeral.ts`) — the lifetime that was missing. Survives the
   * remount, gone when you quit agentop.
   */
  const [menuHidden, setMenuHiddenState] = useState(getSessionsMenuHidden)
  const setMenuHidden = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    setMenuHiddenState(prev => {
      const value = typeof next === 'function' ? next(prev) : next
      setSessionsMenuHidden(value)
      return value
    })
  }, [])
  /** Ids the user has already been asked about this run, so the offer is made once. */
  const [restoreAsked, setRestoreAsked] = useState(false)
  /**
   * Whether the visible action row has the keyboard.
   *
   * The row is there so the screen can be used WITHOUT knowing any letters — every verb is spelled
   * out, reachable with `tab` and the arrows, and clickable. The letters stay as accelerators for
   * people who already know them; they were never meant to be the only way in.
   */
  /**
   * Whether closed conversations are listed at all.
   *
   * OFF by default. The screen is about what is happening, and on a real machine the history is an
   * order of magnitude bigger than the fleet — it buried the live rows the first time it shipped on.
   * One keypress and one visible toggle bring it back, and search reaches it either way.
   */
  const [actionsFocused, setActionsFocused] = useState(false)
  const [actionIndex, setActionIndex] = useState(0)
  /** Which pane has the keyboard. The aside is a real pane, not a strip of hints. */
  const [focus, setFocus] = useState<'list' | 'aside'>('list')
  /**
   * WHICH ROW the menu cursor is on, by name rather than by position.
   *
   * It used to be an index into the selectable rows, and that list changes composition constantly —
   * which verbs are enabled depends on the selected session — so moving down the fleet renumbered
   * every row beneath the actions block and the menu cursor jumped, usually back into the first
   * section, which then opened. An index is not an identity.
   */
  const [asideKey, setAsideKey] = useState('action:attach')

  const done = useMemo(() => new Set(fleet?.finishedTasks ?? []), [fleet?.finishedTasks])
  // The bucket names, resolved ONCE. Grouping and the filter chips read the same book, so a band
  // and the row that selects it can never be called different things.
  const words = useMemo(() => sessionWordBook(s), [s])
  // The only fact a `keyOf` needs that is not on the session itself.
  const dimensionCtx = useMemo(() => ({ marked }), [marked])
  // While a search is active the list is drawn FLAT and newest-first, whatever the user's grouping
  // is — a grouped search scatters its hits across bands and makes you hunt the screen for them.
  // It is an override on the DRAWING only: the stored grouping/cascade/order are untouched, so
  // clearing the query restores the arrangement with nothing to put back. See `searchArrangement`.
  const searchView = searchArrangement(query.trim() !== '', grouping, cascade, order)
  const rows = useMemo(() => sessionRows(groupSessions(
    filterSessions(
      (fleet?.sessions ?? []).filter(v =>
        // ONE predicate over ONE filter model, reading the very `keyOf` the bands are built from.
        // What used to be here was a precedence chain over four booleans and two scopes, in which
        // the state set silently outranked the switches beside it.
        sessionKept(v, { filters, showNamed, ctx: dimensionCtx })
        // A FINISHED task's sessions are withheld, not removed: the work is over and it stops
        // competing for the screen with the work that is not. Scoping TO a task overrides the
        // switch, or picking a finished task from the menu would empty the list. It stays outside
        // the dimension model on purpose: "finished" is a fact about the TASK, not a bucket any
        // session falls in — every session of a finished task still wears its own state.
        && (showDone || taskFilter !== null || !(v.task && done.has(v.task)))),
      query,
      transcript?.ids,
      active,
    ),
    searchView.grouping,
    words,
    fleet?.finishedTasks ?? [],
    searchView.order,
    dimensionCtx,
    searchView.cascade,
    // The heading is passed only when something ACTUALLY fell. `sessionRows` treats an absent word
    // as "there is no such section", so on an ordinary machine the reading order is unchanged
    // rather than carrying an empty block that exists to say nothing.
  ), s.sessionsClosedWord, s.sessionsDoneWord, fleet?.fell ? s.sessionsFellWord : undefined,
     // Absent when nothing is marked, so the band is not merely empty — it does not exist.
     marked.size > 0 ? { ids: marked, label: s.sessionsMarkedBand } : undefined), [
    fleet?.sessions, fleet?.finishedTasks, fleet?.fell, done, grouping, cascade, query, transcript, filters,
    showNamed, showDone, taskFilter, dimensionCtx, order, words, marked, active,
  ])

  /**
   * How deep the current search went — counted over the SAME rows the screen filtered, so the
   * numbers on the header and the rows under it can never disagree.
   */
  const depth = useMemo(() => {
    if (query.trim() === '') return ''
    const transcriptOn = transcriptScopeOn(scopes)
    return searchDepthText(
      searchDepth(fleet?.sessions ?? [], query, transcript?.ids, active),
      {
        scope: s.searchScope, noGrep: s.searchNoGrep,
        noTranscripts: s.searchNoTranscripts, transcriptOff: s.searchTranscriptOff,
      },
      {
        // With transcription switched off the disk read never ran; the line says so rather than
        // claiming a count of zero or a search still in flight.
        ...(transcriptOn
          ? {
              running: searchingText,
              runningWord: s.searchRunning,
              ...(transcript?.unavailable ? { unavailable: transcript.unavailable } : {}),
            }
          : { off: true }),
      },
    )
  }, [fleet?.sessions, query, transcript, searchingText, s, active, scopes])

  const selectable = useMemo(() => selectableIndexes(rows), [rows])

  // The cards are the SAME sequence the list draws, headings removed — so `at` (an index into
  // `selectable`) names the same session in both layouts, and switching layout keeps the selection.
  const cards = useMemo(
    () => rows.flatMap(r => (r.kind === 'session' ? [r.session] : [])),
    [rows],
  )
  const badges = useMemo(() => cardBadges(rows), [rows])

  // Resolved by IDENTITY every render: the row the glued session is on NOW, wherever the sort left
  // it. `cursor` survives only as the fallback for when that session is gone — a session that ends
  // between two polls shortens the list, and the clamp then lands the cursor on the row that took
  // its place rather than past the end. See `selectedRow`.
  const at = selectedRow(rows, selectable, glueRef.current, cursor)
  const selected: ControlSession | undefined = at < 0
    ? undefined
    : (rows[selectable[at]!] as Extract<SessionRow, { kind: 'session' }>).session

  /**
   * Move the cursor to a selectable position AND glue it to whatever session is there.
   *
   * Every navigation goes through here rather than a bare `setCursor`, so the identity and the
   * number are set together and can never disagree — the moment they do is the moment `x` kills the
   * wrong session.
   */
  const moveTo = useCallback((index: number) => {
    const max = selectable.length - 1
    if (max < 0) return
    const clamped = Math.max(0, Math.min(index, max))
    setCursor(clamped)
    glueRef.current = idAtRow(rows, selectable, clamped)
  }, [rows, selectable])

  /**
   * Keep the glue honest across every reorder the user did not cause.
   *
   * Runs after each render. When the glued session is still on screen it is a no-op; when it is
   * absent (first render, or after `toTop` dropped it, or the session ended) it ADOPTS the currently
   * resolved row, so the cursor follows a concrete session by identity from then on. It also syncs
   * the numeric `cursor` to the resolved index so navigation deltas and the persisted page start
   * from the right row. Setting a ref never re-renders; the one `setCursor` is guarded and converges.
   */
  useEffect(() => {
    if (at < 0) { glueRef.current = undefined; return }
    const here = idAtRow(rows, selectable, at)
    const present = glueRef.current !== undefined
      && selectable.some(r => {
        const row = rows[r]
        return row?.kind === 'session' && row.session.id === glueRef.current
      })
    if (!present) glueRef.current = here
    if (at !== cursor) setCursor(at)
  }, [rows, selectable, at, cursor])

  // The detail pane asks for exactly what it has to say, and the list absorbs the difference. A
  // pane sized to a constant leaves dead rows under it — air under a pane is a fault, and a list
  // with room to grow is not air, it is a list.
  /**
   * Whether the "start these again?" offer is the thing on screen.
   *
   * Decided HERE rather than beside the render below, because the FOOTER has to know: the offer owns
   * the keyboard, and while it is up every hint the list would print names a key that does nothing.
   * That is the one bug this footer exists to prevent, and it shipped — the offer drew over the list
   * while the strip underneath still advertised `o attach`, `y approve` and `tab actions`.
   */
  const restorable = fleet?.restorable ?? []
  const restoring = !restoreAsked && restorable.length > 0 && Boolean(host.restoreSessions)
  // The instant the offer is ABOUT, so answering it can be recorded against that event rather than
  // as a bare "asked once". `fell` and `restorable` come from one selection, so this is the same
  // fall the rows below belong to; `Date.now()` is the fallback only when a host supplies rows with
  // no fall beside them, where "this moment" is the most that can honestly be claimed.
  const fellAtMs = fleet?.fell?.atMs ?? Date.now()

  /** Whether typing into the selected row is a thing that can work — the same rule
   *  `sessionActions` applies, read once so the footer and the verb cannot disagree. */
  const canPrompt = Boolean(selected)
    && selected!.actionable
    && (selected!.state === 'working' || selected!.state === 'waiting'
      || selected!.state === 'waiting-approval')

  const detail = useMemo(() => (selected ? detailLines(selected, {
    where: s.sessionsWhere,
    model: s.sessionsModel,
    note: s.sessionsNote,
    started: s.sessionsStarted,
    external: s.sessionsExternalNote,
    closed: s.sessionsClosedNote,
    doing: s.sessionsDoing,
    task: s.sessionsTask,
    metrics: s.sessionsMetrics,
    metricsAll: s.sessionsMetricsAll,
    context: s.sessionsContext,
    conversation: s.sessionsConversation,
    alsoLabel: s.sessionsAlsoLabel,
    alsoHarness: s.sessionsAlsoHarness,
    // Absent when the backend did not report one — an invented keystroke is worse than none, since
    // the whole point of this line is that it is the key that actually works here.
    ...(fleet?.detachHint ? { detach: { label: s.sessionsDetach, keys: fleet.detachHint } } : {}),
    // The clock arithmetic happens HERE, not in the pure module and not in the string table: the
    // host reports the INSTANT a session started, and the pane repaints far more often than the
    // poll runs, so a duration computed anywhere upstream would freeze at whatever it was.
  }, startedAt => s.sessionsAgo(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))) : []),
  [selected, s, fleet?.detachHint])
  // A question needs room whether or not the detail pane earned any, so it sets the floor. The
  // cockpit reserves `QUESTION_ROWS` for the same reason: a prompt with nowhere to draw is a prompt
  // the user cannot answer.
  // The action row is drawn from this screen's own budget, so it is subtracted BEFORE the split. A
  // row taken without being paid for is composited over the one under it, which reads as a corrupt
  // frame rather than a cramped one.
  // A QUESTION always gets its rows, switch or no switch: it is a prompt, and one with nowhere to
  // draw cannot be answered. Only the FACTS are what the switch withholds.
  // A card holds what the detail pane holds, so in cards mode the pane is not asked for at all and
  // the whole band goes to the grid — a fleet drawn twice on one screen is half a screen wasted. A
  // QUESTION still gets its rows, switch or no switch: a prompt with nowhere to draw cannot be
  // answered.
  // The one question that carries EVIDENCE. Its rows are BUDGETED here rather than drawn on top of
  // the answers: Ink composites what does not fit, so an unbudgeted preview would not crowd the two
  // answers, it would draw over whatever sits under them.
  const askDetail = ask !== null && ask.kind !== 'keys' ? ask : null
  const askPreview = askDetail?.kind === 'approve' ? (askDetail.session.approvalLines?.length ?? 0) : 0
  // A picker needs a row per option on top of the evidence, or the answers are composited over
  // whatever sits under the pane — the same reason the evidence itself is budgeted.
  const askChoices = askDetail?.kind === 'approve' ? (askDetail.session.dialogOptions?.length ?? 0) : 0
  const detailWanted = askDetail
    ? askRows({ preview: askPreview, detail: detail.length, choices: askChoices })
    : layout === 'cards' || hideDetail ? 0 : detail.length

  /**
   * Act on the selected row, or say why it cannot be acted on.
   *
   * An external session is LISTED because the fleet in one place is the point, and refused here
   * because agentop did not start it — it has no backend to attach to and no record to rename. The
   * refusal is a sentence rather than a silently ignored keypress: a control that does nothing and
   * says nothing is indistinguishable from a broken one.
   */
  const actions = useMemo(
    () => sessionActions(selected, { fell: fleet?.fell?.count ?? 0 }),
    [selected, fleet?.fell?.count],
  )
  // The cursor moves over the ENABLED verbs only; the dim ones keep the row's shape and are never
  // landed on. Clamped every render, because which are enabled changes with the selection.
  const liveActions = useMemo(() => enabledActionIndexes(actions), [actions])
  const liveAt = liveActions.length === 0 ? 0 : Math.min(actionIndex, liveActions.length - 1)
  const at2 = liveActions[liveAt] ?? 0
  const actionWords = useMemo(() => actionLabels(actions, ACTION_WORDS(s)), [actions, s])

  /** How many sessions wear each state, over the WHOLE fleet — see the note in `asideRows`. */
  const stateCounts = useMemo(() => {
    const out: Partial<Record<SessionState, number>> = {}
    for (const v of fleet?.sessions ?? []) out[v.state] = (out[v.state] ?? 0) + 1
    return out
  }, [fleet?.sessions])

  const asideList = useMemo(() => asideRows({
    actions,
    actionWords: ACTION_WORDS(s),
    grouping,
    groupWords: s.sessionsGroupings,
    layout: { heading: s.asideLayout, words: s.sessionsLayouts, value: layout },
    toggles: {
      history: showHistory, done: showDone,
      active: onlyActive, named: showNamed, detail: !hideDetail, cascade,
    },
    toggleWords: {
      history: s.toggleHistory, done: s.toggleDone,
      active: s.toggleActive, named: s.toggleNamed, detail: s.toggleDetail,
      cascade: s.toggleCascade,
    },
    headings: { actions: s.asideActions, view: s.asideView, show: s.asideShow },
    tasks: {
      // Counted over the WHOLE fleet: the count is what says a task has work in it, and counting
      // after the filters would report the number the filter left.
      counts: taskCounts(fleet?.sessions ?? []),
      // The "no task" bucket is a row here like any other value, which is what the `unfiled` switch
      // used to be — a hidden exception that only existed while grouping by task, for one dimension.
      unfiled: s.sessionsUnfiled.task,
      unfiledCount: (fleet?.sessions ?? []).filter(v => !v.task).length,
      active: taskFilter,
      heading: s.asideTasks,
      allLabel: s.asideAllTasks,
      done: fleet?.finishedTasks ?? [],
    },
    sort: { heading: s.asideSort, words: s.sessionsSorts, by: order.by, dir: order.dir },
    states: {
      heading: s.asideStates,
      words: s.sessionsStates,
      // Counted over the WHOLE fleet: counting after the filter reports the number the filter left,
      // which for an unselected state is always zero — a row that can never be turned back on.
      counts: stateCounts,
      kept: [...status] as SessionState[],
    },
    // The other half of the drill-down: a task is something you declared, a project is something
    // every session already has — which makes it the scope that can find a session you never filed.
    projects: {
      counts: projectCounts(fleet?.sessions ?? []),
      active: projectFilter,
      heading: s.asideProjects,
      allLabel: s.asideAllProjects,
    },
  }), [
    actions, grouping, layout, showHistory, showDone, onlyActive, showNamed, hideDetail,
    status, stateCounts, order, taskFilter,
    projectFilter, fleet?.sessions, fleet?.finishedTasks, s,
  ])

  const asidePicks = useMemo(() => asideSelectable(asideList), [asideList])
  // Re-resolved on every render against the list as it now is, so nothing has to remember to fix
  // the cursor after a rebuild.
  const asideRow = resolveAsideCursor(asideList, asideKey)
  const asideAt = asidePicks.indexOf(asideRow)
  /** Move the cursor by NAME — the one setter every key, click and jump goes through. */
  const setAsideRow = useCallback((index: number) => {
    const row = asideList[index]
    if (row) setAsideKey(asideRowKey(row))
  }, [asideList])
  // The menu's titled blocks, derived from the same flat list the cursor walks.
  const sections = useMemo(() => asideSections(asideList), [asideList])


  const asideLabel = useMemo(
    () => asideList.reduce((n, r) => Math.max(n, 'label' in r ? r.label.length + 2 : 0), 0),
    [asideList],
  )
  // Probed once for the aside, then again for real. The action row exists ONLY on a terminal too
  // narrow to carry the menu — where it is the only menu there is — and whether that is the case
  // depends on the width alone, so one extra call settles it without either budget guessing at the
  // other. A row taken without being paid for is composited over the one under it.
  // `hideAside` is passed to BOTH, or the probe answers with an aside the real layout will not draw
  // and the action row is budgeted against a menu that is not there.
  const fold = { asideLabel, hideAside: menuHidden }
  const probe = sessionsCockpit({ width, height, detailWanted, ...fold })
  const actionRows = probe.aside > 0 ? 0 : height >= 12 ? 2 : height >= 8 ? 1 : 0
  const cockpit = actionRows === 0
    ? probe
    : sessionsCockpit({ width, height: Math.max(1, height - actionRows), detailWanted, ...fold })

  // The grid, decided HERE rather than beside the list's own arithmetic further down: both input
  // handlers read it, and a value declared under them reads as "used before its declaration" to
  // anyone editing this file, even though the closures run late.
  //
  // No scrollbar in cards mode — the pager is what says where you are — so it is measured against
  // the pane's full body. `null` on a terminal too small for one whole card, and the LIST is drawn
  // instead: the same degradation the aside menu makes when it is dropped rather than squeezed.
  const cardsBody = paneBody(cockpit.list)
  const band = cardBand({ listRows: cockpit.listRows, header: cockpit.header })
  /**
   * The words a card names its facts with — the very ones the list's column header prints, so the
   * two layouts call one fact one thing.
   *
   * Composed once here rather than inside each card: the layout has to COUNT the lines before any
   * card is drawn, and a second copy of this table is a second answer to what a card says.
   */
  const cardWords = useMemo(() => ({
    attached: s.sessionsCardAttached,
    blind: s.sessionsCardBlind,
    worktree: s.sessionsCols.worktree,
    project: s.sessionsCols.where,
    task: s.sessionsCols.task,
    note: s.sessionsNote,
    model: s.sessionsModel,
    // The clock arithmetic happens HERE, not in the pure module: a card repaints far more often
    // than the poll runs, so a duration computed upstream would freeze at whatever it was.
    ago: (startedAt: number) =>
      s.sessionsAgo(Math.max(0, Math.round((Date.now() - startedAt) / 1000))),
  }), [s])
  /**
   * Whether the grid draws the group HEADINGS the list draws.
   *
   * It costs a row of every band, so it is asked as a question the geometry can answer: measure the
   * grid with that row charged to each band, and take the headings only if a whole card still fits.
   * A region too short for both keeps the cards and gives them their group BADGE back — one of the
   * two always says which group a card belongs to, and the fallback to the list is unchanged.
   */
  const wantHeadings = layout === 'cards' && rows.some(r => r.kind === 'heading')
  /**
   * How many lines each card will draw, so the frames are as tall as they have content for and no
   * taller — the MAX sets the grid's ceiling, and `cardPages` sizes each band to its own tallest
   * card inside it.
   *
   * Counted off the same `cardLines` the cards are drawn from, and off `badges`, which name each
   * card's group whether or not the band ends up drawing a heading — so these numbers do not depend
   * on the decision they feed.
   */
  const cardLineCounts = useMemo(() => (layout === 'cards'
    ? cards.map((c, i) => cardLines(c, cardWords, badges[i] ?? '').length)
    : []), [layout, cards, badges, cardWords])
  const cardMaxLines = cardLineCounts.reduce((n, v) => Math.max(n, v), 0)
  const headedGrid: CardGrid | null = wantHeadings && rows.length > 0
    ? cardGrid({
        width: cardsBody, height: band.gridRows, total: cards.length,
        lines: cardMaxLines, headings: true,
      })
    : null
  const headed = headedGrid !== null
  const grid: CardGrid | null = layout === 'cards' && rows.length > 0
    ? headedGrid
      ?? cardGrid({ width: cardsBody, height: band.gridRows, total: cards.length, lines: cardMaxLines })
    : null
  const pages = useMemo(() => (grid
    ? cardPages({
        rows,
        cols: grid.cols,
        gridRows: band.gridRows,
        cardHeight: grid.cardHeight,
        lines: cardLineCounts,
        capacity: grid.capacity,
        headed,
      })
    : []),
  [grid?.cols, grid?.cardHeight, grid?.capacity, band.gridRows, headed, rows, cardLineCounts])
  // The page is the one holding the CURSOR — derived, never stored beside it. Turning a page is
  // therefore moving the cursor, and there is no second position that can fall out of step.
  const pageAt = pages.length > 0 ? pageOfCard(pages, Math.max(0, at)) : 0
  const page: CardPage | null = pages[pageAt] ?? null
  const pager = grid && page && band.pager
    ? pagerCells({
        label: s.sessionsPage(pageAt + 1, pages.length),
        note: s.sessionsShowing(page.items.length, cards.length),
        width: cardsBody,
      })
    : null


  // Updated only when the PAGE changes, never on every cursor move: `setSessionView` writes
  // `preferences.json` to disk, and a disk write per arrow key is not a thing this screen may do.
  const pageAnchor = page ? cards[page.items[0] ?? 0]?.id : undefined
  useEffect(() => {
    if (pageAnchor && pageAnchor !== cardAnchor) setCardAnchor(pageAnchor)
  }, [pageAnchor, cardAnchor])

  /** Run one verb, whether it arrived from a letter, an arrow key or a click. */
  const runAction = useCallback((a: SessionAction) => {
    if (a === 'new') { if (host.spawnSession) setAsk({ kind: 'new' }); return }
    if (a === 'search') { setAsk({ kind: 'search' }); return }
    if (a === 'group') { setAsk({ kind: 'view' }); return }

    /**
     * What `x` stops — and the ONE thing it may never be: the pinned set.
     *
     * Pinning is a keeping gesture. It persists, it lifts the row into its own band, and people use
     * it to find a row again — so an `x` that read that set turned "keep these four" into "offer to
     * kill these four", which is what this journey was reported as. `stopTargets` is not even given
     * the pinned set: outside the mode it can only answer with the row under the cursor, and the
     * plural answer exists only inside the mode `ctrl+x` opens.
     */
    if (a === 'kill') {
      const stoppable = (fleet?.sessions ?? []).filter(canClose)
      const targets = stopTargets({
        bulk, cursor: selected?.id, stoppable: stoppable.map(sess => sess.id),
      })
      if (targets?.kind === 'many') {
        const picked = new Set(targets.ids)
        setAsk({ kind: 'bulkStop', sessions: stoppable.filter(sess => picked.has(sess.id)) })
        return
      }
      // Nothing picked inside the mode means nothing happens — the row under the cursor is NOT a
      // fallback there, or the mode would kill something the person never selected.
      if (bulk.on) return
      // Outside it, `actOn` owns the single-row question, including the refusal that names why a
      // row cannot be stopped.
    }

    // Batch actions when rows are pinned. Kill is deliberately NOT among them — see above.
    if (marked.size > 0) {
      const markedList = (fleet?.sessions ?? []).filter(sess => marked.has(sess.id))
      if (a === 'prompt') {
        setAsk({ kind: 'batchPrompt', sessions: markedList })
        return
      }
      if (a === 'reopenFell' || a === 'resume') {
        const openSessions = markedList.filter(sess => sess.state === 'working' || sess.state === 'waiting' || sess.state === 'waiting-approval')
        if (openSessions.length > 0) {
          const names = openSessions.map(s => s.title || s.id)
          setAsk({ kind: 'openWarning', openSessions: names })
          return
        }
        const restore = host.restoreSessions
        if (restore) {
          void run(() => restore.call(host, [...marked], true)).then(() => {
            setMarked(new Set())
            onRefreshFleet()
          })
          return
        }
      }
    }

    if (a === 'reopenFell') {
      if (!fleet?.fell || !host.reopenFell) {
        void run(async () => ({ ok: false, message: s.sessionsNoFell }))
        return
      }
      setAsk({ kind: 'reopenFell' })
      return
    }
    if (!selected) return
    if (a === 'attach') return actOn('attach')
    if (a === 'resume') { setAsk({ kind: 'resume', session: selected }); return }
    if (a === 'openTask') { setAsk({ kind: 'openTask', session: selected }); return }
    // Asked rather than done: finishing is a statement about a whole piece of work, and the
    // confirmation is where the screen says what happens to its sessions.
    if (a === 'finishTask') { setAsk({ kind: 'finishTask', session: selected }); return }
    // Refused in words rather than by a key that does nothing: pressing `y` on a session that is
    // working is a reasonable thing to try, and the answer is "it is not asking anything", which is
    // information. Two different refusals, because they are two different facts — the harness's
    // dialog was never read, or this row is not blocked at all.
    // `y` opens the ANSWER question wherever there is something to answer — a bare confirm on a
    // plain dialog, the option picker on a numbered one. It refuses only where there is genuinely
    // nothing: a session that is not blocked at all, or one whose harness nobody has read.
    if (a === 'approve' && !selected.canApprove && !selected.canChoose) {
      // A dialog whose options are readable but unpickable is a refusal that NAMES why and points
      // at attaching, which works — so it opens the question rather than swallowing the keypress.
      if ((selected.dialogOptions?.length ?? 0) > 1) return actOn('approve')
      // `sessionsNotAsking` is a CLAIM ABOUT THE SESSION and it is false here: a row with a
      // `dialogBlind` is asking something agentop could not read. Saying "not asking anything"
      // sends somebody away from a question that is genuinely waiting on them.
      const why = selected.dialogBlind ?? selected.approveBlind ?? s.sessionsNotAsking
      void run(async () => ({ ok: false, message: why }))
      return
    }
    return actOn(a)
  }, [host, grouping, selected, fleet?.fell, fleet?.sessions, marked, bulk, run, s, onRefreshFleet])

  // Only the kinds that NAME a session. `reopenFell` is a fleet question and is handled in
  // `runAction`; routing it through here would hand it a row it must not act on.
  const actOn = useCallback((kind: Extract<Ask, { session: ControlSession }>['kind'] | 'attach') => {
    if (!selected) return
    // Asking to ATTACH to something with nothing running is asking to pick that conversation back
    // up — so it is answered with the reopen question rather than refused. Pressing the one key
    // that means "get me into this" and being told no, while a verb three rows down would have
    // done it, is a refusal about bookkeeping rather than about anything the user did. It covers
    // an EXTERNAL session too: agentop did not start it, but the conversation is on this disk.
    const running = selected.state === 'working' || selected.state === 'waiting'
      || selected.state === 'waiting-approval'
    if (kind === 'attach' && !running && selected.resume) {
      setAsk({ kind: 'resume', session: selected })
      return
    }
    if (!selected.actionable) {
      void run(async () => ({ ok: false, message: s.sessionsNotActionable }))
      return
    }
    if (kind === 'attach') {
      const attach = host.attachSession
      if (!attach) return
      void (async () => {
        const ticket = await attach.call(host, selected.id)
        // The screen never execs anything: it reports the intent, the shell releases the terminal,
        // and `cli-start.ts` hands it over. Coming back is the other half of the same gesture.
        if (ticket) onExit({ kind: 'attach', ticket })
      })()
      return
    }
    setAsk({ kind, session: selected })
  }, [selected, host, run, onExit, s])

  /**
   * Jump the menu to a section, whatever the focus was.
   *
   * The one place the digits, the arrows and a click all go through. `←`/`→` were the only way to
   * move between sections, and on a tablet's soft keyboard there are no arrow keys at all — so the
   * only way left was pressing down through every row of the section you were in, which is exactly
   * the tedium the fold was supposed to end.
   */
  const gotoSection = useCallback((n: number) => {
    const section = sections[n]
    const target = section?.indexes[0]
    if (target === undefined) return
    setFocus('aside')
    setActionsFocused(false)
    setAsideRow(target)
  }, [sections, setAsideRow])

  /**
   * Put the arrangement back to how the app opens on a fresh machine.
   *
   * One function behind `ctrl+r` and behind the menu row, because a keystroke and a button that
   * both claim to do the same thing and are written twice are two things that will one day differ.
   */
  /**
   * Everything that is not running, newest first, with nothing grouping it.
   *
   * It sets the four things that answer "what did I have open recently" in one move: no bands, the
   * off states only, ordered by last activity, and no scope or search left over narrowing it. It is
   * an ordinary arrangement rather than a mode — every switch it touched is still where it was, and
   * `ctrl+r` puts it all back.
   */
  const showRecentlyClosed = useCallback(() => {
    setGrouping('none')
    setCascade(false)
    // The status selection AND both scopes in one write: a scope left over is exactly the kind of
    // leftover that makes this land on an empty list.
    setFilters(f => {
      const next = { ...f, status: [OFF_STATE] }
      delete next.task
      delete next.project
      return next
    })
    setShowNamed(true)
    setShowDone(true)
    setOrder({ by: 'recent', dir: 'desc' })
    setQuery('')
    toTop()
  }, [toTop])

  const resetView = useCallback(() => {
    setGrouping(groupingOf(DEFAULT_SESSION_VIEW.grouping))
    setCascade(DEFAULT_SESSION_VIEW.cascade ?? false)
    setShowDone(DEFAULT_SESSION_VIEW.showDone ?? false)
    // The DEFAULT's own filters, read back through the same migration the restore uses — so the
    // arrangement the app opens on and the one `ctrl+r` returns to are one answer, not two.
    setFilters(migrateSessionFilters(DEFAULT_SESSION_VIEW).filters)
    setShowNamed(migrateSessionFilters(DEFAULT_SESSION_VIEW).showNamed)
    setOrder(DEFAULT_ORDER)
    setHideDetail(false)
    setLayout(DEFAULT_SESSION_VIEW.layout ?? 'list')
    setMarked(new Set(DEFAULT_MARKED))
    // The mode is an arming state, not an arrangement — `ctrl+r` puts the screen back to how it
    // opens, and it does not open armed.
    setBulk(BULK_STOP_OFF)
    setQuery('')
    toTop()
  }, [toTop])

  /** Run whatever an aside row means — the same path a key and a click both take. */
  const runAside = useCallback((index: number) => {
    const row = asideList[index]
    if (!row) return
    if (row.kind === 'action') { if (row.enabled) runAction(row.action); return }
    if (row.kind === 'group') { setGrouping(row.value); toTop(); return }
    if (row.kind === 'layout') { setLayout(row.value); return }
    if (row.kind === 'task') { scopeTo('task', row.all ? null : row.name); return }
    if (row.kind === 'project') { scopeTo('project', row.name || null); return }
    if (row.kind === 'sort') {
      // Picking the order already in force FLIPS it, which is the gesture every table has and the
      // only one that does not need a second control for the direction.
      setOrder(o => (o.by === row.value
        ? { by: o.by, dir: o.dir === 'desc' ? 'asc' : 'desc' }
        : { by: row.value, dir: DEFAULT_ORDER.dir }))
      toTop()
      return
    }
    if (row.kind === 'state') {
      // The never-empty rule lives in `toggleValue` now, where the keyboard reaches it too.
      setFilters(f => ({ ...f, status: toggleValue(f.status ?? ACTIVE_STATES, row.value) }))
      toTop()
      return
    }
    if (row.kind !== 'toggle') return
    if (row.toggle === 'history') return pressShortcut('history')
    if (row.toggle === 'active') return pressShortcut('active')
    toTop()
    if (row.toggle === 'cascade') return setCascade(v => !v)
    if (row.toggle === 'done') return setShowDone(v => !v)
    if (row.toggle === 'named') return setShowNamed(v => !v)
    return setHideDetail(v => !v)
  }, [asideList, runAction, resetView, pressShortcut, scopeTo, toTop])

  useInput((input, key) => {
    const nav: NavKey = {
      input,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
      home: key.home,
      end: key.end,
      shift: key.shift,
    }

    // `tab` moves between the list and the MENU, which is what makes every verb and every switch
    // reachable without knowing a single letter. The menu is a real pane, so it keeps its own
    // cursor while the list keeps its selection.
    if (key.tab) {
      if (cockpit.aside > 0) setFocus(f => (f === 'list' ? 'aside' : 'list'))
      else setActionsFocused(f => !f)
      return
    }

    // The DIGITS jump straight to a menu section, from the list as well as from the menu — every
    // section wears its number, so this is a key the screen documents itself rather than one you
    // have to be told about. They work where the arrows are not available at all.
    // A digit brings the menu BACK as well as jumping to a section: the keys that reach the menu
    // are the way out of having hidden it, so there is nothing extra to remember.
    if (input >= '1' && input <= '9') {
      const n = Number(input) - 1
      if (n < sections.length) { setMenuHidden(false); gotoSection(n); return }
    }

    // `ctrl+x` is the door to the bulk-stop mode, IN and OUT, and it is answered BEFORE the menu
    // gets the keyboard — the menu's own `x` deletes a task, and a chord that meant one thing on the
    // list and another in the menu is exactly the collision this journey exists to remove.
    //
    // The same chord both ways rather than `esc` on the way out: `esc` here already drops the
    // search, then the project, then the task, so a key that both un-narrows the list and disarms a
    // selection would do the wrong one of the two at the moment it matters most. See
    // `bulkStopToggle`.
    if (key.ctrl && input === 'x') {
      setBulk(bulkStopToggle)
      // The mode selects LIST rows, so it hands the keyboard back to the list rather than leaving
      // it in a menu where `space` means nothing.
      setFocus('list')
      setActionsFocused(false)
      return
    }

    if (focus === 'aside' && cockpit.aside > 0) {
      if (key.escape) { setFocus('list'); return }
      if (key.return) return runAside(asideRow)
      // `x` on a TASK row removes the name. The list grows without bound otherwise — reported with
      // dozens of entries, some naming work that is over and some whose sessions no longer exist —
      // and `finishTask` only hides them. Same key as closing a session, because it is the same
      // gesture applied to whatever the cursor is on; `all` is refused, since "every task" names no
      // task to remove.
      if (input === 'x') {
        const row = asideList[asideRow]
        if (row?.kind === 'task' && !row.all && row.name) {
          setAsk({ kind: 'deleteTask', name: row.name, count: row.count })
          return
        }
      }
      // `←`/`→` JUMP between sections. Reaching the next one by pressing down through every row of
      // this one is the whole of what made the menu tedious — and with the accordion it is also the
      // gesture that opens a section, so the arrows that do nothing else here are the right keys
      // for it. The cursor lands on the section's first row, which is what a person wants next.
      if (key.leftArrow || key.rightArrow) {
        if (sections.length === 0) return
        const step = key.rightArrow ? 1 : -1
        return gotoSection((activeSection + step + sections.length) % sections.length)
      }
      if (key.upArrow || input === 'k') return setAsideRow(asidePicks[Math.max(0, asideAt - 1)] ?? asideRow)
      if (key.downArrow || input === 'j') return setAsideRow(asidePicks[Math.min(asidePicks.length - 1, asideAt + 1)] ?? asideRow)
      return
    }

    if (actionsFocused) {
      if (key.escape) { setActionsFocused(false); return }
      if (key.return) return runAction(actions[at2]?.action ?? 'new')
      if (key.leftArrow) return setActionIndex(Math.max(0, liveAt - 1))
      if (key.rightArrow) return setActionIndex(Math.min(liveActions.length - 1, liveAt + 1))
      return
    }

    // `enter` on a session opens its MANAGEMENT rather than attaching to it.
    //
    // Attaching is the most drastic thing this screen does — it hands the whole terminal away — and
    // making it the default answer to "I want to look at this" meant there was no way to reach the
    // other verbs without already knowing where they were. Now enter moves to the menu, with the
    // cursor on the first verb this row can take; attaching is the verb at the top of it.
    if (key.return) {
      if (cockpit.aside > 0 && selected) {
        setFocus('aside')
        // The first verb this row can actually take, by name — the row-specific verb is `attach`
        // on a running session and `resume` on everything else, so a fixed index would land on
        // whichever happened to be first.
        setAsideRow(asidePicks[0] ?? 0)
        return
      }
      // No menu to move to on a narrow terminal, so enter keeps its old meaning there.
      return runAction(actions[liveActions[0] ?? 0]?.action ?? 'new')
    }
    // `esc` DROPS whatever is narrowing the list, one layer at a time, most-recent first. A search
    // could only be undone by opening the field and clearing it, and the field re-submitted the old
    // query on an empty enter — so a typo in the search box was a list that could not be got back.
    if (key.escape) {
      if (query) { setQuery(''); toTop(); return }
      if (projectFilter !== null) { scopeTo('project', null); return }
      if (taskFilter !== null) { scopeTo('task', null); return }
      return
    }
    // `ctrl+r` puts the arrangement back to how the app opens on a fresh machine. Every switch on
    // this screen is remembered, which is what people asked for and also what makes an arrangement
    // you fiddled with three weeks ago follow you around — and finding your way out of it one
    // toggle at a time means knowing what the defaults were.
    if (key.ctrl && input === 'r') { resetView(); return }
    // `ctrl+a` beside `l`, and `ctrl+h` for the list of everything. Two keys for one switch is not
    // duplication here: `l` is what the footer has room to name, and a chord is what someone
    // reaches for without having read the footer at all.
    if (key.ctrl && input === 'a') { pressShortcut('active'); return }
    // Folding the menu answers TWO keys, and the second one is not a convenience.
    //
    // `ctrl+b` is tmux's DEFAULT PREFIX. Run in a plain terminal the cockpit receives it and this
    // works — measured through the preview, which writes the real 0x02 byte. Run inside the user's
    // own tmux it never arrives at all: intercepting the prefix is what a prefix IS, so the client
    // consumes it and the pane is never told. This app already knows that, which is why it reads
    // the real prefix from `show-options -g prefix` to tell people how to detach.
    //
    // A chord that silently does nothing for everyone who works inside tmux is exactly the "the
    // command to hide the aside menu is not working" this was reported as. So plain `b` does it
    // too, and it is the one the footer and the key list name.
    if (input === 'b' || (key.ctrl && input === 'b')) { setMenuHidden(v => !v); return }
    // `?` is the key, and `ctrl+h` is accepted where the terminal can tell it apart from backspace.
    // It usually cannot: `ctrl+h` IS ASCII 8, which is the backspace byte, so Ink reports it as
    // `key.backspace` and a binding on it would either never fire or fire on backspace. Measured
    // here, not assumed. `?` has no such collision and is what every list-shaped TUI already uses.
    // `h` is the letter people try first and it was unbound; `?` is what every list-shaped TUI
    // answers and stays. `ctrl+h` is accepted where the terminal can tell it apart from backspace —
    // it usually cannot, since `ctrl+h` IS ASCII 8, so Ink reports it as `key.backspace` and a
    // binding on it would either never fire or fire on backspace. Measured here, not assumed.
    if (input === 'h' || input === '?' || (key.ctrl && input === 'h')) { setAsk({ kind: 'keys' }); return }
    if (input === 'v') return runAction('group')
    // One key, because there is one switch. `c` and `e` toggled two halves of the same question.
    // ONE key for one question. `active` and `history` partition `SESSION_STATES`, so the two
    // shortcuts are one boolean read from either end — and it had THREE keys: `l` narrowed to the
    // active states, while `c` and `e` (literally the same call) widened back. Pressing any of them
    // did the same visible thing, which is a keyboard that lies about how many controls exist.
    // `c` for CLOSED — one key for one switch. `l` and `e` are kept as aliases of the same call
    // rather than as controls of their own: they were three keys doing one visible thing, which is
    // a keyboard that lies about how many controls exist, and dropping them outright would break
    // the hands that already learned `l`.
    // The LAST CONVERSATIONS, flat and by recency — a view, reached by one key, because the ordinary
    // way to it was four separate switches (lift the filter, drop the grouping, change the sort,
    // clear the scope) and by then you are arranging a screen instead of finding the thing you
    // closed twenty minutes ago. Capital, like the other verbs that act on more than the row.
    if (input === 'C') { showRecentlyClosed(); return }
    if (input === 'c' || input === 'l' || input === 'e') {
      pressShortcut(onlyActive ? 'history' : 'active')
      return
    }
    if (input === 'd') { setHideDetail(v => !v); return }
    // `ctrl+g` for the GRID, not `g`: `g` is "top of the list" two lines down and in
    // `resolveListKey`'s menus, and a key answered by the screen AND by the list does two things at
    // once. `v` — the design's fallback — is already the grouping picker. The chord keeps the
    // mnemonic, collides with nothing, and pairs with `ctrl+f` beside it.
    if (key.ctrl && input === 'g') { setLayout(l => (l === 'list' ? 'cards' : 'list')); return }
    // The HIGHLIGHTER. `space` because it is the mark key of every list that has one, and because
    // it is the only unclaimed key on this screen that a person reaches for without being told.
    //
    // It answers TWO questions, and which one depends on a mode the screen announces in its own
    // title: inside the bulk-stop mode it picks a row to be STOPPED, outside it pins. The key did
    // not move — pinning is still `space`, which is what people already have in their fingers —
    // and the second meaning is only reachable from a chord somebody typed on purpose.
    if (input === ' ') {
      if (!selected) return
      if (bulk.on) { setBulk(b => bulkStopPick(b, selected.id)); return }
      setMarked(prev => {
        const next = new Set(prev)
        if (next.has(selected.id)) next.delete(selected.id)
        else next.add(selected.id)
        return next
      })
      return
    }
    // `u` used to hide the unfiled band while grouping by task. That is now the task section's own
    // "no task" row, selectable like every other value on every dimension, so the key is gone with
    // the switch — a key whose control no longer exists is a key nothing on screen explains.
    // The verbs are named after what they DO, in the language of the menu they open. They were
    // handed out in the order they were written — `a` started a session, `n` renamed one, `t` wrote
    // a note — so the letter and the verb had nothing to do with each other and the only way to
    // learn one was to read the list. `k` stays out of all of it: it is `up` in this list, and a key
    // that moves the cursor on one screen and destroys work on another is a real accident waiting.
    if (input === 'n') return runAction('new')
    if (input === 'r') return runAction('rename')
    // The note is `m` for memo: `t` belongs to the TASK, which is the verb people reach for it with.
    if (input === 'm') return runAction('note')
    if (input === 't') return runAction('task')
    // The capitals act on the whole TASK rather than on the row, which is the one thing worth making
    // people reach for a shift key to say.
    if (input === 'T') return runAction('openTask')
    if (input === 'F') return runAction('finishTask')
    // Attaching has its OWN key because `enter` deliberately does not do it any more: enter opens
    // the menu, which is what made every other verb reachable, and the cost of that was three
    // keystrokes for the thing this screen is most often opened to do.
    if (input === 'o') return runAction('attach')
    // `ctrl+f` is what people already type for find; `/` stays as an alias for the vi hands, and is
    // deliberately not in the key help — the footer names ONE key per verb or it stops being read.
    if ((key.ctrl && input === 'f') || input === '/') return runAction('search')
    if (input === 'x') return runAction('kill')
    // The two that act on a session WITHOUT entering it. `a` for approve, with `y` kept as the alias
    // every yes/no prompt has taught — neither is a navigation key, which is the rule `x` exists
    // for: a key that moves the cursor on one screen and writes into somebody's session on another
    // is the shape of a real accident.
    if (input === 'a' || input === 'y') return runAction('approve')
    if (input === 'p') return runAction('prompt')
    // Capital `R`, so it cannot be hit while reaching for anything else. It is the one verb here
    // that acts on the whole fleet.
    if (input === 'R') return runAction('reopenFell')

    // A grid has two axes, so the arrows mean what they mean in a grid: `←`/`→` step one card,
    // `↑`/`↓` step a whole BAND of them. The list's own reducer wraps a single column, which in a
    // grid would send the cursor from the top-left card to the bottom-RIGHT one.
    if (grid && selectable.length > 0) {
      const here = Math.max(0, at)
      const to = (n: number) => moveTo(n)
      // Band to band rather than by `cols`: with grouping on, a band holding a one-card group is
      // shorter than the grid is wide, and stepping by `cols` jumped clean over the band below it.
      const step = (dy: number) => to(cardStep(pages, here, dy))
      if (key.leftArrow) return to(here - 1)
      if (key.rightArrow) return to(here + 1)
      if (key.upArrow || input === 'k') return step(-1)
      if (key.downArrow || input === 'j') return step(1)
      // The page is always the one holding the cursor, so turning a page IS moving the cursor —
      // there is no second position to keep in sync with the first. Onto the page's FIRST card
      // rather than a fixed number of cards along: with headings the pages hold different amounts.
      if (key.pageUp) return to(pages[Math.max(0, pageAt - 1)]?.items[0] ?? 0)
      if (key.pageDown) return to(pages[Math.min(pages.length - 1, pageAt + 1)]?.items[0] ?? here)
      if (key.home || input === 'g') return to(0)
      if (key.end || input === 'G') return to(selectable.length - 1)
      return
    }

    if (selectable.length > 0) {
      const next = resolveListKey(nav, Math.max(0, at), selectable.length)
      if (next !== at) moveTo(next)
    }
  }, { isActive: isActive && ask === null })

  /**
   * Apply what the host remembered, ONCE, when it arrives.
   *
   * `useState(view?.…)` alone is not enough: the status is null on the first render and the stored
   * arrangement lands a moment later, so the initial value is always the default. Guarded by a ref
   * so this can never fight a change the user makes afterwards.
   */
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !view) return
    restored.current = true
    setGrouping(groupingOf(view.grouping))
    setCascade(view.cascade ?? view.grouping === 'tree')
    // Absent reads as OFF, which is the point of finishing a task at all.
    setShowDone(view.showDone ?? false)
    // ONE read of the stored filters, through the migration that decides what a file written by an
    // older build means. It is the only place the four legacy switches are still consulted.
    const restoredFilters = migrateSessionFilters(view)
    setFilters(restoredFilters.filters)
    setShowNamed(restoredFilters.showNamed)
    // Through the SAME seam, so "nothing is marked" is a value the restore can carry. It used to be
    // read straight off `view.marked`, whose absence the persist below could not tell apart from an
    // empty set — see `SessionFilterState.marked`.
    setMarked(new Set(restoredFilters.marked))
    setOrder((view.sort as SessionOrder | undefined) ?? DEFAULT_ORDER)
    setScopes(selectionFromScopes(view.searchScopes))
    setHideDetail(view.hideDetail ?? false)
    // The DEFAULT, never a literal — same rule, same reason as `onlyActive` above.
    setLayout(view.layout ?? DEFAULT_SESSION_VIEW.layout ?? 'list')
    setCardAnchor(view.cardAnchor)
  }, [view])

  /**
   * Put the cursor back on the remembered page, ONCE, when the fleet finally arrives.
   *
   * Separate from the arrangement restore because it needs a different thing to have loaded: the
   * arrangement comes from the host's status, the anchor can only be resolved against the sessions.
   * An anchor no longer in the list — the session ended, a filter changed, the machine is another
   * one — simply leaves the cursor where it is, which is page 0.
   */
  const anchored = useRef(false)
  useEffect(() => {
    if (anchored.current || cards.length === 0 || !view?.cardAnchor) return
    anchored.current = true
    const index = cards.findIndex(v => v.id === view.cardAnchor)
    if (index >= 0) moveTo(index)
  }, [cards, view?.cardAnchor, moveTo])

  // Written whenever any part of the arrangement moves, rather than at each call site: four setters
  // that each had to remember to persist is four places for one to be forgotten. It waits for the
  // restore, so the defaults of a first render never overwrite what was stored.
  useEffect(() => {
    // NOTHING is written before the restore has happened. The guard used to be
    // `!restored.current && view`, which let the very first render write while `view` was still
    // undefined — and `view` is undefined on every remount until the host's status arrives. Detach
    // returns to a freshly mounted screen, so the defaults landed on disk a moment before the
    // stored arrangement was read, and the arrangement was gone. `sessionViewPref` now always
    // answers, so an absent `view` means "not loaded yet" and nothing else.
    if (!restored.current) return
    onView({
      grouping,
      // The filters and their derived-on-write copies, in one place — an older binary reading this
      // file still comes up filtered rather than with everything lifted.
      ...storedFilters({ filters, showNamed, marked: [...marked] }),
      showUnfiled: true,
      showDone,
      hideDetail,
      layout,
      cascade,
      ...(cardAnchor ? { cardAnchor } : {}),
      sort: order,
      // The persisted shape is the canonical scope ARRAY (server contract, #240), derived from this
      // screen's toggles at the edge so the object never crosses the boundary.
      searchScopes: selectionToScopes(scopes),
    } as SessionViewPrefs)
  }, [grouping, cascade, filters, showNamed, showDone, hideDetail,
      layout, cardAnchor, order, marked, scopes, onView, view])

  useEffect(() => {
    if (!isActive) return
    // While a question is open the global keys stand down and the footer says only what works —
    // a hint for a key that does nothing is the one bug this footer exists to prevent.
    onChrome(restoring
      // The offer owns the keyboard and answers exactly two keys. It says so on the pane itself;
      // the footer must not contradict it with a strip of verbs that do nothing.
      ? { capture: true, hints: [s.keyRestoreAnswer] }
      : ask
      ? { capture: true, hints: [s.keyBack] }
      : focus === 'aside' && cockpit.aside > 0
        // The menu is a vertical list, so it answers ↑↓ and enter — and `esc` is the way back to the
        // sessions. A hint for a key that does nothing here is the one bug this footer prevents.
        ? {
            capture: false,
            claimArrows: true,
            hints: [
              s.keyQuit,
              s.keyAsideSection,
              s.keyMove,
              s.keyRun,
              ...(asideList[asideRow]?.kind === 'task' && !asideList[asideRow].all && asideList[asideRow].name
                ? [s.keySessionsDeleteTask]
                : []),
              s.keyBack,
              s.keyTabsAlt,
            ],
          }
      : actionsFocused
        // While the action row has the keyboard it is a horizontal list, so it claims the arrows —
        // and the footer stops saying they change screen for exactly as long as that is true.
        ? { capture: false, claimArrows: true, hints: [s.keyQuit, s.keyActionMove, s.keyRun, s.keyBack, s.keyTabsAlt] }
        : {
            // The LIST claims the arrows too, which is the whole reason `[`/`]` exist. `←`/`→` had
            // no meaning inside this screen and every meaning outside it, so reading down a list
            // and overshooting by one row left the screen entirely — the cursor keys of the thing
            // you are reading must not also be the way out of it.
            capture: false,
            claimArrows: true,
            hints: bulk.on
              // While the mode is on the footer says ONLY the three keys the mode answers. A strip
              // of ordinary verbs under a red list would be the footer contradicting the screen.
              ? [s.keySessionsStopPick, s.keySessionsStopRun, s.keySessionsStopLeave, s.keyMove]
              : [
              s.keyQuit, s.keyTabsAlt, s.keySessionsActions, s.keyAsideSection,
              s.keySessionsAttach, s.keyMove,
              // Named only where the key actually does something on the selected row. The footer is
              // the only documentation this screen has, and a hint for an inert key is the one bug
              // it exists to prevent.
              ...(selected?.canApprove || selected?.canChoose ? [s.keySessionsApprove] : []),
              ...(canPrompt ? [s.keySessionsPrompt] : []),
              s.keySessionsSearch, s.keySessionsNew, s.keySessionsGroup, s.keySessionsClosed,
              ...(grouping === 'task' ? [s.keySessionsNoTask] : []),
              // Named only while the menu is THERE to fold: on a narrow terminal the aside is
              // dropped anyway, and a hint for a key with nothing to act on is the one bug this
              // footer exists to prevent.
              ...(cockpit.aside > 0 || menuHidden ? [s.keySessionsFold] : []),
              s.keySessionsReset,
            ],
          })
  }, [isActive, onChrome, s, ask, actionsFocused, focus, cockpit.aside, grouping,
      selected?.canApprove, selected?.canChoose, canPrompt, menuHidden, restoring, asideList, asideRow,
      bulk.on])

  usePointer(p => {
    const wheel = wheelDelta(p.button)
    if (wheel !== 0) {
      if (selectable.length === 0) return
      const next = Math.min(Math.max(0, Math.max(0, at) + wheel), selectable.length - 1)
      return moveTo(next)
    }
    if (!isActivation(p)) return

    // Every region is a FRAMED pane, so a click is resolved in pane coordinates: `PANE_EDGE_X`
    // columns of border and padding on the left, one row of title on the top. Resolving against the
    // content's own origin without paying for the frame is a menu that answers one row above the
    // row you pointed at, which is worse than one that does not answer at all.
    const inPane = (x0: number, w: number, y0: number, h: number) =>
      p.x >= x0 + PANE_EDGE_X && p.x < x0 + w - PANE_EDGE_X
      && p.y >= y0 + 1 && p.y < y0 + h - 1

    // The MENU is the left pane of the band. Answered FIRST, because every hit test below is
    // written in the list's coordinates — and the menu was not answering the mouse at all, which
    // for a menu built to be clicked is the whole of it not working.
    if (cockpit.aside > 0 && p.x >= PANE_EDGE_X && p.x < cockpit.aside - PANE_EDGE_X
        && p.y >= 0 && p.y < cockpit.band) {
      // In the SECTIONED menu each block is its own pane, so the row a click lands on is found by
      // walking the stack — the flat offset belongs to the single-pane fallback and would answer
      // with a row from some other block entirely.
      let index = -1
      if (foldRows) {
        let top = 0
        for (let i = 0; i < sections.length; i++) {
          const h = foldRows[i]!
          // A COLLAPSED section is one row and it is a control: clicking its name opens it, which
          // is what its number and the arrows do. A name you can see and cannot press is worse than
          // no name at all.
          if (h < PANE_MIN_ROWS) {
            if (p.y === top) { gotoSection(i); return }
            top += h
            continue
          }
          if (p.y > top && p.y < top + h - 1) {
            const section = sections[i]!
            const inner = paneRows(h)
            const off = windowOffset(
              Math.max(0, section.indexes.indexOf(asideRow)), section.rows.length, inner,
            )
            index = section.indexes[off + (p.y - top - 1)] ?? -1
            break
          }
          top += h
        }
      } else if (p.y >= 1 && p.y < cockpit.band - 1) {
        index = asideOffset + (p.y - 1)
      }
      const row = index < 0 ? undefined : asideList[index]
      if (!row || row.kind === 'heading' || row.kind === 'rule') return
      if (row.kind === 'action' && !row.enabled) return
      setFocus('aside')
      setAsideRow(index)
      runAside(index)
      return
    }

    const listX = cockpit.aside > 0 ? cockpit.aside + 1 : 0
    if (inPane(listX, cockpit.list, 0, cockpit.band)) {
      // Clicking the list is also how you FOCUS it, which is the other half of the orange border:
      // a pointer that selects a row without moving the focus leaves the keys still talking to the
      // menu, and the frame then says one thing while the arrows do another.
      setFocus('list')
      setActionsFocused(false)
      const y = p.y - 1
      // The summary row states what is being shown; the controls live in the view panel, which a
      // click on that row opens. One place to change these, rather than two that can disagree.
      if (cockpit.summary && y === 0) { setAsk({ kind: 'view' }); return }
      if (grid && page) {
        // Resolved against the very grid that drew the cards: the pane's frame and the summary row
        // are both paid for here rather than assumed, or the click answers with the card above the
        // one that was pointed at.
        const gy = y - (cockpit.summary ? 1 : 0)
        const gx = p.x - listX - PANE_EDGE_X
        // Measured off the bands actually on this page, never off `rows * cardHeight`: a heading
        // costs a row and a short group's band still costs a whole one, so the pager does not sit
        // where a uniform grid would have put it.
        if (pager && gy === cardPageRows(page.bands)) {
          const hit = pagerHit(pager, gx)
          // Turning a page IS moving the cursor — the page is derived from it, so there is nothing
          // else to set and nothing that can fall out of step.
          if (hit) {
            const next = pages[hit === 'next' ? pageAt + 1 : pageAt - 1]
            if (next) moveTo(next.items[0] ?? 0)
          }
          return
        }
        const index = cardHit({
          bands: page.bands,
          cardWidth: grid.cardWidth,
          gap: grid.gap,
          x: gx,
          y: gy,
        })
        if (index !== null && index < selectable.length) moveTo(index)
        return
      }
      // The column HEADER is paid for as well as the summary row. Without it every click in the
      // list answered with the row ABOVE the one under the pointer — the grid branch above returns
      // first, and cards draw no header, so this is the list path's arithmetic alone.
      const row = offset + (y - (cockpit.summary ? 1 : 0) - (cockpit.header ? 1 : 0))
      if (row < 0 || row >= rows.length) return
      const found = selectable.indexOf(row)
      if (found < 0) return
      moveTo(found)
      // The X at the right edge. It SELECTS the row first and then asks — so the confirmation names
      // the session under the pointer, never the one that happened to be selected before.
      const entry = rows[row]
      // The whole control, not its last column: the cell is `CLOSE_CELL` wide, and a hit area of
      // one column under a three-column button is a button that mostly does nothing.
      const onClose = closeCell > 0
        && p.x >= listX + PANE_EDGE_X + listBody - CLOSE_CELL.length
      if (onClose && entry?.kind === 'session' && canClose(entry.session)) {
        setAsk({ kind: 'kill', session: entry.session })
      }
      return
    }

    // The action row is drawn UNDER the band, and only where there is no menu. Resolved against the
    // very same fit the row was rendered from, so a click and the drawn cells can never disagree.
    if (actionRows > 0 && p.y === cockpit.band + (actionRows > 1 ? 1 : 0)) {
      const fit = fitActionRow(actionWords, at2, width)
      const hit = actionAtColumn(fit, p.x)
      // A click on a DIM verb does nothing at all: the row keeps its shape so the menu is legible,
      // not so that unavailable things can be pressed.
      if (hit !== null && actions[hit]?.enabled) {
        setActionsFocused(true)
        setActionIndex(liveActions.indexOf(hit))
        runAction(actions[hit]!.action)
      }
    }
  }, { isActive })

  /**
   * How long ago each row that is NOT running began, already localized.
   *
   * Computed here because the clock lives here: the host reports the INSTANT a session started and
   * this pane repaints far more often than the poll runs, so a duration computed upstream would
   * freeze at whatever it was when the host last looked.
   */
  const ages = useMemo(() => {
    const now = Date.now()
    const out = new Map<string, string>()
    for (const v of fleet?.sessions ?? []) {
      const age = sessionAge(v, now, secs => s.sessionsAgo(secs))
      if (age) out.set(v.id, age)
    }
    return out
  }, [fleet?.sessions, s])

  const offset = windowOffset(at < 0 ? 0 : selectable[at]!, rows.length, cockpit.listRows)
  const visible = rows.slice(offset, offset + cockpit.listRows)
  /**
   * WHY the list is empty, which is never simply "there is nothing".
   *
   * The strict filter is only named when it is genuinely the thing that emptied the list — nothing
   * is running AND there is a fleet behind it. Blaming it while a search is what removed the rows
   * sends someone to the wrong switch, and blaming a search while nothing is running at all would
   * hide the fact that the filter is on. Everything else is the plain sentence.
   */
  const runningCount = (fleet?.sessions ?? []).filter(sessionRunning).length
  const narrowed = Boolean(query || projectFilter !== null || taskFilter !== null)
  /**
   * How long ago the fall was, already localized — `undefined` when nothing fell.
   *
   * The clock lives here for the same reason every other age on this screen does: the host reports
   * the INSTANT, and this pane repaints far more often than the poll runs.
   */
  const fellAgo = fleet?.fell
    ? s.sessionsAgo(Math.max(0, Math.round((Date.now() - fleet.fell.atMs) / 1000)))
    : undefined
  const emptyReason = onlyActive && runningCount === 0 && (fleet?.sessions.length ?? 0) > 0
    // The strict filter empties the list on exactly the machine that has just rebooted, and the
    // sessions it is withholding are the ones somebody most wants back. So when a fall is on record
    // the sentence names IT and the key that reopens it, rather than only the switch that would
    // reveal the rows. The filter is not overridden — `only active` means what it says, no
    // exceptions — but a blank pane must not be the only thing standing between a user and their
    // work.
    ? (fleet!.fell && fellAgo
        ? `${s.sessionsEmptyActive(fleet!.sessions.length)} · ${s.sessionsFellNote(fleet!.fell.count, fellAgo)}`
        : s.sessionsEmptyActive(fleet!.sessions.length))
    : narrowed ? s.sessionsEmptyFiltered
    : s.sessionsEmpty

  // The bar takes a column, so the rows are measured against what is left — a table sized to the
  // full pane and then drawn beside a bar is a table truncated by one character on every row.
  const listBar = scrollBar({ offset, total: rows.length, rows: cockpit.listRows })
  const listBody = paneBody(cockpit.list) - (listBar.length > 0 ? 1 : 0)
  // Reserved BEFORE the columns are measured: a control drawn after a table that already spent the
  // full width is a control drawn on top of the last cell.
  const closeCell = closeCellWidth(
    visible.flatMap(r => (r.kind === 'session' ? [r.session] : [])),
    listBody,
  )

  // Slicing from zero would leave the view switches below the fold on a short terminal — invisible,
  // and still the thing `enter` would act on.
  const asideOffset = windowOffset(Math.max(0, asideRow), asideList.length, paneRows(cockpit.band))
  const activeSection = Math.max(0, sections.findIndex(sec => sec.indexes.includes(asideRow)))
  // `null` when the band cannot pay for one frame per block, and the single scrolling pane is drawn
  // instead — a row handed out that does not exist is composited over the row below it.
  // One answer for every height: open what fits, name the rest. `null` only when the band cannot
  // even do that, and the single scrolling pane is drawn instead.
  const foldRows = cockpit.aside > 0 ? asideFold(sections, cockpit.band, activeSection) : null

  // The cascade's guide column, measured over the SAME window as the columns below. Empty for every
  // flat arrangement, and then it costs nothing.
  const guides = useMemo(() => treeGuides(visible), [visible])
  // Measured over the SESSION rows, which are the ones padded to a common width — a heading's guide
  // is as long as its own branch and says nothing about what the table has left.
  const guideWidth = visible.reduce(
    (n, r, i) => (r.kind === 'session' ? Math.max(n, (guides[i] ?? '').length) : n),
    0,
  )

  // Measured across the rows ON SCREEN, so the state, harness and directory columns line up. A
  // single long title thirty rows down must not narrow every visible row to pay for something
  // nobody can see.
  // Zero on a quiet fleet, so the dot's column costs nothing until something is actually waiting.
  const notifyWidth = useMemo(
    () => notifyCellWidth(visible.flatMap(r => (r.kind === 'session' ? [r.session] : []))),
    [visible],
  )

  const columns = useMemo(
    () => sessionColumns(
      visible.flatMap(r => (r.kind === 'session' ? [r.session] : [])),
      // The CONTENT width, not the pane's: measuring against the frame made every column four
      // characters wider than the row it was drawn into, and the table survived only because Ink
      // truncated it. Minus whatever the close control took.
      listBody - closeCell - guideWidth,
      {
        groupedByTask: grouping === 'task',
        groupedByProject: grouping === 'project',
        ages,
        ...(cockpit.header ? { headings: s.sessionsCols } : {}),
      },
    ),
    [visible, listBody, closeCell, guideWidth, grouping, cockpit.header, ages, s],
  )

  // The wizard takes the WHOLE screen rather than the detail strip: it is six questions with a
  // search field in the middle, and squeezing that under a list would give the one control that
  // decides where work happens three rows to show its results in.
  if (ask?.kind === 'view') {
    return (
      <Box flexDirection="column" width={width} flexShrink={0}>
        <ViewOptions
          strings={s}
          grouping={grouping}
          showHistory={showHistory}
          showNamed={showNamed}
          scopes={scopes}
          width={width}
          height={height}
          isActive={isActive}
          onGrouping={g => { setGrouping(g); toTop() }}
          onShowClosed={() => pressShortcut('history')}
          onShowNamed={() => { setShowNamed(v => !v); toTop() }}
          onToggleScope={t => setScopes(sc => toggleScope(sc, t))}
          onToggleAllScopes={() => setScopes(toggleAllScopes)}
          onClose={() => setAsk(null)}
        />
      </Box>
    )
  }

  /**
   * The offer, made ONCE and only when there is something to offer.
   *
   * It comes before the list because it is about the list: after a crash the fleet you are looking
   * at is not the one you left, and finding that out by noticing what is missing is worse than
   * being told. Declining retires those rows, so the same modal never greets you twice.
   */
  if (restoring) {
    return (
      <Box flexDirection="column" width={width} flexShrink={0}>
        <RestoreOffer
          rows={restorable}
          strings={s}
          width={width}
          height={height}
          isActive={isActive}
          onAnswer={action => {
            setRestoreAsked(true)
            // ALL THREE answers are recorded on the HOST, which outlives this mount. `restoreAsked`
            // alone is not enough and never was: attaching to a session unmounts the whole app and
            // `runStart` mounts a fresh one on the sessions tab, so the flag dies between the
            // answer and the return and the offer greets the user again — with different rows,
            // because by then the poll has re-anchored onto whatever the first answer left behind.
            // `list` is the case that made it unmissable: it reaches no host call at all, so before
            // this it dismissed the modal with zero durable effect.
            host.dismissFall?.(fellAtMs)
            if (action === 'accept' || action === 'decline') {
              const restore = host.restoreSessions
              if (!restore) return
              void run(() => restore.call(host, restorable.map(r => r.id), action === 'accept'))
                .then(onRefreshFleet)
            }
          }}
        />
      </Box>
    )
  }

  // The reference takes the WHOLE screen, never the menu column. Drawn into the aside it had ~24
  // columns for a description, so every second row ended in `…` — a list of keystrokes with what
  // they do cut off is the half of the reference nobody needs. It is also the only screen here that
  // is pure text, so it is the one that can afford to be a page.
  if (ask?.kind === 'keys') {
    return (
      <Box flexDirection="column" width={width} flexShrink={0}>
        <KeyHelpScreen strings={s} width={width} height={height} onClose={() => setAsk(null)} />
      </Box>
    )
  }

  if (ask?.kind === 'new') {
    return (
      <Box flexDirection="column" width={width} flexShrink={0}>
        <SessionWizard
          host={host}
          strings={s}
          width={width}
          height={height}
          isActive={isActive}
          onCancel={() => setAsk(null)}
          onDone={result => {
            setAsk(null)
            // A successful ATTACHED start is the same handover `enter` performs — the screen reports
            // the intent and the shell releases the terminal.
            if (result.ok && result.ticket) return onExit({ kind: 'attach', ticket: result.ticket })
            void run(async () => ({ ok: result.ok, message: result.message })).then(onRefreshFleet)
          }}
        />
      </Box>
    )
  }


  // Three framed panes, and the one with the keyboard wears the accent border. The screen used to
  // be a single frame with two unmarked columns inside it, so there was nothing on the screen that
  // said which of them the arrows were talking to — "I'm lost, I don't know what is selected" is
  // the exact failure, and it is the same one the services cockpit solved by framing its regions.
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box flexDirection="row" width={width} flexShrink={0}>
      {cockpit.aside > 0 ? (
        <>
          {foldRows ? (
            // Each block its OWN framed pane, titled with its own heading. One scrolling pane
            // titled "menu" showed its first section and nothing else, so every switch and every
            // task sat below the fold — and the honest reading of that screen is that all of it
            // lives inside "Actions".
            <Box flexDirection="column" width={cockpit.aside} flexShrink={0}>
              {sections.map((section, i) => {
                const h = foldRows[i]!
                // COLLAPSED: the name and how many rows are inside it, and nothing else. What it
                // gives up is its contents, never the fact that it exists.
                if (h < PANE_MIN_ROWS) {
                  const open = focus === 'aside' && i === activeSection
                  const count = ` ${section.rows.length}`
                  const label = truncate(
                    section.title.toLowerCase(),
                    Math.max(1, cockpit.aside - 5 - count.length),
                  )
                  return (
                    <Text key={section.title} wrap="truncate">
                      <Text color={COLORS.secondary}>{`${i + 1} `}</Text>
                      <Text color={open ? COLORS.accent : COLORS.label}>{`▸ ${label}`}</Text>
                      <Text dimColor>{count}</Text>
                    </Text>
                  )
                }
                const inner = paneRows(h)
                const cursorIn = section.indexes.indexOf(asideRow)
                const off = windowOffset(Math.max(0, cursorIn), section.rows.length, inner)
                const bar = scrollBar({ offset: off, total: section.rows.length, rows: inner })
                return (
                  <Pane
                    key={section.title}
                    title={`${i + 1} ${section.title.toLowerCase()}`}
                    focused={focus === 'aside' && i === activeSection}
                    width={cockpit.aside}
                    height={h}
                  >
                    <Box flexDirection="row" flexShrink={0}>
                      <AsideMenu
                        rows={section.rows}
                        cursor={cursorIn}
                        focused={focus === 'aside'}
                        width={paneBody(cockpit.aside) - (bar.length > 0 ? 1 : 0)}
                        height={inner}
                        offset={off}
                        allTasksLabel={s.asideAllTasks}
                        allProjectsLabel={s.asideAllProjects}
                      />
                      <ScrollBar cells={bar} />
                    </Box>
                  </Pane>
                )
              })}
            </Box>
          ) : (
            // Too short to frame each block: one pane, scrolling, with the headings inline.
            <Pane
              title={s.sessionsPaneMenu}
              focused={focus === 'aside'}
              width={cockpit.aside}
              height={cockpit.band}
            >
              <AsideMenu
                rows={asideList}
                cursor={asideRow}
                focused={focus === 'aside'}
                width={paneBody(cockpit.aside)}
                height={paneRows(cockpit.band)}
                offset={asideOffset}
                allTasksLabel={s.asideAllTasks}
                allProjectsLabel={s.asideAllProjects}
              />
            </Pane>
          )}
          {/* The frames provide the separation the drawn divider used to; the gap is the column
              `sessionsCockpit` already withheld from the list. */}
          <Box width={1} flexShrink={0} />
        </>
      ) : null}

      <Pane
        // The TITLE says the mode, because the title is the one part of this pane drawn at every
        // width and every height. The banner below it is dropped on a short terminal along with the
        // summary row it replaces, and a mode you can be in without the screen saying so is exactly
        // the state this design exists to make impossible.
        title={bulk.on ? s.sessionsPaneStopMode : s.tabsShort.sessions}
        focused={focus === 'list' && !actionsFocused}
        width={cockpit.list}
        height={cockpit.band}
      >
      {bulk.on && cockpit.summary ? (
        // In PLACE of the summary, not above it: the mode costs no extra row, so a frame that fit
        // before still fits. Red, and it names every key that works while it is on — the person who
        // walked away and came back reads what to do rather than remembering what they pressed.
        <Text color={COLORS.danger} bold wrap="truncate">
          {truncate(s.sessionsStopBanner(bulk.picks.size), listBody)}
        </Text>
      ) : cockpit.summary ? (
        <SummaryRow
          fleet={fleet}
          grouping={grouping}
          strings={s}
          width={listBody}
          showHistory={showHistory}
          showNamed={showNamed}
          onlyActive={onlyActive}
          // How many rows are ON SCREEN, counted from the very list being drawn. The header used to
          // read the fleet's length, so with `only active` on it announced 44 over a screen showing
          // ten — a number describing a screen nobody is looking at.
          shown={rows.reduce((n, r) => n + (r.kind === 'session' ? 1 : 0), 0)}
          // Counted from the SAME drawn rows, for the same reason `shown` is.
          waitingShown={rows.reduce((n, r) => n + (r.kind === 'session'
            && (r.session.state === 'waiting' || r.session.state === 'waiting-approval') ? 1 : 0), 0)}
          query={query}
          depth={depth}
          scope={projectFilter ?? taskFilter ?? ''}
          fell={fleet?.fell && fellAgo ? s.sessionsFellNote(fleet.fell.count, fellAgo) : ''}
        />
      ) : null}

      {/* What each cell IS. The row was six aligned columns of unlabelled text — the alignment made
          it scannable and the labels are what make it readable, and they are drawn from the very
          same measured widths so the heading can never sit over the wrong column. */}
      {cockpit.header && rows.length > 0 && !grid ? (
        <Text dimColor wrap="truncate">
          {/* Shifted by the cascade's guide column, or the headings sit over the wrong cells the
              moment the tree is on. */}
          {' '.repeat(guideWidth)}
          {'  ' + ' '.repeat(notifyWidth) + (columns.id > 0 ? padCell(s.sessionsCols.id, columns.id) + '  ' : '')}
          {columns.harness > 0 ? padCell(s.sessionsCols.harness, columns.harness) + '  ' : ''}
          {padCell(s.sessionsCols.state, columns.state)}
          {columns.title > 0 ? '  ' + padCell(s.sessionsCols.title, columns.title) : ''}
          {columns.age > 0 ? '  ' + padCell(s.sessionsCols.age, columns.age) : ''}
          {columns.worktree > 0 ? '  ' + padCell(s.sessionsCols.worktree, columns.worktree) : ''}
          {columns.task > 0 ? '  ' + padCell(s.sessionsCols.task, columns.task) : ''}
          {columns.metrics > 0 ? '  ' + padCell(s.sessionsCols.metrics, columns.metrics) : ''}
          {columns.context > 0 ? '  ' + padCell(s.sessionsCols.context, columns.context) : ''}
          {columns.where > 0 ? '  ' + padCell(s.sessionsCols.where, columns.where) : ''}
        </Text>
      ) : null}

      {fleet === undefined ? (
        <Text dimColor>{s.sessionsUnsupported}</Text>
      ) : fleet === null ? (
        <Text dimColor>{s.sessionsLoading}</Text>
      ) : rows.length === 0 ? (
        // An empty fleet is only ever reported as empty when the poll actually worked. When it did
        // not, the host's own sentence is what the summary row is already showing. And a list
        // emptied by a FILTER says which filter and which key lifts it: the sessions a reboot
        // turned into `lost` rows are still there, still named and still reopenable, so "no
        // sessions" would be false — and a blank pane under a strict filter is indistinguishable
        // from a broken one.
        //
        // The behaviour profile fills the space an empty list leaves dead — BELOW that sentence,
        // never instead of it. Sliced to the rows this pane actually has: an Ink screen that
        // overflows its `height` is composited over the rows below it, not clipped, and the
        // sentence above already spends one row of the same budget.
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor wrap="truncate">
            {fleet.unavailable ? ''
              : truncate(emptyReason, listBody)}
          </Text>
          {profileLines(fleet.baseline, listBody, s)
            .slice(0, Math.max(0, cockpit.listRows - 1))
            .map((line, i) => (
              <Text key={i} dimColor>{line}</Text>
            ))}
        </Box>
      ) : grid && page ? (
        <Box flexDirection="column" width={cardsBody} flexShrink={0}>
          {/* One band per group, and the air to the right of a short group is DELIBERATE: it is
              what separates one group from the next, and filling it with the following group's
              cards is exactly how this grid used to ignore the grouping it was drawn under. */}
          {page.bands.map((b, i) => (b.kind === 'heading' ? (
            <GroupHeading key={`h${i}`} band={b} width={cardsBody} />
          ) : (
            <Box key={`b${i}`} flexDirection="row" height={b.height} flexShrink={0}>
              {b.items.map((index, c) => {
                const card = cards[index]
                if (!card) return null
                return (
                  <Box key={card.id} flexDirection="row" flexShrink={0}>
                    {c > 0 ? <Box width={grid.gap} flexShrink={0} /> : null}
                    <SessionCard
                      session={card}
                      // The group is named ONCE: by the heading over the band when there is one,
                      // and by the card's own title when there is not. The card is told both which
                      // group it is in and whether the band already said so — the same rule that
                      // drops the list's `task` cell while grouping by task.
                      group={badges[index] ?? ''}
                      headed={headed}
                      selected={selected?.id === card.id}
                      marked={marked.has(card.id)}
                      stopping={bulk.picks.has(card.id)}
                      width={grid.cardWidth}
                      height={b.height}
                      words={cardWords}
                    />
                  </Box>
                )
              })}
            </Box>
          )))}
          {pager ? <Pager cells={pager} /> : null}
        </Box>
      ) : (
        // NO fixed height: the rows pack upward so nothing sits at the bottom of a tall pane with a
        // field of blank above it. The leftover space belongs at the very bottom of the frame.
        <Box flexDirection="row" flexShrink={0}>
        <Box flexDirection="column" flexShrink={0} width={listBody}>
          {visible.map((row, i) => {
            const index = offset + i
            // The cascade's guides, measured over the SAME window the columns are measured over, so
            // the two agree about how much room is left. Empty for every flat arrangement, which
            // then pays no columns at all.
            const guide = guides[i] ?? ''
            if (row.kind === 'spacer') return <Text key={`s${index}`}> </Text>
            if (row.kind === 'heading') {
              // A heading is drawn as a HEADING: accented, bold, with a rule running out to the
              // edge. Dim grey at the same weight as its rows is not a hierarchy — it is a list that
              // happens to be sorted, which is what this screen was.
              //
              // The cascade indents by its branch DEPTH, which is the whole of what the list has to
              // learn about the tree — the rest of this screen never finds out one exists. The card
              // grid, which has no indentation to spend, breadcrumbs the same branch instead.
              // The guide REPLACES the old two-spaces-per-level indent: it says the same thing
              // about depth and also says which node this hangs off and whether the branch ends
              // here, neither of which a column position can carry.
              const indent = guide || INDENT.repeat(row.depth ?? 0)
              const head = `${row.label}  ${row.count}`
              const rule = Math.max(0, listBody - indent.length - head.length - 3)
              return (
                <Text key={`h${index}`} wrap="truncate">
                  <Text dimColor>{indent}</Text>
                  <Text color={row.muted ? COLORS.muted : COLORS.secondary} bold={!row.muted}>
                    {truncate(head, Math.max(1, listBody - indent.length))}
                  </Text>
                  <Text dimColor>{rule > 0 ? `  ${'─'.repeat(rule)}` : ''}</Text>
                </Text>
              )
            }
            const rowView = (
              <SessionRowView
                key={row.session.id}
                session={row.session}
                selected={selected?.id === row.session.id}
                marked={marked.has(row.session.id)}
                stopping={bulk.picks.has(row.session.id)}
                notify={notifyWidth}
                ages={ages}
                columns={columns}
                width={listBody - guide.length}
                closeCell={closeCell}
              />
            )
            // A session is a CHILD of its heading, so it carries the same bars one level deeper —
            // a heading joined to its parent above rows that are not is a tree drawn half way.
            if (!guide) return rowView
            return (
              <Box key={row.session.id} flexDirection="row" flexShrink={0}>
                <Text dimColor>{guide}</Text>
                {rowView}
              </Box>
            )
          })}
        </Box>
        <ScrollBar cells={listBar} />
        </Box>
      )}
      </Pane>
      </Box>

      {/* The action row stays as the KEYBOARD path for a narrow terminal that has no menu. Drawn
          full width, under the band, because it acts on the selection rather than on either pane. */}
      {actionRows > 0 ? (
        <>
          {actionRows > 1 ? <Text> </Text> : null}
          <SessionActionRow
            labels={actionWords}
            actions={actions}
            selected={at2}
            focused={actionsFocused}
            width={width}
          />
        </>
      ) : null}

      {/* The third pane: what you selected, or the question you were just asked. A question owns the
          keyboard, so the frame says so — the accent is where the keys go, everywhere, always. */}
      {cockpit.detail > 0 && (askDetail || (!hideDetail && detail.length > 0)) ? (
        <Pane
          title={askDetail ? s.sessionsPaneAsk : s.sessionsPaneDetail}
          // The key that puts this pane away, written ON the pane. It lives as a row in the `show`
          // block too, but that block is collapsed by default and five rows deep — a control for a
          // thing you are looking straight at belongs on the thing.
          badge={askDetail ? '' : s.sessionsDetailHide}
          focused={Boolean(askDetail)}
          width={width}
          height={cockpit.detail}
        >
          {askDetail ? (
            <Question
              ask={askDetail as Exclude<Ask, { kind: 'new' } | { kind: 'view' } | { kind: 'keys' }>}
              strings={s}
              width={paneBody(width)}
              rows={paneRows(cockpit.detail)}
              fellAgo={fellAgo}
              onClose={() => setAsk(null)}
              onRun={(fn, label) => {
                setAsk(null)
                void run(fn, label).then(onRefreshFleet)
              }}
              host={host}
              query={query}
              // The cursor goes home on every change. That is the actual answer to the objection
              // that stopped this being live: a narrowing list moves rows out from under the
              // selection, so keeping the old index points at whatever slid into that slot. Row 0
              // is the best match to look at anyway.
              onQuery={q => { setQuery(q); toTop() }}
              fleet={fleet}
              // The mode ENDS with the act it exists for. Nobody has to remember a second keystroke
              // to disarm, which is the state this screen must never leave a person in.
              onStopped={() => setBulk(BULK_STOP_OFF)}
            />
          ) : (
            <Detail lines={detail} width={paneBody(width)} rows={paneRows(cockpit.detail)} />
          )}
        </Pane>
      ) : null}
    </Box>
  )
}

/**
 * How many, and how many of them are waiting — plus the dimension the list is grouped by.
 *
 * The waiting count is stated here as well as in the header because this is the screen a user is
 * looking at when they act on it, and a number they have to look away to read is a number they stop
 * trusting.
 */
/**
 * How many, how many are waiting — and the grouping, as a row of CELLS rather than a corner label.
 *
 * The dimension used to be a word in the corner cycled by a hidden `v`, which is the shape of a
 * control nobody finds: the screen said `GROUP task` without ever saying that was a thing you could
 * change, let alone how. Now every dimension is on screen, the current one is underlined, and
 * clicking one selects it — the same selector idiom the Logs screen uses for its sources, measured
 * by the same pure fit so a click and the drawn cells can never disagree.
 */
/**
 * What the list is showing right now, in words — and nothing you can press.
 *
 * It used to be a control strip: the grouping as clickable cells, the two visibility switches as
 * corner labels. That crammed three controls and two counts into one row, and the switches were
 * neither findable nor obviously switches. The controls moved to the view panel; this row's job is
 * to state the answer, so a glance tells you why the list looks the way it does.
 */
function SummaryRow({
  fleet, grouping, strings: s, width, showHistory, showNamed, onlyActive, shown, waitingShown,
  query, depth, scope, fell,
}: {
  fleet: ControlSessions | null | undefined
  grouping: SessionGrouping
  strings: ControlStrings
  width: number
  showHistory: boolean
  /** The one widening on this block — stated because it changes what a strict filter means. */
  showNamed: boolean
  /** The strict selection: exactly the states that mean something is alive. */
  onlyActive: boolean
  /** Rows actually drawn, counted from the drawn list rather than from the fleet. */
  shown: number
  /**
   * How many of those drawn rows are WAITING on a person.
   *
   * Counted from the drawn list for the same reason `shown` is. `fleet.attention` is a fleet-wide
   * figure — the header carries it on every tab and must — but printed unqualified above a
   * FILTERED list it claims something the rows underneath contradict.
   */
  waitingShown: number
  /** The active search, or `''`. Stated HERE because a list narrowed silently reads as an empty one. */
  query: string
  /** The per-scope depth of the current search — empty when nothing is being searched. */
  depth: string
  /** The active task or project scope, already localized, or `''`. */
  scope: string
  /**
   * Already-localized "N sessions fell X ago — R reopens them", or `''`.
   *
   * On this row rather than only in the empty state, because the list is NOT always empty after a
   * fall: a machine where one session survived, or where the history switches are on, shows rows —
   * and the offer to get the rest back would then have no place to be said at all.
   */
  fell: string
}) {
  if (fleet?.unavailable) {
    return <Text color={COLORS.accent} wrap="truncate">{truncate(fleet.unavailable, width)}</Text>
  }
  const waiting = fleet?.attention ?? 0

  // Only the filters that are actually narrowing something are named. A row that lists every
  // setting at its default is noise; one that names the filter in force is an explanation.
  //
  // Stated as what the list SHOWS, under its own label. It used to read `− not running` beside
  // `GROUP project`, which is wrong twice over: the reader has to know that `−` means "hidden" to
  // avoid reading it as the opposite of the truth, and at this row's width the leading dash sits
  // where a separator would, so the whole thing parses as one phrase — `GROUP project — not
  // running` — in which the grouping and the filter are indistinguishable. A label per cell is what
  // tells them apart, and a positive sentence is what stops the filter naming the rows it removed.
  const filters: string[] = []
  // The strict selection is stated FIRST and alone: it withholds everything the other one does and
  // more, so naming both would describe a filter that is not the one in force. `showNamed` is named
  // whenever it is on, because it is the one thing that puts rows BACK into a narrowed list.
  if (onlyActive) filters.push(s.sessionsFilterActive)
  else if (!showHistory) filters.push(s.sessionsFilterNoHistory)
  if (showNamed) filters.push(s.sessionsFilterNamed)

  // MEASURED, never left to Yoga: a row that wraps takes two of the screen's rows while its budget
  // counted one, and everything below it — the action row, the detail pane, the footer — is pushed
  // off the bottom. That failure reads as "the whole screen vanished", not as "one row is too wide".
  // A SCOPE outranks the grouping on this row. The grouping is a preference you set once; a search
  // or a drill-down is a reason the list in front of you is short, and a list that is short for a
  // reason nobody stated is one people read as broken. It carries the key that drops it, because
  // the whole complaint was not being able to get back.
  // The depth rides on the SAME row as the search announcement rather than taking one of its own:
  // an extra row here is a row the list loses, and `summaryCells` already measures and truncates
  // this one. It goes after the query and before `esc clears`, which is the reading order —
  // what you searched, how deep it went, how to get out.
  const narrowed = query ? `${s.sessionsSearching(query)}${depth ? ` · ${depth}` : ''}` : scope
  const cells = summaryCells({
    group: narrowed || `${s.sessionsGroupBy} ${s.sessionsGroupings[grouping]}`,
    hiding: filters.length > 0 ? `${s.sessionsFilterBy} ${filters.join(', ')}` : '',
    count: s.sessionsCount(shown, fleet?.sessions.length ?? 0),
    // The fleet's figure alone was a claim the list below could not support: with a search on,
    // this row read "2 waiting on you" over zero such rows (measured). When the two agree it stays
    // the short sentence; when they do not it names BOTH, because a session needing you that a
    // filter is withholding is the one thing on this screen that must not go quiet.
    waiting: waiting > 0
      ? (waitingShown === waiting
        ? s.sessionsWaitingCount(waiting)
        : s.sessionsWaitingSplit(waitingShown, waiting))
      : '',
    fell,
    width,
  })

  return (
    <Box flexDirection="row" width={width} justifyContent="space-between" flexShrink={0}>
      <Text wrap="truncate">
        {narrowed ? (
          <Text color={COLORS.accent} bold>{cells.group}</Text>
        ) : (
          <>
            <Text dimColor>{`${s.sessionsGroupBy} `}</Text>
            <Text bold>{cells.group.slice(s.sessionsGroupBy.length + 1)}</Text>
          </>
        )}
        {/* The label dim and the value bold, exactly as the grouping cell beside it is drawn — the
            two cells answer different questions and must look like two cells. */}
        {cells.hiding ? (
          <>
            <Text dimColor>{`   ${s.sessionsFilterBy} `}</Text>
            <Text bold>{cells.hiding.slice(s.sessionsFilterBy.length + 1)}</Text>
          </>
        ) : null}
        {/* The fall is an OFFER, not a description, so it is the one cell on this row that wears a
            colour: everything beside it says what the list contains, and this says what is one
            keypress from coming back. */}
        {cells.fell ? <Text color={COLORS.info} bold>{`   ${cells.fell}`}</Text> : null}
      </Text>
      <Text wrap="truncate">
        <Text dimColor>{cells.count}</Text>
        {cells.waiting ? (
          <Text color={COLORS.accent} bold>{`   ${cells.waiting}`}</Text>
        ) : null}
      </Text>
    </Box>
  )
}

function SessionRowView({ session, selected, marked, stopping, notify, ages, columns, width, closeCell }: {
  session: ControlSession
  selected: boolean
  /** Already-localized ages by session id — this component owns no clock and no strings. */
  ages: ReadonlyMap<string, string>
  /** PINNED: the user's own highlight. Survives re-sorting, and outlives the cursor moving away. */
  marked: boolean
  /**
   * Picked to be STOPPED, inside the bulk-stop mode. Ephemeral, and it OUTRANKS `marked` on screen.
   *
   * A row can be both, and when it is, the destructive state is the one that shows. A pin drawn
   * over a row that is about to be killed would be the harmless state hiding the dangerous one,
   * which is the whole failure this journey is about — so the glyph, the colour and the weight all
   * come from here first.
   */
  stopping: boolean
  /** Columns the notification dot takes — `0` when nothing on screen is waiting. */
  notify: number
  columns: SessionColumns
  width: number
  /** Columns reserved at the right edge for the close control — `0` when there is none. */
  closeCell: number
}) {
  // `harness` is a plain string here because it can be EMPTY — a session the registry has
  // forgotten runs a harness nobody recorded. An empty one simply gets no colour.
  const harnessColor = harnessColorOf(session.harness)
  const gap = '  '

  return (
    <Text wrap="truncate">
      {/* Two cells, and they answer different questions: the caret is WHERE THE CURSOR IS, the bar
          is WHAT YOU MARKED. Sharing one cell would make a mark vanish under the cursor, which is
          the one moment you are looking straight at it. The bar is `info` rather than the accent
          on purpose — the accent means focus everywhere else in this app, and a highlight that
          wore it would read as "this is selected" on four rows at once. */}
      <Text color={selected ? COLORS.info : undefined} underline={selected}>{selected ? '❯' : ' '}</Text>
      {/* One cell, three answers, in the order of consequence: picked to be stopped (a red ✕),
          pinned (a blue bar), neither. `stopping` leads on purpose — see the prop. */}
      <Text color={stopping ? COLORS.danger : marked ? COLORS.info : undefined} bold={stopping || marked}>
        {stopping ? '✕' : marked ? '▌' : ' '}
      </Text>
      {/* The NOTIFICATION. Three cells rather than one, because the row you are on, the row you
          marked and the row that needs you are three facts that can all be true at once — and the
          one that must survive is this, since it is the only one the machine is telling YOU. It
          wears the state's own colour, so red and amber keep meaning the same thing across the row,
          and it costs nothing at all on a fleet where nothing is waiting. */}
      {notify > 0 ? (
        <Text color={STATE_COLOR[session.state]} bold>
          {sessionNotify(session) ? '● ' : ' '.repeat(notify)}
        </Text>
      ) : null}
      {/* Colour AND word, always paired — and PADDED, so every title starts in the same column.
          Two spaces between unpadded cells is what made this read as a jumble of words: the state
          words differ by ten characters, so nothing after them ever lined up. */}
      {/* The HANDLE. `agentop session attach 3f5f` takes a prefix, so this is the one thing on the
          row that names the session to anything but this screen. */}
      {columns.id > 0 ? (
        <Text color={selected ? COLORS.info : undefined} underline={selected} dimColor={!selected} bold={selected}>
          {padCell(sessionHandle(session), columns.id) + gap}
        </Text>
      ) : null}
      {/* Harness column, right after the id. It wears its harness colour EXCEPT on the selected
          row, where the whole line is the focus highlight: a terminal draws the underline in the
          text's own colour (there is no separate underline colour Ink can set), so keeping the
          harness hue here drew a purple rule through a cyan line and broke the highlight into two
          pieces. Focus outranks provenance — the harness is still named in the cell, and every
          other row on screen still carries its colour. */}
      {columns.harness > 0 ? (
        <Text color={selected ? COLORS.info : harnessColor} underline={selected} bold={selected}>
          {padCell(session.harness, columns.harness) + gap}
        </Text>
      ) : null}
      <Text
        color={selected ? COLORS.info : STATE_COLOR[session.state]}
        underline={selected}
        bold={selected || session.state === 'waiting-approval'}
      >
        {padCell(session.stateLabel, columns.state)}
      </Text>
      {columns.title > 0 ? (
        <Text
          color={stopping ? COLORS.danger : selected ? COLORS.info : marked ? COLORS.info : undefined}
          underline={selected}
          bold={selected || marked || stopping}
        >
          {gap + padCell(session.title, columns.title)}
        </Text>
      ) : null}
      {/* How long ago it started, on rows that are NOT running — the age is most of the "reopen
          this or not" decision, and it lived only in the detail pane. */}
      {columns.age > 0 ? (
        <Text color={selected ? COLORS.info : undefined} underline={selected} dimColor={!selected}>
          {gap + padCell(ages.get(session.id) ?? '', columns.age)}
        </Text>
      ) : null}
      {/* A linked WORKTREE says so, because it changes what the row IS: three rows of one repo in
          three directories are three checkouts, and without the word they read as three projects.
          The word, never a glyph alone — a distinction announced in a symbol is one that has to be
          taught before the screen can be read. */}
      {columns.worktree > 0 ? (
        <Text color={selected ? COLORS.info : COLORS.secondary} underline={selected} bold={selected}>{gap + padCell(worktreeName(session), columns.worktree)}</Text>
      ) : null}
      {/* The TASK, right of the name. Filing a session under a task and then not being able to see
          which task it is in is the feature not working — the fact only existed in the detail pane
          and in a grouping you had to switch to. `sessionColumns` drops the cell while grouping BY
          task, where the heading over the row already says it. */}
      {columns.task > 0 ? (
        <Text color={selected ? COLORS.info : COLORS.secondary} underline={selected} bold={selected}>
          {gap + padCell(session.task ?? '', columns.task)}
        </Text>
      ) : null}
      {/* Usage sits right of the name and left of the harness — it is a number about THIS row, and
          a row you are deciding whether to close is one whose cost you want beside its name rather
          than one selection away in the detail pane. */}
      {columns.metrics > 0 ? (
        <Text color={selected ? COLORS.info : COLORS.secondary} underline={selected} bold={selected}>{gap + padCell(sessionMetric(session), columns.metrics)}</Text>
      ) : null}
      {/* How full the context window is. Beside the usage because it is the same kind of fact and
          the opposite reading of it: usage is what this session has spent, this is what it has
          left. A row with no reading draws a BLANK of the same width rather than a `0%` — the
          column exists because some rows can answer, not because all of them can. */}
      {columns.context > 0 ? (
        <Text
          color={selected
            ? COLORS.info
            : session.context ? CONTEXT_COLOR[contextLevel(session.context.fraction)] : undefined}
          underline={selected}
          dimColor={!selected && (!session.context || contextLevel(session.context.fraction) === 'ok')}
        >
          {gap + padCell(sessionContext(session), columns.context)}
        </Text>
      ) : null}
      {columns.where > 0 ? (
        <Text color={selected ? COLORS.info : undefined} underline={selected} dimColor={!selected}>{gap + padCell(session.projectGroup || session.project, columns.where)}</Text>
      ) : null}
      {/* The close control, at the right edge and only on a row that can take it. It asks before
          it acts — the same confirmation `x` opens, because a one-click stop on a list that
          re-sorts under the pointer every five seconds is a session ended by accident. */}
      {closeCell > 0 ? (
        <Text color={canClose(session) ? COLORS.danger : undefined}>
          {' ' + (canClose(session) ? CLOSE_CELL : ' ')}
        </Text>
      ) : null}
    </Text>
  )
}

/**
 * "Your last sessions were these — start them again?"
 *
 * Every row is NAMED, because the answer is a decision about specific work and a count is not
 * enough to make it with: three sessions in a repository you have finished with and one you were
 * in the middle of are the same "4" on screen.
 */
function RestoreOffer({ rows, strings: s, width, height, isActive, onAnswer }: {
  rows: readonly RestoreCandidate[]
  strings: ControlStrings
  width: number
  height: number
  isActive: boolean
  onAnswer: (action: 'accept' | 'decline' | 'list') => void
}) {
  useInput((i, key) => {
    const input = i.toLowerCase()
    if (key.return || input === 'r') return onAnswer('accept')
    if (input === 'l' || input === 'v' || key.tab) return onAnswer('list')
    if (key.escape) return onAnswer('decline')
  }, { isActive })

  const now = Date.now()
  // Two rows of chrome above and two below; what is left is the list, and a list longer than that
  // says how many it could not show rather than drawing over the answer.
  const page = Math.max(1, height - 5)

  return (
    <Pane title={s.sessionsPaneRestore} focused width={width} height={height}>
      <Text bold wrap="truncate">{truncate(s.restoreTitle(rows.length), paneBody(width))}</Text>
      <Text> </Text>
      {rows.slice(0, page).map(r => (
        <Text key={r.id} wrap="truncate">
          <Text color={COLORS.accent}>{'  ' + r.label}</Text>
          <Text dimColor>{`  ${r.harness}  ${r.project}`}</Text>
          {r.startedAt !== undefined ? (
            <Text dimColor>
              {`  ${s.sessionsAgo(Math.max(0, Math.round((now - r.startedAt) / 1000)))}`}
            </Text>
          ) : null}
        </Text>
      ))}
      {rows.length > page ? <Text dimColor>{`  … +${rows.length - page}`}</Text> : null}
      <Text> </Text>
      <Text wrap="truncate">{truncate(s.restoreAnswer, paneBody(width))}</Text>
    </Pane>
  )
}

/**
 * Every key this screen answers, on one screen.
 *
 * The footer names the handful that fit; this is the rest. It reads the SAME list the pure module
 * owns, so a key that exists and is not here would have to be left out of that list deliberately.
 */
function KeyHelpScreen({ strings: s, width, height, onClose }: {
  strings: ControlStrings
  width: number
  height: number
  onClose: () => void
}) {
  const rows = useMemo(() => sessionKeyHelp(s.sessionsKeyWhat), [s])
  const keyCol = keyHelpColumn(rows)
  const lines = useMemo(() => keyHelpLines(rows, paneBody(width)), [rows, width])
  // Two rows of chrome: the title and the footer that says how to leave and how to scroll. Budgeted
  // against the height, because Ink composites what does not fit rather than clipping it.
  const page = Math.max(1, paneRows(height) - 1)
  const [top, setTop] = useState(0)
  // The last first-line that still fills the page: scrolling past it would leave air under the
  // list while claiming there is more below.
  const maxTop = Math.max(0, lines.length - page)
  const at = Math.min(top, maxTop)

  useInput((input, key) => {
    if (key.escape || key.return || input === 'q') return onClose()
    // The reference is a DOCUMENT, so it answers the same keys every other scrolling surface in
    // this app answers, through the same pure reducer — clamped at both ends, never wrapped.
    const next = resolveScrollKey(
      { upArrow: key.upArrow, downArrow: key.downArrow, pageUp: key.pageUp, pageDown: key.pageDown,
        home: key.home, end: key.end, input },
      at, maxTop + 1, page,
    )
    if (next !== null) setTop(next)
  })

  const shown = lines.slice(at, at + page)

  return (
    <Pane title={s.sessionsPaneKeys} focused width={width} height={height}>
      {shown.map((line, i) => (
        <Text key={`${at + i}`} wrap="truncate">
          <Text color={COLORS.accent}>{padCell(line.keys, keyCol)}</Text>
          <Text dimColor>{'  ' + line.what}</Text>
        </Text>
      ))}
      {/* The footer says how to leave and — only while there IS more — that scrolling reaches it.
          A list that silently ends at the fold is one people conclude is the whole list. */}
      <Text dimColor wrap="truncate">
        {truncate(
          maxTop > 0
            ? `${s.sessionsKeysMore(at + shown.length, lines.length)}  ·  ${s.keyBack}`
            : s.keyBack,
          Math.max(1, paneBody(width)),
        )}
      </Text>
    </Pane>
  )
}

/**
 * The name of a group, over the band holding its cards.
 *
 * Drawn exactly as the LIST draws its headings — accented and bold, with a dim rule running to the
 * edge — because it is the same heading: both layouts read it off the same `sessionRows`, and a
 * grouping that looked like two different things in two layouts would be two features.
 */
function GroupHeading({ band, width }: {
  band: Extract<CardBand, { kind: 'heading' }>
  width: number
}) {
  // A cascade branch is titled with its whole PATH — the grid has no indentation to spend, so
  // `session-monitor` alone would say nothing about where it sits. Cut from the LEFT, because the
  // last segment is what identifies the node and so is the last thing given up.
  const count = `  ${band.count}`
  const name = band.path ? breadcrumb(band.path, Math.max(0, width - count.length)) : band.label
  const head = `${name}${count}`
  const rule = Math.max(0, width - head.length - 3)
  return (
    <Text wrap="truncate">
      <Text color={band.muted ? COLORS.muted : COLORS.secondary} bold={!band.muted}>
        {truncate(head, width)}
      </Text>
      <Text dimColor>{rule > 0 ? `  ${'─'.repeat(rule)}` : ''}</Text>
    </Text>
  )
}

/**
 * One session as a card — the same `Pane` every other framed region of this app uses.
 *
 * The frame names the card with what identifies it HERE and badges it with what identifies it
 * elsewhere. Which is which depends on whether the band above already says the group:
 *
 *  - **Grouped**: the heading names the project, so the title is the HANDLE and there is no badge.
 *  - **Ungrouped**: the title is the PROJECT — the thing a person scans a wall of cards for — and
 *    the handle moves to the badge. It never simply disappears: it is the prefix
 *    `agentop session attach 3f5f` resolves, and the only thing on the card naming this session to
 *    anything outside this screen. So the project is cut to `paneTitleRoom` to leave space for it,
 *    rather than taking the space and letting `paneTop`'s whole-or-nothing badge rule drop it.
 *
 * A conversation agentop did not start has no handle at all, and gets no badge rather than a
 * stand-in: the harness is already on its state line, and five characters of a synthetic id would
 * offer a handle the CLI cannot resolve.
 *
 * The lines come from the pure `cardLines`, cut from the bottom by `fitCardLines`, so what the card
 * gives up on a short terminal is decided in one place and tested there.
 */
function SessionCard({ session, group, headed, selected, marked, stopping, width, height, words }: {
  session: ControlSession
  /** The group this card belongs to — the heading's own words, or the project when there is none. */
  group: string
  /** True while the band above already names that group, so the card must not repeat it. */
  headed: boolean
  selected: boolean
  marked: boolean
  /** Picked to be stopped. Outranks `marked` here for the same reason it does on a row. */
  stopping: boolean
  width: number
  height: number
  /** The already-localized words, composed once by the screen — see `cardWords`. */
  words: CardLabels
}) {
  const inner = paneBody(width)
  const lines = fitCardLines(cardLines(session, words, group), paneRows(height))
  const handle = sessionHandle(session)
  // Grouped: the handle IS the title. Ungrouped: the project leads and the handle badges it.
  const title = headed ? handle || session.harness : group || handle || session.harness
  const badge = headed ? '' : handle

  return (
    <Pane
      title={truncate(title, paneTitleRoom(badge, width))}
      // Fitted HERE rather than left to `paneTop`, whose badge rule is whole-or-nothing: the handle
      // is the only place a card carries the name the CLI resolves, so it is truncated rather than
      // dropped. `paneBadgeRoom` is that frame's own arithmetic.
      badge={truncate(badge, paneBadgeRoom(title, width))}
      focused={selected}
      width={width}
      height={height}
    >
      {lines.map(line => (
        <CardLineView
          key={line.key}
          line={line}
          width={inner}
          labelWidth={cardLabelWidth(lines, inner)}
          marked={marked}
          stopping={stopping}
          selected={selected}
          stateColor={STATE_COLOR[session.state]}
          bold={session.state === 'waiting-approval'}
        />
      ))}
    </Pane>
  )
}

/**
 * One line of a card. The state keeps its colour and its WORD, exactly as the row does.
 *
 * A labelled line pads its label to `labelWidth` so every value on the card starts at one column —
 * `labelWidth` is `0` when the card is too narrow to name its facts and keep them readable, and then
 * every line draws bare. The lines that name themselves (the title, the state, the usage, what the
 * assistant is saying) take no indent: they are the card's headline, and pushing them right to line
 * up with a label they do not have would spend the width for nothing.
 */
function CardLineView({ line, width, labelWidth, marked, stopping, selected, stateColor, bold }: {
  line: CardLine
  width: number
  /** Columns the label column takes, or `0` to draw no labels at all. */
  labelWidth: number
  marked: boolean
  stopping: boolean
  selected: boolean
  stateColor: string | undefined
  bold: boolean
}) {
  if (line.kind === 'state') {
    const cells = cardStateCells(line.text, line.tail ?? '', width)
    return (
      <Text wrap="truncate">
        <Text color={stateColor} bold={bold}>{cells.state}</Text>
        <Text dimColor>{cells.tail}</Text>
      </Text>
    )
  }
  if (line.kind === 'title') {
    return (
      <Text
        wrap="truncate"
        color={stopping ? COLORS.danger : selected ? SESSION_FOCUS_ACCENT : marked ? COLORS.info : undefined}
        bold
      >
        {truncate(line.text, width)}
      </Text>
    )
  }
  const label = labelWidth > 0 && line.label ? line.label : ''
  const room = label === '' ? width : Math.max(1, width - labelWidth - CARD_LABEL_GAP)
  // The gauge carries its own level, so it is coloured by what it SAYS rather than by what kind of
  // line it is — the one line on the card whose colour is a reading rather than a role. It is drawn
  // unlabelled, like the `usage` line it sits under and shares a subject with, but it is measured
  // against `room` rather than `width` so a label added later cannot push it off its own line.
  if (line.kind === 'gauge') {
    const color = CONTEXT_COLOR[line.level ?? 'ok']
    return (
      <Text wrap="truncate" color={color} dimColor={color === undefined}>
        {truncate(line.text, room)}
      </Text>
    )
  }
  // What the assistant said is drawn in the text colour: it is the content, and every other line is
  // a label for it.
  return (
    <Text wrap="truncate">
      {label === '' ? null : (
        <Text dimColor>{padCell(label, labelWidth) + ' '.repeat(CARD_LABEL_GAP)}</Text>
      )}
      <Text color={line.kind === 'say' ? COLORS.text : COLORS.secondary}>
        {truncate(line.text, room)}
      </Text>
    </Text>
  )
}

/** Which page, how much of the fleet is on it, and the two arrows that move it. */
function Pager({ cells }: { cells: PagerCells }) {
  return (
    <Text wrap="truncate">
      <Text color={COLORS.accent}>{cells.prev ? `${cells.prev} ` : ''}</Text>
      <Text bold>{cells.label}</Text>
      <Text color={COLORS.accent}>{cells.next ? ` ${cells.next}` : ''}</Text>
      <Text dimColor>{cells.note ? `   ${cells.note}` : ''}</Text>
    </Text>
  )
}

/** The harness palette, safe for the empty harness an unregistered session carries. */
function harnessColorOf(harness: string): string | undefined {
  return (HARNESS_COLOR as Record<string, string | undefined>)[harness]
}

/**
 * The facts, cut from the bottom to the rows this pane was given.
 *
 * The lines themselves are decided by the pure `detailLines`, because the LAYOUT needs their count
 * before anything is drawn — see `sessionsLayout`.
 */
function Detail({ lines, width, rows }: {
  lines: readonly DetailLine[]
  width: number
  rows: number
}) {
  const labelWidth = Math.max(...lines.map(l => l.label.length), 0)

  return (
    <Box flexDirection="column">
      {lines.slice(0, Math.max(0, rows)).map(l => (
        <Text key={l.key} wrap="truncate" dimColor={l.note}>
          {l.label ? <Text dimColor>{l.label.padEnd(labelWidth)}  </Text> : <Text>{' '.repeat(labelWidth + 2)}</Text>}
          {/*
            A chat turn is coloured by who wrote it, read off the transcript's own `role` — never
            guessed from the screen (see `chat-tail.ts`). The user's own text takes `COLORS.info`,
            the same token this app already uses elsewhere for "what the user themselves did"; the
            assistant keeps the plain text colour it always had. A `say` line with no `role` is the
            raw-screen-tail fallback for a harness with no verified author, and stays in the
            content colour rather than being coloured as either side.
          */}
          <Text color={l.role === 'user' ? COLORS.info : l.say ? COLORS.text : undefined}>
            {truncate(l.value, Math.max(1, width - labelWidth - 2))}
          </Text>
        </Text>
      ))}
    </Box>
  )
}

/**
 * The three questions this screen asks, drawn where the detail pane was.
 *
 * In place of the facts rather than over them: a modal floating above a list is a second thing to
 * read at the moment the user is deciding, and the row being acted on is still visible above.
 */
/**
 * The questions this screen asks, drawn where the detail pane was.
 *
 * In place of the facts rather than over them: a modal floating above a list is a second thing to
 * read at the moment the user is deciding, and the row being acted on stays visible above.
 */
function Question({
  ask, strings: s, width, rows, fellAgo, onClose, onRun, host, query, onQuery, fleet, onStopped,
}: {
  /** Never `new` — the wizard takes the whole screen and is rendered before this is reached. */
  ask: Exclude<Ask, { kind: 'new' } | { kind: 'view' } | { kind: 'keys' }>
  strings: ControlStrings
  width: number
  /** Rows this pane was actually given — what the dialog preview is cut against. */
  rows: number
  /** How long ago the fall was, already localized. Absent when nothing fell. */
  fellAgo?: string
  onClose: () => void
  onRun: (fn: () => Promise<ActionResult>, label?: string) => void
  host: ControlHost
  query: string
  onQuery: (q: string) => void
  /** Needed to say how many sessions a task actually has — the confirmation used to say zero. */
  fleet: ControlSessions | null | undefined
  /** Called once the bulk stop actually runs, so the mode closes itself behind it. */
  onStopped: () => void
}) {
  if (ask.kind === 'search') {
    return (
      <Box flexDirection="column" width={width}>
      <Text dimColor>{truncate(s.promptHint, width)}</Text>
      <TextPrompt
        label={s.sessionsSearchLabel}
        // The current query is a PLACEHOLDER, never a `defaultValue`. `TextPrompt` treats a default
        // as the answer to an empty submit — correct for renaming, where enter means "leave it as
        // it is", and exactly wrong here: it made an empty enter re-apply the very query the user
        // was trying to drop, so a search could not be undone from the field that set it.
        placeholder={query}
        width={width}
        onCancel={onClose}
        // LIVE, as it is typed. It used to apply on submit, on the reasoning that re-grouping under
        // a moving cursor is unusable — but that reasoning was about the CURSOR, and the fix for a
        // jumping cursor is to reset it, not to make the user type blind. A search whose result you
        // cannot see until you commit is a search you run twice.
        onChange={value => onQuery(value.trim())}
        // Enter closes the field and KEEPS what is already applied. Cancel is what undoes it, and
        // the empty-submit case is why `placeholder` is used above instead of `defaultValue`.
        onSubmit={value => { onQuery(value.trim()); onClose() }}
      />
      </Box>
    )
  }

  // The FLEET question: it names no session, so it is answered before `session` is reached at all.
  if (ask.kind === 'reopenFell') {
    const fell = fleet?.fell
    return (
      <ConfirmPrompt
        // The count AND when. A fall from three days ago is a perfectly legitimate thing to offer,
        // and an offer that does not say when reads as one that just happened.
        label={s.sessionsFellConfirm(fell?.count ?? 0, fellAgo ?? '')}
        yesLabel={s.yes}
        noLabel={s.no}
        width={width}
        height={rows}
        onCancel={onClose}
        onAnswer={(yes: boolean) => {
          const reopen = host.reopenFell
          if (!yes || !reopen) return onClose()
          onRun(() => reopen.call(host), s.actSessions.reopenFell)
        }}
      />
    )
  }

  if (ask.kind === 'openWarning') {
    return (
      <Box flexDirection="column" width={width}>
        <Text color={COLORS.danger} bold>Aviso: Não é possível reabrir as sessões selecionadas.</Text>
        <Text dimColor>As seguintes sessões já estão abertas e não podem ser religadas:</Text>
        {ask.openSessions.map(title => (
          <Text key={title} color={COLORS.accent}>{`  • ${title}`}</Text>
        ))}
        <Text> </Text>
        <Text dimColor>Pressione [Enter] ou [Esc] para fechar este aviso.</Text>
      </Box>
    )
  }

  if (ask.kind === 'batchPrompt') {
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>{`Enviar prompt para ${ask.sessions.length} sessões selecionadas:`}</Text>
        <TextPrompt
          label="Prompt para selecionadas"
          width={width}
          onCancel={onClose}
          onSubmit={value => {
            const text = value.trim()
            const send = host.promptSession
            if (!send || !text) return onClose()
            onRun(async () => {
              for (const sess of ask.sessions) {
                await send.call(host, sess.id, text)
              }
              return { ok: true, message: '' }
            }, s.actSessions.prompt)
          }}
        />
      </Box>
    )
  }

  if (ask.kind === 'bulkStop') {
    return (
      <ConfirmPrompt
        // The COUNT is the question: these are rows picked one at a time inside a mode, and a
        // confirmation that did not say how many were picked would be asking for a blank yes. It is
        // localized now — it used to be a Portuguese sentence hard-coded into an English screen.
        label={s.sessionsStopManyConfirm(ask.sessions.length)}
        yesLabel={s.yes}
        noLabel={s.no}
        width={width}
        onCancel={onClose}
        onAnswer={(yes: boolean) => {
          if (!yes) return onClose()
          // The mode closes on the YES, ahead of everything else — before the host is even asked
          // whether it can stop anything. Leaving a person on a red list with a live `x` because
          // the host turned out to have no `killSession` is the one way out of this mode that must
          // not exist. Declining, by contrast, KEEPS the selection: you said no to the question,
          // not to the four rows you spent a minute picking.
          onStopped()
          const kill = host.killSession
          if (!kill) return onClose()
          onRun(async () => {
            for (const sess of ask.sessions) {
              await kill.call(host, sess.id)
            }
            return { ok: true, message: '' }
          }, s.actSessions.kill)
        }}
      />
    )
  }

  // Answered BEFORE `session` is destructured, because it names a TASK and not a session — the same
  // reason `reopenFell` sits above.
  if (ask.kind === 'deleteTask') {
    return (
      <ConfirmPrompt
        // The count is in the question because the answer turns on it: removing a name that files
        // eleven sessions is a different act from removing one that files none, and the sessions
        // are KEPT either way. A confirmation that hid the number would be asking for a blank yes.
        label={s.sessionsDeleteTaskAsk(ask.name, ask.count)}
        yesLabel={s.yes}
        noLabel={s.no}
        width={width}
        onAnswer={yes => {
          const del = host.deleteTask
          if (!yes || !del) return onClose()
          const name = ask.name
          onClose()
          onRun(() => del.call(host, name), s.actSessions.deleteTask)
        }}
      />
    )
  }

  const { session } = ask

  /**
   * Answering the dialog a session is blocked on — the only question here that shows EVIDENCE.
   *
   * Two shapes, because the dialogs are two shapes:
   *
   *  - **It offers OPTIONS.** They are listed and one is picked, and the picked one is what gets
   *    sent. There is no "approve" here to offer: a session asking "only my fix / promote
   *    everything / stop in dev / type something" has four answers that do different work, and a key
   *    that took the highlighted row would be choosing between them for the user. That was the
   *    defect, and it was reported by somebody looking at exactly that dialog.
   *  - **It offers nothing to choose between** — codex's `Press enter to continue`. Then it really
   *    is a confirmation, and the dialog is shown above it because the confirm key still takes
   *    whatever is on the screen.
   */
  if (ask.kind === 'approve') {
    const options = session.dialogOptions ?? []
    // What is left for the dialog once the question has taken its rows. Cut from the TOP, so the
    // options and the footer — the part being answered — are what survives a short pane.
    const room = Math.max(0, rows - QUESTION_ROWS - 1)
    const preview = fitApprovalPreview(session.approvalLines ?? [], room)
    const evidence = preview.length > 0 ? (
      <>
        <Text dimColor>{truncate(s.sessionsApproveWhat, width)}</Text>
        {preview.map((line, i) => (
          <Text key={`ap${i}`} wrap="truncate" color={COLORS.text}>{truncate(line, width)}</Text>
        ))}
      </>
    ) : null

    if (options.length > 1) {
      // No verified way to pick on this harness. Refused in WORDS, naming what does work — a
      // refusal you can act on beats a verb that silently answers for you.
      if (!session.canChoose) {
        return (
          <Box flexDirection="column" width={width}>
            {evidence}
            {/* WRAPPED, not truncated: this is the whole content of the answer, and a refusal cut
                off at "nobody has verified how to pick an option on ge…" tells nobody anything.
                Bounded so it cannot grow over the rows the pane was given. */}
            <WrappedText
              // `dialogBlind` FIRST: "nobody verified how to pick an option here" and "the dialog
              // is taller than agentop can read" are different facts with different remedies, and
              // the generic string states the wrong one confidently.
              text={session.dialogBlind ?? session.chooseBlind ?? s.sessionsChooseBlind}
              width={width}
              maxRows={Math.max(1, rows - preview.length - 2)}
            />
            <Text dimColor wrap="truncate">{truncate(s.sessionsChooseAttach, width)}</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" width={width}>
          {evidence}
          <Menu
            // `Menu` numbers its own rows from 1, and the parser guarantees the options ARE `1..n`
            // in order — so the number beside a row here is the same number the session printed
            // beside it. Adding the option's number to the label would print it twice.
            items={options.map(o => ({
              label: o.label,
              value: String(o.number),
              ...(o.selected ? { hint: s.sessionsChoiceHighlighted } : {}),
            }))}
            width={width}
            // The row the dialog is highlighting, so pressing enter straight away does what
            // attaching and pressing enter would have done — and nothing else does.
            initialIndex={Math.max(0, options.findIndex(o => o.selected))}
            height={Math.max(2, rows - preview.length - (preview.length > 0 ? 1 : 0))}
            isActive
            onCancel={onClose}
            onSelect={value => {
              const answer = host.answerSession
              if (!answer) return onClose()
              onRun(() => answer.call(host, session.id, Number(value)), s.actSessions.approve)
            }}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        {evidence}
        <ConfirmPrompt
          label={`${s.sessionsApproveConfirm(session.title)} ${s.sessionsApproveCaveat}`}
          yesLabel={s.yes}
          noLabel={s.no}
          width={width}
          height={Math.max(QUESTION_ROWS, rows - preview.length - (preview.length > 0 ? 1 : 0))}
          onCancel={onClose}
          onAnswer={(yes: boolean) => {
            const answer = host.answerSession
            if (!yes || !answer) return onClose()
            onRun(() => answer.call(host, session.id), s.actSessions.approve)
          }}
        />
      </Box>
    )
  }

  if (ask.kind === 'prompt') {
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>{truncate(s.sessionsPromptHint, width)}</Text>
        <TextPrompt
          label={s.sessionsPromptLabel(session.title)}
          width={width}
          onCancel={onClose}
          onSubmit={value => {
            const text = value.trim()
            const send = host.promptSession
            // An empty submit is a CANCEL, never a blank turn sent to an assistant — the same rule
            // the rename prompt follows for the same reason.
            if (!send || !text) return onClose()
            onRun(() => send.call(host, session.id, text), s.actSessions.prompt)
          }}
        />
      </Box>
    )
  }

  if (ask.kind === 'kill') {
    return (
      <ConfirmPrompt
        label={s.sessionsKillConfirm(session.title)}
        yesLabel={s.yes}
        noLabel={s.no}
        width={width}
        onCancel={onClose}
        onAnswer={(yes: boolean) => {
          if (!yes) return onClose()
          const kill = host.killSession
          if (!kill) return onClose()
          onRun(() => kill.call(host, session.id), s.actSessions.kill)
        }}
      />
    )
  }

  if (ask.kind === 'resume') {
    const target = session.resume
    return (
      <ConfirmPrompt
        // The conversation's OWN title is in the question, which is what lets the person — who knows
        // what they were doing — judge whether it is the right one. No heuristic here could.
        label={`${s.sessionsResumeConfirm(target?.title ?? session.title)}${
          session.state === 'unknown' ? ` ${s.sessionsResumeRunning}` : ''}`}
        yesLabel={s.yes}
        noLabel={s.no}
        width={width}
        onCancel={onClose}
        onAnswer={(yes: boolean) => {
          const resume = host.resumeSession
          if (!yes || !target || !resume) return onClose()
          onRun(() => resume.call(host, {
            sessionId: target.sessionId,
            harness: session.harness,
            cwd: session.cwd,
            // The user's own name wins over the conversation's derived one. A reopen that renamed
            // the row back to whatever the transcript called it undoes the rename every time.
            label: session.named ? session.title : target.title,
            // Only a MANAGED row is replaced. An external process's id is synthetic and a closed
            // conversation's is the harness's own — retiring either would be naming a registry row
            // that does not exist, which the host answers by doing nothing rather than by guessing.
            ...(session.actionable ? { replaces: session.id } : {}),
            attach: false,
          }).then(r => ({ ok: r.ok, message: r.message })), s.actSessions.resume)
        }}
      />
    )
  }

  if (ask.kind === 'openTask') {
    const task = session.task ?? ''
    // Counted from the fleet rather than passed as a literal `0`, which is what it was — the
    // question offered to reopen "all 0 sessions" of a task that plainly had some, which is the
    // kind of number that makes a person stop trusting every other number on the screen.
    const count = (fleet?.sessions ?? []).filter(v => v.task === task).length
    return (
      <ConfirmPrompt
        label={s.sessionsOpenTaskConfirm(task, count)}
        yesLabel={s.yes}
        noLabel={s.no}
        width={width}
        onCancel={onClose}
        onAnswer={(yes: boolean) => {
          const open = host.openTask
          if (!yes || !open) return onClose()
          onRun(() => open.call(host, task), s.actSessions.openTask)
        }}
      />
    )
  }

  if (ask.kind === 'finishTask') {
    const task = session.task ?? ''
    const already = (fleet?.finishedTasks ?? []).includes(task)
    const mine = (fleet?.sessions ?? []).filter(v => v.task === task)
    const count = mine.length
    // Counted separately and stated separately. "N sessions" alone does not tell you whether any of
    // them is an assistant currently burning tokens, and that is the fact somebody is worried about
    // when they hesitate over this button.
    const running = mine.filter(sessionRunning).length
    return (
      <ConfirmPrompt
        // The question states what finishing ACTUALLY does — mark the task, hide its sessions
        // behind a switch — and says outright that nothing is stopped. It must not describe
        // something the code does not do: a warning that claims to end everything, over an action
        // that ends nothing, is worse than no warning, because it teaches people that the warnings
        // on this screen can be ignored.
        label={already
          ? s.sessionsReopenConfirm(task)
          : s.sessionsFinishConfirm(task, count, running)}
        yesLabel={s.yes}
        noLabel={s.no}
        width={width}
        height={rows}
        onCancel={onClose}
        onAnswer={(yes: boolean) => {
          const finish = host.finishTask
          if (!yes || !finish) return onClose()
          onRun(() => finish.call(host, task, !already), s.actSessions.finishTask)
        }}
      />
    )
  }

  const isRename = ask.kind === 'rename'
  const isTask = ask.kind === 'task'

  if (isTask) {
    return (
      <TaskChoice
        host={host}
        strings={s}
        current={session.task ?? ''}
        width={width}
        onCancel={onClose}
        onPick={value => {
          const fn = host.taskSession
          if (!fn) return onClose()
          onRun(() => fn.call(host, session.id, value.trim()), s.actSessions.task)
        }}
      />
    )
  }

  return (
    <Box flexDirection="column" width={width}>
    <Text dimColor>{truncate(s.promptHint, width)}</Text>
    <TextPrompt
      label={isRename ? s.sessionsRenamePrompt : s.sessionsNotePrompt}
      // The current value is offered as the default, so `enter` on an unchanged field is a no-op
      // rather than a way to accidentally blank a name.
      defaultValue={(isRename ? session.title : session.note) ?? ''}
      width={width}
      onCancel={onClose}
      onSubmit={value => {
        const text = value.trim()
        const fn = isRename ? host.renameSession : host.noteSession
        if (!fn || !text) return onClose()
        onRun(
          () => fn.call(host, session.id, text),
          isRename ? s.actSessions.rename : s.actSessions.note,
        )
      }}
    />
    </Box>
  )
}

/**
 * The scroll window for the view menu — PURE, so the "does it actually scroll" guarantee is
 * testable without a tty (an input-driven render test flakes under concurrent load; this does not).
 *
 * The menu draws a title and a hint above its rows, so the rows get `height - 2`. Over that budget
 * it uses the SAME following window (`windowOffset`) every other list in this package uses, centred
 * on the cursor — which is what keeps the row the cursor lands on drawn. Slicing from zero
 * (`rows.slice(0, height - 2)`) left the Search-in depths below the fold and unreachable on a short
 * terminal — the `Math.max(1, height - chrome)` trap CLAUDE.md names.
 */
export function viewMenuWindow(
  rowCount: number,
  cursorRow: number,
  height: number,
): { offset: number; body: number } {
  const body = Math.max(1, height - 2)
  return { offset: windowOffset(cursorRow, rowCount, body), body }
}

/**
 * Everything about WHAT the list shows, as ONE vertical panel.
 *
 * It replaced a cramped horizontal strip that cycled the grouping on a hidden key and had nowhere
 * to put the two visibility switches — so they were a corner label people did not find, changed by
 * a letter nobody was told about. A vertical list is navigable with two keys, states every option
 * AND the one in force, and has room to say what each does.
 *
 * Rendered where the whole screen is, like the wizard: this is a decision, not an annotation, and
 * squeezing it under the list is what made it unreadable the first time.
 */
function ViewOptions({
  strings: s, grouping, showHistory, showNamed, scopes, width, height, isActive,
  onGrouping, onShowClosed, onShowNamed, onToggleScope, onToggleAllScopes, onClose,
}: {
  strings: ControlStrings
  grouping: SessionGrouping
  showHistory: boolean
  showNamed: boolean
  scopes: SearchScopeSelection
  width: number
  height: number
  isActive: boolean
  onGrouping: (g: SessionGrouping) => void
  onShowClosed: () => void
  onShowNamed: () => void
  onToggleScope: (t: SearchToggle) => void
  onToggleAllScopes: () => void
  onClose: () => void
}) {
  // One flat list of rows so the cursor moves over exactly what is drawn — the same reason the
  // fleet list flattens its groups.
  type Row =
    | { kind: 'heading'; label: string }
    | { kind: 'group'; value: SessionGrouping }
    | { kind: 'closed' }
    | { kind: 'named' }
    // The cumulative search depths, plus the two-way "all" — see `search-scope.ts`.
    | { kind: 'scope'; toggle: SearchToggle }
    | { kind: 'scopeAll' }

  const scopeLabel: Record<SearchToggle, string> = {
    title: s.searchDepthName, prompt: s.searchDepthPrompt, transcript: s.searchDepthTranscript,
  }
  const rows: Row[] = [
    { kind: 'heading', label: s.viewGroupBy },
    ...GROUPINGS.map(g => ({ kind: 'group' as const, value: g })),
    { kind: 'heading', label: s.viewShow },
    { kind: 'closed' },
    // Was the unfiled switch, which only meant anything while grouping by task. That bucket is now
    // a row in the task section, on every grouping; this is the widening that had no control at all.
    { kind: 'named' },
    { kind: 'heading', label: s.viewSearchDepth },
    ...SEARCH_TOGGLES.map(t => ({ kind: 'scope' as const, toggle: t })),
    { kind: 'scopeAll' },
  ]
  const selectable = rows.map((r, i) => (r.kind === 'heading' ? -1 : i)).filter(i => i >= 0)

  const [index, setIndex] = useState(0)
  const at = Math.min(index, Math.max(0, selectable.length - 1))
  const cursorRow = selectable[at] ?? 0

  useInput((input, key) => {
    if (key.escape) return onClose()
    if (key.upArrow || input === 'k') return setIndex(Math.max(0, at - 1))
    if (key.downArrow || input === 'j') return setIndex(Math.min(selectable.length - 1, at + 1))
    if (!key.return) return
    const row = rows[cursorRow]
    if (!row) return
    if (row.kind === 'group') return onGrouping(row.value)
    if (row.kind === 'closed') return onShowClosed()
    if (row.kind === 'named') return onShowNamed()
    if (row.kind === 'scope') return onToggleScope(row.toggle)
    if (row.kind === 'scopeAll') return onToggleAllScopes()
  }, { isActive })

  // The list — every grouping, the two Show switches, and the Search-in depths — outgrows a short
  // terminal, so it SCROLLS: `viewMenuWindow` is the same following window every other list here
  // uses, and it keeps the cursor's row drawn. Slicing from zero left the depth rows below the fold.
  const { offset, body } = viewMenuWindow(rows.length, cursorRow, height)
  // The "all" glyph is TRI-STATE: a half-dot when only some depths are on, so it can never claim to
  // be on while a depth is off. `allState` is derived from the very toggles above, so the two read
  // as one — the PE's two-way requirement, met by there being only one source.
  const all = allState(scopes)
  const allGlyph = all === 'on' ? '● ' : all === 'off' ? '○ ' : '◐ '

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Text bold>{truncate(s.viewTitle, width)}</Text>
      <Text dimColor>{truncate(s.viewHint, width)}</Text>
      {rows.slice(offset, offset + body).map((row, localIndex) => {
        // `i` is the row's index in the WHOLE list, not the visible slice, so the cursor comparison
        // and the React keys stay correct once the window has scrolled off zero.
        const i = offset + localIndex
        if (row.kind === 'heading') {
          return <Text key={`h${i}`} dimColor bold>{truncate(row.label, width)}</Text>
        }
        const active = i === cursorRow
        // Every row states BOTH what it is and whether it is on. A list of options that shows only
        // the cursor makes you press things to find out what they already were.
        // The dot means ON, always — for every row on this panel.
        const on = row.kind === 'group'
          ? row.value === grouping
          : row.kind === 'closed' ? showHistory
          : row.kind === 'named' ? showNamed
          : row.kind === 'scope' ? scopes[row.toggle]
          : all === 'on'
        const label = row.kind === 'group'
          ? s.sessionsGroupings[row.value]
          : row.kind === 'closed' ? s.viewClosedOn
          : row.kind === 'named' ? s.toggleNamed
          : row.kind === 'scope' ? scopeLabel[row.toggle]
          : s.searchDepthAll
        // The "all" row wears the tri-state glyph; every other row is a plain on/off dot.
        const glyph = row.kind === 'scopeAll' ? allGlyph : on ? '● ' : '○ '
        return (
          <Text key={`r${i}`} wrap="truncate">
            <Text color={active ? COLORS.accent : undefined}>{active ? '  ❯ ' : '    '}</Text>
            {/* Glyph plus word: which options are on must survive a terminal that drops colour. */}
            <Text color={on ? COLORS.success : COLORS.muted}>{glyph}</Text>
            <Text color={active ? COLORS.accent : undefined} bold={active}>
              {truncate(label, Math.max(1, width - 8))}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * The verbs, all of them, with the ones this row cannot take drawn dim.
 *
 * A local row rather than the shared `ActionRow`: that one takes plain labels and cannot say that a
 * cell is unavailable, and the services cockpit it was written for has no such state. The FIT is
 * still the shared, tested one, so what is drawn and what a click resolves against are the same
 * measurement.
 */
function SessionActionRow({ labels, actions, selected, focused, width }: {
  labels: string[]
  actions: readonly OfferedAction[]
  selected: number
  focused: boolean
  width: number
}) {
  const fit = fitActionRow(labels, selected, width)
  return (
    <Text wrap="truncate">
      <Text dimColor>{fit.less ? '‹ ' : '  '}</Text>
      {fit.labels.map((cell, i) => {
        const index = fit.from + i
        const enabled = actions[index]?.enabled ?? false
        const active = index === selected && focused
        return (
          <Text key={cell} dimColor={!enabled}>
            {i > 0 ? ACTION_SEP : ''}
            {/* Underlined as well as accented, the same way the cockpit marks the verb it would
                run: which cell is selected must survive a flattened palette. */}
            <Text
              color={active ? COLORS.accent : enabled ? undefined : COLORS.muted}
              bold={active}
              underline={active}
            >
              {cell}
            </Text>
          </Text>
        )
      })}
      <Text dimColor>{fit.more ? ' ›' : ''}</Text>
    </Text>
  )
}


/**
 * The aside menu — everything this screen can do, on the left, visible.
 *
 * It exists because every control here used to be a letter: the grouping cycled on a hidden `v`, the
 * visibility switches were a corner label, and the verbs only appeared once you knew `tab` reached
 * them. A person opening this screen for the first time could see a list of sessions and no way to
 * act on any of them. A menu you can read and click is not a nicety here.
 *
 * Every row states its own state — a filled dot for a grouping in force or a switch that is on —
 * because a menu that shows only a cursor makes you press things to find out what they already were.
 */
function AsideMenu({
  rows, cursor, focused, width, height, offset, allTasksLabel, allProjectsLabel,
}: {
  rows: readonly AsideRow[]
  /** Index into `rows` of the row under the cursor, or `-1`. */
  cursor: number
  focused: boolean
  width: number
  height: number
  offset: number
  /** What the "every task" row is called — localized chrome the menu does not own. */
  allTasksLabel: string
  allProjectsLabel: string
}) {
  const inner = Math.max(1, width - 2)
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {rows.slice(offset, offset + height).map((row, at) => {
        const i = offset + at
        if (row.kind === 'rule') {
          return <Text key={`r${i}`} dimColor>{'─'.repeat(inner)}</Text>
        }
        if (row.kind === 'heading') {
          return <Text key={`h${i}`} dimColor bold wrap="truncate">{truncate(row.label, width)}</Text>
        }
        const active = i === cursor && focused
        // An action has no on/off state — a dot beside "Rename" would be claiming something. Only
        // the switches, the grouping and the task scope carry one.
        const dot = row.kind === 'action' ? '  ' : row.on ? '● ' : '○ '
        const enabled = row.kind !== 'action' || row.enabled
        // A task row carries its COUNT, which is what says the task has work in it. The label is
        // truncated around it rather than the count being dropped: a task named at its full length
        // with no number tells you nothing you did not already know from the grouping.
        const scoped = row.kind === 'task' || row.kind === 'project'
        // A STATE row carries its count for the same reason a task does — it is what says the
        // filter has anything behind it. The ORDER row carries its direction instead, because
        // picking the order already in force flips it and the arrow is what says which way.
        // A task row that is not the "every task" one carries its count, INCLUDING the unfiled
        // bucket — whose name is empty, which is why this cannot be keyed on the name.
        const count = row.kind === 'state' ? ` ${row.count}`
          : row.kind === 'task' ? (row.all ? '' : ` ${row.count}`)
          : scoped && row.name ? ` ${row.count}`
          : row.kind === 'sort' && row.on ? (row.dir === 'desc' ? ' ↓' : ' ↑')
          : ''
        const allLabel = row.kind === 'project' ? allProjectsLabel : allTasksLabel
        // A finished task wears a tick, so the menu states what it already knows rather than making
        // someone select it to find out.
        const tick = row.kind === 'task' && row.done ? '✓ ' : ''
        // A task row states its OWN name; only a project row is still rebuilt from `name`, and it
        // has no unfiled bucket to collide with (`projectCounts` skips sessions with no project).
        const label = row.kind === 'task' ? tick + row.label
          : scoped ? tick + (row.name || allLabel) : row.label
        return (
          <Text key={`${row.kind}${i}`} wrap="truncate" dimColor={!enabled}>
            <Text color={active ? COLORS.accent : undefined}>{active ? '❯' : ' '}</Text>
            <Text color={row.kind !== 'action' && row.on ? COLORS.success : COLORS.muted}>{dot}</Text>
            <Text
              color={active ? COLORS.accent : enabled ? undefined : COLORS.muted}
              bold={active}
            >
              {truncate(label, Math.max(1, width - 3 - count.length))}
            </Text>
            {count ? <Text dimColor>{count}</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}
