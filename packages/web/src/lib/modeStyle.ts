/**
 * modeStyle.ts — PURE: what colour a harness mode wears.
 *
 * Asked for: the chip should change colour with the mode, so the state is readable without reading.
 *
 * THE GRADIENT IS AUTONOMY, NOT ALARM — how much the session proceeds without asking:
 *
 *   manual        nothing happens on its own          neutral, the chip's default look
 *   plan          it thinks and touches nothing        blue
 *   accept edits  it writes files without asking       orange
 *   auto          it does everything without asking    green
 *
 * NONE OF THEM IS THE FAULT COLOUR. `var(--accent-red)` is what a broken connection, an
 * unauthorized member and an offline machine wear, and `auto mode` is how this product is normally
 * used — painting the ordinary state red is the cry-wolf that `withheldStyle.ts` and the connection
 * pill's `stale` case both exist to avoid. A mode is a choice the user made, not a fault.
 *
 * AN UNKNOWN ID IS NEUTRAL, never a guess. A future claude release can add a mode, and this file
 * would learn about it from a bug report; a chip that is merely uncoloured still reads correctly,
 * while one wearing another mode's colour is a wrong answer given confidently.
 */

export interface ModeStyle {
  /** The chip's text and border colour. */
  fg: string
  /** Its background. Dim by construction — the chip sits in a crowded composer row. */
  bg: string
  /** Its border. */
  border: string
}

/** The neutral chip: the ordinary control look, for `manual` and for anything unrecognised. */
const NEUTRAL: ModeStyle = {
  fg: 'var(--text-secondary)',
  bg: 'var(--bg-elevated)',
  border: 'var(--border-subtle)',
}

const tinted = (colour: string, dim: string): ModeStyle => ({
  fg: colour,
  bg: dim,
  // The border is the colour at low opacity rather than the colour itself: a full-strength ring
  // around a 30px chip reads as a button that is pressed, which is a different fact.
  border: `color-mix(in srgb, ${colour} 45%, transparent)`,
})

const BY_ID: Record<string, ModeStyle> = {
  manual: NEUTRAL,
  plan: tinted('var(--accent-blue)', 'var(--accent-blue-dim)'),
  'accept-edits': tinted('var(--anthropic-orange)', 'var(--anthropic-orange-dim)'),
  auto: tinted('var(--accent-green)', 'var(--accent-green-dim)'),
}

/** The chip's colours for a mode id. Neutral for `manual` and for anything this file has not met. */
export function modeStyle(id: string | undefined): ModeStyle {
  return (id && BY_ID[id]) || NEUTRAL
}
