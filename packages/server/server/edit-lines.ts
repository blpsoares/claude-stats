/**
 * edit-lines.ts — PURE: how many lines a session's OWN edits added and removed.
 *
 * `lines_added` / `lines_removed` came from `getGitFileStats`, which reads a `git diff` of the
 * WORKING TREE. That measures uncommitted work, which is a different question from "what did this
 * session change" — and it answers 0 for the ordinary case of a session that commits as it goes.
 * Reported with 13 files beside `+0 / −0`, which reads as a contradiction because it is one:
 * the file count comes from the session's own Edit/Write calls and the line count did not.
 *
 * So the lines are counted from the SAME place the files are: the tool calls themselves. This is
 * not a new idea in this product — `antigravity-parse.ts` already does exactly this, and its header
 * says why: these are EDIT DELTAS, not `git diff`, and that is what `gitLines: true` means for a
 * harness with no git metadata.
 *
 * What each Claude Code write tool carries, verified against a real transcript:
 *
 *   Write      `content`                     — every line is added; nothing is removed
 *   Edit       `old_string` / `new_string`    — the delta between them
 *   MultiEdit  `edits: [{old_string, new_string}]` — the sum of those deltas
 *   NotebookEdit `new_source` (+ `old_source` when replacing)
 *
 * A REPLACEMENT IS NOT A REWRITE. `old_string` and `new_string` usually share most of their lines,
 * and counting both in full would report a two-word fix as forty lines added and forty removed. So
 * the count is the DIFFERENCE in line count plus the lines that actually changed — measured by
 * comparing the two line lists position by position, which is what a person means by "the lines it
 * touched". It is deliberately not a real diff algorithm: an LCS would be more precise about moved
 * blocks and costs a dependency and a lot of time on a file scan that runs over every session.
 */

export interface EditDelta {
  added: number
  removed: number
}

const lines = (s: string): string[] => (s === '' ? [] : s.split('\n'))

/** The delta between two versions of a fragment. See the header for why this is not an LCS. */
export function replacementDelta(before: string, after: string): EditDelta {
  const a = lines(before)
  const b = lines(after)
  const common = Math.min(a.length, b.length)
  let changed = 0
  for (let i = 0; i < common; i++) if (a[i] !== b[i]) changed++
  return {
    added: changed + Math.max(0, b.length - a.length),
    removed: changed + Math.max(0, a.length - b.length),
  }
}

/** What one write-tool call changed. An input this does not recognise contributes nothing. */
export function editDelta(tool: string, input: unknown): EditDelta {
  if (!input || typeof input !== 'object') return { added: 0, removed: 0 }
  const i = input as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  if (tool === 'Write') {
    // A Write over an existing file is a replacement, but the call does not carry what was there —
    // so it counts as added only. Claiming a removal we cannot see would be inventing a number.
    return { added: lines(str(i.content)).length, removed: 0 }
  }
  if (tool === 'Edit') {
    return replacementDelta(str(i.old_string), str(i.new_string))
  }
  if (tool === 'NotebookEdit') {
    return replacementDelta(str(i.old_source), str(i.new_source))
  }
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(i.edits) ? i.edits : []
    return edits.reduce<EditDelta>((acc, e) => {
      const one = replacementDelta(
        str((e as Record<string, unknown>)?.old_string),
        str((e as Record<string, unknown>)?.new_string),
      )
      return { added: acc.added + one.added, removed: acc.removed + one.removed }
    }, { added: 0, removed: 0 })
  }
  return { added: 0, removed: 0 }
}

/** Running total, for a caller walking a transcript. */
export function addDelta(acc: EditDelta, next: EditDelta): EditDelta {
  return { added: acc.added + next.added, removed: acc.removed + next.removed }
}
