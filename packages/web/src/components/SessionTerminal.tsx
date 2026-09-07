/**
 * SessionTerminal — the xterm.js emulator that renders one terminal frame.
 *
 * This module statically imports `@xterm/xterm` (and its CSS), and is itself loaded through
 * `React.lazy` by the card, so the emulator's weight lands in its OWN chunk — downloaded only when
 * a viewer actually opens a terminal, never on the initial dashboard load.
 *
 * Each `frame` from the channel is a COMPLETE snapshot (tmux `capture-pane` already resolved every
 * spinner, redraw and cursor move into final glyphs), so rendering is `reset()` then `write()` — we
 * never append. The cursor is placed from the frame's own `cursor` field and hidden entirely on a
 * dead frame, because the channel sends `cursor: null` once the pane is dead and a cursor blinking
 * on a finished screen is exactly the "looks alive" lie this feature must not tell.
 *
 * FIDELITY vs the box — the fix for the "scattered words" bug. The frame was captured at the pane's
 * OWN width (`f.cols`, routinely 157/200+) and every line is already hard-broken at that width by
 * tmux. Rendering it into an emulator of ANY other column count reflows those lines and scatters the
 * text — so the emulator's COLUMN count is always EXACTLY `f.cols` and never fitted to the box. A
 * 157-column grid does not fit a card, so instead of reflowing (wrong) or clipping to a scroll
 * window (what read as broken), the whole grid is SCALED to the box with a CSS transform: the layout
 * stays byte-for-byte what `capture-pane` drew, only smaller. `transform` is visual only — it never
 * changes the buffer's column count — so nothing wraps. The discriminant between a faithful and a
 * broken terminal is therefore the pane's COLUMN count against the box, and the scale is what
 * answers it; a session broke precisely when its columns overflowed a box the fit did not shrink.
 *
 * SCROLL — the emulator's ROW count is the whole capture (`max(f.rows, f.lines)`), not one screen,
 * so every shipped line lives on the grid and the fixed-height box scrolls through all of it (see
 * `paint`). Sizing it to the visible screen alone left the earlier lines in xterm's own scrollback,
 * which a per-frame `reset()` wiped — so scrolling up never reached the start of the conversation.
 *
 * Timing: `resize()` throws asynchronously inside xterm if it runs before the renderer has measured
 * its cell dimensions (an unmeasured `Viewport.syncScrollArea` reads `dimensions` off `undefined`),
 * and a `try/catch` cannot catch that — the throw is scheduled, not synchronous. The renderer
 * measures on its FIRST render, so we gate the first paint on xterm's own `onRender` event (with a
 * timeout as a belt-and-braces fallback). Frames that arrive before then are held and painted on
 * ready.
 */

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { xtermTheme, type TerminalFrame } from '../lib/terminalStream'

interface Props {
  frame: TerminalFrame | null
  theme: 'dark' | 'light'
  /** Draw the block cursor at the frame's position. False on a finished/gone screen. */
  showCursor: boolean
  /** Display multiplier from the zoom control. Scales the PIXELS only — never the column count — so
   *  a bigger font can never reflow the capture. Above the fit-to-box scale the box scrolls. */
  zoom?: number
  /** Phase 2b — when true, the emulator accepts keyboard input (`disableStdin` off) and every
   *  `xterm.onData` chunk is handed to `onInput`. NOTHING is echoed locally: the character appears
   *  only when the session draws it back over the read channel, so a key that did not land is never
   *  on screen. False (the default) keeps the Phase-1 read-only terminal exactly as it was. */
  interactive?: boolean
  /** Receives each raw `onData` chunk while `interactive`. Wired to the write channel by the parent. */
  onInput?: (data: string) => void
}

const FONT_SIZE = 13
const FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace"

/** The floor the fit-to-width auto-shrink may not cross. `11px` is not a made-up number — it is the
 *  smallest body text already used throughout this dashboard (the metric chips, the card meta row).
 *  Below it, letters stop being legible characters and become texture; the box scrolls sideways
 *  instead (see `fit`'s doc comment). */
const MIN_SCALE = 11 / FONT_SIZE

/**
 * Has the renderer measured its cell dimensions yet? `resize()` schedules a viewport sync that reads
 * `renderService.dimensions`, and doing that before the first measured render (or after dispose)
 * throws asynchronously — uncatchable by try/catch, and a site-origin console error. So every resize
 * is gated on this being true, read defensively off xterm's core so a version bump degrades to "not
 * ready" rather than crashing.
 */
function dimensionsReady(term: Terminal): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rs = (term as any)?._core?._renderService
    const cell = rs?.dimensions?.css?.cell
    return typeof cell?.width === 'number' && cell.width > 0
  } catch {
    return false
  }
}

/**
 * The emulator's true unscaled pixel size — `cols × rows` times the measured cell — read from
 * xterm's OWN dimensions, never from `.xterm`'s `offsetWidth`. The `.xterm` element has no intrinsic
 * width and collapses to a few pixels while its `.xterm-screen` child overflows to the real size; a
 * fit that measured the collapsed element computed `scale(1)` and let a 252-column pane overflow a
 * narrow box unscaled — the exact scattered rendering. Falls back to the element only if the private
 * dimensions cannot be read.
 */
function naturalSize(term: Terminal): { w: number; h: number } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const css = (term as any)?._core?._renderService?.dimensions?.css
    const cw = css?.cell?.width
    const ch = css?.cell?.height
    if (typeof cw === 'number' && cw > 0 && typeof ch === 'number' && ch > 0) {
      return { w: term.cols * cw, h: term.rows * ch }
    }
  } catch { /* fall through to the element measurement */ }
  const el = term.element
  if (el && el.offsetWidth > 0 && el.offsetHeight > 0) return { w: el.offsetWidth, h: el.offsetHeight }
  return null
}

export default function SessionTerminal({ frame, theme, showCursor, zoom = 1, interactive = false, onInput }: Props) {
  // boxRef is the fixed viewport the parent sizes; scaleRef takes the SCALED footprint so the page
  // lays out correctly; hostRef holds the emulator at its natural cols×rows pixels and is the thing
  // the transform shrinks.
  const boxRef = useRef<HTMLDivElement | null>(null)
  const scaleRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const readyRef = useRef(false)
  const disposedRef = useRef(false)
  // The geometry last applied to the emulator; a resize runs only when it actually changes, so a
  // steady stream of same-size frames never re-triggers the viewport sync that can throw.
  const geomRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  // The latest frame + cursor intent, so the ready-gate can paint whatever is current once xterm
  // has measured itself, even if several frames arrived during that first animation frame.
  const pendingRef = useRef<{ frame: TerminalFrame | null; showCursor: boolean }>({ frame: null, showCursor: false })
  // The latest zoom, so `fit()` (called from the ResizeObserver and the paint callback, not only on
  // a zoom change) always uses the current multiplier.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // The write handler, read through a ref so the once-created `onData` listener always calls the
  // latest one without re-subscribing (and never captures a stale closure).
  const onInputRef = useRef<Props['onInput']>(onInput)
  onInputRef.current = onInput

  /**
   * Fit the natural cols×rows grid into the box by scaling the PIXELS — never by resizing the
   * buffer, so the column count (and therefore the line breaks) never change.
   *
   * The base is fit-to-WIDTH: at zoom 1 every column is shown — a 252-column pane is drawn smaller
   * so it fits — but ONLY DOWN TO `MIN_SCALE`. Below that the card was shrinking a pane's own
   * captured width into illegibility by DEFAULT, with nothing to blame it on: a 157-column capture
   * (an ordinary width — this is not a wide-pane edge case) in a ~900px card measured a real 11px
   * row height at "100%", and the same capture in a narrower card falls well under that. The zoom
   * control could not fix it either, because "100%" there means "no extra zoom on top of the
   * auto-shrink" — it reads the multiplier, not the rendered size, so the control looked fine while
   * the text was not. Past `MIN_SCALE` the box SCROLLS horizontally instead of continuing to shrink
   * (it already supports that — `overflow: auto` on both axes below) — the same trade this module
   * already makes vertically for a tall capture (see `paint`'s `bufRows`). It is never enlarged past
   * 1:1. The user's zoom still multiplies the base; above what the box holds, the box scrolls. At
   * every scale the bytes on screen are exactly what `capture-pane` drew.
   */
  function fit() {
    const box = boxRef.current
    const host = hostRef.current
    const scale = scaleRef.current
    const term = termRef.current
    if (!box || !host || !scale || !term?.element) return
    const nat = naturalSize(term)
    if (!nat) return
    const { w: natW, h: natH } = nat
    // Pin the host to the emulator's true size so `.xterm` cannot collapse and the transform scales
    // the whole grid rather than an overflowing sliver.
    host.style.width = `${natW}px`
    host.style.height = `${natH}px`
    const availW = box.clientWidth
    if (!availW) return
    const base = Math.max(MIN_SCALE, Math.min(1, availW / natW))
    const s = base * zoomRef.current
    host.style.transform = `scale(${s})`
    host.style.transformOrigin = 'top left'
    scale.style.width = `${Math.ceil(natW * s)}px`
    scale.style.height = `${Math.ceil(natH * s)}px`
  }

  function paint() {
    const term = termRef.current
    const box = boxRef.current
    const { frame: f, showCursor: cur } = pendingRef.current
    if (!term || disposedRef.current || !readyRef.current || !f) return

    // SCROLL model. A capture carries up to `TERMINAL_VIEW_LINES` (200) lines of scrollback+screen,
    // routinely MORE than one pane-height. The emulator is therefore sized to hold EVERY shipped
    // line at once (`bufRows`), never just the visible screen: the extra lines used to fall into
    // xterm's own scrollback, which — with a full snapshot `reset()`+`write()` every frame — was
    // wiped and snapped back to the bottom twice a second, so scrolling up never reached the
    // conversation. With the whole capture on one grid, the fixed-height BOX (`overflow:auto`)
    // scrolls through all of it and its scroll position survives every repaint. Columns are still
    // EXACTLY `f.cols`, so nothing reflows — the fidelity fix is untouched. What is NOT in this 200
    // is disclosed by the status line's `truncated`; that ceiling is the server's, stated, not hidden.
    const bufRows = Math.max(f.rows, f.lines)

    // Stick-to-bottom: remember whether the reader was already at the live edge BEFORE the repaint,
    // so a new frame follows the tail for someone watching live, but never yanks a reader who has
    // scrolled up to read history. A small threshold absorbs sub-pixel rounding from the scale.
    const wasAtBottom = !box || (box.scrollTop + box.clientHeight >= box.scrollHeight - 4)

    // EXACTLY the pane's column count — the one width at which its lines do not reflow — with the row
    // count grown to the whole capture. Only when it CHANGED and the renderer has measured, so a
    // resize never schedules a viewport sync it is not ready for (the async `dimensions` throw). If
    // it is not ready this frame, paint at the current size; the next frame, or the ready-gate, catches up.
    if (f.cols > 0 && bufRows > 0 && (f.cols !== geomRef.current.cols || bufRows !== geomRef.current.rows) && dimensionsReady(term)) {
      try {
        term.resize(f.cols, bufRows)
        geomRef.current = { cols: f.cols, rows: bufRows }
      } catch {
        /* geometry can momentarily disagree with the DOM; the next frame corrects it */
      }
    }

    term.reset()
    term.write(f.content, () => {
      // The write callback fires asynchronously; the terminal may have been disposed since (the
      // accordion collapsed, the id changed). Writing to a disposed terminal throws, so bail.
      if (disposedRef.current || termRef.current !== term) return
      // After the content is laid out, place (or hide) the block cursor. The frame's cursor is
      // relative to the VISIBLE screen (the last `f.rows`), so on a taller buffer it is offset down
      // by the scrollback that precedes the live screen — otherwise the cursor lands in the history.
      if (cur && f.cursor) {
        const cursorRow = f.cursor.y + Math.max(0, f.lines - f.rows)
        term.write(`\x1b[?25h\x1b[${cursorRow + 1};${f.cursor.x + 1}H`)
      } else {
        term.write('\x1b[?25l')
      }
      // Re-fit AFTER the write settles — the grid's natural size is only final once the new geometry
      // has rendered — then re-pin to the live edge if that is where the reader was.
      fit()
      if (wasAtBottom && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
    })
  }

  // Create the emulator once.
  //
  // `open()` is deferred to a `requestAnimationFrame`, and the terminal is not even constructed until
  // it fires. Under React StrictMode (dev) an effect is mounted, unmounted and re-mounted in the same
  // tick; opening synchronously meant the FIRST terminal was disposed a moment after `open()`
  // scheduled xterm's own viewport sync, and that scheduled callback then read `dimensions` off a
  // torn-down render service — the uncatchable async `dimensions` throw, once per mount. Deferring
  // open past the rAF means the throwaway StrictMode mount is cancelled BEFORE anything is opened, so
  // nothing is ever scheduled against a terminal that is about to die.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    disposedRef.current = false

    let fallback: ReturnType<typeof setInterval> | null = null
    let ro: ResizeObserver | null = null
    let disposeRender: { dispose: () => void } | null = null
    let disposeData: { dispose: () => void } | null = null
    const stopFallback = () => { if (fallback) { clearInterval(fallback); fallback = null } }

    // Gate the first paint on the renderer having actually MEASURED its cells — not merely on a
    // render event firing, since an early render can precede the measurement and a resize then throws
    // asynchronously. `onRender` retries this on every frame until the measurement lands; a timed
    // fallback re-checks in case it never fires while the box is briefly hidden, and stops itself
    // once ready so it is not a forever-timer.
    const markReady = () => {
      if (readyRef.current || disposedRef.current) return
      const term = termRef.current
      if (!term || !dimensionsReady(term)) return
      readyRef.current = true
      stopFallback()
      paint()
    }
    // Every render can change the emulator's natural size — a `resize()` to a new column count only
    // reflows the DOM on xterm's OWN next render, AFTER the paint that requested it. So the fit runs
    // on `onRender` (once ready), not merely in the write callback: otherwise a 240-column pane is
    // measured at its OLD width and left unscaled, overflowing the box. That is the exact "wrong
    // width" the scattered rendering came from.
    const onRender = () => { markReady(); if (readyRef.current) fit() }

    const raf = requestAnimationFrame(() => {
      if (disposedRef.current) return
      const term = new Terminal({
        fontFamily: FONT_FAMILY,
        fontSize: FONT_SIZE,
        // Phase 2b — stdin is gated by `interactive`. Read-only rows (history, or a page with no
        // write channel) keep it OFF and behave exactly as Phase 1. When on, keystrokes reach
        // `onData` below; NOTHING is echoed here — the character comes back over the read channel.
        disableStdin: !interactive,
        cursorBlink: false,
        cursorStyle: 'block',
        scrollback: 5000,
        // The channel joins the pane's rows with a BARE LF (`lines.join('\n')`, no CR). Without EOL
        // conversion xterm reads `\n` as line-feed only — down a row, SAME column — so every row
        // after a short one starts where the previous row's text ended, splitting words across
        // arbitrary columns (a token comes out `GI…THUB_TOKEN`). `convertEol` maps `\n` to CRLF so
        // each row starts at column 0, which is what makes the render byte-faithful to the frame.
        convertEol: true,
        theme: xtermTheme(theme),
      })
      termRef.current = term
      disposeRender = term.onRender(onRender)
      // One input listener for the emulator's life; it forwards to the LATEST handler through the ref.
      // xterm only fires `onData` while stdin is enabled, so a read-only terminal delivers nothing.
      disposeData = term.onData((d: string) => onInputRef.current?.(d))
      term.open(host)
      fallback = setInterval(markReady, 60)

      // Re-fit whenever the BOX changes width (accordion open, window resize) OR the emulator's own
      // natural size changes (a resize to a new column count). `hostRef` wraps the emulator and is
      // transformed, but `transform` does not affect its reported content size, so observing it
      // catches every geometry change without feeding back on itself.
      ro = new ResizeObserver(() => { if (!disposedRef.current) fit() })
      if (boxRef.current) ro.observe(boxRef.current)
      if (hostRef.current) ro.observe(hostRef.current)
    })

    return () => {
      // Mark disposed FIRST, so a pending onRender / ResizeObserver callback becomes a no-op rather
      // than touching a terminal that is being torn down.
      disposedRef.current = true
      cancelAnimationFrame(raf)
      stopFallback()
      ro?.disconnect()
      disposeRender?.dispose()
      disposeData?.dispose()
      readyRef.current = false
      geomRef.current = { cols: 0, rows: 0 }
      if (termRef.current) { termRef.current.dispose(); termRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the palette in step with the dashboard theme. Updating `options.theme` recolours future
  // output but does not repaint what is already on screen, so a theme flip would leave the current
  // frame blank until the next one arrived — re-paint it now so the switch is instant.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = xtermTheme(theme)
    paint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // Paint each frame as a full snapshot (held until the ready-gate opens on first mount).
  useEffect(() => {
    pendingRef.current = { frame, showCursor }
    paint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, showCursor])

  // Re-fit when the zoom changes — only the scale moves, never the buffer, so nothing reflows.
  useEffect(() => {
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])

  // Arming/disarming flips stdin on the already-created emulator (it is created once). When it turns
  // interactive, focus it so the very first keystroke lands without a second click. Guarded so a
  // version bump that renames the option degrades to "no input" rather than throwing.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try { term.options.disableStdin = !interactive } catch { /* option gone — stays read-only */ }
    if (interactive) { try { term.focus() } catch { /* not ready yet; a click will focus it */ } }
  }, [interactive])

  return (
    <div
      ref={boxRef}
      // The box the parent sizes. At the default zoom the grid is fit to the box width, so it does
      // not scroll; zoomed in past the box it scrolls INSIDE here rather than pushing the page
      // sideways (the repo's responsive rule). The buffer is untouched, so scrolling never reflows.
      style={{ width: '100%', height: '100%', overflow: 'auto' }}
    >
      <div ref={scaleRef}>
        <div ref={hostRef} />
      </div>
    </div>
  )
}
