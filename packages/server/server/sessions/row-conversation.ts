/**
 * row-conversation.ts — PURE: which CONVERSATION a fleet row is showing.
 *
 * A row names its conversation in one of two places, and only one module may know that.
 *
 * A MANAGED row carries `conversationId` — recorded at spawn, never inferred (see
 * `SessionView.conversationId` for why the harness+directory guess is deliberately not allowed to
 * fill it). A CLOSED row carries it INSIDE ITS ID, as `closed:<conversationId>`: it is not a
 * session at all, it is a conversation you can reopen, so it has no separate link to record.
 *
 * That second half had no reader. `chat-web.ts` asked for `row.conversationId`, found nothing on a
 * closed row and answered "this session has no linked conversation yet, so there is no transcript
 * to read" — over a finished conversation whose id was sitting in the very id it was asked about.
 * So the one row that exists PRECISELY so you can go back to a conversation was the one row that
 * could not show it, and the message blamed the harness for it.
 *
 * The web mirrors this rule in `sessionScratch.ts`'s `scratchKey` (it cannot import server code,
 * and it needs a namespaced STORAGE key rather than an id) — the same split `tagMatch.ts` makes
 * against `tagSessionDay`. Change one and change the other.
 */

/** The prefix `session-view.ts` mints a closed conversation's row id with. */
export const CLOSED_ROW_PREFIX = 'closed:'

/** The row id for a conversation nothing is running — the ONE place this shape is written. */
export function closedRowId(conversationId: string): string {
  return `${CLOSED_ROW_PREFIX}${conversationId}`
}

/**
 * The conversation this row reads, or `null` when there is genuinely none.
 *
 * `null` is a real answer and must stay one: a harness that cannot report which conversation it is
 * writing has no link to give, and `conversationBlind` is the row's own sentence for that. Never
 * invent one from the directory here — that guess belongs to `resume`, which a person confirms by
 * title, and not to a transcript this would then render under the wrong session's name.
 */
export function conversationOfRow(row: { id: string; conversationId?: string }): string | null {
  if (row.conversationId) return row.conversationId
  if (!row.id.startsWith(CLOSED_ROW_PREFIX)) return null
  const rest = row.id.slice(CLOSED_ROW_PREFIX.length)
  return rest === '' ? null : rest
}
