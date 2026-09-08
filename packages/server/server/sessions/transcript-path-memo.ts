/**
 * transcript-path-memo.ts — PURE: remembering where a transcript is, and NOT remembering that it
 * is nowhere.
 *
 * THE BUG THIS EXISTS FOR. Three resolvers cached their answer by conversation id — the found path
 * AND the `null` — to keep an unresolvable id costing one scan instead of one scan per poll. The
 * intent is right and the consequence was not: **a harness writes a conversation's transcript when
 * the conversation first says something**, so a session created from the wizard has no file for the
 * first seconds of its life, the chat view's very first poll lands inside that window, and the
 * `null` it got back was then handed to every later poll for the life of the server process.
 *
 * Reported exactly that way: a session started from the UI whose step-3 prompt "never appeared",
 * whose next message sat at `delivered to the session — not read yet` for eight minutes, and whose
 * replies never arrived — while the terminal tab, which reads the pane and not the transcript,
 * showed the whole conversation. Nothing was lost and nothing was queued; the chat was reading a
 * remembered "there is no file here".
 *
 * So: **a found path is remembered forever** (a transcript does not move, and that is a fact about
 * the conversation), and **a miss is remembered only for a while** (it is a fact about the moment).
 * Same rule, and the same reason, as `repo-facts.ts`'s negative TTL.
 */

/**
 * How long a MISS is allowed to stop the expensive scan.
 *
 * The chat view polls every 3s, so this is the difference between one scan per poll and one per
 * half-minute for a conversation that genuinely has no transcript. It is NOT how long a new
 * session waits to become readable: every resolver checks its CHEAP direct path on every call and
 * only the scan is gated — see `resolveChatTranscriptPath`.
 */
export const TRANSCRIPT_MISS_TTL_MS = 30_000

export interface TranscriptPathMemo {
  /** The path this conversation's transcript was found at, or `undefined` if it never has been. */
  get(id: string): string | undefined
  /** Remember a path. Clears any miss — the question is settled. */
  remember(id: string, path: string): void
  /** Record that a scan came back empty at `now`. */
  missed(id: string, now: number): void
  /** May the expensive scan be spent on this id now? `false` only inside a fresh miss's TTL. */
  mayScan(id: string, now: number): boolean
  /** Tests only. */
  clear(): void
}

export function createTranscriptPathMemo(ttlMs = TRANSCRIPT_MISS_TTL_MS): TranscriptPathMemo {
  const found = new Map<string, string>()
  const missedAt = new Map<string, number>()
  return {
    get: id => found.get(id),
    remember(id, path) { found.set(id, path); missedAt.delete(id) },
    missed(id, now) { missedAt.set(id, now) },
    mayScan(id, now) {
      const at = missedAt.get(id)
      return at === undefined || now - at >= ttlMs
    },
    clear() { found.clear(); missedAt.clear() },
  }
}
