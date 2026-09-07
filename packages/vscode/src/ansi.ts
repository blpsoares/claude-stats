/**
 * ansi.ts — PURE. One terminal frame, rendered as HTML, with the cursor where the pane says it is.
 *
 * `GET /api/fleet/stream` sends the pane as `tmux capture-pane -e` produced it: a RENDERED grid
 * with SGR escape sequences intact. tmux has already resolved the spinners, the redraws and the
 * cursor moves into final glyphs, so what is left to do is colour and one cell — no cursor
 * arithmetic, no scrollback model, no alternate buffer. That is why this is 250 lines and not a
 * terminal emulator.
 *
 * The dashboard feeds the same frames to xterm.js. This does not, and the reason is the surface:
 * xterm is a 300 KB dependency that wants a fixed character grid and a fit addon, in a panel that
 * is routinely 300px wide and resized by dragging. What it must NOT cost is colour fidelity, so the
 * palette is imported from the dashboard's own `xtermTheme`: the same session reads the same in
 * both places.
 *
 * **The CURSOR is drawn here and not with CSS**, because it is a cell of the grid — the character
 * the pane's own `cursor` field points at — and CSS has no way to find that character. Without it a
 * person typing sees text appear with nothing marking where the next one goes, which is the whole
 * of "não aparece o _ que fica na frente do último caractere".
 *
 * **Everything is escaped.** The content is a coding assistant's terminal output — file contents,
 * diffs, error messages, whatever it was asked to print — so it is the least trustworthy string in
 * this extension. It is escaped once, on the way in, and nothing downstream un-escapes it.
 */

import { xtermTheme, type XtermTheme } from '../../web/src/lib/terminalStream'

/** Where the pane says the block cursor is. Columns and rows are 0-based, as the channel sends them. */
export interface CursorPos {
  x: number
  y: number
}

/** The eight ANSI colours, in code order (30-37 / 40-47), then their bright twins (90-97 / 100-107). */
const BASE: (keyof XtermTheme)[] = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
]
const BRIGHT: (keyof XtermTheme)[] = [
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

interface Pen {
  fg: string | null
  bg: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

const BLANK: Pen = {
  fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false,
}

export function escapeHtml(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The xterm 256-colour cube, as hex.
 *
 * 0-15 are the palette's own sixteen (so a 256-indexed red matches a `31` red), 16-231 the 6x6x6
 * cube, 232-255 the greyscale ramp. Computed rather than tabulated: a 256-entry literal is 256
 * chances to mistype one.
 */
function xterm256(index: number, theme: XtermTheme): string | null {
  if (index < 0 || index > 255) return null
  if (index < 8) return theme[BASE[index]!] as string
  if (index < 16) return theme[BRIGHT[index - 8]!] as string
  if (index < 232) {
    const n = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    return rgb(steps[Math.floor(n / 36) % 6]!, steps[Math.floor(n / 6) % 6]!, steps[n % 6]!)
  }
  const level = 8 + (index - 232) * 10
  return rgb(level, level, level)
}

function rgb(r: number, g: number, b: number): string {
  const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/**
 * Apply one SGR sequence's parameters to the pen.
 *
 * Extended colour (`38;5;n`, `38;2;r;g;b`) consumes the parameters that follow it, which is why
 * this is an index loop and not a `for…of`: reading them as independent codes turns a truecolour
 * foreground into three unrelated attributes, one of which is usually "bright background".
 */
function applySgr(pen: Pen, params: number[], theme: XtermTheme): Pen {
  let next = { ...pen }
  for (let i = 0; i < params.length; i++) {
    const code = params[i]!
    if (code === 0) { next = { ...BLANK }; continue }
    if (code === 1) { next.bold = true; continue }
    if (code === 2) { next.dim = true; continue }
    if (code === 3) { next.italic = true; continue }
    if (code === 4) { next.underline = true; continue }
    if (code === 7) { next.inverse = true; continue }
    if (code === 22) { next.bold = false; next.dim = false; continue }
    if (code === 23) { next.italic = false; continue }
    if (code === 24) { next.underline = false; continue }
    if (code === 27) { next.inverse = false; continue }
    if (code === 39) { next.fg = null; continue }
    if (code === 49) { next.bg = null; continue }
    if (code >= 30 && code <= 37) { next.fg = theme[BASE[code - 30]!] as string; continue }
    if (code >= 40 && code <= 47) { next.bg = theme[BASE[code - 40]!] as string; continue }
    if (code >= 90 && code <= 97) { next.fg = theme[BRIGHT[code - 90]!] as string; continue }
    if (code >= 100 && code <= 107) { next.bg = theme[BRIGHT[code - 100]!] as string; continue }
    if (code === 38 || code === 48) {
      const mode = params[i + 1]
      if (mode === 5) {
        const colour = xterm256(params[i + 2] ?? -1, theme)
        if (code === 38) next.fg = colour
        else next.bg = colour
        i += 2
      } else if (mode === 2) {
        const colour = rgb(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0)
        if (code === 38) next.fg = colour
        else next.bg = colour
        i += 4
      }
      continue
    }
    // Anything else (blink, strike, fonts, the rest of SGR) is ignored rather than guessed at.
  }
  return next
}

function penStyle(pen: Pen, theme: XtermTheme): string {
  // `inverse` is resolved HERE rather than left to CSS: selected rows, diff markers and a lot of
  // TUI chrome are drawn with it, and a viewer that ignored it would render a highlighted line as
  // ordinary text — the one thing on screen that was meant to stand out.
  const fg = pen.inverse ? (pen.bg ?? theme.background) : pen.fg
  const bg = pen.inverse ? (pen.fg ?? theme.foreground) : pen.bg
  const parts: string[] = []
  if (fg) parts.push(`color:${fg}`)
  if (bg) parts.push(`background:${bg}`)
  if (pen.bold) parts.push('font-weight:600')
  if (pen.dim) parts.push('opacity:.6')
  if (pen.italic) parts.push('font-style:italic')
  if (pen.underline) parts.push('text-decoration:underline')
  return parts.join(';')
}

/** Sticky, so each is tried AT the current index rather than searched for ahead of it. */
const SGR_AT = /\x1b\[([0-9;]*)m/y
const ESCAPE_AT = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_]|\[[0-9;?]*[ -/]*[@-~])/y
/** A sequence the frame ENDS in the middle of — tmux cuts a pane at a byte boundary. */
const DANGLING_AT = /\x1b\[?[0-9;?]*$/y

/**
 * One frame's `content` → HTML.
 *
 * Total: any string in, HTML out, no throw. An empty frame yields an empty string rather than a
 * stray element, so "no output yet" and "one blank line" stay distinguishable.
 *
 * `cursor` is drawn only when the caller passes one, and the caller passes one only for a LIVE
 * frame — the channel sends `cursor: null` on a dead pane, and a cursor blinking on a session that
 * exited is a screen claiming to be alive.
 */
export function ansiToHtml(
  content: string,
  theme: 'dark' | 'light',
  cursor?: CursorPos | null,
): string {
  const palette = xtermTheme(theme)
  let pen: Pen = { ...BLANK }
  let runPen: Pen = pen
  let run = ''
  let out = ''
  let line = 0
  let col = 0
  let cursorDrawn = false

  const flush = () => {
    if (!run) return
    const style = penStyle(runPen, palette)
    const text = escapeHtml(run)
    out += style ? `<span style="${style}">${text}</span>` : text
    run = ''
  }

  /**
   * The cursor sitting PAST the last character of its line — which is where it is whenever somebody
   * is typing at the end of a line, i.e. almost always. There is no cell to wrap, so one is drawn.
   */
  const cursorAtLineEnd = () => {
    if (!cursor || cursorDrawn || line !== cursor.y || col > cursor.x) return
    flush()
    out += cursorCell(' ', pen, palette)
    cursorDrawn = true
  }

  let i = 0
  while (i < content.length) {
    if (content[i] === '\x1b') {
      SGR_AT.lastIndex = i
      const sgr = SGR_AT.exec(content)
      if (sgr) {
        flush()
        const params = (sgr[1] ?? '')
          .split(';')
          .map(p => (p === '' ? 0 : Number(p)))
          .filter(n => Number.isFinite(n))
        pen = applySgr(pen, params.length > 0 ? params : [0], palette)
        runPen = pen
        i = SGR_AT.lastIndex
        continue
      }
      ESCAPE_AT.lastIndex = i
      const other = ESCAPE_AT.exec(content)
      if (other) { i = ESCAPE_AT.lastIndex; continue }
      DANGLING_AT.lastIndex = i
      if (DANGLING_AT.exec(content)) break
      i += 1
      continue
    }

    const ch = content[i]!
    if (ch === '\n') {
      cursorAtLineEnd()
      flush()
      out += '\n'
      line += 1
      col = 0
      i += 1
      continue
    }

    if (cursor && !cursorDrawn && line === cursor.y && col === cursor.x) {
      flush()
      out += cursorCell(ch, pen, palette)
      cursorDrawn = true
    } else {
      // A pen change starts a new run; otherwise the character joins the one being built.
      if (run && !samePen(pen, runPen)) flush()
      runPen = pen
      run += ch
    }
    col += 1
    i += 1
  }

  cursorAtLineEnd()
  flush()
  return out
}

/**
 * The cursor cell: the pane's colours, swapped.
 *
 * Inverting the pen rather than painting a fixed colour keeps it legible on any background the
 * assistant happens to be drawing — a hardcoded white block vanishes on a white selection bar.
 */
function cursorCell(ch: string, pen: Pen, theme: XtermTheme): string {
  // `dim` is DROPPED, and that is the whole reason this was invisible in practice. The cell under
  // the cursor is very often dim — a placeholder, a ghost completion, the inactive half of a prompt
  // — and inheriting it drew the block at 60% opacity exactly where somebody is looking for it. A
  // cursor is chrome, not content: it takes the cell's colours, inverted, and none of its emphasis.
  const style = penStyle({ ...pen, inverse: !pen.inverse, dim: false, italic: false }, theme)
  return `<span class="cursor"${style ? ` style="${style}"` : ''}>${escapeHtml(ch)}</span>`
}

function samePen(a: Pen, b: Pen): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim
    && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse
}
