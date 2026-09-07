import { useEffect, useRef, useState } from 'react'
import { keyboardInset, keyboardOpen, shellRect, type ViewportRect } from '../lib/mobileViewport'

/**
 * The VISIBLE band of the screen, and whether a keyboard is eating it.
 *
 * Only the sessions workspace on a phone asks — see `mobileViewport.ts` for why that screen alone
 * needs it, and `body.ag-viewport-locked` in index.css for the other half of the same fix. Pass
 * `false` and the hook reports the layout viewport and subscribes to nothing; every other page in
 * this product scrolls the document on purpose and must keep doing so.
 *
 * BOTH `resize` AND `scroll` are listened to. The keyboard fires `resize`; WebKit sliding the
 * visual viewport inside the locked layout fires only `scroll`, and a shell that ignored it would
 * be the right height in the wrong place.
 */
export interface Viewport extends ViewportRect {
  /** A software keyboard is up. `false` whenever it cannot be told. */
  keyboard: boolean
  /**
   * How many CSS pixels of the layout viewport it is covering — 0 when it is not up.
   *
   * This, not `height`, is what the shell spends. A box sized to the VISIBLE band ends above the
   * bottom of the screen and takes every `position: fixed` descendant with it; the same number
   * spent as padding lifts the content just as far while the box still reaches the floor.
   */
  keyboardInset: number
}

const layoutHeight = (): number => (typeof window === 'undefined' ? 0 : window.innerHeight)

/**
 * THE KEYBOARD IS MEASURED AGAINST A REMEMBERED RESTING HEIGHT, NOT AGAINST `window.innerHeight`.
 *
 * That was a real defect and it only appears where it matters most. In a Safari TAB the layout
 * viewport does not move for the keyboard, so `innerHeight - visualViewport.height` is the keyboard
 * — but in an INSTALLED PWA, which is how this app is actually used on a phone, iOS resizes the
 * window itself. Both numbers shrink together, the difference stays near zero, and the keyboard is
 * never detected: no padding is reserved, the composer stays behind the keyboard, and the scroll
 * pin (which stands down only while a keyboard is "up") goes on cancelling the caret scroll that
 * used to lift it. Reported as "o teclado sobe e o input fica lá embaixo".
 *
 * The baseline is the tallest visible band seen while nothing was covering it, and it survives the
 * shrink because it was recorded before. It is reset on a WIDTH change — a rotation is a new
 * screen, and carrying a landscape baseline into portrait would read as a permanent keyboard.
 */
interface Baseline { width: number; height: number }

const read = (active: boolean, base: Baseline | null): Viewport => {
  const layout = layoutHeight()
  const vv = active && typeof window !== 'undefined' ? window.visualViewport : null
  const rect = shellRect(vv, layout)
  // The resting height, if one has been recorded for this screen width; otherwise the layout
  // viewport, which is the right answer everywhere the window does not resize.
  const resting = base && base.width === (typeof window === 'undefined' ? 0 : window.innerWidth)
    ? base.height
    : layout
  const up = active && keyboardOpen(resting, rect.height)
  return { ...rect, keyboard: up, keyboardInset: up ? keyboardInset(resting, rect.height) : 0 }
}

export function useVisualViewport(active: boolean): Viewport {
  const baseline = useRef<Baseline | null>(null)
  const [vp, setVp] = useState<Viewport>(() => read(active, null))

  useEffect(() => {
    const update = () => setVp(prev => {
      const next = read(active, baseline.current)
      // Record the resting height whenever nothing is covering it — the LATEST such reading, never
      // the largest seen. A running maximum was the first version and it is a trap: one transient
      // tall reading poisons the baseline for the life of the page, because nothing brings a
      // maximum back down. Measured against the app's own first frame, where the viewport had not
      // settled: the baseline stuck at 2121 and every later comparison reported a 1613px keyboard
      // that never closed. The latest reading is self-correcting instead — a baseline taken while a
      // keyboard happened to be up is simply replaced by the next one taken without it.
      if (!next.keyboard && next.height > 0 && typeof window !== 'undefined') {
        baseline.current = { width: window.innerWidth, height: next.height }
      }
      // Same numbers, same object: this fires on every keyboard frame, and a new object each time
      // would re-render the whole workspace ~60 times a second while the keyboard slides.
      return prev.top === next.top && prev.height === next.height
        && prev.keyboard === next.keyboard && prev.keyboardInset === next.keyboardInset
        ? prev
        : next
    })
    update()
    const vv = typeof window === 'undefined' ? null : window.visualViewport
    // `window`'s own resize is the fallback for an engine with no visual viewport, and is what
    // catches a rotation either way.
    window.addEventListener('resize', update)
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
    }
  }, [active])

  return vp
}
