/**
 * pane-writer.ts — one writer at a time, per pane.
 *
 * WHY IT EXISTS. Writing a prompt is not one operation: `sendTextTo` types the text literally,
 * waits for the burst to settle, captures the frame, presses Enter, and polls for the pane to move
 * — the better part of a second, all of it between two `send-keys` calls into the SAME input box.
 * Nothing serialised those calls, so two sends that overlapped interleaved inside the box: the
 * second prompt's characters landed in the first prompt's unsubmitted line, and the Enter that
 * finally arrived submitted BOTH AS ONE MESSAGE, with every image of both collected at its front.
 *
 * That is the reported defect — "junta os 2 prompts em 1 mensagem só", with the attachments coming
 * back as `[Image #4] [Image #5] [Image #6]`. It reads exactly like the harness merging a queue,
 * which is what it was mistaken for, and the difference is decisive: a harness queue cannot be
 * fixed from here, and this can.
 *
 * IT IS A PANE LOCK, NOT A PROMPT LOCK. Every write into a pane goes through it — the typed line,
 * the browser's key-by-key channel, a named key, the digit-then-text of a dialog answer. A
 * keystroke arriving mid-prompt is the same collision as a second prompt, and the approval path
 * already had the harder version of this bug (`sendChoiceText`'s `3jabuticaba`).
 *
 * FIFO by construction: each write links onto the chain for its own session, so order is the order
 * they were asked for. Per SESSION, never global — two sessions have two panes and must not wait on
 * each other; a busy fleet with one lock would serialise the whole machine.
 *
 * A REJECTION NEVER BREAKS THE CHAIN. The link swallows the outcome and passes the result to its
 * own caller, so one failed write cannot leave every later write on that pane waiting forever —
 * which would be a silent, permanent send failure on one session.
 */

const chains = new Map<string, Promise<unknown>>()

/**
 * Run `fn` once every write already queued for `id` has finished.
 *
 * The returned promise settles exactly as `fn` does — a throw is still a throw for the caller.
 */
export function writeToPane<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(id) ?? Promise.resolve()
  const run = prior.then(fn, fn)
  // The stored link never rejects, so a failure cannot wedge the chain. The CALLER still sees it.
  chains.set(id, run.then(() => undefined, () => undefined))
  return run
}

/** How many panes currently hold a chain — for a test, and for nothing else. */
export function panesWithPendingWrites(): number {
  return chains.size
}

/** Test seam: the map is process-wide, so a test that writes must be able to reset it. */
export function resetPaneWriters(): void {
  chains.clear()
}
