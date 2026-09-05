/**
 * composerHeight.ts — PURE: how tall the message field may grow before it scrolls instead.
 *
 * A composer that will not grow is a composer you cannot read what you wrote in. Reported at two
 * visible lines on a full-height window: "do jeito que ta eu so consigo ler 2 linhas, ta horrivel."
 *
 * The ceiling is a FRACTION OF THE VIEWPORT, not a constant, because the two things it trades off
 * both scale with the window: the room a long prompt needs to be read, and the conversation above
 * it that you are writing IN REPLY TO. A fixed 140px is most of a phone and a sliver of a desktop,
 * so it is either too much or too little on every screen but the one it was measured on.
 *
 * It is CLAMPED at both ends. The floor keeps a few lines on a very short window (a landscape
 * phone), because a field that collapses to one line is the bug this fixes. The ceiling stops the
 * field eating a tall screen — past a dozen or so lines you are composing a document, and the
 * conversation matters more than the twelfth line of the draft.
 */

/** Never fewer than this, however short the window. Roughly four lines plus the field's padding. */
export const MIN_COMPOSER_H = 96
/** Never more than this, however tall. Roughly a dozen lines. */
export const MAX_COMPOSER_H = 320
/** The share of the window the field may take when neither bound binds. */
export const COMPOSER_VIEWPORT_SHARE = 0.34

/**
 * The tallest the field may grow, for a given viewport height.
 *
 * A viewport that is missing or nonsensical (a server render, a detached measurement) answers the
 * FLOOR rather than the ceiling: too small is a field somebody scrolls, too large is a field that
 * covers the conversation, and only one of those is recoverable by typing less.
 */
export function composerMaxHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return MIN_COMPOSER_H
  const share = Math.round(viewportHeight * COMPOSER_VIEWPORT_SHARE)
  return Math.max(MIN_COMPOSER_H, Math.min(MAX_COMPOSER_H, share))
}
