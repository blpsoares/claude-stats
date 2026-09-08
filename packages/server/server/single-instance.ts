import { open, readFile, unlink, stat } from 'fs/promises'
import { dirname } from 'path'
import { mkdir } from 'fs/promises'

/**
 * One server per machine, decided BEFORE any work is spent.
 *
 * Four server processes were once found running side by side on one laptop, each independently
 * walking every repository — the same work, four times, for one dashboard. They were not
 * malicious or exotic: a `dev:api` left running in a worktree, an autostart service, and two
 * copies launched in the SAME SECOND by a supervisor that did not check.
 *
 * The port bind cannot be what prevents this. It happens ~2200 lines into `index.ts`, long after
 * the file watcher and the first data build have started, so a duplicate has already spent minutes
 * of CPU and hundreds of megabytes before it ever learns the address is taken. And two processes
 * starting together both pass a "is the port free?" probe, which is exactly what happened.
 *
 * So the claim is made with `O_EXCL`, which is atomic: of two processes racing to create the same
 * file, the kernel lets exactly one win. The loser exits immediately, having spent nothing.
 */
export interface InstanceLock {
  /** Release the claim. Safe to call twice, and safe when the file is already gone. */
  release(): Promise<void>
}

export interface LockHeld {
  ok: false
  /** PID of the process that holds it, when it could be read. */
  holder?: number
}

export type LockResult = ({ ok: true } & InstanceLock) | LockHeld

/** How long a lock whose contents cannot be read is still believed.
 *
 *  Creating the file and writing the pid into it are two operations, so there is a moment where a
 *  winner's lock is EMPTY. A reader arriving in that moment must not conclude "unreadable, so
 *  stale" and delete the claim out from under it — that turns the guard into the very race it
 *  exists to prevent. An empty lock is therefore obeyed while it is fresh, and only treated as
 *  debris once it is older than any plausible gap between those two operations. */
const UNREADABLE_GRACE_MS = 5_000

/** Is this PID a live process? `kill(pid, 0)` signals nothing and only tests reachability. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else — alive for our purposes.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Was this file written recently enough that an unreadable one deserves the benefit of doubt? */
async function isFresh(file: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(file)).mtimeMs < UNREADABLE_GRACE_MS
  } catch {
    // Gone between the failed create and now — nobody holds it.
    return false
  }
}

/**
 * Claim the lock at `file`, or report who holds it.
 *
 * A STALE lock — one naming a pid that is gone, which is what a crash or a `kill -9` leaves
 * behind — is removed and re-claimed, because refusing to start after a crash would be a worse
 * failure than the one this prevents. The re-claim goes through the same `O_EXCL` create, so two
 * processes finding the same stale lock still produce exactly one winner.
 */
export async function claimInstanceLock(file: string, pid: number = process.pid): Promise<LockResult> {
  await mkdir(dirname(file), { recursive: true }).catch(() => {})

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' — create, and FAIL if it exists. The atomicity this whole module rests on.
      const handle = await open(file, 'wx')
      try {
        await handle.writeFile(String(pid))
      } finally {
        await handle.close()
      }
      return {
        ok: true,
        async release() {
          // Only remove a lock that is still OURS: on a slow shutdown the pid may already have
          // been re-claimed by the next server, and deleting it would let a third one in.
          try {
            const held = parseInt((await readFile(file, 'utf-8')).trim(), 10)
            if (held === pid) await unlink(file)
          } catch { /* already gone, or unreadable — nothing to release */ }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // The lock cannot be created at all (read-only home, no permission). Refusing to start
        // over that would be worse than the duplicate it guards against — degrade to allowed.
        return { ok: true, async release() { /* nothing was claimed */ } }
      }
      let holder: number | undefined
      try {
        const raw = (await readFile(file, 'utf-8')).trim()
        const parsed = parseInt(raw, 10)
        if (Number.isInteger(parsed) && parsed > 0) holder = parsed
      } catch { /* unreadable — handled with the same grace as an empty file */ }

      if (holder !== undefined) {
        if (isAlive(holder)) return { ok: false, holder }
      } else if (await isFresh(file)) {
        // Empty or unparseable, but new: almost certainly a winner mid-write. Yield to it.
        return { ok: false }
      }

      // Stale (or unreadable): drop it and go round once more. Bounded at one retry so a lock
      // being recreated as fast as we delete it ends as "held" rather than as a spin.
      await unlink(file).catch(() => {})
    }
  }
  return { ok: false }
}
