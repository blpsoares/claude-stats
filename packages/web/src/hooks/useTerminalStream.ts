/**
 * useTerminalStream — the EventSource wiring for the live terminal read channel.
 *
 * The pure decisions (what each event means, what the user is told) live in `lib/terminalStream.ts`.
 * This hook is the thin, impure glue: open `GET /api/fleet/stream?id=<id>` as SSE, funnel its named
 * `open`/`frame`/`end` events through the reducer, and tear the connection down when the id changes
 * or the component unmounts.
 *
 * Two things it is careful about:
 *  - **No leak between sessions.** When `id` changes it dispatches `connecting` FIRST (which drops
 *    the previous frame) before opening the new stream, so one session's screen can never be shown
 *    under another session's name for even a single render.
 *  - **`end` closes the socket.** EventSource reconnects on its own after any drop; that is right for
 *    a transient network blip, but an `end` event is the channel saying the session is GONE, so we
 *    close the socket to stop it silently reopening a stream the server has finished.
 *  - **A connection that never delivers is called out, not spun forever.** If no frame arrives within
 *    `STALL_MS` — the stream opened but nothing came, or the socket is queued behind the browser's
 *    per-origin connection limit and never actually connects — we dispatch `stall`, and the status
 *    line switches from "Connecting…" to an honest "No response" with a reconnect verb. An
 *    EventSource `error` while still frame-less does the same. Neither ever blanks a screen that
 *    already has a frame: there the reducer ignores the stall and EventSource's own reconnect takes
 *    over, so a live terminal that drops a packet keeps its last screen (unchanged behaviour).
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  INITIAL_TERMINAL_STATE,
  terminalReducer,
  parseOpen,
  parseFrame,
  parseEnd,
  type TerminalState,
} from '../lib/terminalStream'

/** How long a fresh connection may sit without a single frame before it is called stalled. Long
 *  enough that a slow-but-healthy first capture is not falsely failed, short enough that a dead
 *  channel does not read as eternal progress. */
export const STALL_MS = 10_000

export interface TerminalStream {
  state: TerminalState
  /** Re-open the channel from scratch — the escape hatch a stalled terminal offers the user. */
  reconnect: () => void
}

export function useTerminalStream(id: string | null): TerminalStream {
  const [state, dispatch] = useReducer(terminalReducer, INITIAL_TERMINAL_STATE)
  // Bumped by reconnect() to force the effect to tear down and re-open, even for the same id.
  const [nonce, setNonce] = useState(0)
  const reconnect = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    if (!id) {
      dispatch({ type: 'reset' })
      return
    }

    // Fresh id → clear any previous session's frame before a single byte of the new one arrives.
    dispatch({ type: 'connecting' })

    const es = new EventSource(`/api/fleet/stream?id=${encodeURIComponent(id)}`)

    // Has this connection drawn anything yet? While false, a timeout or an error means the channel
    // never established — worth saying so. Once true, a drop is a transient blip: keep the screen and
    // let EventSource reconnect (the reducer ignores a stall once a frame exists, this just avoids
    // the needless dispatch and cancels the timer).
    let framed = false
    let stallTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      stallTimer = null
      dispatch({ type: 'stall' })
    }, STALL_MS)
    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null } }

    // The server sends a NAMED `open` event, which collides with EventSource's own native
    // connection-open event. The native one carries no `data`; the server's does — so branch on it.
    es.addEventListener('open', (e: MessageEvent) => {
      if (!e.data) return
      const open = parseOpen(e.data)
      if (open) dispatch({ type: 'open', open })
    })

    es.addEventListener('frame', (e: MessageEvent) => {
      const frame = parseFrame(e.data)
      if (frame) { framed = true; clearStall(); dispatch({ type: 'frame', frame }) }
    })

    es.addEventListener('end', (e: MessageEvent) => {
      clearStall()
      const reason = parseEnd(e.data) ?? 'error'
      dispatch({ type: 'end', reason })
      // GONE means gone — do not let EventSource reopen a stream the server has closed for good.
      es.close()
    })

    // A native error is EventSource failing/closing the socket. If it happens while we have never
    // drawn a frame, the channel never established — surface it as stalled (honest) rather than
    // leaving "Connecting…" up while the browser silently retries. AFTER a frame we do nothing: the
    // last frame stays on show and EventSource's own auto-reconnect handles the blip.
    es.onerror = () => { if (!framed) { clearStall(); dispatch({ type: 'stall' }) } }

    return () => { clearStall(); es.close() }
  }, [id, nonce])

  return { state, reconnect }
}
