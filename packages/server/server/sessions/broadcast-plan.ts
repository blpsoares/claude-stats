/**
 * broadcast-plan.ts — PURE: one prompt, several sessions. What goes where, and what comes back.
 *
 * The most powerful thing on the fleet screen. `promptSession` types a line into ONE session after
 * re-reading its screen; this asks for the same line in several, which multiplies both the use and
 * the damage. So the rules here are about what it REFUSES.
 *
 * ## Every session is still checked on its own
 *
 * This plan says which sessions are worth ASKING about. It does not send anything and it does not
 * decide whether a send is safe: `promptSession` re-reads each screen at the moment it writes,
 * because a session that was working five seconds ago may be sitting on a permission prompt now,
 * where a typed sentence is an answer to a question nobody read. A broadcast that skipped that
 * check to save five round trips would be the one gesture in this product able to answer a dozen
 * dialogs at once.
 *
 * That is why `plan` carries no "safe" flag. The only thing it can know from a poll-old list is
 * which rows could not possibly take a prompt — and it says so per row, so the refusals are
 * readable BEFORE anything is sent rather than as a list of failures afterwards.
 *
 * ## The rules
 *
 * - **A session that is not RUNNING is excluded, by name.** A prompt to a `lost` or `exited` row
 *   has nowhere to go. It is reported rather than dropped: a count that shrinks between what was
 *   ticked and what was sent is the thing that makes somebody re-send.
 * - **A session with a DIALOG OPEN is excluded, by name.** The row already knows this — it is the
 *   same rule the composer keeps — and a sentence typed into a dialog goes into its filter, where
 *   the submit takes whatever is highlighted.
 * - **AN EMPTY PROMPT IS REFUSED.** Not "sent to nobody": refused, so the mistake is visible.
 * - **AN EMPTY SELECTION IS REFUSED**, and never read as "everything". Same rule, same reason, as
 *   `selectFell`.
 * - **A cap.** `MAX_BROADCAST` sessions at once. Beyond that this stops being a message and becomes
 *   a fleet command nobody can take back, and the number is small enough to read in a confirmation.
 */

/** What a row has to say for itself before this can decide anything. */
export interface BroadcastCandidate {
  id: string
  /** What the row is called, for the confirmation and the report. */
  title: string
  /** Is it running right now? */
  running: boolean
  /** Is a dialog open on it? A prompt would go into the dialog's filter. */
  blocked: boolean
}

/** A session this prompt will be offered to. */
export interface BroadcastTarget { id: string; title: string }

/** A session it will not, and the reason in a code the caller renders. */
export interface BroadcastSkip {
  id: string
  title: string
  reason: 'not-running' | 'dialog-open' | 'unknown'
}

export type BroadcastPlan =
  | { ok: true; targets: BroadcastTarget[]; skipped: BroadcastSkip[] }
  | { ok: false; reason: 'no-text' | 'no-selection' | 'none-eligible' | 'too-many'; skipped: BroadcastSkip[] }

/**
 * How many sessions one broadcast may reach.
 *
 * Not a performance limit — it is a blast radius. Beyond a dozen this stops being a message to a
 * few sessions and becomes a command to a fleet, and the list stops being something a person reads
 * before pressing. A caller that wants more sends twice, which is a decision made twice.
 */
export const MAX_BROADCAST = 12

export function planBroadcast(o: {
  text: string
  /** The ids the user ticked. NEVER null: there is no "all" for this — see the header. */
  ids: readonly string[]
  /** Every row the caller knows about, from the last poll. */
  rows: readonly BroadcastCandidate[]
}): BroadcastPlan {
  const skipped: BroadcastSkip[] = []
  if (o.text.trim() === '') return { ok: false, reason: 'no-text', skipped }
  // Deliberately no `null` case, unlike `selectFell`: reopening what a crash took has a defensible
  // "all", and typing into every session on the machine does not.
  if (o.ids.length === 0) return { ok: false, reason: 'no-selection', skipped }

  const known = new Map(o.rows.map(r => [r.id, r]))
  const seen = new Set<string>()
  const targets: BroadcastTarget[] = []
  for (const id of o.ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = known.get(id)
    if (!row) { skipped.push({ id, title: id, reason: 'unknown' }); continue }
    if (!row.running) { skipped.push({ id, title: row.title, reason: 'not-running' }); continue }
    if (row.blocked) { skipped.push({ id, title: row.title, reason: 'dialog-open' }); continue }
    targets.push({ id, title: row.title })
  }

  // Counted over the TARGETS, not the selection: rows that were going to be skipped anyway cost
  // nothing, and refusing because of them would be refusing over something that was not going to
  // happen.
  if (targets.length > MAX_BROADCAST) return { ok: false, reason: 'too-many', skipped }
  if (targets.length === 0) return { ok: false, reason: 'none-eligible', skipped }
  return { ok: true, targets, skipped }
}

/** What one session's send did. `message` is the host's own sentence, kept verbatim. */
export interface BroadcastOutcome { id: string; title: string; ok: boolean; message: string }

export interface BroadcastReport {
  sent: number
  failed: number
  /** Rows the plan never attempted, with their reasons. */
  skipped: BroadcastSkip[]
  outcomes: BroadcastOutcome[]
}

/**
 * The report, from what actually happened.
 *
 * PER SESSION, always — never a single "sent to 5 sessions". A broadcast is the one action here
 * where a partial success is normal: one session takes it, one is mid-dialog by the time its turn
 * comes, one has just died. Collapsing that into one sentence would make the failures invisible,
 * and the whole reason to re-read each screen at write time is that failures are EXPECTED.
 */
export function broadcastReport(
  outcomes: readonly BroadcastOutcome[], skipped: readonly BroadcastSkip[],
): BroadcastReport {
  return {
    sent: outcomes.filter(o => o.ok).length,
    failed: outcomes.filter(o => !o.ok).length,
    skipped: [...skipped],
    outcomes: [...outcomes],
  }
}
