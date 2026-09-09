/**
 * noteFocus.ts — PURE: which row a chat note's chip asked for, and what to say when there is none.
 *
 * A system note names a KIND (`a skill was loaded`), so its chip could only ever open the aside tab
 * and leave the reader hunting the list — the limitation CLAUDE.md records for `command output`,
 * and until now the reality for skills too, whose body named the skill all along. The server now
 * carries that identity as `ChatTurn.systemRef`, `openArtifacts(tab, ref)` already carried a
 * reference for the live feed, and this holds the two rules both lists answer.
 *
 * NOTHING HERE INVENTS A MATCH. An absent reference focuses nothing and the list looks exactly as
 * it always has; a reference no row carries is REPORTED, because a tab that opens and highlights
 * nothing is indistinguishable from a button that did not work.
 */

/** The flash a focused row wears. One constant, so two lists cannot disagree about what it means. */
export const ROW_FLASH = 'ag-row-flash 1.6s ease-in-out 2'

/**
 * Is this row the one the chip named?
 *
 * `ref` is `undefined` whenever the note named nothing resolvable — the common case for every note
 * whose body carries no identity — and that must focus NO row rather than all of them.
 */
export function isFocusedRow(key: string, ref: string | undefined): boolean {
  return ref !== undefined && key === ref
}

/** Does any row carry the reference? Vacuously true when there is no reference to carry. */
export function rowsCarry(keys: readonly string[], ref: string | undefined): boolean {
  return ref === undefined || keys.includes(ref)
}

/**
 * The sentence for a reference no row carries — a skill loaded from somewhere this machine no
 * longer lists, or a list that has not arrived yet. It NAMES the thing, because "something you used
 * is missing" sends nobody anywhere.
 */
export function focusMissNotice(ref: string, pt: boolean): string {
  return pt
    ? `“${ref}” foi usada nesta conversa e não está nesta lista.`
    : `“${ref}” was used in this conversation and is not in this list.`
}
