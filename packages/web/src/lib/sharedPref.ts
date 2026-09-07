/**
 * sharedPref.ts — state that belongs to the WORK, kept where every device can see it.
 *
 * THE PROBLEM THIS EXISTS FOR. The dashboard is one process on one machine, reached over Tailscale
 * from a phone, a tablet and a desktop. Everything it computes is already shared — sessions,
 * metrics, transcripts — but a whole category of state had drifted into `localStorage`, which is
 * per browser and never leaves it. So the same application answered "which sessions am I holding",
 * "which warnings did I dismiss", "what should notify me" differently on each device. Reported as
 * "as coisas se comportam de forma diferente… é literalmente a mesma aplicação".
 *
 * It was never decided; it accumulated. `localStorage` is the shortest path at the moment a store
 * is written, so each one took it. This module is the decision, made once.
 *
 * THE LINE. State about the WORK is shared (pins, dismissals, what notifies me, how I read a list).
 * State about the SCREEN stays local — terminal zoom, pane widths, a collapsed sidebar, a window's
 * position, and the two caches that exist to make the first paint instant. A phone and a 27-inch
 * monitor disagreeing about a pane width is correct; disagreeing about a pinned session is not.
 *
 * TWO RULES, both learned from real defects:
 *
 * 1. THE BROWSER COPY IS THE FIRST PAINT, NEVER THE TRUTH. It decides what is drawn before the
 *    server answers and is corrected a moment later — the pattern `App.tsx` already uses for the
 *    theme and the card order. Waiting for the network to draw a list is a blank frame on every
 *    load; trusting the local copy is three applications again.
 *
 * 2. THE WRITE IS ARMED ONLY BY A SUCCESSFUL LOAD — the rule `a11y-prefs.ts` states for the same
 *    trap. A central answers 401 until login and a machine can still be starting up. Treating that
 *    failure as "the shared value is empty" would let the first change made on one device write its
 *    local state over what every other device holds. Unarmed, a device works from its local copy
 *    and writes nothing: a device that cannot READ the shared value is exactly the one that must
 *    not overwrite it.
 *
 * ONE GET FOR ALL OF THEM. Every store registers here, and `loadSharedPrefs()` reads
 * `/api/preferences` ONCE and dispatches. Six stores fetching independently on every refocus is six
 * requests to answer one question. Writes stay per store — `writePreferences` is a shallow merge
 * across preference keys, so two stores writing different keys cannot clobber each other.
 */

export interface SharedPrefStore<T> {
  /** The value in force right now — local copy until the load lands, shared value after. */
  get(): T
  /** Change it here and, once armed, everywhere. */
  set(next: T): void
  subscribe(fn: () => void): () => void
  /** Stable reference for `useSyncExternalStore`'s server snapshot (a fresh object each call loops). */
  serverSnapshot(): T
}

interface Registered {
  prefKey: string
  adopt: (raw: unknown) => void
}

const registry: Registered[] = []

/** False until `/api/preferences` has answered once. See rule 2. */
let armed = false

/** Test seam: the module state is process-wide, so a test that loads must be able to reset it. */
export function resetSharedPrefs(): void {
  armed = false
  registry.length = 0
}

/**
 * PURE: is this incoming value the same as the one held?
 *
 * Compared structurally, so an equal value that arrives as a different object does NOT notify —
 * a re-render loop is the cost, and every one of these stores feeds `useSyncExternalStore`.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createSharedPref<T>(opts: {
  /** The `localStorage` key. Kept for the first paint, and kept COMPATIBLE — an existing key must
   *  go on being read, or every device silently loses what it had on the day this shipped. */
  key: string
  /** The field inside `/api/preferences`. */
  prefKey: string
  /** What is in force when neither side has anything to say. */
  fallback: T
  /** Total: anything unrecognised yields `null` and the caller keeps what it has. A stored document
   *  can be hand-edited or written by an older build, and a throw here is a blank dashboard. */
  parse: (raw: unknown) => T | null
}): SharedPrefStore<T> {
  const { key, prefKey, fallback, parse } = opts

  let current: T = (() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return fallback
      return parse(JSON.parse(raw)) ?? fallback
    } catch {
      return fallback
    }
  })()

  const subscribers = new Set<() => void>()
  const notify = () => { for (const fn of subscribers) fn() }
  const writeLocal = () => {
    try { localStorage.setItem(key, JSON.stringify(current)) } catch { /* private mode */ }
  }

  registry.push({
    prefKey,
    adopt: (raw: unknown) => {
      const shared = raw === undefined ? fallback : parse(raw)
      if (shared === null || sameValue(shared, current)) return
      current = shared
      writeLocal()
      notify()
    },
  })

  return {
    get: () => current,
    set: (next: T) => {
      if (sameValue(next, current)) return
      current = next
      writeLocal()
      if (armed) {
        void fetch('/api/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [prefKey]: current }),
        }).catch(() => { /* it holds here; the next load reconciles */ })
      }
      notify()
    },
    subscribe: (fn: () => void) => {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    },
    serverSnapshot: () => current,
  }
}

/**
 * Read the shared values and adopt them. Idempotent; safe on every mount and every refocus.
 *
 * A failure leaves `armed` false and every store on its local copy — see rule 2. It deliberately
 * does not report the failure: there is nothing for a person to do about it, and a dashboard that
 * announces "could not reach preferences" on a machine that is merely starting up is noise.
 */
export async function loadSharedPrefs(): Promise<void> {
  try {
    const res = await fetch('/api/preferences')
    if (!res.ok) return
    const prefs = await res.json() as Record<string, unknown>
    armed = true
    for (const store of registry) store.adopt(prefs[store.prefKey])
  } catch {
    /* offline, or a central that has not signed us in yet — stay unarmed and local */
  }
}
