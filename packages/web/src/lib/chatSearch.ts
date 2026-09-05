/**
 * chatSearch.ts — PURE: finding a phrase inside the open conversation.
 *
 * `ctrl+f` scoped to one session. The browser's own find works on what is PAINTED, which in a
 * conversation is the tail somebody has scrolled to; this searches every turn the view holds and
 * can take the reader to one they have not scrolled past yet.
 *
 * TWO DECISIONS, both about being found rather than being exact:
 *
 * 1. IT FOLDS ACCENTS AND CASE. This product is used in Portuguese, where "sessao" and "sessão" are
 *    the same word to everyone except a string comparison, and nobody types the tilde while
 *    hunting. `foldForSearch` therefore lowercases and strips diacritics — but it does so
 *    CHARACTER BY CHARACTER, preserving length exactly, so an offset into the folded text is an
 *    offset into the original. A plain `.normalize('NFD')` would be shorter or longer than what it
 *    describes and every range would land in the wrong place.
 *
 * 2. MATCHES ARE RANGES, NOT TURNS. A long turn can hold the phrase five times, and "3 of 12" has
 *    to mean the third OCCURRENCE, not the third message. The caller renders them however it can —
 *    the conversation is markdown, so a range may only be marked where the browser can do it
 *    without touching React's DOM.
 */

/** One occurrence: which turn, and the half-open range inside that turn's text. */
export interface ChatMatch {
  turnIndex: number
  start: number
  end: number
}

/** Anything with the one field this module reads. Structural, so it never imports the chat view. */
export interface SearchableTurn {
  text?: string
}

/**
 * Lowercase and strip diacritics, PRESERVING LENGTH so offsets survive.
 *
 * Every code point maps to exactly as many UTF-16 units as it occupied. A character whose folded
 * form would change that length — `İ` lowercases to two units, an emoji is a surrogate pair with no
 * meaningful base — is left as it is rather than folded. Being unfoldable is not a reason to
 * corrupt every offset after it.
 */
export function foldForSearch(text: string): string {
  let out = ''
  for (const ch of text) {
    if (ch.length !== 1) { out += ch; continue }
    const base = ch.normalize('NFD')[0] ?? ch
    const folded = base.toLowerCase()
    out += folded.length === 1 ? folded : ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch
  }
  return out
}

/**
 * Every occurrence of `query` across the turns, in reading order.
 *
 * A blank or whitespace-only query matches NOTHING rather than everything: the second reading turns
 * "I cleared the box" into "every character in this conversation is a hit", and the count beside
 * the field would jump to five figures for a keystroke nobody meant as a search.
 *
 * Overlapping occurrences are not counted twice — the scan advances past each hit, so "aa" in
 * "aaa" is one match, which is what a reader stepping through them expects.
 */
export function findChatMatches(turns: readonly SearchableTurn[], query: string): ChatMatch[] {
  const needle = foldForSearch(query.trim())
  if (needle === '') return []
  const out: ChatMatch[] = []
  turns.forEach((turn, turnIndex) => {
    const text = turn.text ?? ''
    if (text === '') return
    const hay = foldForSearch(text)
    let from = 0
    for (;;) {
      const at = hay.indexOf(needle, from)
      if (at === -1) break
      out.push({ turnIndex, start: at, end: at + needle.length })
      from = at + needle.length
    }
  })
  return out
}

/**
 * Move through the matches, WRAPPING at both ends.
 *
 * A search result list is a ring, unlike a scrolling document: pressing "next" on the last hit
 * takes you to the first, because the alternative is a control that stops responding with no
 * explanation. Returns 0 for an empty list so a caller can index blindly.
 */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return 0
  return ((current + direction) % total + total) % total
}

/**
 * The label beside the field: `3 / 12`, or the honest empty answers.
 *
 * "No results" and "type something" are DIFFERENT facts and get different words — an empty field
 * reporting "0 results" reads as a conversation with nothing in it.
 */
export function matchLabel(
  query: string, total: number, current: number, lang: 'pt' | 'en',
): string {
  if (query.trim() === '') return ''
  if (total === 0) return lang === 'pt' ? 'nada encontrado' : 'no matches'
  return `${current + 1} / ${total}`
}
