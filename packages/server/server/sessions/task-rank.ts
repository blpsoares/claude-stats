/**
 * task-rank.ts — where a card sits when the board is ordered BY HAND. Pure.
 *
 * Dragging a card between two others has to be ONE write. The obvious model — an integer position
 * per task — makes every drop rewrite every card below it, which on a shared JSON book read by
 * several processes is both slow and a race: two agents dropping cards at once renumber the same
 * rows from two different starting points.
 *
 * So the position is a STRING and the operation is "give me something that sorts between these
 * two" — the trick Jira's LexoRank and the fractional-indexing literature describe. A string always
 * has room between it and its neighbour, so an insert is O(1) writes forever.
 *
 * Two rules make it safe here:
 *
 *  - **Comparison is byte-wise on the string, never numeric.** `'a1' < 'a2' < 'b'` is the whole
 *    ordering. Anything that parses the rank as a number reintroduces the collisions this avoids.
 *  - **Ranks GROW, so they are rebalanced.** Repeatedly dropping into the same gap lengthens the
 *    string by roughly one character each time. `needsRebalance` says when a column has gone long
 *    enough to be worth rewriting in one pass — a maintenance job, never a correctness one: a long
 *    rank still sorts correctly, it is only wasteful.
 */

/** The alphabet, in ascending byte order. Digits before letters, so `'0' < 'a'` holds. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const FIRST = ALPHABET[0]!
const LAST = ALPHABET[ALPHABET.length - 1]!
const BASE = ALPHABET.length

/** Long enough that a column is worth rewriting, far beyond anything hand-dragging reaches. */
export const MAX_RANK_LENGTH = 16

const value = (c: string | undefined): number => (c === undefined ? -1 : ALPHABET.indexOf(c))

/**
 * A rank strictly between `a` and `b`, either of which may be absent (start / end of the list).
 *
 * Returns `null` when the two are equal or out of order — a caller that has lost track of its
 * neighbours must not be handed a rank that silently lands somewhere else. That is the one case
 * where a rebalance is not optional.
 */
export function rankBetween(a: string | null, b: string | null): string | null {
  const lo = a ?? ''
  const hi = b ?? ''
  if (hi && lo && lo >= hi) return null
  if (!lo && !hi) return 'm'

  let out = ''
  for (let i = 0; ; i++) {
    const l = value(lo[i])
    const h = hi[i] === undefined ? (hi ? BASE : BASE) : value(hi[i])
    // While the two agree, copy and keep looking for the first place they differ.
    if (lo[i] !== undefined && hi[i] !== undefined && lo[i] === hi[i]) {
      out += lo[i]
      continue
    }
    const mid = Math.floor(((l < 0 ? -1 : l) + (hi[i] === undefined ? BASE : h)) / 2)
    if (mid > (l < 0 ? -1 : l)) return out + ALPHABET[mid]
    // No room at this position: keep the low digit and descend. `lo` may run out, in which case
    // the digit is the alphabet's first and the next round opens the whole range again.
    out += lo[i] ?? FIRST
  }
}

/** `n` evenly spread ranks — what a fresh column gets, or what a rebalance rewrites it to. */
export function initialRanks(n: number): string[] {
  if (n <= 0) return []
  const out: string[] = []
  // One character while it fits (36 cards), two beyond that. Wide gaps, so the first drags are
  // single-character inserts rather than immediately growing the strings.
  const width = n <= BASE - 2 ? 1 : 2
  const span = Math.pow(BASE, width)
  const step = Math.max(1, Math.floor(span / (n + 1)))
  for (let i = 1; i <= n; i++) {
    let v = Math.min(span - 1, i * step)
    let s = ''
    for (let w = 0; w < width; w++) {
      s = ALPHABET[v % BASE] + s
      v = Math.floor(v / BASE)
    }
    out.push(s)
  }
  return out
}

/** True once a column's ranks have grown long enough to be worth one rewriting pass. */
export function needsRebalance(ranks: readonly (string | undefined)[]): boolean {
  return ranks.some(r => (r?.length ?? 0) > MAX_RANK_LENGTH)
}

/**
 * The ranks a MOVE produces: the dragged id placed at `index` among `ordered`, everything else
 * untouched where possible.
 *
 * Returns the writes to apply — usually one. A `null` from `rankBetween` (neighbours that cannot be
 * split, or a list whose ranks have collided) falls back to rewriting the whole column, which is
 * correct and rare; reporting failure instead would leave a card the user just dropped where it
 * was.
 */
export function planMove(
  ordered: readonly { id: string; rank?: string }[],
  id: string,
  index: number,
): Array<{ id: string; rank: string }> {
  const without = ordered.filter(t => t.id !== id)
  const at = Math.max(0, Math.min(index, without.length))
  const before = without[at - 1]?.rank ?? null
  const after = without[at]?.rank ?? null
  const rank = rankBetween(before, after)
  if (rank !== null && !needsRebalance([before ?? undefined, after ?? undefined])) return [{ id, rank }]

  // Rebalance: place the card, then rewrite the column in one pass.
  const placed = [...without.slice(0, at), { id, rank: undefined }, ...without.slice(at)]
  const fresh = initialRanks(placed.length)
  return placed.map((t, i) => ({ id: t.id, rank: fresh[i]! }))
}
