/**
 * turnScroll.ts — take the reader to one rendered turn, and MARK it.
 *
 * ONE implementation, because there is one gesture. The composer's recall modal and the gallery's
 * right-click menu both offer "go to the message", and two copies of this would be two chances for
 * them to disagree about which element they are looking for — the id comes from `turnAnchorId` and
 * nowhere else.
 *
 * A scroll on its own answers nothing on a column of similar-looking bubbles ("it moved, to
 * which?"), so the bubble flashes and the class is removed afterwards, leaving nothing on the page
 * marked.
 *
 * It returns FALSE when the bubble is not on the page — the transcript was re-fetched, or the
 * reader is on the terminal view where no bubbles are rendered at all. The caller must then SAY so:
 * a button that silently does nothing is the control-that-reads-as-broken this codebase argues
 * against everywhere else.
 */

import { turnAnchorId } from './lastSent'

/** How long the mark stays. Long enough to find the bubble, short enough to leave nothing behind. */
const FLASH_MS = 1800

export function goToTurn(kind: 'turn' | 'echo', index: number): boolean {
  const el = document.getElementById(turnAnchorId(kind, index))
  if (!el) return false
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('ag-turn-flash')
  window.setTimeout(() => el.classList.remove('ag-turn-flash'), FLASH_MS)
  return true
}
