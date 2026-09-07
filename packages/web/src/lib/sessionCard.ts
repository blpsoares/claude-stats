/**
 * sessionCard.ts — PURE. What a session card need not repeat.
 *
 * The rule is the cockpit's. `cardPages` / `cardGrid` in `packages/tui/src/control/sessions.ts`
 * landed on it for the terminal grid and it transfers unchanged: a card names every fact it
 * carries, and **a fact whose value IS the band's own name is dropped** — the heading two rows
 * above already said it. In a 320px grid column that repetition is not merely noise, it is the
 * width the TITLE needed: five cards under `blpsoares/agentistics` each spent a line saying
 * `blpsoares/agentistics` while their titles were cut to `Sessions card re…`.
 *
 * It drops a fact only when the band states THIS VALUE, never merely because the band names that
 * dimension. `CardMeta` reads a project from the live fleet row where there is one and from the
 * stored path otherwise, so the card's value and the band's label can legitimately disagree —
 * dropping on the dimension alone would take away a fact the heading never stated.
 */

/** How the list is banded. `task` is deliberately absent — see `RecentSessions`. */
export type SessionGrouping = 'none' | 'status' | 'repo' | 'project' | 'harness' | 'model' | 'marked'

/** The facts a card carries beside its state and its title. */
export type CardFact = 'harness' | 'project' | 'repo' | 'model'

/** The fact a band of this grouping states in its own heading, or null when it states none. */
export function bandFact(grouping: SessionGrouping): CardFact | null {
  switch (grouping) {
    case 'repo': return 'repo'
    case 'project': return 'project'
    case 'harness': return 'harness'
    case 'model': return 'model'
    default: return null
  }
}

/**
 * May the card drop this fact? Only when the band names that dimension AND names this very value.
 * A card outside any band (the pinned block, a flat list) passes no label and keeps everything.
 */
export function bandRepeats(
  grouping: SessionGrouping,
  fact: CardFact,
  value: string | undefined,
  bandLabel: string | undefined,
): boolean {
  if (!value || !bandLabel) return false
  if (bandFact(grouping) !== fact) return false
  return value === bandLabel
}
