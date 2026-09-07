/**
 * input-channel.ts — the ORDER guarantee and the per-message confirmation, injectable and pure of IO.
 *
 * One channel per WebSocket connection (one connection per session). TCP already delivers a single
 * connection's messages in order; this module is the second half of the guarantee the spec demands:
 * the server processes them STRICTLY SEQUENTIALLY — one `send-keys` at a time — so a slow send can
 * never let a later keystroke overtake it. That is why key-by-key typing here does not scramble the
 * way per-keystroke HTTP POSTs would.
 *
 * The mechanism is a promise chain: each `submit` is appended after the previous handler, and every
 * handler is `await`ed before the next runs. The chain is defended so it can never break — a handler
 * that would throw is caught and answered with a failure ack, and the tail is reset to a resolved
 * promise, so one bad message does not wedge the connection.
 *
 * The backend and the ack sink are injected (`sendText` / `sendKey` pre-bound to the session,
 * `emit`), exactly as `terminal-hub.ts` injects its capture and clock — which is what lets the
 * ordering and the honest-failure behaviour be proven without a tmux server.
 */
import { ackFail, ackOk, parseInputMessage, type InputAck } from './input-protocol'

export interface InputChannelDeps {
  /** Type literal text into the session with NO submit — `sendKeysLiteralArgs`, pre-bound to the id. */
  sendText(text: string): Promise<boolean>
  /** Press one NAMED key (`C-c`, `Enter`) — `sendKeysNamedArgs`, pre-bound to the id. */
  sendKey(key: string): Promise<boolean>
  /** Deliver one ack back to the client. */
  emit(ack: InputAck): void
}

export interface InputChannel {
  /** Enqueue one raw client message. Returns immediately; the ack arrives via `emit`. */
  submit(raw: string): void
}

export function createInputChannel(deps: InputChannelDeps): InputChannel {
  // The serial tail. Every submit chains onto it; `.then` here (rather than resolving in parallel) is
  // the ordering guarantee itself.
  let tail: Promise<void> = Promise.resolve()

  async function handle(raw: string): Promise<void> {
    const parsed = parseInputMessage(raw)
    if (!parsed.ok) {
      deps.emit(ackFail(parsed.seq, parsed.reason))
      return
    }
    const m = parsed.msg
    let ok = false
    try {
      ok = m.kind === 'text' ? await deps.sendText(m.text) : await deps.sendKey(m.key)
    } catch {
      // A backend that threw is not a reason to report success and not a reason to tear the socket
      // down: the keystroke did not land, so the client is told so and the next one is still handled.
      ok = false
    }
    deps.emit(ok ? ackOk(m.seq) : ackFail(m.seq, 'send_failed'))
  }

  return {
    submit(raw) {
      // `catch(() => {})` guarantees the tail stays resolvable — `handle` already swallows send
      // errors, but this is the belt to that braces so a future edit cannot silently freeze the queue.
      tail = tail.then(() => handle(raw)).catch(() => {})
    },
  }
}
