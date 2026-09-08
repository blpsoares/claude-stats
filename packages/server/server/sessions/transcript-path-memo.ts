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
 * So: **a miss is remembered only for a while** (it is a fact about the moment) — same rule, and the
 * same reason, as `repo-facts.ts`'s negative TTL — and **a found path is remembered until it stops
 * being there**, which is a weaker claim than the one this module shipped with. It said "a found
 * path is remembered forever (a transcript does not move)". It moves, and it is also deleted; that
 * sentence cost a user every reply for the length of a session. `resolveMemoizedPath` at the foot of
 * this file is where the corrected rule lives, and its comment carries the measurement.
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
  /** Drop a remembered path that is no longer on disk. Leaves NO miss behind, so the resolve
   *  that discovered the staleness may scan on that same call — see `resolveMemoizedPath`. */
  forget(id: string): void
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
    forget(id) { found.delete(id) },
    missed(id, now) { missedAt.set(id, now) },
    mayScan(id, now) {
      const at = missedAt.get(id)
      return at === undefined || now - at >= ttlMs
    },
    clear() { found.clear(); missedAt.clear() },
  }
}

/**
 * A REMEMBERED PATH IS STILL A GUESS UNTIL IT IS STATTED, and the header above used to say
 * otherwise: "a found path is remembered forever — a transcript does not move". It does move.
 *
 * Claude Code files a transcript under the project directory derived from the session's CURRENT
 * cwd, so a session whose cwd changes has its `<conversation-id>.jsonl` MOVED wholesale to another
 * project directory. Measured 2026-09-08 on a live session: the file left
 * `~/.claude/projects/-home-mithrandir-agentistics/` and reappeared, whole and still being written,
 * under `…--claude-worktrees-session-shell/`. Every later resolve answered the remembered path,
 * `readChatWindow` failed on a file that was not there, the catch turned that into `turns: []`, and
 * because the session was LIVE the payload carried no `unavailable` — so the panel drew "This
 * conversation has no messages yet" over a 2.4 MB transcript. The user stopped seeing replies
 * entirely and had to attach to the terminal to read anything.
 *
 * The cwd change is not the only way to get there, and not the common one. **Claude Code deletes
 * transcripts older than `cleanupPeriodDays` (30 by default) on every startup** — so any long-lived
 * server that once resolved a conversation holds a path to a file that is eventually deleted under
 * it, and answers with it forever. A moved file and a deleted file fail identically here.
 *
 * The scan that would find the file in its new home was already written and already correct. It was
 * simply never reached, because the memo answered first. So: verify before answering, and on a
 * remembered path that is gone, FORGET it and resolve again from scratch. `remember` clears any
 * miss, so a forgotten id is free to scan immediately — a stale path must never buy the miss TTL.
 *
 * The cost is ONE `stat` on a memo hit, which is exactly what a memo MISS already spent on its
 * direct path. It is not a new class of work, and it is the whole of the fix.
 */

/** Is this path still on disk? Injected so this module stays pure and testable without a fixture. */
export type PathExists = (path: string) => Promise<boolean>

export interface MemoizedResolve {
  exists: PathExists
  /**
   * The CHEAP guess, tried on every call before any scan — Claude's cwd-encoded project directory.
   * Absent for the resolvers that have no direct form and can only search.
   */
  direct?: () => Promise<string | null>
  /** The EXPENSIVE search. Gated by the miss TTL, never by a stale hit. */
  scan: () => Promise<string | null>
  now: number
}

/**
 * The one shape all three transcript resolvers share: remembered, then direct, then scanned.
 *
 * It lives here rather than being written out in `chat-tail.ts`, in `resolveCodexTranscript` and in
 * `resolveKimiTranscript` because it WAS written out in all three, identically, and the staleness
 * above was therefore three bugs. A rule with three copies is the defect `task-reopen.ts` exists to
 * have fixed once.
 */
export async function resolveMemoizedPath(
  memo: TranscriptPathMemo,
  id: string,
  o: MemoizedResolve,
): Promise<string | null> {
  const known = memo.get(id)
  if (known !== undefined) {
    if (await o.exists(known)) return known
    // Moved or deleted. Forgetting is not enough on its own — it is what lets the scan below run
    // on this very call instead of on the far side of a TTL the stale hit never paid.
    memo.forget(id)
  }
  if (o.direct) {
    const d = await o.direct()
    if (d !== null) { memo.remember(id, d); return d }
  }
  if (!memo.mayScan(id, o.now)) return null
  memo.missed(id, o.now)
  const found = await o.scan()
  if (found !== null) memo.remember(id, found)
  return found
}
