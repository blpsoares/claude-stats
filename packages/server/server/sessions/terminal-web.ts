/**
 * terminal-web.ts — the WEB dashboard's live terminal channel onto one session's pane.
 *
 * The sibling of `fleet-web.ts`, and deliberately LEANER than it. `fleet-web` routes through the
 * Ink control host because the fleet's ACTIONS carry rules that must not be re-implemented in a
 * browser (a numbered dialog is never answered by a bare confirm). Reading a screen carries no such
 * rule — a capture is a capture — so this channel talks straight to the session backend and skips
 * the React/Ink import graph entirely. It keeps exactly ONE rule of its own, the one that matters:
 * SCOPE. A stream is opened only for a session THIS MACHINE MANAGES (its own registry), so the read
 * power never reaches past the fleet the dashboard already lists — the same boundary the write path
 * will inherit in Phase 2, established here where it is cheap.
 *
 * The heavy lifting (shared loop, dedup, death) is `terminal-hub.ts`; the framing is the pure
 * `terminal-stream.ts`. This file is just the singleton wiring and the SSE plumbing. The whole
 * surface is additionally gated by `localShell` in `capability-guard.ts` and 404'd on a central, so
 * it is unreachable on an internet-exposed instance regardless of who is authenticated — a captured
 * terminal is shell access with extra steps.
 */

import { resolveBackend } from './index'
import { readRegistry } from './registry'
import { createTerminalHub, type TerminalHub } from './terminal-hub'
import { encodeSse, TERMINAL_POLL_MS, TERMINAL_VIEW_LINES } from './terminal-stream'
import { HISTORY_LIMIT } from './tmux-cli'

/**
 * A ceiling on concurrent terminal streams for the whole process. Each holds a socket, a controller
 * and (with the hub's sharing) at worst one capture loop, so an unbounded count is a free way to
 * exhaust the server (OWASP API4) — the same reason `/api/events` caps its client set.
 */
export const MAX_TERMINAL_STREAMS = 100

/**
 * A comment line every so often to keep the connection warm. A terminal that is deduped to silence
 * — a session sitting on a permission prompt sends no frames for minutes — is exactly the case a
 * proxy or load balancer reaps as idle. An SSE comment (`: …`) is ignored by the client, so it
 * costs nothing but the bytes.
 */
const KEEPALIVE_MS = 15_000

const POLL_MS = Number(process.env.AGENTISTICS_TERMINAL_POLL_MS) > 0
  ? Number(process.env.AGENTISTICS_TERMINAL_POLL_MS)
  : TERMINAL_POLL_MS

let hub: TerminalHub | null = null

async function getHub(): Promise<TerminalHub> {
  if (hub) return hub
  // Resolved once: `resolveBackend` returns a constant object, and the hub then holds it.
  const backend = await resolveBackend()
  hub = createTerminalHub({
    capture: id => backend.captureTerminal(id, TERMINAL_VIEW_LINES),
    isManaged: async id => (await readRegistry()).some(m => m.id === id),
    historyLimit: HISTORY_LIMIT,
    viewLines: TERMINAL_VIEW_LINES,
    pollMs: POLL_MS,
  })
  return hub
}

/**
 * A keystroke just landed — capture the screen now rather than at the next poll.
 *
 * Deliberately reads the module's `hub` directly instead of `getHub()`: if no hub exists, nobody is
 * watching anything, and building one to nudge a session no surface is showing would start a
 * capture loop for a screen nobody can see.
 */
export function nudgeTerminal(id: string): void {
  hub?.nudge(id)
}

/** Scope check for the route, so a session outside this machine's fleet is a clean 404 rather than
 *  a 200 stream that immediately says `not-found`. The hub re-checks on subscribe regardless. */
export async function terminalSessionExists(id: string): Promise<boolean> {
  return (await readRegistry()).some(m => m.id === id)
}

/** True when the process is already at its stream ceiling — the route answers 503. */
export async function terminalAtCapacity(): Promise<boolean> {
  return (await getHub()).subscribers() >= MAX_TERMINAL_STREAMS
}

/**
 * Build the SSE body for one session's terminal. The caller wraps it in a Response with the CORS +
 * event-stream headers (matching `/api/events`). Cleanup is tied to `signal`: when the browser
 * disconnects, the subscription is dropped, and when the last reader of a session leaves the hub
 * stops capturing it.
 */
export async function openTerminalStream(id: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const h = await getHub()
  const enc = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null

  const teardown = () => {
    unsubscribe?.()
    unsubscribe = null
    if (keepalive !== null) { clearInterval(keepalive); keepalive = null }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (chunk: string) => {
        if (closed) return
        try { controller.enqueue(enc.encode(chunk)) } catch { closed = true }
      }
      const close = () => {
        if (closed) return
        closed = true
        teardown()
        try { controller.close() } catch { /* already closed */ }
      }

      // If the browser is already gone by the time we start, do nothing.
      if (signal.aborted) { close(); return }

      send(encodeSse('open', { id, viewLines: TERMINAL_VIEW_LINES, historyLimit: HISTORY_LIMIT }))
      keepalive = setInterval(() => send(': keepalive\n\n'), KEEPALIVE_MS)

      unsubscribe = await h.subscribe(id, {
        onFrame: frame => send(encodeSse('frame', frame)),
        onEnd: reason => { send(encodeSse('end', { reason })); close() },
      })

      signal.addEventListener('abort', close)
    },
    cancel() {
      teardown()
    },
  })
}
