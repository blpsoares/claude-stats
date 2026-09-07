/**
 * input.ts — the extension's half of the live terminal's WRITE channel.
 *
 * The server contract is `docs/terminal-interactive.md` (Phase 2b): a WebSocket at
 * `/api/fleet/input?id=`, one JSON message per keystroke, one ack per message, FIFO by construction
 * because it is ONE socket. This replaced an HTTP route of the same name that this extension shipped
 * against for a day — two write channels for one act is exactly the duplication this repo is built
 * against, and the socket is the better of the two: ordering is a property of the transport rather
 * than of a client-side queue, and every keystroke is ACKED, so "it did not land" is a fact the UI
 * can be told rather than a silence.
 *
 * The HOST opens it, not the webview: a webview's `localhost` is the editor client's, which under
 * Remote-SSH or WSL is not the machine the sessions run on.
 */

import type { KeyPress } from './protocol'

/**
 * The named keys the server accepts (`KEY_ALLOWLIST` in `input-protocol.ts`). Everything else a
 * keyboard produces travels as literal TEXT.
 *
 * This is the client's own copy, and the server validates membership regardless — the comment on the
 * server's set says so in as many words. Keeping one here is not the duplication the repo forbids:
 * without it the client would send names the server refuses, and the user would collect an ack
 * failure per unmapped key. A name that is in this list and not in the server's is refused cleanly
 * with `bad_key`; the reverse simply means this client cannot send that key yet.
 */
const KEY_NAMES: Readonly<Record<string, string>> = {
  Enter: 'Enter',
  Backspace: 'BSpace',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

/** `Ctrl-<letter>` for the control keys the server accepts. `C-c` above all. */
const CTRL_KEYS: ReadonlySet<string> = new Set(['c', 'd', 'a', 'e', 'u', 'w', 'k'])

/**
 * One key press → what to put on the wire, or `null` when this client cannot send it.
 *
 * `null` is a refusal to ASK, not a claim the key is unsendable: it keeps the user from collecting
 * an ack failure for a key nobody meant to press (a media key, a modifier on its own).
 */
export function wireFor(press: KeyPress): { kind: 'text'; data: string } | { kind: 'key'; name: string } | null {
  if (press.ctrl && press.alt) return null
  if (press.ctrl) {
    const letter = press.key.toLowerCase()
    return CTRL_KEYS.has(letter) ? { kind: 'key', name: `C-${letter}` } : null
  }
  if (press.alt) return null
  const named = KEY_NAMES[press.key]
  if (named) return { kind: 'key', name: named }
  // A single printable character is text. Anything longer with no name — `F5`, `Home`, a media key —
  // this client does not send.
  return press.key.length === 1 ? { kind: 'text', data: press.key } : null
}

export interface InputAck {
  seq: number | null
  ok: boolean
  reason?: string
}

type AckListener = (ack: InputAck) => void

interface Socket {
  ws: WebSocket
  /** The client's own monotonic counter, echoed in each ack. */
  seq: number
  /** Queued while the socket is still opening — a keystroke typed in that window is not dropped. */
  pending: string[]
  open: boolean
  listeners: Set<AckListener>
}

/**
 * One socket per session, opened on demand and kept while the panel is showing that session.
 *
 * Per session rather than per surface: the sidebar and a tab looking at the same session share it,
 * exactly as they share the read stream, and the server counts sockets against its own ceiling.
 */
export class InputSockets {
  private readonly sockets = new Map<string, Socket>()

  constructor(private readonly api: () => string) {}

  /** Send one keystroke. Opens the socket if this is the first. */
  send(id: string, press: KeyPress | { text: string }, onAck?: AckListener): void {
    const wire = 'text' in press ? { kind: 'text' as const, data: press.text } : wireFor(press)
    if (!wire) return
    const socket = this.socketFor(id)
    if (onAck) socket.listeners.add(onAck)
    const message = JSON.stringify({ seq: ++socket.seq, ...wire })
    if (socket.open) {
      try { socket.ws.send(message) } catch { /* closed under us; the retry is the user's next key */ }
    } else {
      socket.pending.push(message)
    }
  }

  /** Let go of a session's socket. */
  close(id: string): void {
    const socket = this.sockets.get(id)
    if (!socket) return
    this.sockets.delete(id)
    try { socket.ws.close() } catch { /* already gone */ }
  }

  dispose(): void {
    for (const id of [...this.sockets.keys()]) this.close(id)
  }

  private socketFor(id: string): Socket {
    const existing = this.sockets.get(id)
    if (existing) return existing

    const url = new URL(`${this.api()}/api/fleet/input`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('id', id)

    const ws = new WebSocket(url.toString())
    const socket: Socket = { ws, seq: 0, pending: [], open: false, listeners: new Set() }
    this.sockets.set(id, socket)

    ws.addEventListener('open', () => {
      socket.open = true
      // Whatever was typed while it was opening, in the order it was typed.
      for (const message of socket.pending.splice(0)) {
        try { ws.send(message) } catch { /* closed under us */ }
      }
    })
    ws.addEventListener('message', event => {
      const ack = parseAck(String(event.data))
      if (!ack) return
      for (const listener of socket.listeners) listener(ack)
    })
    // A closed socket is forgotten rather than retried on a timer: the next keystroke opens a fresh
    // one, which is the only moment anybody cares whether it is up.
    ws.addEventListener('close', () => { if (this.sockets.get(id) === socket) this.sockets.delete(id) })
    ws.addEventListener('error', () => { if (this.sockets.get(id) === socket) this.sockets.delete(id) })
    return socket
  }
}

export function parseAck(raw: string): InputAck | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value !== 'object' || value === null) return null
    if (typeof value.ok !== 'boolean') return null
    return {
      seq: typeof value.seq === 'number' ? value.seq : null,
      ok: value.ok,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    }
  } catch {
    return null
  }
}
