/**
 * sessionPick.ts — PURE: the arithmetic of "tick some sessions and do a thing to them".
 *
 * Two features ask the same question and answer it differently, which is the whole reason this is
 * one module with a parameter rather than two lists:
 *
 *  - **Reopen what fell** starts every row TICKED. Putting the machine back the way it was is the
 *    common case, and the point of the list is that it is a default rather than the only answer.
 *  - **Broadcast a prompt** starts every row UNTICKED. Nothing here has a defensible "all": a
 *    default that types into every live session is a default that eventually types into one nobody
 *    meant.
 *
 * The rest — the header checkbox's three states, what the confirm button says, whether it is
 * pressable — is identical, and is here so it is tested once.
 */

/** A row as a picker needs it. Whatever else it carries is the caller's business. */
export interface PickRow { id: string; title: string }

/** The header box: all, none, or some. A `some` box is INDETERMINATE and must not read as off. */
export type PickAllState = 'all' | 'none' | 'some'

export function pickAllState(rows: readonly PickRow[], picked: ReadonlySet<string>): PickAllState {
  if (rows.length === 0 || picked.size === 0) return 'none'
  const on = rows.filter(r => picked.has(r.id)).length
  if (on === 0) return 'none'
  return on === rows.length ? 'all' : 'some'
}

/**
 * What the header box does when pressed.
 *
 * `some` clears rather than fills. A half-ticked list means somebody has been choosing; the safer
 * of the two readings of one click is the one that starts them over, not the one that silently
 * adds back the rows they just removed.
 */
export function togglePickAll(rows: readonly PickRow[], picked: ReadonlySet<string>): Set<string> {
  return pickAllState(rows, picked) === 'all' ? new Set() : new Set(rows.map(r => r.id))
}

export function togglePick(picked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(picked)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Where a picker opens. See the header — the two features differ here and nowhere else. */
export function initialPick(rows: readonly PickRow[], mode: 'all' | 'none'): Set<string> {
  return mode === 'all' ? new Set(rows.map(r => r.id)) : new Set()
}

/**
 * The picked rows, IN THE ORDER THEY WERE SHOWN.
 *
 * A `Set` iterates in insertion order, which is the order somebody happened to click — not the
 * order they read. Everything downstream (the confirmation's list, the server's report) is easier
 * to check against the screen when the two agree.
 */
export function pickedRows<T extends PickRow>(rows: readonly T[], picked: ReadonlySet<string>): T[] {
  return rows.filter(r => picked.has(r.id))
}

/**
 * Is the button pressable, and what does it say?
 *
 * The COUNT is in the label, always. "Reopen" and "Reopen 5 sessions" are different promises, and
 * this is a button that starts assistants or writes into them — the number is the thing a person
 * checks before pressing.
 */
export function pickConfirmLabel(
  count: number, kind: 'reopen' | 'send', pt: boolean,
): { label: string; enabled: boolean } {
  if (count === 0) {
    return {
      enabled: false,
      label: kind === 'reopen'
        ? (pt ? 'Nenhuma escolhida' : 'None picked')
        : (pt ? 'Nenhuma escolhida' : 'None picked'),
    }
  }
  const one = count === 1
  return {
    enabled: true,
    label: kind === 'reopen'
      ? (pt
        ? (one ? 'Reabrir 1 sessão' : `Reabrir ${count} sessões`)
        : (one ? 'Reopen 1 session' : `Reopen ${count} sessions`))
      : (pt
        ? (one ? 'Enviar para 1 sessão' : `Enviar para ${count} sessões`)
        : (one ? 'Send to 1 session' : `Send to ${count} sessions`)),
  }
}
