import { useEffect, useState } from 'react'
import { keyboardOpen, shellRect, type ViewportRect } from '../lib/mobileViewport'

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
}

const layoutHeight = (): number => (typeof window === 'undefined' ? 0 : window.innerHeight)

const read = (active: boolean): Viewport => {
  const layout = layoutHeight()
  const vv = active && typeof window !== 'undefined' ? window.visualViewport : null
  const rect = shellRect(vv, layout)
  return { ...rect, keyboard: active && keyboardOpen(layout, rect.height) }
}

export function useVisualViewport(active: boolean): Viewport {
  const [vp, setVp] = useState<Viewport>(() => read(active))

  useEffect(() => {
    const update = () => setVp(prev => {
      const next = read(active)
      // Same numbers, same object: this fires on every keyboard frame, and a new object each time
      // would re-render the whole workspace ~60 times a second while the keyboard slides.
      return prev.top === next.top && prev.height === next.height && prev.keyboard === next.keyboard
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
