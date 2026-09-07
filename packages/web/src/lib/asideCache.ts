/**
 * asideCache.ts — what the artifacts panel already read, kept across an open/close.
 *
 * The panel's tabs held their answers in component state, so CLOSING the aside destroyed them and
 * opening it again re-read every one from zero — the skills list, the repository's pull requests,
 * a skill's own body. Reported exactly that way: "if I close the aside and come back it reloads
 * everything from scratch, and it is slow as hell". Nothing about those answers is per-mount; they
 * are facts about a SESSION, and the panel is a view of them.
 *
 * IT IS A CACHE, NOT A STORE. Every entry carries when it was read, and `read` says whether what it
 * hands back is STALE. The panel renders the cached answer at once and refreshes behind it, so the
 * list is instant and still current — a cache that could only ever be fresh would have to block,
 * which is the behaviour being fixed, and one that never refreshed would show yesterday's pull
 * requests forever.
 *
 * BOUNDED, and by SESSION. A fleet is dozens of conversations and a browser tab lives for days, so
 * the map is capped and the least-recently-read SESSION goes first — dropping one topic of a
 * session that is still open would make that one tab reload while its siblings did not, which is
 * the same surprise in miniature.
 *
 * It holds only what the server already returned to this browser, and nothing is persisted: a page
 * reload is a new question, and an answer surviving into a session that may have been renamed,
 * reopened or killed in the meantime is a stale claim with nothing left to correct it.
 */

/** How long an answer is believed without a re-read. Long enough to survive an open/close cycle. */
export const ASIDE_TTL_MS = 60_000

/** How many sessions' answers are kept at once. */
export const MAX_ASIDE_SESSIONS = 12

interface Entry<T> {
  value: T
  /** When it was read, by the caller's clock. */
  atMs: number
  /** Last time it was HANDED BACK — what eviction orders on. */
  usedMs: number
}

/** What one lookup answers. `value` absent means nothing is cached and the caller must read. */
export interface AsideRead<T> {
  value?: T
  /**
   * The cached value is older than the TTL.
   *
   * True WITH a `value` means "draw this now, and refresh behind it" — never "discard it". A stale
   * answer on screen while a fresh one is on its way is the whole point; a spinner over an answer
   * we already have is the reload this module exists to remove.
   */
  stale: boolean
}

export interface AsideCache {
  read<T>(key: string, nowMs?: number): AsideRead<T>
  write<T>(key: string, value: T, nowMs?: number): void
  /** Forget everything about one session — after a kill, or when the row is gone. */
  forgetSession(sessionId: string): void
  clear(): void
}

/** The key one answer is filed under. A session AND a topic, never a topic alone. */
export function asideKey(sessionId: string, topic: string, detail = ''): string {
  return detail ? `${sessionId} ${topic} ${detail}` : `${sessionId} ${topic}`
}

/** Does this key belong to that session? Exact on the id — a prefix would match `abc` from `abcd`. */
export function keyOfSession(key: string, sessionId: string): boolean {
  return key.startsWith(`${sessionId} `)
}

export function createAsideCache(max = MAX_ASIDE_SESSIONS, ttlMs = ASIDE_TTL_MS): AsideCache {
  const entries = new Map<string, Entry<unknown>>()

  const evict = (): void => {
    const seen = new Map<string, number>()
    for (const [k, e] of entries) {
      const id = k.split(' ')[0] ?? ''
      seen.set(id, Math.max(seen.get(id) ?? 0, e.usedMs))
    }
    if (seen.size <= max) return
    const order = [...seen.entries()].sort((a, b) => a[1] - b[1])
    for (const [id] of order.slice(0, seen.size - max)) {
      for (const k of [...entries.keys()]) if (keyOfSession(k, id)) entries.delete(k)
    }
  }

  return {
    read<T>(key: string, nowMs = Date.now()): AsideRead<T> {
      const hit = entries.get(key)
      if (!hit) return { stale: true }
      hit.usedMs = nowMs
      return { value: hit.value as T, stale: nowMs - hit.atMs >= ttlMs }
    },
    write<T>(key: string, value: T, nowMs = Date.now()): void {
      entries.set(key, { value, atMs: nowMs, usedMs: nowMs })
      evict()
    },
    forgetSession(sessionId: string): void {
      for (const k of [...entries.keys()]) if (keyOfSession(k, sessionId)) entries.delete(k)
    },
    clear(): void { entries.clear() },
  }
}

/** The one cache the panel uses. Module-level, so it outlives every mount of the aside. */
export const asideCache = createAsideCache()
