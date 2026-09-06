/**
 * sessionArtifacts.ts — PURE: which files the open session has written, from the conversation it
 * is already showing.
 *
 * THIS NEEDS NO SERVER, and that is the design rather than an economy. `ChatTurn.tools` already
 * arrives on every turn as `{ name, detail }`, and `chat-tail.ts`'s `toolDetail` reads named
 * fields in priority order — so for a file tool the `detail` IS the `file_path`. `SessionChat`
 * already polls that payload, so this list is exactly as fresh as the conversation beside it and
 * the two can never disagree by a poll interval.
 *
 * SELECTION IS BY TOOL NAME, NEVER BY THE SHAPE OF `detail`. `toolDetail`'s first key is
 * `command`, so a `Bash` call's detail is a shell line — and "this looks like a path" would put
 * `rm -rf build/` in a list of files somebody is about to click.
 *
 * AND IT IS THE CANONICAL NAME, NOT THE DISPLAYED ONE. A turn carries both: `name` is what the
 * harness itself called the tool (agy's `write_to_file`), which is what the bubble shows because a
 * conversation records what happened; `canonical` is the same tool under the shared vocabulary
 * (`Write`), present only where the two differ. This set is written in the shared vocabulary, so it
 * reads `canonical ?? name` — matching on the displayed name alone would make this panel blind on
 * every harness but Claude, and rewriting the displayed name to suit this set is what put Claude's
 * tool names in an Antigravity session's bubbles.
 *
 * `Read` is excluded. The question this panel answers is what the session PRODUCED; an assistant
 * reading forty files to answer one question would bury the two it wrote.
 */

/**
 * The tools whose `detail` is a file path, in the SHARED vocabulary — see `canonical` above.
 * Read from `chat-tail.ts`'s own priority list.
 */
export const ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
])

export interface Artifact {
  /** The absolute path, exactly as the transcript recorded it. */
  path: string
  /** The last segment — what the row is called. */
  name: string
  /** Everything before it, shown dim under the name. */
  dir: string
  /** `new` when the session's FIRST touch was a `Write`; `edited` otherwise. */
  kind: 'new' | 'edited'
  /** How many times this session touched it. */
  touches: number
  /** This is the file of a turn that has not finished — the one being written now. */
  live: boolean
}

interface Turnish {
  tools?: {
    name: string
    /** The shared-vocabulary name, when it differs from the displayed one. */
    canonical?: string
    detail?: string
    writes?: string[]
    opaqueWrite?: boolean
  }[]
  pending?: boolean
}

/**
 * Did this conversation write through commands whose paths cannot be read?
 *
 * An interpreter fed a program on stdin writes files nobody can name from the command line — the
 * server marks those calls rather than guessing at the script's contents. The panel uses this to
 * distinguish "this session wrote nothing" from "this session wrote things I cannot list", which
 * on a session that had produced eighty files was the difference between an honest gap and a
 * confident wrong answer.
 */
export function hasUnlistedWrites(turns: readonly Turnish[]): boolean {
  return turns.some(t => (t?.tools ?? []).some(c => c.opaqueWrite === true))
}

export function artifactsFromTurns(turns: readonly Turnish[]): Artifact[] {
  // Insertion order is the transcript's order, which is what makes "first touch" answerable.
  const seen = new Map<string, { first: string; touches: number; order: number; live: boolean }>()
  let order = 0

  for (const t of turns) {
    for (const call of t?.tools ?? []) {
      // A file the SHELL wrote is a file this session wrote. `writes` is computed server-side by
      // `shell-writes.ts` because `detail` carries only the command's first line, which is almost
      // never the one holding the redirection.
      for (const w of call.writes ?? []) {
        const prevW = seen.get(w)
        if (prevW) { prevW.touches += 1; prevW.order = order++; prevW.live = t?.pending === true }
        else seen.set(w, { first: 'Write', touches: 1, order: order++, live: t?.pending === true })
      }
      if (!ARTIFACT_TOOLS.has(call.canonical ?? call.name)) continue
      const path = call.detail?.trim()
      if (!path) continue
      // `toolDetail` appends an ellipsis past 200 characters. A truncated path names no file, and
      // asking the server for one would be a refusal every time — so it is not offered.
      if (path.endsWith('…')) continue
      const prev = seen.get(path)
      if (prev) {
        prev.touches += 1
        prev.order = order++
        prev.live = t.pending === true
      } else {
        // The CANONICAL name again: `kind` is decided by whether the first touch was a `Write`, so
        // recording agy's own `write_to_file` here would file every file it created as `edited`.
        // Same reading as the `ARTIFACT_TOOLS` test above, and it must not drift from it.
        seen.set(path, {
          first: call.canonical ?? call.name, touches: 1, order: order++, live: t.pending === true,
        })
      }
    }
  }

  return [...seen.entries()]
    .map(([path, v]) => {
      const cut = path.lastIndexOf('/')
      return {
        path,
        name: cut === -1 ? path : path.slice(cut + 1),
        dir: cut === -1 ? '' : path.slice(0, cut),
        kind: v.first === 'Write' ? ('new' as const) : ('edited' as const),
        touches: v.touches,
        live: v.live,
      }
    })
    // Newest first: the thing that just happened is what the panel is opened for.
    .sort((a, b) => (seen.get(b.path)!.order - seen.get(a.path)!.order))
}
