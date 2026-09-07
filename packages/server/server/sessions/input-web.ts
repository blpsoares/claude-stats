/**
 * input-web.ts — the WEB dashboard's WRITE channel onto one session's pane, over a WebSocket.
 *
 * The write-side sibling of `terminal-web.ts` (the read SSE stream). Same two-layer shape: the
 * ORDER guarantee and the per-message confirmation are the pure `input-channel.ts`; the contract is
 * the pure `input-protocol.ts`; this file is only the singleton wiring and the socket plumbing.
 *
 * It keeps the same ONE rule the read channel keeps — SCOPE. A socket is opened only for a session
 * THIS MACHINE MANAGES (its own registry), so the write power never reaches past the fleet the
 * dashboard already lists. Everything harder is upstream of it: `index.ts` refuses the upgrade unless
 * `localShell` is granted (capability-guard) and the Origin is same-origin (CSWSH), and 404s it on a
 * central. A captured terminal is shell access with extra steps; typing into one is the shell itself,
 * so it rides the very same gates, and no lower ones.
 *
 * The backend is resolved LAZILY via a dynamic import, exactly as `terminal-web.ts` reaches it
 * dynamically: it keeps this module's own static graph light (registry + the two pure input modules),
 * so `index.ts` can name these handlers without pulling the session-view/Ink graph into the server
 * that never opens this page.
 */

import { readRegistry } from './registry'
import { nudgeTerminal } from './terminal-web'
import { createInputChannel, type InputChannel } from './input-channel'
import { encodeAck } from './input-protocol'
import type { SessionBackend } from './types'

/**
 * A ceiling on concurrent write sockets for the whole process — each holds a socket and a serial
 * queue, so an unbounded count is a free way to exhaust the server (OWASP API4), the same reason the
 * read stream caps at `MAX_TERMINAL_STREAMS`.
 */
export const MAX_INPUT_SOCKETS = 100

/** The per-connection state carried on `ws.data`. The channel is built on `open`. */
export interface FleetInputState {
  readonly id: string
  channel: InputChannel | null
}

/** The shape this module needs from a socket — structural, so `index.ts` owns the full `WSData`. */
interface InputSocket {
  data: { fleetInput?: FleetInputState }
  send(data: string): unknown
}

let backendPromise: Promise<SessionBackend> | null = null
function getBackend(): Promise<SessionBackend> {
  // `./index` reaches the session-view graph; loading it only here (never at module top) is what
  // keeps a static import of this file cheap.
  if (!backendPromise) backendPromise = import('./index').then(m => m.resolveBackend())
  return backendPromise
}

let openSockets = 0

/** Build the state stamped onto `ws.data` at upgrade time; the channel is created on `open`. */
export function createInputState(id: string): FleetInputState {
  return { id, channel: null }
}

/** Scope check for the route: a session outside this machine's fleet is a clean 404, never an upgrade. */
export async function inputSessionExists(id: string): Promise<boolean> {
  return (await readRegistry()).some(m => m.id === id)
}

/** True when the process is already at its write-socket ceiling — the route answers 503. */
export function inputAtCapacity(): boolean {
  return openSockets >= MAX_INPUT_SOCKETS
}

/** For tests / diagnostics: how many write sockets are open right now. */
export function inputSocketCount(): number {
  return openSockets
}

/**
 * On open: build the serial channel bound to this session. The channel's sends resolve the backend
 * lazily and go to `sendTextRaw` (literal, NO Enter) / `sendKey` (named), and each ack is written
 * straight back on this socket. There is no "ready" frame and no local echo: the WS open event is the
 * client's go-ahead, and a character appears only when the SESSION draws it (read back over SSE), so
 * the UI can never paint a keystroke that did not land.
 *
 * A delivered keystroke NUDGES the read channel. There is no local echo by design, so the character
 * appears on the next capture — and the capture cadence is tuned for WATCHING a session (500ms),
 * which is nothing when you are reading one and an eternity when you are typing into it. `nudge`
 * captures immediately instead of at the next tick; it is a no-op for a session nobody is watching,
 * so it costs exactly the surfaces that would see the difference.
 */
export function openInputSocket(ws: InputSocket): void {
  const state = ws.data.fleetInput
  if (!state) return
  openSockets++
  const { id } = state
  state.channel = createInputChannel({
    sendText: async text => {
      const ok = await (await getBackend()).sendTextRaw(id, text)
      if (ok) nudgeTerminal(id)
      return ok
    },
    sendKey: async key => {
      const ok = await (await getBackend()).sendKey(id, key)
      if (ok) nudgeTerminal(id)
      return ok
    },
    emit: ack => { try { ws.send(encodeAck(ack)) } catch { /* socket already closed */ } },
  })
}

/** On message: hand the raw bytes to the channel, which parses, orders, sends and acks. */
export function onInputMessage(ws: InputSocket, raw: string | Buffer): void {
  const state = ws.data.fleetInput
  if (!state?.channel) return
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  state.channel.submit(text)
}

/** On close: release the channel and the capacity slot. Idempotent — a double close cannot go negative. */
export function closeInputSocket(ws: InputSocket): void {
  const state = ws.data.fleetInput
  if (!state || !state.channel) return
  state.channel = null
  openSockets = Math.max(0, openSockets - 1)
}
