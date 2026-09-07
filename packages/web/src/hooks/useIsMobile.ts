import { useState, useEffect } from 'react'

const MOBILE_BREAKPOINT = 768

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return isMobile
}

/**
 * True when the primary pointer is COARSE (touch, or a stylus without hover) — `(pointer: coarse)`
 * — never a width test. `useIsMobile()` answers a SIZING question (touch targets, the bottom
 * sheet) and stays a width breakpoint on purpose; this answers a GESTURE question (does this
 * device have a right click?) that width cannot: a touch tablet at 1024px is not "mobile" by width
 * but still has no `contextmenu` gesture, and a narrow desktop window is the opposite mistake in
 * the other direction. Kept separate rather than folded into `useIsMobile` so neither question
 * quietly starts answering the other. Guarded for environments with no `matchMedia` (SSR, a test
 * DOM) — such an environment is assumed to have a normal pointer, i.e. fine, not coarse.
 */
export function useIsCoarsePointer(): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const [coarse, setCoarse] = useState(() => supported && window.matchMedia('(pointer: coarse)').matches)

  useEffect(() => {
    if (!supported) return
    const mq = window.matchMedia('(pointer: coarse)')
    const handler = (e: MediaQueryListEvent) => setCoarse(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [supported])

  return coarse
}
