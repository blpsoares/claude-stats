/**
 * echoStatus.ts — PURE: what to say about a message that was DELIVERED and not yet read.
 *
 * An echo is a message the session has already been given — typed into its pane, accepted, sitting
 * in its composer — that has not yet appeared in the transcript, because the assistant is mid-turn
 * and will read it when that turn ends.
 *
 * It used to say "waiting for the session to read it", which is TRUE and reads as "this did not
 * send". Reported exactly that way, beside a terminal where the messages were plainly visible:
 * "na ui ta falando que as mensagens estao enfileiradas, so que elas ja foram enviadas". Nothing
 * was lost — all four messages were later found in the transcript — but a label that leaves
 * somebody checking the terminal to see whether their message survived has failed at its one job.
 *
 * SO IT LEADS WITH DELIVERY. The message is IN the session; what is pending is the reading. And it
 * says WHY when the reason is knowable: a busy session reads at the end of its turn, which is the
 * difference between "this is normal" and "something is stuck".
 *
 * THE AGE IS SHOWN ONLY ONCE IT MEANS SOMETHING. For the first half-minute an unread message is
 * simply the normal case, and a timer running from zero invites watching it. Past that it is worth
 * knowing how long, because that is the only signal a reader has that a session has stopped
 * consuming its queue.
 */

/** Below this, an unread message is just the ordinary case and carries no age. */
export const ECHO_AGE_QUIET_MS = 30_000

export interface EchoStatus {
  /** The sentence, already localized. */
  text: string
  /** True once the wait is long enough to be worth a second look. */
  notable: boolean
}

/**
 * @param ageMs how long since the message was handed over, or null when that is not known
 * @param working whether the session is mid-turn
 */
export function echoStatus(
  ageMs: number | null, working: boolean, lang: 'pt' | 'en',
): EchoStatus {
  const pt = lang === 'pt'
  const notable = ageMs !== null && ageMs >= ECHO_AGE_QUIET_MS
  const mins = ageMs === null ? 0 : Math.floor(ageMs / 60_000)
  const age = !notable ? ''
    : mins >= 1
      ? (pt ? ` há ${mins} min` : ` for ${mins} min`)
      : (pt ? ` há ${Math.floor((ageMs ?? 0) / 1000)}s` : ` for ${Math.floor((ageMs ?? 0) / 1000)}s`)

  // The session is BUSY: the wait has a cause, and naming it is the difference between "normal"
  // and "stuck".
  if (working) {
    return {
      text: pt
        ? `entregue à sessão${age} — ela lê ao terminar o turno`
        : `delivered to the session${age} — it reads this when its turn ends`,
      notable,
    }
  }
  return {
    text: pt
      ? `entregue à sessão${age} — ainda não lida`
      : `delivered to the session${age} — not read yet`,
    notable,
  }
}
