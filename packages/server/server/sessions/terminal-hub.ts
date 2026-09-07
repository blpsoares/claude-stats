/**
 * terminal-hub.ts — one capture loop per WATCHED session, shared by every reader of it.
 *
 * The criterion the spec sets is "follow the agent without hammering the server with a fleet of open
 * sessions". Two properties deliver it, and both live here:
 *
 *  - **Viewer-gated.** A session is captured only while at least one browser is watching it. The
 *    loop starts on the first subscriber and stops on the last. So the server's work scales with the
 *    number of open TERMINALS (usually one), never with the size of the fleet.
 *  - **Shared, deduped.** Many readers of the same session share ONE loop and ONE tmux read per
 *    tick; an unchanged frame is sent to nobody. A reader that joins mid-stream is handed the last
 *    frame immediately, so it sees the current screen without waiting for the next change.
 *
 * Injectable on purpose — the backend, the scope check and the clock are passed in — because that is
 * how `createSessionsPoller` is built and tested in this same directory, and it lets the "one loop
 * for N readers / dedup / death ends the stream" behaviour be proven without a tmux server. The
 * decisions that could be silently wrong (what counts as a change, how a capture becomes a frame)
 * live in the pure `terminal-stream.ts`; this module is the orchestration around them.
 */

import { buildFrame, captureDigest, type TerminalEndReason, type TerminalFrame } from './terminal-stream'
import type { TerminalCapture } from './types'

export interface TerminalSink {
  onFrame(frame: TerminalFrame): void
  onEnd(reason: TerminalEndReason): void
}

type TimerHandle = ReturnType<typeof setInterval>

export interface TerminalHubDeps {
  /** Read the pane, ANSI-preserved. `null` means the session is GONE (ends the stream). */
  capture(id: string): Promise<TerminalCapture | null>
  /** Scope gate: is this a session this machine manages and this user may already see? A stream for
   *  anything else is refused before a loop ever starts — writing power never, reading power never,
   *  widens past the fleet the dashboard already lists. */
  isManaged(id: string): Promise<boolean>
  /** The scrollback ceiling, carried into each frame for the "showing last N of M" honesty. */
  historyLimit: number
  /** How many lines of history each capture requests — decides a frame's `truncated` flag. */
  viewLines: number
  pollMs: number
  /** Injectable so a test drives the loop by hand instead of by wall-clock. */
  setInterval?: (fn: () => void, ms: number) => TimerHandle
  clearInterval?: (h: TimerHandle) => void
}

interface Entry {
  sinks: Set<TerminalSink>
  handle: TimerHandle | null
  /** Guards against a slow tmux read overlapping the next tick. */
  busy: boolean
  lastDigest: string | null
  lastFrame: TerminalFrame | null
  seq: number
}

export interface TerminalHub {
  /** Start (or join) watching a session. The returned function unsubscribes; call it once. */
  subscribe(id: string, sink: TerminalSink): Promise<() => void>
  /**
   * Capture now — the screen just changed because somebody typed into it. A no-op for a session
   * nobody is watching. See the implementation for why it is a short burst.
   */
  nudge(id: string): void
  /** How many capture loops are running — for the route's cap and for tests. */
  activeLoops(): number
  /** Total readers across all sessions — for the route's cap. */
  subscribers(): number
}

export function createTerminalHub(deps: TerminalHubDeps): TerminalHub {
  const setIv: (fn: () => void, ms: number) => TimerHandle =
    deps.setInterval ?? ((fn, ms) => setInterval(fn, ms) as TimerHandle)
  const clearIv: (h: TimerHandle) => void = deps.clearInterval ?? clearInterval
  const entries = new Map<string, Entry>()

  function stop(id: string, entry: Entry): void {
    if (entry.handle !== null) { clearIv(entry.handle); entry.handle = null }
    entries.delete(id)
  }

  async function tick(id: string): Promise<void> {
    const entry = entries.get(id)
    if (!entry || entry.busy) return
    entry.busy = true
    try {
      let cap: TerminalCapture | null
      try {
        cap = await deps.capture(id)
      } catch {
        // A read that THREW is not proof the session is gone (a transient tmux hiccup), so it does
        // not end the stream — the next tick tries again. Only an explicit `null` means gone.
        return
      }
      const still = entries.get(id)
      if (!still) return // unsubscribed while the read was in flight
      if (cap === null) {
        for (const s of [...still.sinks]) { try { s.onEnd('gone') } catch { /* sink is done */ } }
        stop(id, still)
        return
      }
      const digest = captureDigest(cap.lines, cap.info)
      if (digest === still.lastDigest) return // nothing changed — send nobody a frame
      still.seq += 1
      const frame = buildFrame(still.seq, cap.lines, cap.info, deps.historyLimit, deps.viewLines)
      still.lastDigest = digest
      still.lastFrame = frame
      for (const s of [...still.sinks]) { try { s.onFrame(frame) } catch { /* sink is done */ } }
    } finally {
      const e = entries.get(id)
      if (e) e.busy = false
    }
  }

  return {
    /**
     * Capture NOW, because something just changed the screen on purpose.
     *
     * The poll cadence is tuned for watching — half a second is nothing when you are reading what
     * an agent is doing, and it is an eternity when you are TYPING: every character would take up
     * to `pollMs` to appear, which reads as a broken keyboard rather than as a slow one. The write
     * path calls this after a keystroke lands, so the echo is one capture away instead of one
     * interval.
     *
     * A short burst rather than a single tick: tmux accepts the key, the program redraws a moment
     * later, and a capture taken between the two shows the screen as it was. Three cheap reads over
     * ~200ms cover both edges. It is bounded by construction — only a session somebody is WATCHING
     * has an entry, and `tick` is a no-op while one is already in flight.
     */
    nudge(id) {
      const entry = entries.get(id)
      if (!entry || entry.sinks.size === 0) return
      void tick(id)
      setTimeout(() => { if (entries.has(id)) void tick(id) }, 60)
      setTimeout(() => { if (entries.has(id)) void tick(id) }, 200)
    },

    async subscribe(id, sink) {
      if (!(await deps.isManaged(id))) {
        try { sink.onEnd('not-found') } catch { /* sink is done */ }
        return () => {}
      }
      let entry = entries.get(id)
      if (!entry) {
        entry = { sinks: new Set(), handle: null, busy: false, lastDigest: null, lastFrame: null, seq: 0 }
        entries.set(id, entry)
        // First tick immediately so the first reader is not waiting a whole interval for a screen
        // that already exists, then on the cadence.
        entry.handle = setIv(() => { void tick(id) }, deps.pollMs)
        void tick(id)
      } else if (entry.lastFrame) {
        // A newcomer to a running loop gets the current screen now, not at the next change.
        try { sink.onFrame(entry.lastFrame) } catch { /* sink is done */ }
      }
      entry.sinks.add(sink)

      let done = false
      return () => {
        if (done) return
        done = true
        const e = entries.get(id)
        if (!e) return
        e.sinks.delete(sink)
        if (e.sinks.size === 0) stop(id, e) // last reader left — stop hammering tmux
      }
    },
    activeLoops() {
      return entries.size
    },
    subscribers() {
      let n = 0
      for (const e of entries.values()) n += e.sinks.size
      return n
    },
  }
}
