/**
 * useTerminalWrite — the WebSocket glue for the live terminal's DIRECT-TYPING write channel (Phase 2b).
 *
 * The pure decisions live beside it: `lib/terminalKeys.ts` (what a keystroke is + the allowlist +
 * the reason wording) and `lib/terminalChannel.ts` (the honesty accounting — consent, lifecycle,
 * verifiable per-key acks). This hook is the thin, impure half: open `WS /api/fleet/input?id=<id>`
 * when the session is armed, turn each `xterm.onData` chunk into one ordered message, and feed the
 * acks back through the reducer.
 *
 * Why the server contract fits with no client cleverness (see docs/terminal-write-channel.md):
 *  - ONE socket per session + the server processing it strictly sequentially is what guarantees order
 *    (A2). The client never reorders and never trusts a timestamp — it just sends in `onData` order
 *    over the one connection.
 *  - The `seq` is the CLIENT's own monotonic counter, held in a ref so a 40-key burst assigns 40
 *    distinct ids synchronously (reading reducer state between events would collide). The server
 *    echoes it in the ack, which makes the pairing VERIFIABLE, not inferred.
 *  - NO local echo: nothing is written to xterm here. A key appears only when the SESSION draws it,
 *    read back over the SSE read channel — so a key that did not land is never on screen (A6, by
 *    construction). This hook only accounts for delivery so a DROP is surfaced, never painted.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { inputReasonText, splitInput } from '../lib/terminalKeys'
import {
  INITIAL_CHANNEL,
  channelReducer,
  type ChannelState,
} from '../lib/terminalChannel'

export interface TerminalWrite {
  /** Feed one raw `onData` chunk. Classifies, then sends it as text or a named key — or drops it
   *  (blocked by the allowlist, or the channel is not open). Never echoes locally. */
  send: (data: string) => void
  /** The honesty state — phase + pending + undelivered — for the consumer to render a status. */
  state: ChannelState
  /** True once the socket is open and consent stands: typing will actually be delivered. */
  ready: boolean
  /** A localized sentence when something is wrong (a failed ack, a drop), else null. */
  reason: string | null
}

function wsUrl(id: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/fleet/input?id=${encodeURIComponent(id)}`
}

/**
 * @param id       the fleet row id (same id `/api/fleet/stream` and `/api/fleet/act` use)
 * @param enabled  consent stands AND the row is typable — the ONLY thing that opens the socket
 * @param lang     for the localized failure reason
 */
export function useTerminalWrite(id: string, enabled: boolean, lang: 'pt' | 'en'): TerminalWrite {
  const [state, dispatch] = useReducer(channelReducer, INITIAL_CHANNEL)
  const wsRef = useRef<WebSocket | null>(null)
  const seqRef = useRef(1)
  // Synchronous mirror of "socket open", so `send` (called from xterm's onData, outside React's
  // render) can gate itself without waiting for the reducer state to commit.
  const openRef = useRef(false)

  useEffect(() => {
    if (!enabled || !id) {
      // Not armed / not typable: no socket exists, so nothing can be sent — A5 by construction.
      dispatch({ type: 'disarm' })
      return
    }

    dispatch({ type: 'arm' })
    dispatch({ type: 'connecting' })
    seqRef.current = 1
    openRef.current = false

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl(id))
    } catch {
      dispatch({ type: 'closed', reason: 'channel_unavailable' })
      return
    }
    wsRef.current = ws
    // Did this socket ever open? A close BEFORE open is a refused/failed upgrade (exposed profile,
    // no cookie, wrong origin, capacity) — a different, honest message from a mid-session drop.
    let opened = false

    ws.onopen = () => { opened = true; openRef.current = true; dispatch({ type: 'open' }) }

    ws.onmessage = (e: MessageEvent) => {
      // Server → client: one ack per message, `{ seq, ok, reason? }`. A malformed frame is ignored
      // rather than thrown on — it never resurrects a pending key.
      try {
        const ack = JSON.parse(typeof e.data === 'string' ? e.data : '') as { seq?: number; ok?: boolean; reason?: string }
        if (typeof ack.seq === 'number' && typeof ack.ok === 'boolean') {
          dispatch({ type: 'ack', id: ack.seq, ok: ack.ok, reason: ack.reason })
        }
      } catch { /* not JSON — ignore, never crash the channel */ }
    }

    const onGone = () => {
      openRef.current = false
      dispatch({ type: 'closed', reason: opened ? 'connection_lost' : 'channel_unavailable' })
    }
    ws.onclose = onGone
    // An error is followed by a close on all browsers; onclose does the accounting. This just makes
    // sure a socket erroring before it ever opened is not left as eternal "connecting".
    ws.onerror = () => { if (!opened) openRef.current = false }

    return () => {
      openRef.current = false
      // Drop handlers before closing so the teardown close does not re-dispatch into a torn-down
      // reducer, then close the socket for this id.
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try { ws.close() } catch { /* already closing */ }
      wsRef.current = null
    }
  }, [id, enabled])

  const send = useCallback((data: string) => {
    const ws = wsRef.current
    // No socket, or not open yet: the key is NOT sent. With no local echo it simply never appears —
    // honest by construction — and the consumer's status line explains why (connecting / unavailable).
    if (!ws || !openRef.current) return

    // ONE onData chunk is not one keystroke: xterm coalesces, a paste arrives whole, and a mobile
    // keyboard sends a composed word together with its return. `splitInput` decomposes it into the
    // ordered pieces; they go down this one socket in this order, each with its own seq, so
    // ordering is preserved by construction.
    const parts = splitInput(data)

    const refused = parts.find(p => p.kind === 'blocked')
    if (refused) {
      // `empty` is a genuine no-op. Anything else is REPORTED: this used to be a bare `return`, so a
      // chunk carrying text plus a return — "abc\r", the ordinary shape of typing a line and
      // pressing Enter on a phone — was dropped whole, with no pending key, no failed ack and
      // nothing on screen. A line you can see and cannot send is the one failure this channel
      // exists to prevent.
      if (refused.kind === 'blocked' && refused.reason !== 'empty') {
        // Its OWN action, never a send/ack pair under a synthetic id: that pair poisons the FIFO
        // whenever a real key is in flight (see `ChannelAction.refused`).
        dispatch({ type: 'refused', reason: refused.reason === 'too-long' ? 'too_long' : 'mixed_chunk' })
      }
      return
    }

    for (const part of parts) {
      const seq = seqRef.current++
      const msg = part.kind === 'text'
        ? { seq, kind: 'text', data: part.text }
        : { seq, kind: 'key', name: (part as { key: string }).key }
      // Account for the send FIRST (so a synchronous throw still leaves the key pending → reported),
      // then transmit. Order on the wire is onData order over the single connection.
      dispatch({ type: 'send', id: seq })
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        // The socket died between the open check and the send — treat as a drop so the pending key
        // is surfaced as not-delivered rather than silently lost. Stop: the rest of this chunk
        // would arrive after a reconnect, out of the order the user typed it in.
        openRef.current = false
        dispatch({ type: 'closed', reason: 'connection_lost' })
        return
      }
    }
  }, [])

  const reason = state.error ? inputReasonText(state.error, lang) : null
  const ready = state.armed && state.phase === 'open'
  return { send, state, ready, reason }
}
