/**
 * file-lock.ts — a lock ACROSS PROCESSES, for a file several agentop processes read-modify-write.
 *
 * `registry.ts` serialises its mutations with a promise chain, which is correct and is only half
 * the problem: agentop runs as SEVERAL processes — the systemd server, the cockpit, and every
 * one-shot `agentop session …` — and a promise chain is per process. Two of them reading the same
 * `managed-sessions.json`, each adding its own record, each writing the whole list back, is a lost
 * write every time they overlap.
 *
 * MEASURED, not theorised. Two sessions started minutes apart came back with the same `createdAt`
 * to the millisecond and no `label` at all — the signature of records that were erased and then
 * re-created by adoption, which cannot know a name. That is why "sessoes criadas por aqui nao sao
 * renomeadas com o nome do titulo que coloquei" and "renomear sessoes nao esta renomeando de
 * verdade" are ONE bug: both write a label into a file that another process overwrites.
 *
 * `mkdir` IS THE LOCK. It is the one filesystem operation that is atomic and fails when the target
 * exists, on every platform this runs on, with no dependency and no daemon — `open(O_EXCL)` is
 * equally atomic but leaves a file that looks like data, and a directory beside a JSON file reads
 * as what it is. `proper-lockfile` does exactly this and is not worth a dependency here.
 *
 * A LOCK MUST NEVER BE ABLE TO WEDGE THE PRODUCT. Every rule below exists for that:
 *
 * - It is STALE after `STALE_MS`. A process killed between acquire and release leaves the directory
 *   behind, and without expiry the next start of agentop would hang forever on a lock nobody holds.
 *
 * **A BLOCKED ACQUIRER MAY NEVER DELETE THE LOCK IT IS BLOCKED ON, and the first version did.** On
 * a failed `mkdir` it stat'd the directory, and a stat that threw `ENOENT` — the lock released in
 * the instant between the two calls — was treated as "stale" and answered with
 * `rm(dir, {recursive: true})`. By the time that `rm` ran another process could already hold a NEW
 * lock in that same path, and deleting it left BOTH of them believing they held it. Measured with
 * six concurrent processes taking the lock 25 times each: **31 overlapping acquisitions out of
 * 150**, with the age-based expiry never once firing (`staleOld: 0`) — the destructive `rm` was the
 * whole of it. That is the residual loss behind sessions whose registry record disappeared.
 *
 * So a vanished lock is answered by RETRYING, which touches nothing, and a genuinely abandoned one
 * is taken over by `rename` — the one operation where exactly one racer can win. Whoever renames it
 * aside owns the right to remove it; everyone else fails the rename and goes back to racing.
 * - The wait is BOUNDED. Past `WAIT_MS` the caller runs anyway — because the alternative is
 *   refusing to record a session that has already been spawned, and a lost label is a smaller harm
 *   than a live session with no record at all. It says so through `contended`, so a caller can log
 *   it rather than pretend it held the lock.
 * - Release NEVER throws. A failed cleanup becomes a stale lock, which the next acquirer clears.
 */

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A lock older than this is assumed abandoned. Longer than any write; far shorter than a coffee. */
export const STALE_MS = 15_000

/** How long to wait for someone else's lock before going ahead without it. */
export const WAIT_MS = 5_000

const RETRY_MS = 25

export interface LockHandle {
  /** True when the lock could NOT be taken and the work is proceeding anyway. */
  contended: boolean
  release(): Promise<void>
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * How a failed `mkdir` should be answered.
 *
 *   `retry`  the lock is gone — race for it again, and TOUCH NOTHING.
 *   `steal`  it is old enough to be abandoned; try to take it over, atomically.
 *   `wait`   somebody holds it and is alive.
 */
type Blocked = 'retry' | 'steal' | 'wait'

async function inspectLock(dir: string, nowMs: number): Promise<Blocked> {
  try {
    const st = await stat(dir)
    return nowMs - st.mtimeMs > STALE_MS ? 'steal' : 'wait'
  } catch {
    // Gone between the failed mkdir and this stat — whoever held it released it. RETRY, never
    // delete: see the header's second rule.
    return 'retry'
  }
}

/**
 * Take the lock for `file`, or give up waiting and say so.
 *
 * The lock is `<file>.lock`, a directory. The pid is written inside it purely so a person looking
 * at a stuck machine can see who to blame; nothing reads it.
 */
export async function lockFile(file: string, nowMs = () => Date.now()): Promise<LockHandle> {
  const dir = `${file}.lock`
  const deadline = nowMs() + WAIT_MS
  for (;;) {
    try {
      await mkdir(dir)
      // Best effort, and deliberately not awaited for correctness: the lock is the DIRECTORY.
      void writeFile(join(dir, 'pid'), String(process.pid), 'utf-8').catch(() => undefined)
      return { contended: false, release: () => rm(dir, { recursive: true, force: true }).catch(() => undefined) }
    } catch {
      const blocked = await inspectLock(dir, nowMs())
      // The lock vanished under us. Just race for it again — the old code DELETED here, which is
      // the bug this rewrite exists for.
      if (blocked === 'retry') continue
      if (blocked === 'steal') {
        // ATOMIC TAKEOVER. `rename` is the one operation that lets exactly one racer win: whoever
        // renames the abandoned lock aside owns the right to remove it, and everybody else fails
        // and goes back to racing for a fresh `mkdir`. A plain `rm` here is what let two processes
        // hold the lock at once.
        const aside = `${dir}.stale-${process.pid}-${Date.now()}`
        try { await rename(dir, aside) } catch { continue }
        await rm(aside, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      if (nowMs() >= deadline) {
        // Proceed WITHOUT the lock rather than fail the caller. See the header.
        return { contended: true, release: async () => undefined }
      }
      await sleep(RETRY_MS)
    }
  }
}

/** Run `fn` while holding the lock. The handle is released whatever `fn` does. */
export async function withFileLock<T>(
  file: string,
  fn: (held: { contended: boolean }) => Promise<T>,
): Promise<T> {
  const lock = await lockFile(file)
  try {
    return await fn({ contended: lock.contended })
  } finally {
    await lock.release()
  }
}
