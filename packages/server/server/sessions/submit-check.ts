/**
 * submit-check.ts — PURE: did the submit actually land?
 *
 * `sendTextTo` typed the prompt and then sent `Enter`, and called it delivered when tmux exited
 * zero. TMUX'S EXIT CODE SAYS THE KEYS WERE WRITTEN TO THE PANE — nothing about the harness having
 * acted on them. So a submit that the TUI swallowed was reported as success, the web composer
 * cleared, the row went on saying "delivered · it reads this when its turn ends", and the prompt sat
 * in the harness's input box unsent. Reported after it had been sitting there for hours: "esse
 * prompt ta pendurado tem uma eternidade, fui abrir o terminal e ele tava aqui, preso, sem ser
 * enviado".
 *
 * The check is the SCREEN, not the text. Looking for the prompt's own words is the obvious idea and
 * it is wrong in the direction that matters: after a successful submit the words are still on the
 * screen — they are in the conversation now — so "I can still see it" proves nothing, and the retry
 * would fire on every successful send. What a submit reliably does is CHANGE the frame: the input
 * empties. So the comparison is between the pane as it stood with the text typed into it and the
 * pane a moment after `Enter`, and an UNCHANGED pane is the failure.
 *
 * IT DRIVES A RETRY AND NEVER A VERDICT. Measured against a real pane: a program whose screen does
 * not change on submit (`cat`, and any TUI that redraws identically) makes an accepted send look
 * exactly like a swallowed one — the first version of this reported that as a FAILURE, which would
 * have put "send failed" under a prompt that had arrived and invited the user to send it twice.
 * "Nothing moved" is not evidence of anything; it is only a reason to press return once more, which
 * on an empty input costs nothing. So the caller's answer stays what tmux said, and this decides
 * only whether to try again.
 *
 * The retry is bounded to one, because the failure this exists for is a timing window and not a
 * broken pane.
 */

/**
 * Whether the pane moved between two captures.
 *
 * Trailing blank lines are ignored — a TUI repaints its own footer padding differently between
 * captures and that is not the input clearing. Everything else is compared verbatim: a cursor
 * moving is a change, and it is a change caused by whatever we just sent.
 */
export function frameChanged(before: readonly string[], after: readonly string[]): boolean {
  return trim(before).join('\n') !== trim(after).join('\n')
}

function trim(lines: readonly string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop()
  return out
}

/**
 * Should a second return be sent?
 *
 * THE CHECK ABOVE ANSWERS ONLY FOR A STILL PANE, and for one release nothing said so. `frameChanged`
 * asks "did anything on screen change" as a proxy for "did the input empty", and a session MID-TURN
 * changes on its own: the spinner glyph, the elapsed timers and the token counter all advance
 * between any two captures. Measured 2026-09-08 on a live pane, two captures 200 ms apart with
 * nothing sent to it, three lines differed. So the proxy was `true` on the first 60 ms poll of every
 * send to a working session, the bounded retry never fired, and a swallowed return was reported as
 * delivered: the composer cleared and the row said "delivered · it reads this when its turn ends"
 * over a prompt still sitting in the harness's input box, found there with 36 minutes on the clock.
 *
 * That is the worst possible place to lose the retry. A BUSY session is exactly where the return is
 * at risk — the input arrives as one fast burst, the harness reads it as a paste, and a return
 * landing inside that burst becomes a newline rather than a submit — and it is also the only place
 * where a submit produces no obvious change, because the message goes to a queue instead of
 * starting a turn.
 *
 * So the pane is ASKED whether it animates, by comparing two captures taken before the return with
 * nothing sent between them, and:
 *
 * - **animating** — the comparison cannot answer, so press return again. This is not a guess; it is
 *   the module's own rule applied honestly: "nothing moved" was never evidence, only a reason to
 *   press return once more, and on an emptied input that costs nothing.
 * - **still** — today's behaviour exactly, unchanged and untouched.
 *
 * Every case this cannot settle therefore resolves toward the keystroke, because the two errors are
 * not symmetric: a redundant return on an empty input does nothing, while a missing one strands a
 * message for as long as nobody opens the terminal.
 */
export function needsSecondReturn(animating: boolean, movedAfterReturn: boolean): boolean {
  return animating || !movedAfterReturn
}
