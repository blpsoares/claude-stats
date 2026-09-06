/**
 * mobileViewport.ts — PURE: how tall the sessions shell is on a phone, and where it sits.
 *
 * Reported: "quando eu tento scrollar as vezes no mobile, ele roda a página inteira e não deixa
 * scrollar, além disso quando o input sobe junto com o teclado, ao sair ele fica numa altura
 * diferente do que estava antes, assim tanto ele como o menu sobem um pouco."
 *
 * BOTH HALVES ARE ONE CAUSE: iOS scrolls the DOCUMENT under the sessions workspace, and the
 * workspace is the one screen in this product that has nothing to scroll. It is a fixed-height
 * column whose conversation, list and aside each scroll inside themselves — so every pixel of
 * document scroll is spurious, and it arrives two ways:
 *
 *   1. RUBBER-BAND. A flick at the top of the conversation chains to the document, which has no
 *      overflow and bounces the whole page down instead — the header sliding out from under the
 *      status bar with the conversation dragged along behind it.
 *   2. THE KEYBOARD. Safari does NOT shrink the layout viewport for the keyboard; it SCROLLS the
 *      page to bring the caret into view. Dismissing the keyboard is supposed to undo that and
 *      routinely does not, so the document is left permanently scrolled — which is why the input
 *      and the fixed bottom nav both come back a little higher than they went.
 *
 * So the document is LOCKED (`body.ag-viewport-locked`, index.css) and the keyboard is MEASURED
 * here. Locking alone would be half a fix, and the wrong half: with nothing left to scroll, the
 * composer would simply sit behind the keyboard.
 *
 * WHAT THE SHELL SPENDS IS `keyboardInset`, AS PADDING — never `height` as its own height. Sizing
 * the shell to the visible band was tried and reverted within the hour: a shorter box ends above
 * the bottom of the screen, and since `#root` clips on a phone, every `position: fixed` descendant
 * anchors to that edge instead of the window's — so the bottom bar and the composer came up
 * already floating, before any keyboard was involved. The visible band is also not reliably the
 * screen at rest (Safari's collapsing toolbars, a non-zero `offsetTop`), which is exactly when a
 * shell must be right without anything having happened yet. `100dvh` + `padding-bottom: inset`
 * gives the same content height with the border box still on the floor.
 *
 * `100dvh` cannot do the job alone, either: it tracks the collapsing URL bar and is deliberately
 * blind to the keyboard, which is the one thing being measured here. The two together are the fix.
 *
 * `offsetTop` is the residue: WebKit can still scroll the visual viewport WITHIN the locked layout.
 * It is read so the measurement stays honest, and deliberately not acted on — a shell that moves
 * with it is the floating box again.
 */

/** The visible band: its height, and how far WebKit has slid it down the locked layout. */
export interface ViewportRect {
  top: number
  height: number
}

/** The shape of `window.visualViewport` this module reads — nothing else of it is used. */
export interface VisualViewportLike {
  height: number
  offsetTop: number
}

const usable = (n: number): boolean => Number.isFinite(n) && n > 0

/**
 * The band the shell should occupy.
 *
 * `fallbackH` (the layout viewport) answers whenever the visual viewport cannot: an older engine
 * with no `visualViewport`, a server render, a zero height mid-rotation. A fallback that is itself
 * unusable yields 0 rather than a NaN height — a shell with no height is visibly wrong, a shell
 * with `NaN` silently drops to auto and takes the flex arithmetic below it with it.
 */
export function shellRect(vv: VisualViewportLike | null | undefined, fallbackH: number): ViewportRect {
  const fallback = usable(fallbackH) ? Math.round(fallbackH) : 0
  if (!vv || !usable(vv.height)) return { top: 0, height: fallback }
  const top = Number.isFinite(vv.offsetTop) ? Math.max(0, Math.round(vv.offsetTop)) : 0
  return { top, height: Math.round(vv.height) }
}

/**
 * How much of the layout viewport something is covering — the keyboard, in practice.
 *
 * Never negative: the visual viewport is momentarily TALLER than the layout one while the URL bar
 * collapses, and a negative inset read as "the keyboard opened by -40px" is worse than a 0.
 */
export function keyboardInset(layoutH: number, visualH: number): number {
  if (!usable(layoutH) || !usable(visualH)) return 0
  return Math.max(0, Math.round(layoutH - visualH))
}

/**
 * The threshold, in CSS pixels, above which the missing band is a keyboard.
 *
 * It is deliberately far above the URL bar's own travel (~44-88px of chrome that comes and goes on
 * scroll) and far below the shortest software keyboard on a phone (~250px), so neither answer is
 * close to the boundary. A tighter number would read the URL bar as a keyboard.
 */
export const KEYBOARD_MIN_PX = 150

/** Whether a keyboard is up. `false` whenever it cannot be told, never a guess. */
export function keyboardOpen(layoutH: number, visualH: number): boolean {
  return keyboardInset(layoutH, visualH) >= KEYBOARD_MIN_PX
}
