/**
 * promptCount.ts — PURE. How many characters are in the box, said the way a person counts them.
 *
 * `String.length` is UTF-16 CODE UNITS, so `🙂` reads as 2 and a flag emoji as 4. Nobody typing one
 * thinks they typed two, and this number sits directly beside the field it describes — it is the
 * one figure in the product a reader can check by eye, so being off by one on a smiley is not a
 * rounding difference, it is the counter being wrong in front of them. Iterating the string counts
 * CODE POINTS, which is what matches the caret for everything anyone types here.
 *
 * (Grapheme clusters would be closer still — a family emoji is several code points joined by
 * zero-width joiners — and `Intl.Segmenter` is how you would do it. It is deliberately not used:
 * it is not in every browser this dashboard opens in, and the failure mode of the fallback is a
 * counter that silently disagrees with itself between machines. One rule everywhere beats a better
 * rule in some places, for a number whose whole job is to be predictable.)
 */

/** Characters as the caret moves over them. `0` for anything that is not a string. */
export function promptCharCount(text: string): number {
  if (typeof text !== 'string' || text === '') return 0
  let n = 0
  // `for…of` walks code points, so a surrogate pair counts once.
  for (const _ of text) n++
  return n
}

/** Thousands grouped the reader's way — `10.480` in pt, `10,480` in en. */
function grouped(n: number, lang: 'pt' | 'en'): string {
  return n.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')
}

/**
 * The label to put under the field, or `null` when there is nothing to say.
 *
 * ABSENT on an empty field rather than reading `0`: the composer's footer already carries the hint
 * about what Enter does and what an attachment means, and a counter with nothing to count would
 * take room from a sentence that is doing work.
 */
export function promptCountLabel(text: string, lang: 'pt' | 'en'): string | null {
  const n = promptCharCount(text)
  if (n === 0) return null
  if (lang === 'pt') return `${grouped(n, 'pt')} ${n === 1 ? 'caractere' : 'caracteres'}`
  return `${grouped(n, 'en')} ${n === 1 ? 'character' : 'characters'}`
}
