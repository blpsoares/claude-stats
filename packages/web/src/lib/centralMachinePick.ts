/**
 * centralMachinePick.ts — which machine a CENTRAL's Sessions workspace is looking at.
 *
 * Module scope, not React state, for the same reason `fleet.ts`'s poller is: the picker draws in
 * the aside and the fleet is fetched by the poller, and two copies of "which machine" is how a list
 * ends up describing one machine while a header counts another.
 *
 * Remembered per browser, so reopening the app lands where you left it.
 */

const KEY = 'agentistics-central-machine'

let picked: string | null = null
let loaded = false
const listeners = new Set<() => void>()

function load(): void {
  if (loaded) return
  loaded = true
  try { picked = localStorage.getItem(KEY) } catch { picked = null }
}

export function getCentralMachine(): string | null {
  load()
  return picked
}

export function setCentralMachine(id: string | null): void {
  load()
  if (picked === id) return
  picked = id
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch { /* private mode — the memory is a convenience, the selection still works */ }
  for (const fn of listeners) fn()
}

export function subscribeCentralMachine(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** `useSyncExternalStore`'s server snapshot — there is no machine before hydration. */
export function centralMachineServerSnapshot(): string | null {
  return null
}
