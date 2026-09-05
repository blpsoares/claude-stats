/**
 * echoMatch.ts — PURE: which delivered messages the transcript has taken in.
 *
 * An echo is a message already handed to the session, shown in the conversation until the
 * transcript carries it. Retiring it was an EQUALITY test over collapsed whitespace, and equality
 * is the wrong relation — measured on the transcript of the session that reported this:
 *
 *     '> /home/…/9f6434bc-image.png\n> era mais ou menos algo assim…\n'
 *     'pode fazer tudo. so quanto aquela imagem vc n me respondeu\r\n'
 *     '\n[Image #22] esse prompt ta pendurado tem uma eternidade…'
 *
 * ONE user entry, holding TWO messages. A harness that is mid-turn QUEUES what arrives and commits
 * the queue as a single turn, so the second message is stored joined to the first — and the
 * terminal put `\r` in it on the way. The echo is therefore a SUBSTRING of what was stored and can
 * never equal it, so the label stood there forever under a message that had arrived and been
 * answered. "ainda tem mensagem que ta ficando eternamente na fila."
 *
 * So containment, not equality — with one guard. A very short echo ("ok", "sim") appears inside
 * unrelated turns by coincidence, and retiring it there would hide a message that really was still
 * waiting. Below `SAFE_CONTAINS_LEN` the old equality rule stands: a false "still waiting" on a
 * two-letter message costs a glance, a false "delivered" costs the message.
 */

/** Whitespace is collapsed on both sides: the harness re-wraps what it stores, and adds `\r`. */
export function collapseEcho(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Shorter than this and only an exact match retires the echo.
 *
 * Long enough that a coincidence is not credible, short enough to cover a real one-line message
 * ("faz o merge e sobe o binário" is 28).
 */
export const SAFE_CONTAINS_LEN = 12

/** The echoes that are still waiting, given what the transcript's user turns now say. */
export function pendingEchoes(
  echoes: readonly string[],
  userTurns: readonly string[],
): string[] {
  const seen = userTurns.map(collapseEcho).filter(t => t !== '')
  return echoes.filter(text => {
    const c = collapseEcho(text)
    if (c === '') return false
    if (seen.includes(c)) return false
    if (c.length < SAFE_CONTAINS_LEN) return true
    return !seen.some(t => t.includes(c))
  })
}
