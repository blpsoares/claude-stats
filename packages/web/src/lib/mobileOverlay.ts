/**
 * mobileOverlay.ts — PURE: the padding a FULL-SCREEN dialog needs on a phone.
 *
 * A modal that fills the screen on mobile draws its own title bar at y=0, which in an installed iOS
 * PWA is underneath the clock and the battery — and the status bar takes the taps there, so the
 * dialog's CLOSE button is visible and unpressable. Reported as "várias partes da interface estão
 * impossíveis de clicar", with the Hardware modal's title colliding with the clock in the
 * screenshot.
 *
 * The inset goes on the OVERLAY rather than on each dialog's header: the overlay already owns the
 * dark ground, so the band above the dialog stays covered while the dialog itself starts below the
 * status bar. One property, and the dialog's own layout is untouched.
 *
 * It is `--safe-top`, which is 0 in every browser tab — so this changes nothing anywhere the bug
 * does not exist.
 *
 * `overlayPadding` is the one place this decision lives, and `mobileOverlay.lint.test.ts` fails the
 * build on a full-screen mobile overlay that hardcodes `0` instead of calling it. Eight of them
 * existed when this was written; the next one is the reason the lint is here rather than a comment.
 */

/**
 * @param isMobile  the `useIsMobile()` reading
 * @param desktop   what the overlay pads with when it is NOT full-screen (a number is px)
 */
export function overlayPadding(isMobile: boolean, desktop: number | string): string {
  return isMobile ? 'var(--safe-top) 0 0' : (typeof desktop === 'number' ? `${desktop}px` : desktop)
}

/**
 * The same decision as a constant, for the overwhelmingly common inline shape
 * `padding: isMobile ? OVERLAY_TOP : 24`.
 *
 * Top only: a full-screen dialog wants its left, right and bottom edges flush with the screen —
 * the bottom inset is the home indicator, and these dialogs own their own footers.
 */
export const OVERLAY_TOP = 'var(--safe-top) 0 0'
