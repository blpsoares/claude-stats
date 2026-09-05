/**
 * replyQuote.ts — PURE: what replying to a message means here.
 *
 * There is no reply THREAD to send. The transport types a line into a tmux pane and these CLIs have
 * one linear conversation, so a reply is a QUOTE: the lines are `> `-prefixed and sent above what
 * you write, which is what the assistant actually reads and is what mail has always done. Saying
 * that plainly beats a UI implying threading the session cannot do.
 *
 * Three decisions, each of which can be wrong, and none of which belongs in JSX:
 *
 * 1. WHAT TRAVELS. The quote is spent CONTEXT — a reply echoing forty lines back at the session
 *    costs it window for nothing it does not already have. Four lines name the message; an ellipsis
 *    says there was more.
 * 2. WHAT THE BAR SHOWS. The first line or two, with the blank lines dropped: a message that opens
 *    with a fenced block or a heading would otherwise preview as two empty rows, which reads as a
 *    reply to nothing.
 * 3. WHO IS BEING REPLIED TO. "Replying to" with no name is the one thing the bar exists to answer.
 *    The user's own turn is "You"; an assistant turn is the HARNESS, by the name the rest of the
 *    product calls it.
 */

/** The turn being replied to, as the composer holds it. Structural — this module imports no view. */
export interface ReplyTarget {
  role: 'user' | 'assistant'
  text: string
  /**
   * The text is a SELECTED EXCERPT of the turn, not the turn.
   *
   * It changes two things and is therefore a field rather than something inferred from length: the
   * quote is not capped (see `quoteFor`), and the bar says "an excerpt of" rather than naming the
   * message, because a preview showing the middle of a paragraph with no such warning reads as the
   * whole of a very short message.
   */
  excerpt?: boolean
}

/** How many lines of the quoted message travel with the reply. See decision 1. */
export const QUOTE_LINES = 4

/** How many lines of it the bar above the composer shows. See decision 2. */
export const PREVIEW_LINES = 2

/**
 * A quoted excerpt, `> `-prefixed and bounded.
 *
 * A quote of nothing is EMPTY, not a lone `> ` — the caller joins this with the paths and the
 * typed text and filters empties out, so a blank marker would put a stray quote character at the
 * top of a message nobody quoted anything into.
 */
export function quoteLines(text: string, max: number = QUOTE_LINES): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const lines = trimmed.split('\n')
  const head = lines.slice(0, max).map(l => `> ${l}`)
  if (lines.length > max) head.push('> …')
  return head.join('\n')
}

/**
 * The first line or two, for the bar above the composer.
 *
 * BLANK LINES ARE DROPPED, not counted: a message opening with a fence or a heading followed by an
 * empty line would preview as one word and a gap, which reads as a reply to nothing. The ellipsis
 * is appended only when something was actually left out — a two-line message must not look
 * truncated.
 */
export function replyPreview(text: string, max: number = PREVIEW_LINES): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '')
  if (lines.length === 0) return ''
  const head = lines.slice(0, max).join(' ')
  return lines.length > max ? `${head} …` : head
}

/**
 * An excerpt, marked at the ends it does not reach.
 *
 * REPLYING TO A SELECTION IS A DIFFERENT ACT from replying to a message: the sender has said which
 * part they mean, and the reason they did it is that the whole message is expensive to send back.
 * So the excerpt travels VERBATIM and WHOLE — capping what somebody deliberately selected sends a
 * different message from the one they composed, which is the one thing a quote may never do.
 *
 * What it must not do is read as the whole turn. So an ellipsis is added at each end the excerpt
 * does not reach. **An excerpt that cannot be located in the turn is marked at BOTH ends**: the
 * bubble renders markdown, so a selection taken off the screen legitimately differs from the source
 * text, and between "claim it is complete" and "say it may be partial" only the second is wrong in
 * the harmless direction.
 *
 * Whitespace is normalised for the comparison ONLY. The returned text keeps the selection's own
 * line breaks, because they are what the reader saw.
 */
export function markExcerpt(full: string, selected: string): string {
  const text = selected.trim()
  if (text === '') return ''
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const haystack = norm(full)
  const needle = norm(text)
  const at = needle === '' ? -1 : haystack.indexOf(needle)
  const lead = at !== 0
  const trail = at < 0 || at + needle.length !== haystack.length
  return `${lead ? '…' : ''}${text}${trail ? '…' : ''}`
}

/**
 * The `> ` block that actually travels, for either kind of target.
 *
 * ONE function, because the cap is the difference and a caller choosing between two quoting
 * helpers is a caller that will one day cap an excerpt. A whole message is an INFERRED quantity and
 * is bounded (decision 1); an excerpt was CHOSEN and is not.
 */
export function quoteFor(target: ReplyTarget): string {
  return target.excerpt ? quoteLines(target.text, Number.POSITIVE_INFINITY) : quoteLines(target.text)
}

/**
 * Who said it.
 *
 * The assistant side is the harness's own label, passed in rather than looked up here: the label
 * table lives with the rest of the harness chrome and a second copy of it is a second place for
 * the two to disagree. An empty or missing label falls back to a neutral word instead of rendering
 * "Replying to" followed by nothing — the name is the whole point of the line.
 */
export function replyAuthor(
  role: 'user' | 'assistant',
  harnessLabel: string | undefined,
  lang: 'pt' | 'en',
): string {
  const pt = lang === 'pt'
  if (role === 'user') return pt ? 'Você' : 'You'
  const label = (harnessLabel ?? '').trim()
  if (label !== '') return label
  return pt ? 'o assistente' : 'the assistant'
}

/**
 * Parse a stored reply target.
 *
 * Storage is a string somebody else's code can also write, and a half-read entry here becomes a
 * quote sent to a session that nobody composed — so anything that is not a `{role, text}` pair with
 * a role this product knows and a non-empty text is dropped. Same rule, and the same reason, as
 * `parseAttachments`.
 */
export function parseReply(raw: string | null): ReplyTarget | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return null
    const { role, text } = v as Record<string, unknown>
    if (role !== 'user' && role !== 'assistant') return null
    if (typeof text !== 'string' || text.trim() === '') return null
    // The mark is only ever honoured when it is literally `true`: a stored value of any other
    // shape is a document this code did not write, and reading it as truthy would uncap the quote.
    const excerpt = (v as Record<string, unknown>).excerpt === true
    return excerpt ? { role, text, excerpt: true } : { role, text }
  } catch { return null }
}
