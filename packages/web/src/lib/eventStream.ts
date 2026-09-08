/**
 * eventStream.ts — ONE shared `/api/events` EventSource for the whole app.
 *
 * The dashboard's push channel `/api/events` carries several event TYPES: `change` (the server wrote
 * new session data → refetch) and `notification` (a new bell/toast → re-read the scoped list). Each
 * consumer used to open its OWN `EventSource('/api/events')` — `useData` and `useNotificationStream`
 * both did — so an idle Sessions page held TWO live sockets to the same URL before a single terminal
 * was opened. That matters: a browser caps how many connections one origin may hold at once (~6 over
 * HTTP/1.1), each live terminal spends one (`/api/fleet/stream`), and a socket wasted on a duplicate
 * broadcast is one fewer a maximised terminal can have — which is exactly how a terminal ends up
 * queued behind the limit, stuck "connecting" forever.
 *
 * So this module owns a SINGLE, ref-counted EventSource: the first subscriber opens it, every later
 * one shares it, and it closes only when the last subscriber leaves. Subscribers register by event
 * TYPE and receive the raw `MessageEvent`; there is one native listener per type, fanned out to that
 * type's handler set. The EventSource factory is injectable so the pure ref-counting can be tested
 * without a real socket. EventSource's own auto-reconnect is left untouched — a dropped `/api/events`
 * comes back on its own, exactly as it did per-hook.
 */

export type StreamEventHandler = (e: MessageEvent) => void

export interface EventStream {
  /** Subscribe to one event type. Returns an unsubscribe fn; the shared socket closes when the last
   *  subscriber (of any type) unsubscribes. */
  subscribe(type: string, handler: StreamEventHandler): () => void
}

export function createEventStream(makeES: () => EventSource): EventStream {
  let es: EventSource | null = null
  // type → the app handlers waiting on it
  const handlers = new Map<string, Set<StreamEventHandler>>()
  // type → the ONE native listener bound to the current socket that fans out to `handlers`
  const dispatchers = new Map<string, StreamEventHandler>()

  function bind(type: string) {
    if (!es || dispatchers.has(type)) return
    const dispatch: StreamEventHandler = (e) => { handlers.get(type)?.forEach(h => h(e)) }
    dispatchers.set(type, dispatch)
    es.addEventListener(type, dispatch)
  }

  function open() {
    es = makeES()
    // Re-bind every type that already has subscribers to the fresh socket.
    for (const type of handlers.keys()) bind(type)
  }

  function close() {
    if (!es) return
    for (const [type, dispatch] of dispatchers) es.removeEventListener(type, dispatch)
    dispatchers.clear()
    es.close()
    es = null
  }

  function subscribe(type: string, handler: StreamEventHandler): () => void {
    let set = handlers.get(type)
    if (!set) { set = new Set(); handlers.set(type, set) }
    set.add(handler)
    if (!es) open()
    else bind(type)

    return () => {
      const s = handlers.get(type)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) {
        handlers.delete(type)
        const dispatch = dispatchers.get(type)
        if (dispatch && es) es.removeEventListener(type, dispatch)
        dispatchers.delete(type)
      }
      // Last subscriber of any type gone → release the socket (a per-origin connection slot back).
      if (handlers.size === 0) close()
    }
  }

  return { subscribe }
}

/**
 * A code-split bundle DUPLICATES this module into several chunks — measured on the production
 * build, `useData`, `index` and `ConnectionSettings` each carried their own copy. A plain
 * module-level `const` is then a PER-COPY singleton: `useData`'s copy opens one `/api/events`
 * socket and the notification hook's copy (in `index`) opens a SECOND, which is exactly the
 * double-connection this module exists to remove (verified in the browser: 2 live sockets on the
 * production dashboard before this). So the ONE instance is anchored on `globalThis` — the first
 * duplicated copy to run creates it, every other copy reuses it, giving a true cross-chunk
 * singleton and one socket. `createEventStream` stays a pure factory (the tests drive it directly);
 * only the app-wide instance is shared this way.
 */
const GLOBAL_KEY = '__agentisticsEventStream__'
type EventStreamHolder = { [GLOBAL_KEY]?: EventStream }

/** Return the ONE cross-chunk-shared EventStream, creating it on first use. */
export function sharedEventStream(makeES: () => EventSource): EventStream {
  const holder = globalThis as unknown as EventStreamHolder
  return (holder[GLOBAL_KEY] ??= createEventStream(makeES))
}

/** The app-wide shared `/api/events` stream — one socket for the whole app, across every chunk. */
export const eventStream: EventStream = sharedEventStream(() => new EventSource('/api/events'))

/** Subscribe to one `/api/events` event type on the shared socket. */
export function subscribeEvent(type: string, handler: StreamEventHandler): () => void {
  return eventStream.subscribe(type, handler)
}
