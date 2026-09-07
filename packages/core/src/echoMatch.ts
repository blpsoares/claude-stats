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
 *
 * THE SECOND SHAPE, AND IT LOOKED LIKE A DUPLICATE MESSAGE. A message with attachments is sent as
 * one path per line followed by the prose — that is what the composer types into the pane — and the
 * harness stores it with the paths REPLACED by its own markers. Measured on this machine:
 *
 *   echo    '/home/u/.agentistics/attachments/ab-image.png\n…/cd-image.png\nvou te passar…'
 *   stored  '[Image #26] [Image #27]vou te passar…'
 *
 * Neither equal nor contained, so the echo stood forever BESIDE the transcript's own copy of the
 * same message — two bubbles, one message. Reported as exactly that: "aparentemente o prompt que eu
 * mandei por aqui tbm foi enviado via terminal e dai duplicou". Nothing was sent twice.
 *
 * So an echo is also compared by its PROSE — itself minus the attachment lines it added. And when
 * there is no prose (a message that was only files), by the COUNT: a stored turn that is nothing
 * but markers, as many as the echo carried paths. That second rule is narrow on purpose — it never
 * fires on a turn that has words in it.
 *
 * THE THIRD SHAPE — A SHORT MESSAGE WITH NO WAY OUT, and this one had no expiry at all. Every rule
 * above is a comparison, so a message the comparisons cannot recognise waits FOREVER. Under
 * `SAFE_CONTAINS_LEN` only equality is allowed — deliberately, a two-letter echo appears inside
 * unrelated turns by coincidence — and the queue-joining shape above is exactly what makes equality
 * fail. Reported with a three-letter message: "executei o btw no claude e n apareceu nada na
 * sessão, na real tá enfileirado eternamente." It had been read and answered.
 *
 * The way out is not a timeout — a session really can sit on its queue for an hour, and a timer
 * that retires an unread message is the one error worse than this one. It is ORDER. Delivery is
 * FIFO: the write channel is FIFO by construction, `editEcho` APPENDS, and a harness commits its
 * input queue in the order it arrived. So a LATER echo appearing in the transcript is proof that
 * every earlier one was read — it could not have been overtaken. `landedIndex` is that rule, and it
 * costs nothing in confidence: the later echo was recognised by the very comparisons above, and the
 * earlier ones are then a deduction from ordering rather than a guess about their text.
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
/** A line that is nothing but a path — what the composer adds for each attachment. */
function isPathLine(line: string): boolean {
  const t = line.trim()
  return t !== '' && !/\s/.test(t) && (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t))
}

/** The echo without the attachment lines it carries, and how many those were. */
export function echoProse(text: string): { prose: string; paths: number } {
  const lines = text.split('\n')
  const kept = lines.filter(l => !isPathLine(l))
  return { prose: collapseEcho(kept.join('\n')), paths: lines.length - kept.length }
}

const MARKER = /\[Image #\d+\]/g

/** How many markers a stored turn is made of, when it is made of nothing else. */
function markerOnlyCount(turn: string): number {
  const t = turn.trim()
  const markers = t.match(MARKER)
  if (!markers) return 0
  return t.replace(MARKER, '').trim() === '' ? markers.length : 0
}

/**
 * A stored turn with its LEADING markers removed — what is left is the prose the person typed.
 *
 * Only leading ones, and only for comparison: the harness puts them where the composer put the
 * paths, which is the top. A marker in the middle of a sentence is something the person wrote.
 */
function withoutLeadingMarkers(turn: string): string {
  return collapseEcho(turn.trim().replace(/^(?:\[Image #\d+\]\s*)+/, ''))
}

/**
 * How the transcript accounts for one echo.
 *
 *   `no`      nothing in the transcript looks like it — still waiting.
 *   `weak`    matched, but only by EQUALITY on a string under `SAFE_CONTAINS_LEN`. Good enough to
 *             retire that one echo, and NOT good enough to speak for the ones before it.
 *   `anchor`  matched by a comparison a coincidence cannot fake.
 */
type EchoMatch = 'no' | 'weak' | 'anchor'

export function pendingEchoes(
  echoes: readonly string[],
  userTurns: readonly string[],
): string[] {
  const seen = userTurns.map(collapseEcho).filter(t => t !== '')
  const stripped = userTurns.map(withoutLeadingMarkers).filter(t => t !== '')
  const match = echoes.map(text => matchEcho(text, userTurns, seen, stripped))
  // The last echo matched by something a coincidence cannot fake. Delivery is FIFO, so everything
  // before it went into the same pane earlier and was read no later — the header's third shape.
  //
  // ONLY an `anchor` may speak for the messages before it. A `weak` match is the very coincidence
  // `SAFE_CONTAINS_LEN` exists to guard against — a person types "ok" and the transcript has an
  // "ok" from an hour ago — and letting one of those anchor the rule turns a mistake that cost ONE
  // spurious retirement into one that silently clears the whole queue behind it. A message the
  // person can no longer see is the failure this file exists to prevent.
  const lastAnchor = match.lastIndexOf('anchor')
  return echoes.filter((_text, i) => i > lastAnchor && match[i] === 'no')
}

/**
 * How the transcript accounts for this one echo, judged on TEXT alone.
 *
 * Split out because `pendingEchoes` now needs the answer for every echo, not just the one it is
 * deciding: the ordering rule above reads the whole vector.
 */
function matchEcho(
  text: string,
  userTurns: readonly string[],
  seen: readonly string[],
  stripped: readonly string[],
): EchoMatch {
  const c = collapseEcho(text)
  // An empty echo is nothing to wait for. It anchors nothing — there is no evidence in it.
  if (c === '') return 'weak'
  if (seen.includes(c)) return c.length >= SAFE_CONTAINS_LEN ? 'anchor' : 'weak'
  if (c.length >= SAFE_CONTAINS_LEN && seen.some(t => t.includes(c))) return 'anchor'
  const { prose, paths } = echoProse(text)
  if (paths === 0) return 'no'
  // The prose against the stored turn with its leading markers removed. EXACT equality is enough
  // here and is what makes it safe for a two-word message: the markers stand exactly where the
  // paths stood, so what remains on both sides is the same typed sentence — no coincidence to
  // guard against, and none of the length rule's caution is needed.
  if (prose !== '' && (stripped.includes(prose)
    || (prose.length >= SAFE_CONTAINS_LEN && stripped.some(t => t.includes(prose))))) return 'anchor'
  // Only files and no words: match a turn that is only markers, as many as there were paths.
  if (prose === '' && userTurns.some(t => markerOnlyCount(t) === paths)) return 'anchor'
  return 'no'
}
