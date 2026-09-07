/**
 * terminalChannel.ts — the pure honesty core of the DIRECT-TYPING write channel (Phase 2b).
 *
 * `terminalKeys.ts` decides WHAT a keystroke is; this module tracks WHETHER it was delivered. It is
 * the raw-mode analogue of the #269 line composer (`terminalInput.ts`): same load-bearing rule —
 * the terminal must never show a key as delivered that did not reach the process — enforced now at
 * keystroke scale over an ordered channel (a single WebSocket; order is guaranteed by one
 * connection + sequential processing on the server, never by the client).
 *
 * The honesty model that makes A6 true BY CONSTRUCTION: the terminal does NOT echo locally. A typed
 * key is sent and only appears on screen when the SESSION echoes it back through the read channel
 * (`terminalStream.ts`). So a key that never reaches the process never appears — there is no locally
 * echoed character to be exposed as a lie when the channel drops. This reducer adds the second half:
 * it tracks keys that were SENT but not yet CONFIRMED, so a dropped channel (or a failed ack) is
 * surfaced as an explicit "not delivered", never left as silence or a spinner.
 *
 * Each keystroke carries a client-assigned monotonic id, echoed back on its ack. Pairing is then
 * VERIFIED, not inferred: an ack must reference the id of the key we expect next; a mismatch (which
 * an ordered channel + sequential server should make impossible) is DETECTED and surfaced rather
 * than silently accepted. That is the whole value of an id over bare FIFO — it shows up exactly in
 * the bad case (a reconnect, a lost message). The obligation the coordinator fixed — every send is
 * confirmed delivered-or-failed, with a reason — plus that id is all this needs; the wire shape is
 * Victor's server dispatch.
 *
 * Pure and reducer-shaped so the honesty rules are pinned by `terminalChannel.test.ts`.
 */

/** Where the write channel is in its lifecycle. Sending is possible only in `open`. */
export type ChannelPhase = 'idle' | 'connecting' | 'open' | 'closed'

export interface ChannelState {
  /** Consent — explicit, per-session, revocable, exactly as the #269 composer's `armed`. */
  armed: boolean
  phase: ChannelPhase
  /** Ids of keystrokes sent but not yet acked, in send order (FIFO). */
  pending: number[]
  /** The verbatim failure reason on screen while `undelivered`, or null. */
  error: string | null
  /** A6 — a send failed or the channel dropped with keys in flight. Cleared only on a fresh open. */
  undelivered: boolean
}

export const INITIAL_CHANNEL: ChannelState = {
  armed: false,
  phase: 'idle',
  pending: [],
  error: null,
  undelivered: false,
}

export type ChannelAction =
  | { type: 'arm' }
  | { type: 'disarm' }
  | { type: 'connecting' }
  | { type: 'open' }
  | { type: 'closed'; reason?: string }
  // The id is the CLIENT's monotonic seq, assigned by the transport (a ref) at send time — not by the
  // reducer — so a burst of onData events can't collide reading stale state between renders (A2). The
  // reducer only accounts for what the transport says it sent.
  | { type: 'send'; id: number }
  | { type: 'ack'; id: number; ok: boolean; reason?: string }

/** A key may be transmitted only while consent stands and the channel is open. */
export function canSend(state: ChannelState): boolean {
  return state.armed && state.phase === 'open'
}

/** How many keystrokes are sent-but-unconfirmed right now. */
export function pendingCount(state: ChannelState): number {
  return state.pending.length
}

const DEFAULT_DROP_REASON = 'channel closed; keystrokes may not have been delivered'

export function channelReducer(state: ChannelState, action: ChannelAction): ChannelState {
  switch (action.type) {
    case 'arm':
      // Idempotent: arming an already-armed channel never disturbs keys in flight.
      return state.armed ? state : { ...INITIAL_CHANNEL, armed: true }

    case 'disarm':
      // Revoking consent drops everything — a session you stopped driving keeps nothing.
      return INITIAL_CHANNEL

    case 'connecting':
      if (!state.armed) return state
      // A fresh attempt starts honest: a prior failure is cleared as the channel comes back.
      return { ...state, phase: 'connecting', error: null, undelivered: false, pending: [] }

    case 'open':
      if (!state.armed) return state
      return { ...state, phase: 'open', error: null, undelivered: false }

    case 'closed': {
      // A drop WITH keys in flight is an honest failure (A6); with nothing pending it is a clean close.
      const lost = state.pending.length > 0
      return {
        ...state,
        phase: 'closed',
        pending: [],
        undelivered: state.undelivered || lost,
        error: lost ? (action.reason ?? DEFAULT_DROP_REASON) : state.error,
      }
    }

    case 'send':
      if (!canSend(state)) return state
      return { ...state, pending: [...state.pending, action.id] }

    case 'ack': {
      // Only meaningful while a key is actually in flight — a late/duplicate ack (pending drained by
      // an OK, a close, or a disarm) resurrects nothing.
      if (state.pending.length === 0) return state
      // Verify, don't infer: the ack must answer the key we expect next. A mismatch is a detectable
      // fault (reconnect, lost message) — surfaced, and the accounting left intact rather than
      // popping the wrong key.
      if (state.pending[0] !== action.id) {
        return { ...state, undelivered: true, error: action.reason ?? 'delivery confirmation out of order' }
      }
      const [, ...rest] = state.pending
      if (action.ok) return { ...state, pending: rest }
      return {
        ...state,
        pending: rest,
        undelivered: true,
        error: action.reason ?? 'not delivered',
      }
    }

    default:
      return state
  }
}
