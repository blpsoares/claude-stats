/**
 * lastSent.ts — PURE: which message was the last one the PERSON sent.
 *
 * "The last turn with `role: 'user'`" is the obvious reading and it is wrong, because that role is
 * not a claim that anybody typed anything. The transcript files a background task reporting back,
 * an injected system reminder, a `!` command's stdout and a slash command's caveat under the same
 * role — `ChatTurn.system` names which — and one of those was once circled in a screenshot with
 * "I didn't send that". A control that recalls "your last message" and shows a system reminder is
 * that same defect with a button on it.
 *
 * So this walks BACKWARDS and skips everything nobody wrote: system envelopes, background-task
 * status lines, and turns with no text (a turn that is only tool calls is work, not a message).
 *
 * AN ECHO WINS. A message that was delivered and has not reached the transcript yet is, by
 * construction, newer than anything in it — it is retired the instant the transcript carries the
 * same text. Reading past it would recall the message BEFORE the one just sent, which is the one
 * moment somebody is most likely to be looking for it.
 *
 * The answer is `null` where there is nothing, and the caller must then draw NO CONTROL. A button
 * that opens a modal saying "no messages" is a control that exists to refuse.
 */

/** The one field of a turn this module needs beyond its text. Structural — it imports no view. */
export interface SentTurn {
  role: 'user' | 'assistant'
  text: string
  /** Set when the harness filed something under the user's role that no person wrote. */
  system?: string
  /** A background task's status line. Nobody said it. */
  task?: unknown
}

/**
 * Where the recalled message is: a committed transcript turn, or an echo still waiting to land.
 *
 * `index` is the position within its own list, which is what the anchor id is built from — the two
 * lists are rendered as two runs of bubbles and their indexes are not interchangeable.
 */
export interface SentMessage {
  kind: 'turn' | 'echo'
  index: number
  text: string
}

/** Does this turn count as something a person sent? See the header for every exclusion. */
export function isPersonMessage(turn: SentTurn): boolean {
  if (turn.role !== 'user') return false
  if (turn.system !== undefined) return false
  if (turn.task !== undefined) return false
  return turn.text.trim() !== ''
}

/**
 * The last message the person sent, or `null` when they have not sent one.
 *
 * Echoes are searched first and in reverse for the same reason the turns are: the list is in send
 * order, and an empty string in it is not a message.
 */
export function lastSentMessage(
  turns: readonly SentTurn[],
  echoes: readonly string[] = [],
): SentMessage | null {
  for (let i = echoes.length - 1; i >= 0; i--) {
    const text = echoes[i] ?? ''
    if (text.trim() !== '') return { kind: 'echo', index: i, text }
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn && isPersonMessage(turn)) return { kind: 'turn', index: i, text: turn.text }
  }
  return null
}

/**
 * The DOM id of one rendered bubble.
 *
 * One rule, used by both the renderer and the scroller, so "go to message" can never be looking for
 * an id nothing wrote. The two runs are namespaced apart because their indexes overlap: turn 0 and
 * echo 0 are both the first of their own list.
 */
export function turnAnchorId(kind: 'turn' | 'echo', index: number): string {
  return `ag-chat-${kind}-${index}`
}
