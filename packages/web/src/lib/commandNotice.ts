/**
 * commandNotice.ts — PURE: the sentence for a `missing` command token.
 *
 * `commandToken.ts` draws the line between `missing` (the session's own list does not have it) and
 * `unknown` (there is no list to check yet) — this module only ever speaks for the first of those.
 * It WARNS, and nothing more: the list is what the harness reported, and a harness may still accept
 * a command nobody enumerated, so the message never says the send will fail and the composer never
 * disables it over this. See `commandToken.ts`'s header for why `unknown` gets no sentence at all.
 */

/** The sentence shown under the field when the leading command is `missing`. */
export function commandNotFoundNotice(name: string, pt: boolean): string {
  return pt
    ? `“${name}” não é um comando desta sessão — a mensagem ainda pode ser enviada.`
    : `“${name}” is not a command this session offers — the message can still be sent.`
}
