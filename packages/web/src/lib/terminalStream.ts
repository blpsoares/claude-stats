/**
 * terminalStream.ts — the browser's half of the live terminal read channel.
 *
 * The server contract is `docs/terminal-channel.md` (`GET /api/fleet/stream?id=<sessionId>`, SSE,
 * Phase 1 read-only). This module owns the PURE half of consuming it: parsing the `open`/`frame`/
 * `end` events, the reducer that turns a stream of events into a view-model, and the HONESTY line
 * that says — in words — whether what you are looking at is the live screen, a finished session, or
 * a session that is gone. A frozen terminal that looks alive is the same kind of lie as a false
 * `waiting`, so the difference between those three is drawn from the channel's own fields
 * (`alive`, `truncated`, `lines`, the `end` reason), never guessed from a still screen.
 *
 * The emulator wiring (xterm) and the EventSource live in `useTerminalStream.ts` / `SessionTerminal`.
 * They are kept out of here so this — the part that decides what the user is told — stays pure and
 * tested.
 */

import type { FleetRow } from './fleet'

export interface TerminalOpen {
  id: string
  viewLines: number
  historyLimit: number
}

export interface TerminalCursor {
  x: number
  y: number
}

export interface TerminalFrame {
  /** Monotonic within one stream; advances only when the screen changed. */
  seq: number
  /** The rendered pane, `\n`-joined, WITH SGR escape sequences intact. Feed to the emulator. */
  content: string
  cols: number
  rows: number
  /** Block-cursor position, or null once the pane is dead — never draw a cursor on a dead frame. */
  cursor: TerminalCursor | null
  /** false once the hosted command has exited. The last frame stays readable, shown as finished. */
  alive: boolean
  /** How many lines `content` carries — the honest "you are seeing N lines" number. */
  lines: number
  /** The scrollback ceiling tmux keeps. */
  historyLimit: number
  /** true when there is more scrollback above than this frame carries. */
  truncated: boolean
}

/** Why the stream closed. Only a session GONE from tmux ends the stream; a mere exit does not. */
export type TerminalEndReason = 'gone' | 'not-found' | 'error'

const END_REASONS: ReadonlySet<string> = new Set<TerminalEndReason>(['gone', 'not-found', 'error'])

export type TerminalPhase =
  /** nothing selected to watch */
  | 'idle'
  /** stream (re)opening; no frame drawn yet */
  | 'connecting'
  /** a live frame is on screen (the hosted command is running) */
  | 'streaming'
  /** the command exited; the last screen it drew stays readable (stream still open) */
  | 'finished'
  /** the session left tmux; the last frame is the last thing it ever drew */
  | 'ended'
  /** the channel opened (or was asked to) but no frame ever arrived — the connection did not
   *  actually establish anything. Reachable ONLY from `connecting` (never once a frame exists), so
   *  a live screen is never blanked by a transient blip. This is the honest end of the "connecting
   *  forever" state: a signal that claimed to be progressing without establishing anything. */
  | 'stalled'

export interface TerminalState {
  phase: TerminalPhase
  open: TerminalOpen | null
  frame: TerminalFrame | null
  endReason: TerminalEndReason | null
}

export const INITIAL_TERMINAL_STATE: TerminalState = {
  phase: 'idle',
  open: null,
  frame: null,
  endReason: null,
}

export type TerminalAction =
  | { type: 'reset' }
  | { type: 'connecting' }
  | { type: 'open'; open: TerminalOpen }
  | { type: 'frame'; frame: TerminalFrame }
  | { type: 'end'; reason: TerminalEndReason }
  /** The connection took too long or errored while no frame had arrived yet. The hook raises it on a
   *  connecting-timeout or an EventSource error; the reducer only honours it before the first frame. */
  | { type: 'stall' }

export function terminalReducer(state: TerminalState, action: TerminalAction): TerminalState {
  switch (action.type) {
    case 'reset':
      return INITIAL_TERMINAL_STATE
    case 'connecting':
      // A fresh connection — for a NEW id, or a reconnect. Drop the previous session's frame
      // entirely: carrying it over for even one render would leak one session's screen onto the
      // next, which is the one thing this feature may never do.
      return { phase: 'connecting', open: null, frame: null, endReason: null }
    case 'open':
      return { ...state, open: action.open, phase: state.frame ? state.phase : 'connecting' }
    case 'frame':
      return {
        ...state,
        frame: action.frame,
        endReason: null,
        phase: action.frame.alive ? 'streaming' : 'finished',
      }
    case 'end':
      // Keep the last frame — the finished screen is the whole point of showing it. Only the phase
      // and the reason change, so the terminal is signalled as gone, not frozen in silence.
      return { ...state, phase: 'ended', endReason: action.reason }
    case 'stall':
      // The honesty stop for "connecting forever": once we have waited long enough (or the socket
      // errored) with NOTHING drawn, say so instead of spinning. But a stall may NEVER blank a screen
      // that already has a frame — a live/finished terminal that drops a packet must keep showing its
      // last screen and let EventSource reconnect, exactly as a native error does. So a stall is only
      // honoured while still frame-less; otherwise it is ignored.
      return state.frame ? state : { ...state, phase: 'stalled', endReason: null }
    default:
      return state
  }
}

// ---- parsers -------------------------------------------------------------------------------------

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function parseOpen(raw: string): TerminalOpen | null {
  const v = parseJson(raw)
  if (!isRecord(v) || typeof v.id !== 'string') return null
  return {
    id: v.id,
    viewLines: typeof v.viewLines === 'number' ? v.viewLines : 0,
    historyLimit: typeof v.historyLimit === 'number' ? v.historyLimit : 0,
  }
}

export function parseFrame(raw: string): TerminalFrame | null {
  const v = parseJson(raw)
  if (!isRecord(v) || typeof v.content !== 'string') return null
  let cursor: TerminalCursor | null = null
  if (isRecord(v.cursor) && typeof v.cursor.x === 'number' && typeof v.cursor.y === 'number') {
    cursor = { x: v.cursor.x, y: v.cursor.y }
  }
  const num = (x: unknown, fallback = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback)
  return {
    seq: num(v.seq),
    content: v.content,
    cols: num(v.cols),
    rows: num(v.rows),
    cursor,
    alive: v.alive !== false, // default to live unless explicitly false
    lines: num(v.lines),
    historyLimit: num(v.historyLimit),
    truncated: v.truncated === true,
  }
}

export function parseEnd(raw: string): TerminalEndReason | null {
  const v = parseJson(raw)
  if (!isRecord(v) || typeof v.reason !== 'string' || !END_REASONS.has(v.reason)) return null
  return v.reason as TerminalEndReason
}

// ---- the honesty line ----------------------------------------------------------------------------

export type TerminalTone = 'idle' | 'connecting' | 'live' | 'finished' | 'ended' | 'stalled'

export interface TerminalStatus {
  tone: TerminalTone
  /** Short label for the pill beside the terminal. */
  label: string
  /** One sentence saying what you are actually looking at. */
  detail: string
  /** True only for a live frame with a real cursor — never on a dead or gone screen. */
  showCursor: boolean
  /** True when there is more scrollback than the frame carries; the UI discloses it. */
  truncated: boolean
}

export function terminalStatus(state: TerminalState, lang: 'pt' | 'en'): TerminalStatus {
  const pt = lang === 'pt'
  const f = state.frame
  const lines = f?.lines ?? 0
  const truncated = Boolean(f?.truncated)

  if (state.phase === 'idle') {
    return {
      tone: 'idle',
      label: pt ? 'Nenhuma sessão' : 'No session',
      detail: pt ? 'Escolha uma sessão viva para ver o terminal dela.' : 'Pick a live session to watch its terminal.',
      showCursor: false,
      truncated: false,
    }
  }

  if (state.phase === 'connecting') {
    return {
      tone: 'connecting',
      label: pt ? 'Conectando' : 'Connecting',
      detail: pt ? 'Abrindo o canal do terminal…' : 'Opening the terminal channel…',
      showCursor: false,
      truncated: false,
    }
  }

  if (state.phase === 'stalled') {
    // The honest failure. A "connecting" that never resolves is indistinguishable from death, so once
    // we have waited without a single frame we say what actually happened and what to do about it —
    // rather than spinning the pill forever. The reconnect verb the UI draws is named here.
    return {
      tone: 'stalled',
      label: pt ? 'Sem resposta' : 'No response',
      detail: pt
        ? 'O canal abriu, mas nenhum dado chegou. A sessão pode não estar produzindo saída, ou a conexão falhou. Toque em reconectar para tentar de novo.'
        : 'The channel opened but no data arrived. The session may not be producing output, or the connection failed. Tap reconnect to try again.',
      showCursor: false,
      truncated: false,
    }
  }

  // A disclosure appended to any live/finished detail: are we seeing everything, or the latest slice?
  const scope = truncated
    ? (pt
        ? `mostrando as últimas ${lines} linhas — há saída mais antiga acima que não cabe aqui`
        : `showing the last ${lines} lines — there is older output above that is not shown`)
    : (pt
        ? `mostrando ${lines} linha${lines === 1 ? '' : 's'}`
        : `showing ${lines} line${lines === 1 ? '' : 's'}`)

  if (state.phase === 'streaming') {
    return {
      tone: 'live',
      label: pt ? 'Ao vivo' : 'Live',
      detail: pt ? `A tela atual do agente — ${scope}.` : `The agent's current screen — ${scope}.`,
      showCursor: Boolean(f?.cursor),
      truncated,
    }
  }

  if (state.phase === 'finished') {
    return {
      tone: 'finished',
      label: pt ? 'Encerrada' : 'Finished',
      detail: pt
        ? `O comando terminou; esta é a última tela que ele desenhou — ${scope}.`
        : `The command exited; this is the last screen it drew — ${scope}.`,
      showCursor: false,
      truncated,
    }
  }

  // ended
  const reason = state.endReason
  // "the screen below is the last thing it drew" is only true when there IS a last frame; a session
  // that was already gone when we opened the stream left nothing to show, so say that instead.
  const goneDetail = state.frame
    ? (pt
        ? 'A sessão saiu do tmux; a tela abaixo é a última coisa que ela desenhou.'
        : 'The session left tmux; the screen below is the last thing it drew.')
    : (pt
        ? 'A sessão já não estava mais no tmux; não há tela para mostrar.'
        : 'The session was already gone from tmux; there is no screen to show.')
  const detail =
    reason === 'not-found'
      ? (pt
          ? 'Esta sessão deixou de ser gerenciada por esta máquina.'
          : 'This session is no longer managed by this machine.')
      : reason === 'error'
        ? (pt ? 'O canal do terminal não pôde ser lido.' : 'The terminal channel could not be read.')
        : goneDetail
  return {
    tone: 'ended',
    label: pt ? 'Sessão encerrada' : 'Session gone',
    detail,
    showCursor: false,
    truncated,
  }
}

// ---- which rows can be watched -------------------------------------------------------------------

/**
 * The fleet states that unambiguously have a LIVE tmux pane to read: an assistant that is running
 * or waiting on a person. Everything else has nothing worth offering to watch — `closed` (read from
 * the store, never had a pane) and `lost` (its tmux went away) would draw an immediate `end: gone`,
 * and `exited` is a finished conversation whose pane is, on a real machine, almost always already
 * gone from tmux; including it buried the live sessions under dozens of dead history rows. A session
 * that exits WHILE being watched still reports its finished screen honestly through the open stream
 * — this filter only governs what the selector OFFERS, not what a live stream may show.
 */
const WATCHABLE_STATES: ReadonlySet<FleetRow['state']> = new Set<FleetRow['state']>([
  'working',
  'waiting',
  'waiting-approval',
])

export function watchableFleetRows(rows: readonly FleetRow[]): FleetRow[] {
  return rows.filter(r => WATCHABLE_STATES.has(r.state))
}

// ---- emulator theme ------------------------------------------------------------------------------

/** The 16-colour ANSI palette + surface colours xterm renders with, per dashboard theme. */
export interface XtermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * Two palettes tuned to the dashboard's own dark/light surfaces. The ANSI 16 are a standard,
 * legible set (close to the "one dark"/"one light" families) so a coding assistant's coloured
 * output reads the same as it does in a real terminal, in both themes.
 */
export function xtermTheme(theme: 'dark' | 'light'): XtermTheme {
  if (theme === 'light') {
    return {
      background: '#ffffff',
      foreground: '#1c1c1c',
      cursor: '#1c1c1c',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(0,0,0,0.14)',
      black: '#3a3a3a',
      red: '#c4271c',
      green: '#187a2f',
      yellow: '#8a6d00',
      blue: '#1a56c4',
      magenta: '#9a2ab5',
      cyan: '#0a7d8c',
      white: '#d0d0d0',
      brightBlack: '#7a7a7a',
      brightRed: '#e0342a',
      brightGreen: '#20a03e',
      brightYellow: '#b08a00',
      brightBlue: '#2f6fe0',
      brightMagenta: '#b83fd0',
      brightCyan: '#159bab',
      brightWhite: '#1c1c1c',
    }
  }
  return {
    background: '#0e1116',
    foreground: '#d7dae0',
    cursor: '#e8690b',
    cursorAccent: '#0e1116',
    selectionBackground: 'rgba(255,255,255,0.20)',
    black: '#3b4048',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#ef7078',
    brightGreen: '#a5d68a',
    brightYellow: '#f0ca8e',
    brightBlue: '#74bbf3',
    brightMagenta: '#d19ae6',
    brightCyan: '#6cc7d1',
    brightWhite: '#ffffff',
  }
}
