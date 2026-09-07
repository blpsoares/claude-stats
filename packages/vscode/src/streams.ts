/**
 * streams.ts — the live screen of a session, read by the extension host.
 *
 * `GET /api/fleet/stream?id=` is Server-Sent Events, and the browser would normally consume it with
 * `EventSource`. The webview cannot: its `localhost` is the editor client's, which in a Remote-SSH
 * or WSL window is not the machine the sessions run on. So the host opens the stream — it sits
 * beside the fleet — and forwards each event over `postMessage`.
 *
 * **One connection per session, shared by every surface watching it.** That mirrors the server's own
 * model (one `capture-pane` loop per session, however many readers) and it is what makes the sidebar
 * and an editor tab showing the same session cost one stream rather than two. A session nobody is
 * watching is not streamed at all: capture is viewer-gated on the server, so an unwatched stream is
 * work on the host for a screen nobody can see.
 *
 * **A stream that never delivers must say so.** The client leaves `connecting` only on a frame or an
 * `end`; if neither arrives within `STALL_MS` the surface is told, because a "Connecting…" that
 * never resolves is indistinguishable from a dead session. A stall never blanks a screen that
 * already has a frame — there the last frame stands and the reconnect handles the blip.
 */

/** The wire events, forwarded verbatim so the parsers that already exist do the reading. */
export type TerminalEventName = 'open' | 'frame' | 'end' | 'stall' | 'error'

export interface TerminalEvent {
  id: string
  event: TerminalEventName
  /** The event's raw `data:` payload. `stall`/`error` carry an empty string. */
  data: string
}

/** Matches the dashboard's own `STALL_MS`: 10s without a first frame is a stall, not patience. */
const STALL_MS = 10_000
/** How long to wait before re-opening a stream that closed with watchers still on it. */
const RETRY_MS = 2_000

type Listener = (event: TerminalEvent) => void

interface Stream {
  controller: AbortController
  listeners: Set<Listener>
  /** Cleared once the first frame arrives; a stall is only ever reported before that. */
  stallTimer?: ReturnType<typeof setTimeout>
  retryTimer?: ReturnType<typeof setTimeout>
  sawFrame: boolean
  closed: boolean
  /**
   * The last `open` and `frame` this stream delivered, kept for whoever joins next.
   *
   * Not a cache — the whole feature depends on it. A session that is WAITING ON A PERSON draws
   * nothing: its screen is a permission prompt and does not change, sometimes for hours. A surface
   * that joined an already-open stream and waited for the next frame therefore waited forever, on
   * exactly the sessions somebody opens a terminal to look at. The server's own hub replays for the
   * same reason ("a newcomer to a running loop gets the current screen now, not at the next
   * change"); this is that rule on the client side of one HTTP subscription.
   */
  lastOpen?: string
  lastFrame?: string
}

export class TerminalStreams {
  private readonly streams = new Map<string, Stream>()

  constructor(private readonly api: () => string) {}

  /** Start watching, or join the stream already open for this session. */
  watch(id: string, listener: Listener): void {
    const existing = this.streams.get(id)
    if (existing) {
      existing.listeners.add(listener)
      // Hand the newcomer what the stream has already delivered. Without this it sees the screen
      // only when it next CHANGES, which on a session waiting for a person is never — see the note
      // on `lastFrame`.
      if (existing.lastOpen !== undefined) listener({ id, event: 'open', data: existing.lastOpen })
      if (existing.lastFrame !== undefined) listener({ id, event: 'frame', data: existing.lastFrame })
      return
    }
    const stream: Stream = {
      controller: new AbortController(),
      listeners: new Set([listener]),
      sawFrame: false,
      closed: false,
    }
    this.streams.set(id, stream)
    void this.open(id, stream)
  }

  /** Stop watching. The connection closes once the last watcher leaves. */
  unwatch(id: string, listener: Listener): void {
    const stream = this.streams.get(id)
    if (!stream) return
    stream.listeners.delete(listener)
    if (stream.listeners.size > 0) return
    this.close(id)
  }

  /** Drop every listener a surface registered — what a closed panel needs. */
  unwatchAll(listener: Listener): void {
    for (const id of [...this.streams.keys()]) this.unwatch(id, listener)
  }

  dispose(): void {
    for (const id of [...this.streams.keys()]) this.close(id)
  }

  private close(id: string): void {
    const stream = this.streams.get(id)
    if (!stream) return
    stream.closed = true
    clearTimeout(stream.stallTimer)
    clearTimeout(stream.retryTimer)
    stream.controller.abort()
    this.streams.delete(id)
  }

  private emit(id: string, event: TerminalEventName, data: string): void {
    const stream = this.streams.get(id)
    if (!stream) return
    for (const listener of stream.listeners) listener({ id, event, data })
  }

  private async open(id: string, stream: Stream): Promise<void> {
    stream.stallTimer = setTimeout(() => {
      if (!stream.sawFrame && !stream.closed) this.emit(id, 'stall', '')
    }, STALL_MS)

    try {
      const url = new URL(`${this.api()}/api/fleet/stream`)
      url.searchParams.set('id', id)
      const res = await fetch(url.toString(), {
        headers: { Accept: 'text/event-stream' },
        signal: stream.controller.signal,
      })
      // A refusal before the stream opens is an ANSWER — the session is not one this machine
      // manages, the profile has no host power, the process is at its stream ceiling — and it is
      // reported as such rather than retried into a loop that never says anything.
      if (!res.ok || !res.body) {
        this.emit(id, 'error', String(res.status))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE frames are separated by a blank line. Anything after the last one is a partial
        // frame and stays in the buffer — a JSON payload cut in half parses as nothing.
        let split = buffer.indexOf('\n\n')
        while (split !== -1) {
          this.dispatch(id, stream, buffer.slice(0, split))
          buffer = buffer.slice(split + 2)
          split = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // An abort is the ordinary way this ends; anything else is a blip the retry below covers.
    } finally {
      clearTimeout(stream.stallTimer)
      // Re-open while somebody is still watching: the server closes a stream when the session goes,
      // but it also closes on an ordinary network hiccup, and `EventSource`'s own reconnect is
      // exactly what this hand-rolled reader has to replace.
      if (!stream.closed && stream.listeners.size > 0) {
        stream.retryTimer = setTimeout(() => {
          if (!stream.closed && stream.listeners.size > 0) void this.open(id, stream)
        }, RETRY_MS)
      }
    }
  }

  /** One SSE block → one event. `: keepalive` comment lines carry no event and are ignored. */
  private dispatch(id: string, stream: Stream, block: string): void {
    let name = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!name) return
    if (name === 'frame') {
      stream.sawFrame = true
      clearTimeout(stream.stallTimer)
    }
    if (name === 'end') {
      // The session is gone. Deliver the reason, then stop — retrying would reopen a stream the
      // server has already said has nothing behind it.
      this.emit(id, 'end', data)
      stream.closed = true
      return
    }
    if (name === 'open') stream.lastOpen = data
    if (name === 'frame') stream.lastFrame = data
    if (name === 'open' || name === 'frame') this.emit(id, name, data)
  }
}
