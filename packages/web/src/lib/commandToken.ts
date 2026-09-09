/**
 * commandToken.ts — PURE: what the composer's leading `/command` IS, right now.
 *
 * `slashLine.ts` answers a different question and keeps answering it: given any message, which
 * prefix LOOKS like an invocation. That is the right question for a sent message in a bubble,
 * where the command may since have been uninstalled and re-colouring history would be a lie about
 * the past. This one is about the DRAFT, where the useful question is whether the thing you are
 * typing will actually do something.
 *
 * THREE STATES, and the third is the one that keeps this honest:
 *
 *  - `found`   — the session offers this command. The composer paints it like a button.
 *  - `missing` — the session's command list was read, and this is not in it. A warning, never a
 *                block: the list is what the harness reported, and a harness may accept a command
 *                nobody enumerated. Refusing to send would turn an incomplete list into a wall.
 *  - `unknown` — there is no list to check against yet, or the read failed. NOTHING is claimed.
 *                No paint, no warning. "I could not check" and "it does not exist" are different
 *                sentences, and only one of them is ever true here.
 *
 * The `unknown` case is not an edge: the list is fetched when the picker first opens, so the very
 * first character of the very first command in a session is typed before any answer has arrived.
 */

/** The shape of a name a command can have: letters, digits, `-`, `_`, and the plugin `:` . */
const COMMAND = /^\/([A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?)(?=$|\s)/

export type CommandState = 'found' | 'missing' | 'unknown'

export interface CommandToken {
  /** The `/name` as typed, without its trailing space. */
  text: string
  /** Where it sits in the draft, so a renderer can slice around it without re-matching. */
  start: number
  end: number
  state: CommandState
}

/**
 * The leading command token of a draft, or `null` when there is not one.
 *
 * `known` is the set of command names the session reported, WITHOUT their leading slash, or `null`
 * when no list has been read. `null` is not an empty set — an empty set means "this session offers
 * nothing", which is a real answer and makes every command `missing`.
 *
 * ONLY THE HEAD OF THE DRAFT. A slash mid-sentence is a path, a date or a fraction; painting those
 * would light up half of what anybody types.
 */
export function commandToken(draft: string, known: ReadonlySet<string> | null): CommandToken | null {
  const m = COMMAND.exec(draft)
  if (!m) return null
  const name = m[1]!
  return {
    text: `/${name}`,
    start: 0,
    end: name.length + 1,
    state: known === null ? 'unknown' : known.has(name) ? 'found' : 'missing',
  }
}

/**
 * The set `commandToken` takes, from whatever the session reported.
 *
 * `null` in, `null` out: a list that has not arrived cannot be turned into an empty one without
 * claiming the session offers nothing.
 */
export function knownCommands(
  skills: readonly { name: string }[] | null,
): ReadonlySet<string> | null {
  return skills === null ? null : new Set(skills.map(s => s.name))
}
