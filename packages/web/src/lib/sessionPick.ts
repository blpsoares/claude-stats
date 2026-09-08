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
export interface PickRow {
  id: string
  title: string
  /** The folder, so two sessions of one repo are told apart. Searched as well as shown. */
  detail?: string
  /**
   * May this row be picked at all? Absent reads as YES.
   *
   * A row that cannot take the verb is SHOWN and disabled rather than hidden, with `reason` beside
   * it: a control that is silently absent and one that is silently inert teach the same wrong
   * thing, which is that the session is not there.
   */
  enabled?: boolean
  /** Why it cannot, already localized by the server. Rendered only when `enabled` is false. */
  reason?: string
}

/** The list is filed by whether the row can take the verb NOW. `all` keeps the caller's order. */
export type PickTab = 'active' | 'all'

export const PICK_TABS: readonly PickTab[] = ['active', 'all']

export function pickTabLabel(tab: PickTab, pt: boolean): string {
  if (tab === 'active') return pt ? 'Ativas' : 'Active'
  return pt ? 'Todas' : 'All'
}

/**
 * What the tab HOLDS, in a sentence.
 *
 * The tab names the set and this says what the set IS — the same rule `kindHint` follows in the new
 * session wizard, and for the same reason: "Active" and "All" are two words that do not, by
 * themselves, explain why a session is in one and not the other.
 */
export function pickTabHint(tab: PickTab, pt: boolean): string {
  if (tab === 'active') {
    return pt
      ? 'Sessões rodando agora, que podem receber o prompt.'
      : 'Sessions running now, which can take the prompt.'
  }
  return pt
    ? 'Toda a frota. As que não podem receber aparecem esmaecidas, com o motivo.'
    : 'The whole fleet. The ones that cannot take it are dimmed, with the reason.'
}

/**
 * The empty state, chosen by WHAT emptied the list.
 *
 * "Nothing matched this search" and "nothing is running" send a reader to two different actions —
 * clear the box, or switch tab — and one shared empty box would name neither.
 */
export function pickEmpty(tab: PickTab, query: string, anyRows: boolean, pt: boolean): string {
  if (query.trim().length > 0) {
    return pt ? 'Nada corresponde a essa busca.' : 'Nothing matches this search.'
  }
  if (!anyRows) return pt ? 'Nenhuma sessão aqui.' : 'No sessions here.'
  if (tab === 'active') {
    return pt
      ? 'Nenhuma sessão rodando. Veja a frota inteira em "Todas".'
      : 'No session is running. See the whole fleet under "All".'
  }
  return pt ? 'Nenhuma sessão aqui.' : 'No sessions here.'
}

/**
 * The rows a tab and a search leave, IN THE ORDER THEY CAME.
 *
 * The search reads the title AND the folder, because two sessions of one repository are told apart
 * by the folder and by nothing else — searching only the title would make the second one
 * unreachable. Case-folded, trimmed; an empty query filters nothing.
 */
export function filterPickRows<T extends PickRow>(
  rows: readonly T[], tab: PickTab, query: string,
): T[] {
  const q = query.trim().toLowerCase()
  return rows.filter(r => {
    if (tab === 'active' && r.enabled === false) return false
    if (q.length === 0) return true
    return r.title.toLowerCase().includes(q) || (r.detail ?? '').toLowerCase().includes(q)
  })
}

/** The header box: all, none, or some. A `some` box is INDETERMINATE and must not read as off. */
export type PickAllState = 'all' | 'none' | 'some'

export function pickAllState(rows: readonly PickRow[], picked: ReadonlySet<string>): PickAllState {
  // `all` is measured against what CAN be picked, or a list holding one un-takeable row could never
  // read as full and the header box would stay indeterminate with everything reachable ticked.
  const takeable = rows.filter(r => r.enabled !== false)
  if (takeable.length === 0 || picked.size === 0) return 'none'
  const on = takeable.filter(r => picked.has(r.id)).length
  if (on === 0) return 'none'
  return on === takeable.length ? 'all' : 'some'
}

/**
 * What the header box does when pressed.
 *
 * `some` clears rather than fills. A half-ticked list means somebody has been choosing; the safer
 * of the two readings of one click is the one that starts them over, not the one that silently
 * adds back the rows they just removed.
 */
export function togglePickAll(rows: readonly PickRow[], picked: ReadonlySet<string>): Set<string> {
  // Only ever fills with rows that CAN be picked — the header box must not tick a row whose own
  // checkbox is disabled, which would put a count on the button the server is about to refuse.
  const takeable = rows.filter(r => r.enabled !== false)
  return pickAllState(rows, picked) === 'all' ? new Set() : new Set(takeable.map(r => r.id))
}

export function togglePick(picked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(picked)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Where a picker opens. See the header — the two features differ here and nowhere else. */
export function initialPick(rows: readonly PickRow[], mode: 'all' | 'none'): Set<string> {
  return mode === 'all' ? new Set(rows.filter(r => r.enabled !== false).map(r => r.id)) : new Set()
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
