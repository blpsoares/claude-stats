/**
 * slashLine.ts — PURE: the part of a message that is a SKILL INVOCATION.
 *
 * A message that starts with `/name` is a command to the harness, not prose, and it reads as prose
 * in a bubble full of prose. Asked for directly: the invoked skill should stand out in colour.
 *
 * IT IS ONLY EVER THE HEAD OF THE MESSAGE. A slash mid-sentence is a path (`/home/u/x`), a date, a
 * fraction — colouring those would paint half the conversation. So the match is anchored, and it
 * requires the shape a skill name actually has: letters, digits, `-`, `_`, and the `:` that
 * separates a plugin from its skill. A leading `/home/...` therefore does not match, because the
 * segment after the first `/` is followed by another `/`.
 */

export interface SlashSplit {
  /** The `/name` itself, without the trailing space. `''` when the message is not an invocation. */
  command: string
  /** Everything after it, verbatim — including the newline structure. */
  rest: string
}

const SLASH = /^\/([A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?)(?=$|[\s])/

export function splitSlashLine(text: string): SlashSplit {
  const m = SLASH.exec(text)
  if (!m) return { command: '', rest: text }
  return { command: `/${m[1]}`, rest: text.slice(m[0].length) }
}
