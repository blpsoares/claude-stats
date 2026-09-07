/**
 * shared-snapshot.ts — ONE POLLER, MANY READERS.
 *
 * Reported as "aqui na listagem aparecem 4 sessoes e no agentop so aparecem 3 … ambas deveriam
 * andar juntos". They cannot, as long as each surface polls for itself.
 *
 * WHY A SECOND POLLER DISAGREES, and it is not a race that can be tightened away: `working` is
 * MOVEMENT — the frame changed since the LAST poll of that poller — and `attention-confirm.ts`
 * additionally requires a state to be seen twice before it is believed. Both facts live in the
 * poller's own memory. A poller that has just started has neither, so it reads a producing session
 * as `waiting`, and a `running only` filter then hides it entirely. Measured at one instant on this
 * machine: the long-lived server reported all four sessions `working` while a freshly built host
 * reported the same four `waiting`. That is the four-versus-three.
 *
 * `agentop` runs as several processes — the server, the cockpit, every one-shot `agentop session
 * ls`, every `hooks context` — and four of them build their own poller today. The one that is
 * ALWAYS long-lived is `agentop server`. So the short-lived readers ask it, and fall back to
 * polling for themselves when nothing answers.
 *
 * THE FALLBACK IS NOT A DETAIL. The cockpit's whole purpose includes a machine whose server is
 * stopped — that is where you go to start it. So an unreachable server is an ordinary answer here
 * (`null`), never an error, and every caller keeps the poller it already had.
 *
 * The timeout is short on purpose: this sits in front of a local socket, and a reader that waits
 * seconds for a server that is not there is worse than one that polls for itself immediately.
 */

import { PORT } from '../config'

/** How long a local HTTP call may take before the caller gives up and polls for itself. */
export const SNAPSHOT_TIMEOUT_MS = 1500

/**
 * The running server's own fleet snapshot, or `null` when there is no server to ask.
 *
 * `null` covers every way that can happen — nothing listening, a refusal, a body that will not
 * parse, an older build with no such route — because the caller's answer is the same for all of
 * them: poll for yourself. Distinguishing them would be information nobody acts on.
 *
 * Deliberately UNTYPED at the boundary and shaped by the caller: this module must not import the
 * poller's types, or the one-shot commands pull in the whole session host to make one HTTP call.
 */
export async function readServerSnapshot<T>(lang: string): Promise<T | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), SNAPSHOT_TIMEOUT_MS)
  try {
    const res = await fetch(
      `http://127.0.0.1:${PORT}/api/fleet/snapshot?lang=${encodeURIComponent(lang)}`,
      { signal: ctl.signal },
    )
    if (!res.ok) return null
    const body = await res.json() as { sessions?: unknown } | null
    // A body with no `sessions` array is not a snapshot. Answering with it would hand a caller an
    // empty fleet — the confident-zero this whole family of modules exists to refuse.
    if (!body || !Array.isArray(body.sessions)) return null
    return body as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Is THIS process the server?
 *
 * The server must never ask itself — it would be an HTTP round trip to its own poller, and on a
 * cold start a request that cannot complete until the thing making it has finished starting.
 * `SERVE_STATIC` is set by `cli.ts` for the `server` subcommand and by nothing else, so it is the
 * one marker that is true exactly when this process is serving.
 */
export function isServerProcess(): boolean {
  return process.env.SERVE_STATIC === '1'
}
