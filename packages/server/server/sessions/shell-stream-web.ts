/**
 * shell-stream-web.ts — the utility shell's live READ channel, `GET /api/shell/stream?id=<shellId>`.
 *
 * The sibling of `terminal-web.ts`, and deliberately NOT a call into it. Everything generic is
 * shared — the frame shape (`terminal-stream.ts`), the one-loop-per-watched-pane hub with its dedup
 * and its death handling (`terminal-hub.ts`) — so the browser reads the very same frames from both
 * channels and `SessionTerminal` needs no branch. What is NOT shared is the ONE rule each channel
 * keeps: SCOPE. `terminal-web.ts` resolves an id against `managed-sessions.json`; this one resolves
 * it against `shells.json`, which is what stops a shell id ever being answered as a fleet row (and
 * a fleet id ever being answered as a shell).
 *
 * `index.ts` has already refused this path where the exposure profile forbids it (`localShell` in
 * `capability-guard.ts`), on a central, and where the user's own `shellEnabled` switch is off. What
 * is left here is the scope check, the stream ceiling and the SSE plumbing.
 */

import { readShells } from './shell-store'
import { createShellTerminal, type TmuxRun } from './shell-terminal'
import { createTerminalHub, type TerminalHub } from './terminal-hub'
import { encodeSse, TERMINAL_POLL_MS, TERMINAL_VIEW_LINES } from './terminal-stream'
import { HISTORY_LIMIT } from './tmux-cli'

/**
 * A ceiling on concurrent shell streams for the whole process, for the reason
 * `MAX_TERMINAL_STREAMS` exists: each holds a socket and a controller, so an unbounded count is a
 * free way to exhaust the server. It is far below the fleet's because the SHELLS themselves are
 * capped at `SHELL_CAP` = 8 — this only has to allow several viewers of each.
 */
export const MAX_SHELL_STREAMS = 32

/** See `terminal-web.ts`: a channel deduped to silence is what a proxy reaps as idle. */
const KEEPALIVE_MS = 15_000

async function tmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    return { code: await p.exited, out, err }
  } catch {
    // tmux is not on PATH. 127 is what a shell reports for that; a capture then reads as gone,
    // which is the truth — there is no pane. Never a throw.
    return { code: 127, out: '', err: '' }
  }
}

const terminal = createShellTerminal(tmux as TmuxRun)

let hub: TerminalHub | null = null

function getHub(): TerminalHub {
  if (hub) return hub
  hub = createTerminalHub({
    capture: id => terminal.capture(id, TERMINAL_VIEW_LINES),
    // THE SCOPE RULE. `shells.json`, never the registry — a shell is not a session, and an id from
    // one store must never resolve in the other.
    isManaged: async id => (await readShells()).some(s => s.id === id),
    historyLimit: HISTORY_LIMIT,
    viewLines: TERMINAL_VIEW_LINES,
    pollMs: TERMINAL_POLL_MS,
  })
  return hub
}

/**
 * A keystroke just landed — capture now rather than at the next poll.
 *
 * Reads the module's `hub` directly rather than building one: with no hub nobody is watching
 * anything, and building one to nudge a pane no surface is showing would start a capture loop for a
 * screen nobody can see. Same reasoning as `nudgeTerminal`.
 */
export function nudgeShell(id: string): void {
  hub?.nudge(id)
}

/** Scope check for the route, so an id that is not an open shell is a clean 404. */
export async function shellStreamExists(id: string): Promise<boolean> {
  return (await readShells()).some(s => s.id === id)
}

/** True when the process is already at its stream ceiling — the route answers 503. */
export function shellStreamAtCapacity(): boolean {
  return getHub().subscribers() >= MAX_SHELL_STREAMS
}

/**
 * The SSE body for one shell's pane. Identical framing to `/api/fleet/stream`, so the browser's
 * reader is the same reader. Cleanup is tied to `signal`: when the browser disconnects the
 * subscription is dropped, and when the last reader leaves, the hub stops capturing — the unwatch
 * discipline, enforced on the server as well as asked of the client.
 */
export async function openShellStream(id: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const h = getHub()
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
