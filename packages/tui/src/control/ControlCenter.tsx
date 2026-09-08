/**
 * ControlCenter — the one component mounted for the whole `agentop` session.
 *
 * Everything the user does here is a state transition inside this tree: screens, questions and
 * text prompts never mount a second Ink app and never print a line. That is the entire reason the
 * control center exists — the old launcher re-rendered once per step and grew the scrollback
 * forever.
 *
 * The shell owns what must survive a screen switch (the status, the last action's outcome, the
 * scroll position of each read-only screen) and nothing else. Every screen stays mounted and is
 * hidden with `display="none"` rather than unmounted, so coming back to one finds it exactly as it
 * was — a remount would reset the Logs viewport and the cockpit's own wizard on every glance
 * elsewhere.
 *
 * The chrome is six rows and no more, in reading order: the title, a blank, the tab bar, its
 * accent rule, then — under the body — the status line and the footer. It used to be eight: a
 * two-row wordmark, a mode sentence and a two-row tab strip, which on a 24-row terminal was a third
 * of the screen spent telling the user what they had just typed.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, useInput } from 'ink'
import { useTerminalSize } from '../useTerminalSize'
import { bodyHeight, resolveScrollKey, resolveTabKey, scrollBy, type NavKey } from './nav'
import { fitTabs, headerLayout, tabAtColumn } from './chrome.ts'
import { paneHit, shellHit } from './hit'
import { isActivation, trackClick, wheelDelta, type ClickTrack, type MouseReport, type Pointer } from './mouse'
import { createPointerBus, PointerProvider, type MouseChannel } from './pointer'
import { TAB_ORDER, type ActionResult, type ControlExit, type ControlHost, type ControlSessions, type ControlStatus, type TabId } from './types'
import { appendLines } from './stream'
import type { CliLang } from './lang'
import { controlStrings } from './i18n'
import { Footer, Header, Spinner, StatusLine, TabBar, tabBarTabs } from './Chrome'
import { Pane, paneBody, paneRows } from './Pane'
import { cheatContent, contributeContent, helpContent } from './content'
import { StaticTab } from './tabs/Static'
import { Logs } from './tabs/Logs'
import { Services } from './tabs/Services'
import { Backup } from './tabs/Backup'
import { Sessions } from './tabs/Sessions'
import { Dashboard } from './tabs/Dashboard'
import { HardwareTab } from './tabs/HardwareTab'
import { writeFrame } from './altScreen'

/**
 * What a screen tells the shell about itself.
 *
 * `capture` is the important half: while a text prompt or a question is open the global keys must
 * stop working, or typing an endpoint URL would quit the app on the `q` of `https` and refresh it
 * on the `r`. The screen knows when it is capturing; the shell cannot guess.
 *
 * `claimArrows` is the other half of the same idea, and there is only one of it now. Screens move
 * on `←`/`→` alone — the digits stopped switching screens when the numbered strip went away — and
 * the cockpit's action row is the one place that wants those arrows for itself, because it is a
 * horizontal list. Its way back out is `esc`, so nothing is ever more than two keys from any
 * screen, and the footer stops saying `←→ screens` for exactly as long as it would be false.
 *
 * The flag matters more than it sounds: a key answered by the screen AND by the shell does two
 * things at once, only one of which the row that advertises it can describe. That is the same class
 * of bug as a footer hint for a key that does nothing — a control that lies.
 */
export interface ScreenChrome {
  capture: boolean
  claimArrows?: boolean
  hints: string[]
}

/** Kept under the old name too: the screens import it, and both readings are accurate. */
export type TabChrome = ScreenChrome

/**
 * A task the shell is performing, and what it has said so far.
 *
 * The output of the long commands — `docker compose up --build`, `central.sh up`, `bun run bin` — no
 * longer goes to the terminal: the app stays in the alternate screen and the lines arrive on
 * `ControlHost.onOutput`, which `run` subscribes to around every action. They are accumulated HERE,
 * in the shell, for the same reason the status line lives here: `run` is the single funnel every
 * screen performs through, so subscribing anywhere else would mean subscribing in several places.
 *
 * `id` exists so a second run of the SAME verb is a different task: the screen resets its viewport
 * when this changes, and two consecutive `Rebuild & restart`es would otherwise share a scroll
 * position and a title that never changed.
 */
export interface TaskView {
  id: number
  /** The verb the user pressed, so a wall of build output is always attributable. */
  title: string
  /** Newest LAST, bounded by the ring in `control/stream.ts`. */
  lines: string[]
  /** `null` while it is still running; the outcome once it is done. */
  result: ActionResult | null
}

/**
 * What a screen performs through, and how the output pane gets its title.
 *
 * The label is the VERB the user pressed. It is optional because most actions say nothing worth
 * watching, and it is passed rather than derived because only the screen knows which control was
 * activated — `run` sees a function.
 */
export type RunAction = (fn: () => Promise<ActionResult>, label?: string) => Promise<ActionResult>

/**
 * The built-in fallback for how often the fleet is re-read, used only until the host answers
 * `status.sessionPollMs` (or if it never does). Five seconds — the interval the monitor was
 * originally specified at. The user-facing default and floor/ceiling live in `preferences.ts`
 * (`SESSION_POLL_DEFAULT_MS` and friends); this constant is deliberately not imported from there —
 * the TUI reads no preferences of its own, exactly like the mouse and the language.
 */
const SESSION_POLL_MS = 5_000

/**
 * The terminal bell, as an escape rather than a literal byte.
 *
 * Written as `\u0007` on purpose: a raw BEL in a source file is invisible in every diff and every
 * editor, and the next person to touch this line would have no way to see what it is.
 */
const BEL = '\u0007'

/** Screens whose only state is a scroll position, which the shell holds for them. */
type StaticTabId = 'help' | 'cheatsheet' | 'contribute'

export interface ControlCenterProps {
  host: ControlHost
  lang: CliLang
  initial?: {
    tab?: TabId
    /** Open with the setup wizard up — what "bare `agentop` opens on Setup" became. */
    setup?: boolean
  }
  onExit: (exit: ControlExit) => void
  /**
   * The mouse, or nothing at all.
   *
   * Absent means a keyboard-only app rather than a half-connected one: the preview script and any
   * surface rendered outside `runControlCenter` have no terminal to enable tracking on, and the
   * footer says nothing about a device that cannot report.
   */
  mouse?: MouseChannel
}

export function ControlCenter({ host, lang: initialLang, initial, onExit, mouse }: ControlCenterProps) {
  const [lang, setLang] = useState<CliLang>(initialLang)
  const s = controlStrings(lang)

  const [tab, setTab] = useState<TabId>(initial?.tab ?? 'services')
  // Seeded from what the host already knows, so a REMOUNT does not open on the defaults. Detaching
  // from a session remounts this app, `refresh()` takes about a second to probe systemd and docker,
  // and for that second the sessions list was drawn with the shipped arrangement instead of the
  // user's — the screen visibly rearranged itself under them. `null` stays the first-ever launch,
  // where there is genuinely nothing to know yet.
  const [status, setStatus] = useState<ControlStatus | null>(host.lastStatus?.() ?? null)
  const [busy, setBusy] = useState(true)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [chrome, setChrome] = useState<ScreenChrome>({ capture: false, hints: [] })
  const [scroll, setScroll] = useState<Record<StaticTabId, number>>({
    help: 0,
    cheatsheet: 0,
    contribute: 0,
  })

  const { columns, rows } = useTerminalSize()
  // The shell pads one column on each side, so the floor has to leave room for BOTH — a clamp of
  // twenty inside a twenty-column terminal is a frame one column wider than the screen, and every
  // row of it shears.
  const width = Math.max(1, columns - 2)

  /**
   * How many times `r` has been pressed.
   *
   * The screens that hold a snapshot of their own — the dashboard reads `/api/data` — cannot be
   * refreshed by `host.refresh()`, which re-detects services and nothing else. Rather than give them
   * a second key, the one key that already means "re-read what is on screen" is broadcast: a counter
   * a screen can depend on, so `r` means exactly one thing everywhere in this application.
   */
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(async () => {
    setBusy(true)
    setNonce(n => n + 1)
    try {
      setStatus(await host.refresh())
    } finally {
      setBusy(false)
    }
  }, [host])

  useEffect(() => { void refresh() }, [refresh])

  /**
   * The session fleet, polled by the SHELL rather than by the sessions screen.
   *
   * It lives here because the counter it feeds is drawn in the header, which is on every tab: a poll
   * that only ran while the sessions screen was open would leave that counter stale — or worse,
   * confidently zero — everywhere else, which is the one thing it exists to prevent.
   *
   * `undefined` means the host has no fleet at all; `null` means it has one and has not answered
   * yet. Two different sentences, and the screen must not collapse them into one.
   */
  const [fleet, setFleet] = useState<ControlSessions | null | undefined>(
    host.sessions ? null : undefined,
  )

  /**
   * How often the fleet is re-read — `null`-until-chosen, same shape as `mouseChoice` below: the
   * default until the host answers is the built-in one, and once the config pane row has been
   * pressed the local answer wins so a stale `refresh()` cannot flicker it back to what it was.
   */
  const [pollChoice, setPollChoice] = useState<number | null>(null)
  const sessionPollMs = pollChoice ?? status?.sessionPollMs ?? SESSION_POLL_MS

  const setSessionPollMs = useCallback((next: number) => {
    setPollChoice(next)
    // The TUI owns no persistence — the host stores it beside every other preference.
    void host.setSessionPollMs(next)
  }, [host])

  /**
   * One read of the fleet, callable on demand as well as on the interval.
   *
   * The sessions screen calls it straight after an action, because a kill or a rename the user just
   * performed has to be visible before the next tick — a list that ignores you for five seconds
   * reads as a list that ignored you.
   */
  const pollFleet = useCallback(async () => {
    const read = host.sessions
    if (!read) return
    let next: ControlSessions
    try {
      next = await read.call(host)
    } catch {
      // `sessions()` is contracted never to throw. If it does anyway, the stale list beats a blank
      // one — reporting an empty fleet would say every running session had ended.
      return
    }
    setFleet(next)
    // The bell rings for the TRANSITION into waiting, which the host computed; ringing on the level
    // would beep every five seconds for as long as a question went unanswered. It goes through
    // `writeFrame` because nothing may write to the alternate buffer around Ink.
    if (next.rang.length > 0) writeFrame(BEL)
  }, [host])

  useEffect(() => {
    if (!host.sessions) return
    void pollFleet()
    // Re-armed whenever `sessionPollMs` changes, so pressing the config row's action takes effect
    // on the very next tick rather than waiting out whatever interval was already running.
    const timer = setInterval(() => { void pollFleet() }, sessionPollMs)
    return () => clearInterval(timer)
  }, [host, pollFleet, sessionPollMs])

  /**
   * The task the last action started, or `null` when nothing has been performed yet.
   *
   * Held by the shell rather than by the screen that started it because `run` is the only place an
   * action happens, and because the same output could be shown by a second screen tomorrow without
   * moving the subscription.
   */
  const [task, setTask] = useState<TaskView | null>(null)
  const taskId = useRef(0)

  /** Put the facts back. `esc` on the output pane, and nothing else. */
  const dismissTask = useCallback(() => setTask(null), [])

  /**
   * The single path through which a screen performs anything.
   *
   * It keeps the spinner, the status line, the streamed output and the post-action refresh in one
   * place, so a screen can never forget one of the four. The result is returned as well as displayed
   * because some flows branch on it (offering the boot question only after a start that worked).
   *
   * The subscription is opened BEFORE `fn` and closed after it, and the buffer is cleared at the
   * START of every action — one task's output appearing under the next one's title would be a pane
   * lying about what it is showing.
   */
  const run = useCallback(async (fn: () => Promise<ActionResult>, label?: string): Promise<ActionResult> => {
    setBusy(true)
    setResult(null)

    const id = ++taskId.current
    // A plain local variable rather than a piece of state read back: lines arrive in bursts (a
    // build prints dozens in one tick) and `setTask(prev => …)` cannot be trusted to have run
    // before the next one lands.
    let lines: string[] = []
    setTask({ id, title: label ?? s.paneOutput, lines, result: null })
    const unsubscribe = host.onOutput(line => {
      lines = appendLines(lines, [line])
      // A NEW array each time, so React sees the change; the ring is what bounds how big it gets.
      // Guarded on the id so a late line from a previous action cannot repaint the current one.
      setTask(prev => (prev && prev.id === id ? { ...prev, lines } : prev))
    })

    let res: ActionResult
    try {
      res = await fn()
    } catch (err) {
      // The host localizes its own outcomes; a thrown error has no localized form, so its own
      // message is the most truthful thing we can show.
      res = { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      unsubscribe()
    }
    setResult(res)
    // The pane keeps what it showed and gains the outcome; `esc` is what puts the facts back.
    setTask(prev => (prev && prev.id === id ? { ...prev, result: res } : prev))
    try {
      setStatus(await host.refresh())
    } catch {
      // refresh() is contracted never to throw; if it does, the stale panel beats a blank one.
    }
    setBusy(false)
    return res
  }, [host, s.paneOutput])

  // Screens report on every state change of their own, which happens far more often than the value
  // actually changes; re-setting an equal object would re-render the whole shell each keystroke.
  const reportChrome = useCallback((next: ScreenChrome) => {
    setChrome(prev =>
      prev.capture === next.capture
      && Boolean(prev.claimArrows) === Boolean(next.claimArrows)
      && prev.hints.join('\u0000') === next.hints.join('\u0000')
        ? prev
        : next,
    )
  }, [])

  const switchLang = useCallback((next: CliLang) => {
    setLang(next)
    // The host localizes what it returns — the mode sentence, the service labels, the outcome in
    // the status line — so switching only the TUI's own strings leaves half the screen in the
    // previous language until the next action. Re-asking is what makes the toggle look instant.
    void host.setLang(next).then(refresh)
  }, [host, refresh])

  /**
   * The ONE way any read-only screen's viewport moves.
   *
   * Every scroll — a key now, a mouse wheel next — goes through this, which is why the position
   * lives in the shell rather than inside each screen: a driver that is not the keyboard has one
   * function to call and one place to read the current position from.
   */
  const setScrollFor = useCallback((id: StaticTabId, index: number) => {
    setScroll(prev => (prev[id] === index ? prev : { ...prev, [id]: Math.max(0, index) }))
  }, [])

  /**
   * Whether the terminal is reporting the mouse.
   *
   * `null` means "nobody has said" — the host is asked on the first refresh, and the default until
   * then is ON, which is what the user chose. Once `m` has been pressed the local answer wins for
   * the rest of the session: the host has been told, and re-reading it on every refresh would let a
   * stale status flicker the setting back.
   */
  const [mouseChoice, setMouseChoice] = useState<boolean | null>(null)
  const mouseOn = mouseChoice ?? status?.mouse ?? true

  const toggleMouse = useCallback(() => {
    setMouseChoice(prev => {
      const next = !(prev ?? status?.mouse ?? true)
      // The TUI owns no persistence — the host stores it beside every other preference.
      void host.setMouse(next)
      return next
    })
  }, [host, status?.mouse])

  // The escape sequences are `altScreen`'s, so tracking cannot outlive the process; this is the only
  // place that asks for them, and it asks on mount as well, which is what turns the mouse on.
  useEffect(() => { mouse?.setTracking(mouseOn) }, [mouse, mouseOn])

  // Ctrl-C on its own handler, always live. Ink is in raw mode with `exitOnCtrlC: false`, so no
  // SIGINT is generated and this is the ONLY way out of a screen that is capturing input — without
  // it, a half-typed prompt would be a trap.
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') onExit({ kind: 'quit', code: 130 })
  })

  // The header is the block wordmark when the terminal can carry it beside the machine's tag and
  // the one-line mark when it cannot, so its height is not a constant and the body is budgeted
  // against what it will actually draw. Everything else is fixed: a blank, the tab bar, its rule,
  // the status line and the footer. The update notice costs no row of its own — it is a dot on the
  // header's right-hand tag.
  const header = headerLayout({
    mode: status?.mode ?? '',
    version: status?.version ?? '',
    latestVersion: status?.latestVersion,
    // Drawn in the header so it is readable from every tab — a counter you have to navigate to in
    // order to see cannot tell you to navigate there.
    attention: fleet?.attention ?? 0,
    // Absent on a machine whose memory cannot be read, and then no gauge is drawn at all — never a
    // zero. The host decides `red`, from the distance to the ceiling AND from swap pressure; the
    // TUI owns no logic here either.
    ...(status?.memory ? { memory: status.memory } : {}),
    // WHICH machine, and whether its link is alive. Absent in solo mode and on a machine that has
    // never completed a handshake — no name is drawn rather than a hostname standing in for one.
    ...(status?.machineName ? { machineName: status.machineName } : {}),
    ...(status?.accountName ? { accountName: status.accountName } : {}),
    ...(status?.linkState ? { linkState: status.linkState } : {}),
    ...(status?.pushMs !== undefined ? { pushMs: status.pushMs } : {}),
    width,
  })
  const height = bodyHeight(rows, header.rows)

  const isStatic = tab === 'help' || tab === 'cheatsheet' || tab === 'contribute'

  // Only the three interactive screens report, and only they clear their own flags again. Scoping
  // every claim to them means a screen that never reports cannot inherit a stale `true` and lock
  // the global keys with no owner left to release them.
  const reports = tab === 'services' || tab === 'sessions' || tab === 'backup' || tab === 'dashboard'
    || tab === 'logs'
  const capturing = chrome.capture && reports
  const arrowsClaimed = Boolean(chrome.claimArrows) && reports

  useInput((input, key) => {
    const nav: NavKey = {
      input,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
      home: key.home,
      end: key.end,
      tab: key.tab,
      shift: key.shift,
    }

    // `tab` belongs to the panes and the digits belong to the screens' own lists; changing screen
    // is `←`/`→`, and the only thing that can take those is a pane that is itself a horizontal list.
    const next = resolveTabKey(nav, tab, !arrowsClaimed)
    if (next && next !== tab) { setTab(next); return }

    if (input === 'q') { onExit({ kind: 'quit', code: 0 }); return }
    if (input === 'r') { void refresh(); return }
    if (input === 'm' && mouse) { toggleMouse(); return }

    if (isStatic) {
      const id = tab as StaticTabId
      // The shell does not know how the content wrapped at this width, so it scrolls against an
      // OPEN-ENDED length and the screen clamps to its own line count and reports the corrected
      // index back. `G` therefore lands on the last row without either side counting it twice.
      const next = resolveScrollKey(nav, scroll[id], Number.MAX_SAFE_INTEGER, Math.max(1, height - 3))
      if (next !== null) return setScrollFor(id, next)
    }
  }, { isActive: !capturing })

  const tabs = tabBarTabs(TAB_ORDER, s.tabsShort)
  // Computed HERE and handed to the bar, rather than measured again inside it: the strip's cell
  // widths are what a click on it is resolved against, and two measurements of the same row would
  // agree until the day one of them changed.
  const tabLayout = fitTabs(tabs, tab, width)

  // -------------------------------------------------------------------------
  // the mouse
  // -------------------------------------------------------------------------

  /** The previous press, so a second one on the same cell can be recognised as a double. */
  const clicks = useRef<ClickTrack | null>(null)

  /**
   * One terminal report, resolved.
   *
   * The shell answers for its OWN chrome — the tab bar is the only thing up here a pointer can act
   * on — and converts everything else into the frame of whichever screen is showing, which is what
   * lets each screen resolve a click against the very layout values it rendered from. Anything that
   * lands on the title, the status line or the padding is dropped, silently: a click on nothing is
   * not an error to report.
   */
  const onReport = useCallback((report: MouseReport) => {
    // Turning the mouse OFF has to mean ignoring it, not merely stopping asking for it. Normally the
    // terminal falls silent the moment tracking is disabled, so this changes nothing — but reports
    // can still arrive after the fact: a sequence already in flight when `m` was pressed, a terminal
    // that keeps reporting, or a paste carrying the bytes. Acting on any of those would make the
    // toggle a request rather than a setting.
    if (!mouseOn) return

    const hit = shellHit({ headerRows: header.rows, bodyRows: height }, report.column, report.row)
    if (hit.region === 'chrome') return

    const track = report.kind === 'press'
      ? (clicks.current = trackClick(clicks.current, report, Date.now()))
      : clicks.current
    const local: Pointer = {
      x: 0,
      y: 0,
      kind: report.kind,
      button: report.button,
      shift: report.shift,
      double: report.kind === 'press' && (track?.count ?? 1) >= 2,
    }

    if (hit.region === 'tabs') {
      // While a question owns the keyboard the arrows do not change screen and the bar is drawn
      // dim; a click that switched anyway would be the one control on this frame that lies.
      if (capturing || !isActivation({ ...local, x: hit.x, y: 0 })) return
      const target = tabAtColumn(tabLayout, hit.x)
      if (!target) return
      const at = TAB_ORDER.indexOf(tab)
      if (target.kind === 'tab') return setTab(target.id)
      const step = target.kind === 'prev' ? -1 : 1
      return setTab(TAB_ORDER[(at + step + TAB_ORDER.length) % TAB_ORDER.length]!)
    }

    if (isStatic) {
      // The read-only screens have no controls, only a viewport, and the shell is the thing holding
      // its position — so the wheel is answered here rather than emitted to a screen that would
      // have to hand the answer straight back.
      const delta = wheelDelta(report.button)
      if (delta === 0) return
      const id = tab as StaticTabId
      // Open-ended, exactly like the keyboard path: only the screen knows how the prose wrapped at
      // this width, and it clamps and reports the corrected index back.
      return setScrollFor(id, scrollBy(scroll[id], delta, Number.MAX_SAFE_INTEGER))
    }

    // The cockpit draws its own panes and lays out against the body, so it receives body
    // coordinates. Every other screen is framed by the shell and receives the INSIDE of that frame,
    // which is the same rectangle it was given a width and a height for.
    const frame = tab === 'services'
      ? { x: hit.x, y: hit.y }
      : paneHit(width, height, hit.x, hit.y)
    if (!frame) return
    mouse?.pointer.emit({ ...local, x: frame.x, y: frame.y })
  }, [mouseOn, header.rows, height, width, tab, tabLayout, capturing, isStatic, scroll, setScrollFor, mouse])

  const onReportRef = useRef(onReport)
  onReportRef.current = onReport
  // Subscribed once per channel: the handler closes over the tab and the scroll position, so it is
  // rebuilt on every render, and resubscribing that often would churn the listener set on every
  // keystroke.
  useEffect(() => mouse?.onReport(report => { onReportRef.current(report) }), [mouse])

  // Ordered by what the user can least afford to lose, because `footerHints` drops from the right.
  // The read-only screens have no state to report, so the shell says what works on them; every
  // interactive screen names its own keys, which is the only way the footer can follow a focus the
  // shell cannot see.
  const staticHints = [s.keyQuit, s.keyTabs, s.keyScroll, s.keyEnds]
  /**
   * The mouse's own hints, LAST, because `footerHints` drops from the right and `q quit` has to
   * survive a narrow terminal.
   *
   * The copy hint is only said while tracking is on, and it is the reason it exists: with the
   * terminal reporting buttons, a plain drag no longer selects text, and `shift` is what hands the
   * gesture back to the terminal. A workaround nobody can discover is not one.
   */
  const mouseHints = mouse ? (mouseOn ? [s.keyMouseCopy, s.keyMouse] : [s.keyMouse]) : []
  const hints = [...(isStatic ? staticHints : chrome.hints), ...mouseHints]
  // Same correction on the read-only screens' own footer: while the mouse reports, "select with the
  // mouse to copy" is no longer true on its own.
  const copyHint = mouse && mouseOn ? s.copyHintShift : s.copyHint

  /**
   * Everything that is not the cockpit is framed by the shell rather than by the screen.
   *
   * One containment style is what makes six screens read as one application, and putting the frame
   * here means Logs and the three read-only screens neither know nor can disagree about it —
   * they receive the INSIDE of a pane and lay out against that. The titles are the SHORT names, the
   * same lowercase words the strip prints and the cockpit's own panes wear, so a pane title reads
   * as a label everywhere rather than as a heading here and a label there.
   */
  const bodyWidth = paneBody(width)
  const bodyRows = paneRows(height)

  return (
    // Everything under here can be pointed at, so everything under here is inside the provider.
    // Only the ACTIVE screen's components listen (they gate on the same `isActive` their keyboard
    // does), which is what keeps a hidden screen from answering a click meant for the cockpit.
    <PointerProvider bus={mouse?.pointer ?? EMPTY_POINTERS}>
    <Box flexDirection="column" paddingX={1}>
      <Header layout={header} width={width} />
      <Box height={1} />
      {/* Where you are, and how to move: the bar reads top-down with the title above it and the
          content under it, which is the whole fix for a frame nobody could orient themselves in. */}
      <TabBar layout={tabLayout} width={width} dim={capturing} />

      {/* Ink does not clip an overflowing child, it COMPOSITES it: a body one row too tall lands
          on top of the status line and the two are drawn into the same cells, which reads as a
          corrupted frame rather than as a cramped one. Every screen budgets itself against
          `height`; this is the guarantee that a miscount degrades into a missing row instead. */}
      <Box flexDirection="column" height={height} overflowY="hidden">
        <Screen visible={tab === 'services'}>
          <Services
            host={host}
            status={status}
            strings={s}
            lang={lang}
            width={width}
            height={height}
            isActive={tab === 'services'}
            run={run}
            // The output of whatever was last performed, and the way back to the facts. The cockpit
            // draws it into the detail region — the big pane the user pointed at.
            task={task}
            onDismissTask={dismissTask}
            onChrome={reportChrome}
            onExit={onExit}
            onLang={switchLang}
            // Both absent when there is no mouse, which is what removes the config row and the
            // `m` key together rather than leaving a control for a device that cannot report.
            mouseOn={mouseOn}
            onMouse={mouse ? toggleMouse : undefined}
            sessionPollMs={sessionPollMs}
            onSessionPollMs={setSessionPollMs}
            // A machine that has never been configured opens with the wizard already asking. It is
            // a question of this screen now rather than a tab of its own — see `TAB_ORDER`.
            initialSetup={initial?.setup}
          />
        </Screen>

        {/* Like the services cockpit, the sessions screen frames its OWN regions — a menu, the
            list and the detail — so the one holding the keyboard can wear the accent border. One
            frame around all three said nothing about which of them the arrows were talking to. */}
        <Screen visible={tab === 'sessions'}>
            <Sessions
              host={host}
              // Polled by the shell, not by this screen — the counter it feeds is in the header,
              // which is on every tab.
              fleet={fleet}
              strings={s}
              width={width}
              height={height}
              isActive={tab === 'sessions'}
              run={run}
              onChrome={reportChrome}
              onExit={onExit}
              // An action the user just took must be visible before the next tick, or the screen
              // looks like it ignored them.
              onRefreshFleet={() => { void pollFleet() }}
              // Remembered across runs by the HOST, like the language and the mouse: the control
              // center owns no persistence, so a setting it can toggle is a setting the host stores.
              view={status?.sessionView}
              onView={v => { void host.setSessionView?.(v) }}
            />
        </Screen>

        {/* A cockpit like Services, for the same reason: the harnesses list and the config pane
            are the selection, and the detail pane is a fuller view of the same facts or the place
            a running backup streams into. It is its own tab rather than a corner of Services —
            an operation over the data, and operations come before the numbers. */}
        <Screen visible={tab === 'backup'}>
          <Backup
            host={host}
            strings={s}
            width={width}
            height={height}
            isActive={tab === 'backup'}
            run={run}
            task={task}
            onDismissTask={dismissTask}
            onChrome={reportChrome}
            nonce={nonce}
          />
        </Screen>

        {/* Framed by the shell like Logs, and for the same reason: it is a viewport with a
            selector over it, not a cockpit of related panes. The connection state that used to sit
            in the standalone app's header rides on its screen strip instead of on a pane badge, so
            the same row says where you are and whether the numbers under it are live. */}
        <Screen visible={tab === 'dashboard'}>
          <Pane title={s.tabsShort.dashboard} width={width} height={height}>
            <Dashboard
              status={status}
              strings={s}
              lang={lang}
              width={bodyWidth}
              height={bodyRows}
              isActive={tab === 'dashboard'}
              nonce={nonce}
              onChrome={reportChrome}
            />
          </Pane>
        </Screen>

        <Screen visible={tab === 'hardware'}>
          <Pane title={s.tabsShort.hardware} width={width} height={height}>
            <HardwareTab
              status={status}
              fleet={fleet}
              strings={s}
              lang={lang}
              width={bodyWidth}
              height={bodyRows}
              isActive={tab === 'hardware'}
              nonce={nonce}
              onChrome={reportChrome}
            />
          </Pane>
        </Screen>

        <Screen visible={tab === 'logs'}>
          <Pane title={s.tabsShort.logs} width={width} height={height}>
            <Logs
              host={host}
              // The sources are DERIVED from the services the host reported — see `logSources`.
              // They used to be a constant list of runtime ids inside the screen, which is how it
              // went on offering `local` and `machine` as two things long after the model had made
              // them one.
              status={status}
              lang={lang}
              width={bodyWidth}
              height={bodyRows}
              isActive={tab === 'logs'}
              onChrome={reportChrome}
            />
          </Pane>
        </Screen>

        <Screen visible={tab === 'cheatsheet'}>
          <Pane title={s.tabsShort.cheatsheet} width={width} height={height}>
            <StaticTab
              sections={cheatContent(lang)}
              width={bodyWidth}
              height={bodyRows}
              intro={s.cheatIntro}
              copyHint={copyHint}
              scrollIndex={scroll.cheatsheet}
              onScrollChange={i => setScrollFor('cheatsheet', i)}
            />
          </Pane>
        </Screen>

        <Screen visible={tab === 'help'}>
          <Pane title={s.tabsShort.help} width={width} height={height}>
            <StaticTab
              sections={helpContent(lang)}
              width={bodyWidth}
              height={bodyRows}
              intro={s.helpIntro}
              copyHint={copyHint}
              scrollIndex={scroll.help}
              onScrollChange={i => setScrollFor('help', i)}
            />
          </Pane>
        </Screen>

        <Screen visible={tab === 'contribute'}>
          <Pane title={s.tabsShort.contribute} width={width} height={height}>
            <StaticTab
              sections={contributeContent(lang)}
              width={bodyWidth}
              height={bodyRows}
              intro={s.contributeIntro}
              copyHint={copyHint}
              scrollIndex={scroll.contribute}
              onScrollChange={i => setScrollFor('contribute', i)}
            />
          </Pane>
        </Screen>
      </Box>

      {busy
        ? <Spinner label={s.working} />
        : <StatusLine message={result?.message} ok={result?.ok} width={width} />}
      <Footer hints={hints} width={width} />
    </Box>
    </PointerProvider>
  )
}

/**
 * The bus a keyboard-only surface gets.
 *
 * Created once at module scope rather than per render: `usePointer` resubscribes whenever the bus
 * identity changes, and a fresh empty bus on every render would do that on every keystroke.
 */
const EMPTY_POINTERS = createPointerBus()

/**
 * A hidden screen keeps its state but takes no rows.
 *
 * `display="none"` rather than returning null: an unmounted Logs screen would forget its scroll
 * position and its paused/following state, and an unmounted cockpit would drop the user back
 * at question one for the crime of looking at the cheat sheet.
 */
function Screen({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    // `flexShrink={0}` is what turns overflow into clipping. Ink's Box shrinks by default, and a
    // column too tall for its parent is not truncated but COMPRESSED — Yoga hands several rows the
    // same y and Ink composites them into one line of nonsense. Refusing to shrink lets the
    // parent's `overflowY: hidden` cut the extra rows off instead.
    <Box flexDirection="column" flexShrink={0} display={visible ? 'flex' : 'none'}>
      {children}
    </Box>
  )
}
