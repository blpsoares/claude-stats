/**
 * process-conversation.ts — the IO half of `agy-conversation.ts`: which conversation the process
 * behind one of our panes is writing, read from the log that process holds OPEN.
 *
 * The pure module holds every RULE (which file, which line, and every refusal); this one only
 * performs the two reads and never decides anything. Same split as
 * `harness-session-file.ts` / `harness-sessions.ts`, and for the same reason: the rules are what
 * needs pinning against real bytes, and the filesystem is what must never throw into the poll.
 *
 * ## Cost, and why it is asked so narrowly
 *
 * The poll runs every five seconds over the whole fleet. A `/proc/<pid>/fd` sweep is a `readdir`
 * plus a `readlink` per descriptor, and the log read is the whole file — so the CALLER asks only
 * for a row that has NO link yet and whose harness has an entry in `HARNESS_PROCESS_LOGS`. On a
 * fleet with no antigravity in it this module is never called at all, and a linked agy row is asked
 * exactly once: `recordConversation` writes the id, and the next poll skips it.
 *
 * Failure is ABSENCE, always. No `/proc` (not Linux), a pid that has exited between the pane listing
 * and this read, a descriptor whose target cannot be resolved, an unreadable log: the answer is
 * `null`, the row keeps behaving exactly as it does today, and `conversationBlind`'s degradation
 * sentence in `chat-web.ts` is what the user sees. Nothing here may throw into the poll.
 */

import { readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_PROCESS_LOGS } from './harness-session-file'

/** Every path this process currently holds open. `[]` for anything that cannot be read. */
async function openFiles(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return [] // not Linux, the process has exited, or the descriptors are not ours to read
  }
  const out: string[] = []
  for (const name of names) {
    try {
      out.push(await readlink(join(dir, name)))
    } catch {
      // A descriptor closed between the listing and the resolve, or a link we may not follow. One
      // missing entry is one fewer candidate, never a failed read of the rest.
    }
  }
  return out
}

/**
 * The conversation the process at `pid` is writing, or `null` when nothing here can say.
 *
 * `null` covers every distinguishable failure on purpose: this answer feeds
 * `recordConversation`, which writes a link that is then treated as exact everywhere, so the only
 * two outcomes worth having are a conversation somebody can point at and no answer at all.
 */
export async function readProcessConversation(
  harness: HarnessId,
  pid: number,
): Promise<string | null> {
  const source = HARNESS_PROCESS_LOGS[harness]
  if (!source) return null

  const log = source.logFromFds(await openFiles(pid))
  if (!log) return null

  try {
    return source.conversationFrom(await readFile(log, 'utf-8'))
  } catch {
    return null
  }
}
