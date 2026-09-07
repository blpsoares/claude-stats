/**
 * asideWidth.ts — how wide the sidebar is allowed to be, and what it remembers.
 *
 * Only the sessions workspace can be resized. The dashboard's body is a fixed list of nav labels
 * with a known longest item, so a wider column there buys nothing and a narrower one truncates
 * words that were sized to fit; a session list is the opposite — the titles are the user's own
 * sentences and the right width is a judgement only they can make.
 *
 * PURE. The drag handler and `localStorage` live in the component; everything decidable lives here,
 * so the clamp is testable and there is one answer to "how wide may it be".
 */

/** Narrower than this and a session title has no room left after the dots and the state word. */
export const ASIDE_MIN = 220

/**
 * Wider than this and the centre pane — which holds a terminal — stops being the main thing on
 * screen. It is a cap rather than a proportion because the pane it protects has a real minimum: a
 * terminal reflows badly below about 80 columns.
 */
export const ASIDE_MAX = 520

/**
 * The width both workspaces open at, before anybody drags anything.
 *
 * One figure for both. Each having its own meant the aside resized every time the workspace switch
 * was pressed, which reads as the sidebar breaking rather than as the content changing.
 */
export const ASIDE_DEFAULT = 268

/** The stored width, clamped, with anything unreadable falling back to the default. */
export function resolveAsideWidth(stored: string | null, viewport?: number): number {
  const n = Number(stored)
  const wanted = Number.isFinite(n) && n > 0 ? n : ASIDE_DEFAULT
  return clampAsideWidth(wanted, viewport)
}

/**
 * The width, held inside the bounds — and inside the VIEWPORT, which is the bound that moves.
 *
 * A width stored on a wide monitor is reopened on a laptop, and a sidebar wider than the window is
 * one with no content beside it at all. Half the viewport is the ceiling there: past that the
 * sidebar has stopped being a sidebar.
 */
export function clampAsideWidth(width: number, viewport?: number): number {
  const ceiling = viewport !== undefined && Number.isFinite(viewport) && viewport > 0
    ? Math.max(ASIDE_MIN, Math.min(ASIDE_MAX, Math.floor(viewport / 2)))
    : ASIDE_MAX
  return Math.round(Math.max(ASIDE_MIN, Math.min(ceiling, width)))
}
