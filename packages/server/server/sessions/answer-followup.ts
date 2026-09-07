/**
 * answer-followup.ts — PURE: what to do AFTER the digit has been typed into a dialog.
 *
 * ## The bug this exists for
 *
 * `answerSession` typed the option's digit and stopped. That is right for claude's PERMISSION
 * PROMPT — `1. Yes / 2. Yes, always / 3. No`, where the digit selects AND submits, which is the
 * dialog the whole path was verified against. It is not right for every dialog the harness draws:
 * on one where the digit only MOVES THE HIGHLIGHT, nothing is submitted, tmux still reports the
 * keystroke delivered, the card latches "already answered from here", and the question stays on
 * screen forever. Reported as exactly that: "clico na resposta e dou enter, simplesmente não envia,
 * o componente fica visível eternamente".
 *
 * CLAUDE.md already records that claude draws at least THREE different dialogs and that one release
 * shipped having probed only the first — "assume there is another until somebody has looked". This
 * is that lesson applied to the SENDING side rather than the reading side.
 *
 * ## Why it reads the screen instead of holding a table
 *
 * A table would have to say, per harness and per dialog, whether the digit submits. Nobody has
 * probed that for every dialog, and a wrong entry sends a second keystroke into a dialog that has
 * already closed — which is the one error here that does damage, because the key would land on
 * whatever the session put up next. So nothing is assumed: the digit goes in, the frame is READ
 * BACK, and the follow-up is decided from what the screen actually says.
 *
 * ## The four answers, and why each is safe
 *
 * - `done` — the dialog is gone. The digit submitted it. Send NOTHING.
 * - `changed` — a dialog is up, but it is a DIFFERENT one. Our answer landed and the session asked
 *   something new. Send NOTHING: this is the dangerous case a table gets wrong, and pressing Enter
 *   here would answer a question nobody has read.
 * - `submit` — the SAME dialog, and the option we picked is now the highlighted one. The digit
 *   moved the cursor and did not submit; Enter is what finishes it, and it can only act on the row
 *   we chose.
 * - `stuck` — the same dialog and our option is NOT highlighted. The keystroke did not do what it
 *   was supposed to. Send nothing and SAY so, rather than pressing keys until something moves.
 *
 * The `changed` guard is what makes `submit` safe: it fires only when the option list is
 * byte-for-byte the one that was on screen before the digit, so Enter cannot reach a dialog that
 * arrived in between.
 */

import type { DialogOption } from './dialog-choice'

export type AnswerFollowUp =
  /** The dialog closed — the digit submitted it. */
  | { kind: 'done' }
  /** A different dialog is up now. Ours landed; do not touch this one. */
  | { kind: 'changed' }
  /** Same dialog, our option highlighted. Enter submits it. */
  | { kind: 'submit' }
  /** Same dialog, our option NOT highlighted. The keystroke did not take. */
  | { kind: 'stuck' }

/**
 * The dialog's identity — its options, by number and label.
 *
 * `selected` is deliberately EXCLUDED: moving the highlight is precisely what the digit is expected
 * to do, so a shape that included it would call every successful keypress a different dialog.
 */
export function dialogShape(options: readonly DialogOption[]): string {
  return options.map(o => `${o.number}:${o.label}`).join('\n')
}

export function answerFollowUp(input: {
  /** Does the frame still match this harness's approval rules? */
  stillAsking: boolean
  /** The options that were on screen when the digit was sent. */
  before: readonly DialogOption[]
  /** The options on screen now. */
  after: readonly DialogOption[]
  /** The option that was picked. */
  choice: number
}): AnswerFollowUp {
  if (!input.stillAsking) return { kind: 'done' }
  // No options readable any more, on a frame that still looks like a dialog: it is not the dialog
  // we answered, and nothing here may press a key into something it cannot read.
  if (input.after.length === 0) return { kind: 'changed' }
  if (dialogShape(input.after) !== dialogShape(input.before)) return { kind: 'changed' }
  return input.after.some(o => o.number === input.choice && o.selected)
    ? { kind: 'submit' }
    : { kind: 'stuck' }
}
