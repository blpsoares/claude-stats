/**
 * composerAction.ts — PURE: which face the composer's one action button is wearing.
 *
 * The button shares a slot: STOP while the session works, SEND otherwise. Sharing the slot is what
 * stops the control under a thumb moving when a turn ends — but it means one expression has to
 * decide, and that expression is here rather than inline in the JSX.
 *
 * IT LIVED IN TWO PLACES AND THEY DISAGREED. The rule was written correctly as a local
 * `stopShown`, and the JSX re-derived it as `working && stopVerb?.enabled` — the same rule minus
 * the draft. A merge that took one side's markup and the other side's variable left the weaker
 * copy drawing and the correct one unused, so the stop button stayed up while somebody typed and
 * the send button they were typing toward never appeared. Reported with a screenshot of ten
 * characters sitting beside a red square.
 *
 * THE DRAFT IS WHAT DECIDES between the two faces. Nothing written means there is nothing to send,
 * so the only thing left to do to a working session is stop it; a single character means the
 * opposite. Attachments count as something written — a message that is only files is still a
 * message.
 */

export interface ComposerActionInput {
  /** Is the session producing right now? */
  working: boolean
  /** Does the row actually OFFER a stop? A stop on an idle session sends Escape into its prompt. */
  stopEnabled: boolean
  /** The composer's text, verbatim. */
  draft: string
  /** How many files are attached. */
  attachments: number
}

/** True when the shared slot shows STOP. False means it shows SEND. */
export function stopShown(o: ComposerActionInput): boolean {
  return o.working && o.stopEnabled && !hasSomethingToSend(o)
}

/** Is there anything the send button could send — text, or files, or both? */
export function hasSomethingToSend(o: Pick<ComposerActionInput, 'draft' | 'attachments'>): boolean {
  return o.draft.trim() !== '' || o.attachments > 0
}
