/**
 * machine-label.ts — PURE: what this machine calls itself in its backup release tags.
 *
 * The label rides in the tag (`backup-<machine>-<timestamp>`), which is what lets several machines
 * share one backup repository without their histories being mistaken for one another, and what
 * retention reads to decide which releases are this machine's to delete.
 *
 * It defaulted to the HOSTNAME, and a hostname is what a laptop was called at the factory:
 * `BRAIAODE2` names nothing to anyone. Meanwhile the person has already named this machine once —
 * on the central they connected it to (`Alienware`, on the machine this was written for). Asking
 * them to name the same machine a second time, in a second place, is the duplication that ends
 * with the two disagreeing.
 */

/** Only the two fields this decision reads. Structural so the team config owns its own shape. */
export interface LabelSource {
  id: string
  machineName?: string
}

/**
 * The default label: the name a central already gave this machine, else the hostname.
 *
 * A DEFAULT only — an explicitly chosen label always wins, and is not this function's business.
 *
 * Several centrals can hold several names for one machine and there is no way to know which was
 * meant, so the choice is made by connection id: STABLE beats clever here, because the label is in
 * the tag. A label that changed between two backups would split one machine's history in two, and
 * retention — which only ever deletes releases it can prove are this machine's — would then prune
 * one half and let the other accumulate forever.
 */
export function defaultMachineLabel(hostname: string, connections: LabelSource[]): string {
  const named = connections
    .filter(c => (c.machineName ?? '').trim().length > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
  return named[0]?.machineName?.trim() ?? hostname
}

/**
 * A better name to OFFER for this machine, or null.
 *
 * The label is written once, at connect time, from whatever the default was then — so a stored
 * value equal to the hostname is that default showing through rather than a choice: nobody typed
 * `BRAIAODE2`. When a central holds a real name for the same machine (`Alienware`), saying so is
 * the whole of the fix.
 *
 * It is an OFFER and never an automatic switch. The label rides in the release tag, so changing it
 * splits one machine's history into two that retention — which only deletes releases it can prove
 * are this machine's — then treats as two machines, pruning one half and letting the other grow
 * forever. Choosing that is the user's, in one click, with the consequence visible.
 *
 * Comparison folds case and surrounding space, because `braiaode2` and `BRAIAODE2` are the same
 * machine and offering a rename over that difference would be noise.
 */
export function suggestedLabel(
  stored: string, hostname: string, fromCentral: string | null,
): string | null {
  const norm = (v: string): string => v.trim().toLowerCase()
  if (!fromCentral) return null
  if (norm(stored) !== norm(hostname)) return null      // deliberately chosen — leave it alone
  if (norm(fromCentral) === norm(stored)) return null   // nothing better to offer
  return fromCentral
}
