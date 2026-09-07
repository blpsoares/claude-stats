/**
 * chatFeed.ts — ONE read of a conversation, shared by whoever is watching it, and kept WARM for a
 * while after they leave.
 *
 * THE BUG THIS EXISTS FOR: "se eu saio de um chat e volto, por um instante fica meu último prompt
 * ali e, do nada, carrega todas as novas mensagens".
 *
 * `sessionScratch` caches the conversation so returning paints instantly instead of showing an
 * empty column, and the view re-fetches on mount so the cache is never the answer, only the first
 * frame. That is right, and it has one consequence nobody wrote down: THE CACHE IS ONLY WRITTEN
 * WHILE THE VIEW IS MOUNTED, so its age is exactly how long you have been away. Leave a session
 * mid-turn, spend two minutes elsewhere, come back — the first frame is the conversation as it was
 * when you left, ending at your own last message, and every reply that landed in between arrives
 * in one jump a few hundred milliseconds later. The jump is not a slow fetch (the read answers in
 * 66-143 ms on every session on this machine); it is a first frame that was two minutes old.
 *
 * So the fix is not a faster fetch, it is a first frame that is not stale: the conversation you
 * just left KEEPS BEING READ for a few minutes, at a relaxed cadence, and returning to it paints
 * something current. Both halves are bounded, because a background poll nobody asked for is the
 * kind of thing that quietly costs a machine:
 *
 *   - only the `MAX_WARM` most recently left conversations, never every cached one;
 *   - only while the document is VISIBLE — a hidden tab has no reader to be surprised;
 *   - only for `WARM_TTL_MS`, after which the conversation is on its own again;
 *   - never for a conversation whose session has ENDED, whose transcript cannot change.
 *
 * What it deliberately does NOT do is claim the cached frame is current. When the first frame IS
 * stale — the tab was hidden, or you were away longer than the warm window — the view says it is
 * updating, because content that changes under the reader with nothing said is the complaint this
 * whole module is answering.
 */

import { sessionScratch, type CachedChat } from './sessionScratch'

/** Matches the fleet poll. The transcript only changes when a turn lands, so faster buys nothing. */
export const FOREGROUND_POLL_MS = 3000

/**
 * How often a conversation NOBODY IS LOOKING AT is re-read.
 *
 * Deliberately much slower than the foreground: the only thing this cadence buys is the age of the
 * FIRST FRAME on return, and the view's own read on mount closes whatever gap is left. Ten seconds
 * means that first frame is at most one turn behind — usually identical — for a tenth of the
 * requests a foreground poll would spend on a conversation nobody has open.
 */
export const WARM_POLL_MS = 10000

/**
 * How long a conversation stays warm after its last watcher leaves.
 *
 * Long enough to cover going somewhere else and coming back, short enough that a session opened
 * once and abandoned stops costing anything. Past it the cached frame is stale and SAID to be.
 */
export const WARM_TTL_MS = 5 * 60_000

/** How many left-behind conversations stay warm at once. The most recently left win. */
export const MAX_WARM = 2

/**
 * How old a cached first frame may be before the view says it is updating.
 *
 * A second and a half is comfortably more than one foreground poll plus its round trip, so a frame
 * that is merely between ticks is never announced as stale — only one that is actually behind.
 */
export const STALE_FRAME_MS = 1500

/** What this module knows about one conversation. Pure data, so every decision below is testable. */
export interface FeedEntry {
  /** How many mounted surfaces are watching it right now. */
  watchers: number
  /** When the last watcher left, or null while one is still there. */
  leftAt: number | null
  /** When a read was last ATTEMPTED — the cadence is measured on attempts, so a failing read
   *  waits its turn like any other instead of being retried on every tick. */
  triedAt: number | null
  /** The last answer said the session is not running, so its transcript is final. */
  ended: boolean
}

export function newEntry(): FeedEntry {
  return { watchers: 0, leftAt: null, triedAt: null, ended: false }
}

/** Is this conversation due for a read right now? */
export function feedDue(e: FeedEntry, now: number, visible: boolean): boolean {
  const since = e.triedAt === null ? Infinity : now - e.triedAt
  // WATCHED: the cadence the view has always had. A hidden tab still counts as watched — the
  // browser throttles its timers to about once a minute by itself, and coming back into view asks
  // immediately (`refreshChat`), which is what covers the gap.
  if (e.watchers > 0) return since >= FOREGROUND_POLL_MS
  // WARM: a conversation nobody has open, being kept current for a possible return.
  if (!visible) return false
  if (e.ended) return false
  if (feedExpired(e, now)) return false
  return since >= WARM_POLL_MS
}

/**
 * Has the warm window closed? A watched conversation never expires.
 *
 * An ENDED one goes AT ONCE: its transcript is final, so nothing would re-read it, and an entry
 * that is never read is pure memory — it holds the last answer's bytes. What a reopened
 * conversation needs is only the STAMP, and that outlives the entry in `readStamps`.
 */
export function feedExpired(e: FeedEntry, now: number): boolean {
  if (e.watchers > 0) return false
  if (e.ended) return true
  if (e.leftAt === null) return false
  return now - e.leftAt >= WARM_TTL_MS
}

/**
 * Which warm conversations to let go of, keeping the `max` most recently left.
 *
 * Watched ones are never dropped, whatever they cost — something is on screen showing them.
 */
export function warmToDrop(entries: readonly (readonly [string, FeedEntry])[], max = MAX_WARM): string[] {
  const warm = entries.filter(([, e]) => e.watchers === 0)
  const ordered = [...warm].sort((a, b) => (b[1].leftAt ?? 0) - (a[1].leftAt ?? 0))
  return ordered.slice(max).map(([k]) => k)
}

/**
 * Is the frame this view is about to paint from the cache old enough to be worth saying so?
 *
 * An UNKNOWN age counts as stale: the payload was cached by a version of this app, or a mount, that
 * this module never saw read it, and presenting a frame of unknown age as current is the exact
 * thing being fixed. `null` here means "no cached frame at all", which is the loading state and not
 * this question — the caller only asks once it has something to paint.
 */
export function firstFrameStale(at: number | null | undefined, now: number): boolean {
  if (at === null || at === undefined) return true
  return now - at >= STALE_FRAME_MS
}

// ---------------------------------------------------------------------------------------------
// The live half: one entry per session id, one timer for all of them.
// ---------------------------------------------------------------------------------------------

interface LiveEntry extends FeedEntry {
  /** The session id the route takes. */
  id: string
  /** The scratch key the CACHE is filed under — the conversation, not the row. Kept up to date by
   *  every subscribe, because a live row learns its `conversationId` mid-use. */
  key: string
  lang: string
  listeners: Set<(payload: CachedChat) => void>
  inFlight: boolean
  /**
   * The last answer's raw bytes — and NOT the object parsed from them.
   *
   * A transcript changes when a turn lands and not otherwise, so most reads answer exactly what the
   * last one did, and handing the view a NEW object each time re-rendered the whole conversation
   * every three seconds for nothing. Comparing the bytes is what lets the unchanged case hand back
   * the SAME instance, which React's own `Object.is` bail-out turns into no render at all.
   *
   * The instance it hands back is READ FROM `sessionScratch`, never held here. That cache caps
   * itself at `MAX_CACHED_CHATS` precisely because a conversation is hundreds of turns and an
   * unbounded map grows with how much of the product you use — and a reference kept in this module
   * would pin exactly the payloads that cap exists to release, defeating it from outside. When the
   * cache has moved on, the bytes are parsed again: one render, no leak.
   *
   * `raw` itself is bounded by the entry, and entries are bounded to what is being POLLED — the
   * one conversation on screen plus `MAX_WARM`. Measured over the 14 sessions on this machine, the
   * largest chat read is 132 KB and the median far below it, so the ceiling here is a few hundred
   * KB held only while those conversations are in use — against a `sessionScratch` that already
   * holds ten parsed conversations by design.
   */
  raw: string | null
}

const entries = new Map<string, LiveEntry>()

/**
 * WHEN each conversation's cached frame was last read — the one thing that must outlive the entry.
 *
 * Two numbers per conversation is nothing, and it is what lets everything else be dropped
 * aggressively: an entry can go the moment nobody is reading it, because the answer to "is the
 * frame I am about to paint behind?" no longer lives on it.
 *
 * Capped and evicted oldest-first for the same reason `MAX_CACHED_CHATS` is: a map that only ever
 * grows is a leak whether its rows are small or not. An evicted stamp reads as an unknown age,
 * which `firstFrameStale` already treats as stale — the safe direction.
 */
const readStamps = new Map<string, number>()

/** How many conversations keep a read stamp. Well past `MAX_CACHED_CHATS`, because a stamp costs
 *  a number and the cached frame it describes costs hundreds of KB. */
export const MAX_STAMPS = 50

/** PURE: the stamps to forget, oldest read first, once the map is over budget. */
export function stampsToDrop(stamps: readonly (readonly [string, number])[], max = MAX_STAMPS): string[] {
  if (stamps.length <= max) return []
  return [...stamps].sort((a, b) => a[1] - b[1]).slice(0, stamps.length - max).map(([k]) => k)
}

function stampRead(key: string, at: number): void {
  readStamps.set(key, at)
  for (const k of stampsToDrop([...readStamps])) readStamps.delete(k)
}

let ticker: ReturnType<typeof setInterval> | null = null

/** The ticker asks every second and the per-entry cadence decides — one timer, any number of
 *  conversations, and a cadence that can change (watched -> warm) without rescheduling anything. */
const TICK_MS = 1000

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function startTicker(): void {
  if (ticker !== null || typeof setInterval === 'undefined') return
  ticker = setInterval(tick, TICK_MS)
}

function stopTicker(): void {
  if (ticker === null) return
  clearInterval(ticker)
  ticker = null
}

function tick(): void {
  const now = Date.now()
  const vis = visible()
  for (const [key, e] of [...entries]) {
    if (feedExpired(e, now)) { entries.delete(key); continue }
  }
  for (const key of warmToDrop([...entries].map(([k, e]) => [k, e] as const))) entries.delete(key)
  if (entries.size === 0) { stopTicker(); return }
  for (const e of [...entries.values()]) if (feedDue(e, now, vis)) void read(e)
}

async function read(e: LiveEntry): Promise<void> {
  if (e.inFlight) return
  e.inFlight = true
  e.triedAt = Date.now()
  try {
    const res = await fetch(`/api/fleet/chat?id=${encodeURIComponent(e.id)}&lang=${e.lang}`)
    if (!res.ok) return
    const text = await res.text()
    // The frame is CURRENT as of now whether or not it changed — freshness is when the answer was
    // last confirmed, not when it last differed.
    stampRead(e.key, Date.now())
    const held = e.raw === text ? sessionScratch.readChat(e.key) : null
    if (held !== null) {
      // Same instance, deliberately: the watchers still hear that a read landed (which is what
      // clears "updating"), and React renders nothing. Read back rather than kept, so this module
      // pins no conversation the cache has already let go of.
      for (const cb of [...e.listeners]) cb(held)
      return
    }
    const next = JSON.parse(text) as CachedChat
    e.raw = text
    e.ended = next.live === false
    // Write through, so the NEXT visit starts where this one ended.
    sessionScratch.writeChat(e.key, next)
    for (const cb of [...e.listeners]) cb(next)
  } catch {
    /* transient — keep the last conversation rather than blanking it */
  } finally {
    e.inFlight = false
  }
}

/**
 * Watch one conversation. Returns the unsubscribe, which leaves it WARM rather than stopping it.
 *
 * `key` is the scratch key (the conversation), `id` the session id the route takes — the two are
 * different things and `scratchKey` explains why.
 */
export function subscribeChat(
  opts: { id: string; key: string; lang: string },
  onPayload: (payload: CachedChat) => void,
): () => void {
  let e = entries.get(opts.id)
  if (!e) {
    e = {
      ...newEntry(),
      id: opts.id, key: opts.key, lang: opts.lang,
      listeners: new Set(), inFlight: false, raw: null,
    }
    entries.set(opts.id, e)
  }
  const entry = e
  // A row that has just learned its `conversationId` files its cache under a new name; the feed
  // keeps reading the same session and starts writing to the new slot.
  entry.key = opts.key
  // A language change is a DIFFERENT answer from the same route (the harness labels are localized),
  // so the bytes it last saw no longer describe what it would get back.
  if (entry.lang !== opts.lang) { entry.lang = opts.lang; entry.raw = null }
  entry.watchers += 1
  entry.leftAt = null
  entry.listeners.add(onPayload)
  startTicker()
  // The mount's own read. Whatever the cache holds, the view asks once for itself — that has always
  // been the rule here, and it is what makes the cache "the first frame, never the answer".
  void read(entry)
  return () => {
    entry.listeners.delete(onPayload)
    entry.watchers = Math.max(0, entry.watchers - 1)
    if (entry.watchers === 0) entry.leftAt = Date.now()
  }
}

/**
 * Ask for this conversation NOW, outside the cadence.
 *
 * The two moments a reader is actually waiting are not on the interval: the instant a message is
 * sent, and the instant a turn ends.
 */
export function refreshChat(id: string): void {
  const e = entries.get(id)
  if (e) void read(e)
}

/** When the cached frame for this conversation was read, or null if this session never read it. */
export function chatReadAt(key: string): number | null {
  return readStamps.get(key) ?? null
}

/** Testing seam: forget everything, including the timer. */
export function resetChatFeed(): void {
  entries.clear()
  readStamps.clear()
  stopTicker()
}
