/**
 * pinnedSessions.ts — the up-to-three sessions a person keeps in sight.
 *
 * With a busy fleet the two or three sessions that matter right now scatter every time the grouping
 * changes. Pinning says "these I always want to hand": they sit in their own block at the top,
 * OUTSIDE the grouping, and survive a reload. The store is the persisted, shared source of truth
 * (localStorage + an external store), the same shape as `terminalZoom.ts`.
 *
 * The rules are deliberate and pinned by the pure `planPinToggle`:
 *  - a HARD limit (MAX_PINNED), and the one past it is REFUSED, never a silent swap — a swap
 *    surprises, a refusal is predictable;
 *  - pinning/unpinning is the ONLY thing that changes the set — a filter, a grouping or a search
 *    never touches it, and a pinned session that dies stays pinned (shown as ended) until the person
 *    unpins it, so a slot is never taken away behind their back.
 */

const KEY = 'agentistics-pinned-sessions'
export const MAX_PINNED = 10

export interface PinToggleResult {
  next: string[]
  ok: boolean
  /** Why a pin was refused. `limit` = already at MAX_PINNED. */
  reason?: 'limit'
}

/** PURE: the whole rule of toggling a pin. Unpin always succeeds; pinning a new id succeeds only
 *  below the limit, and the fourth is refused with the set left unchanged. */
export function planPinToggle(current: readonly string[], id: string, max = MAX_PINNED): PinToggleResult {
  if (current.includes(id)) return { next: current.filter(x => x !== id), ok: true }
  if (current.length >= max) return { next: [...current], ok: false, reason: 'limit' }
  return { next: [...current, id], ok: true }
}

/**
 * PURE: reorder the pinned set.
 *
 * Total — an index outside the list returns it unchanged rather than throwing or silently
 * appending. A drag can end anywhere, including outside the list, and a reorder that invents a
 * position is worse than one that does nothing.
 *
 * Membership is never touched here: only `planPinToggle` adds or removes.
 */
export function planPinMove(current: readonly string[], from: number, to: number): string[] {
  const next = [...current]
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length) return next
  if (from === to) return next
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/**
 * PURE: which of the pinned KEYS resolve to a row right now, and to which one.
 *
 * Deliberately takes the row list the caller passes, and does no filtering of its own — the
 * pinned band's whole point is that a filter, a search or "active only" must never remove a row
 * from it, so the caller must pass the UNNARROWED fleet. A pinned row that finished while the
 * person was away is exactly the case this exists for: `activeOnly` (on by default in the
 * Sessions workspace) used to cut `pinnedRows` from the same already-`activeOnly`-filtered list
 * the bands read, which silently dropped a pinned session the instant it finished — "pin it,
 * leave, come back, it's gone" needed no reload and no id change to reproduce, only the pinned
 * session finishing before the next look.
 */
export function resolvePinnedRows<T>(
  pins: readonly string[],
  rows: readonly T[],
  keyOf: (row: T) => string,
): T[] {
  return pins
    .map(k => rows.find(r => keyOf(r) === k))
    .filter((r): r is T => r !== undefined)
}

function readInitial(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_PINNED)
  } catch {
    return []
  }
}

let current: string[] = readInitial()
const subscribers = new Set<() => void>()

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* storage may be unavailable; the in-memory set still drives this session */
  }
  for (const fn of subscribers) fn()
}

export function getPinnedIds(): string[] {
  return current
}

export function isSessionPinned(id: string): boolean {
  return current.includes(id)
}

/** Toggle a pin, returning whether it happened (a refused fourth returns ok:false, reason:'limit'). */
export function togglePinnedSession(id: string): PinToggleResult {
  const result = planPinToggle(current, id)
  if (result.ok && (result.next.length !== current.length || !result.next.every((x, i) => x === current[i]))) {
    current = result.next
    persist()
  }
  return result
}

/** Reorder and persist. Subscribers are notified exactly as `togglePinnedSession` notifies them. */
export function movePinnedSession(from: number, to: number): void {
  const next = planPinMove(current, from, to)
  if (next.length === current.length && next.every((x, i) => x === current[i])) return
  current = next
  persist()
}

export function subscribePinnedSessions(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

const EMPTY: string[] = []
/** Stable empty array for `useSyncExternalStore`'s server snapshot (a new [] each call loops). */
export function pinnedServerSnapshot(): string[] {
  return EMPTY
}
