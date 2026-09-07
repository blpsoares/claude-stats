import { describe, expect, it } from 'bun:test'
import { KEYBOARD_MIN_PX, keyboardInset, keyboardOpen, shellRect } from './mobileViewport'

/** An iPhone 12 in Safari: 844 tall, ~664 of it visible under the browser's own chrome. */
const LAYOUT = 664

describe('shellRect', () => {
  it('is the VISUAL viewport, so the keyboard is already subtracted', () => {
    // The reported half that used to work by accident: the composer has to rise. It rises because
    // the shell is shorter, not because the document was scrolled out from under it.
    expect(shellRect({ height: 328, offsetTop: 0 }, LAYOUT).height).toBe(328)
  })

  it('THE REPORTED CASE: dismissing the keyboard returns the EXACT height it started at', () => {
    // "ao sair ele fica numa altura diferente do que estava antes". The old path could not: it was
    // a leftover document scroll, and nothing restored it. This one is derived from a number that
    // comes back on its own, so the round trip is an identity.
    const before = shellRect({ height: LAYOUT, offsetTop: 0 }, LAYOUT)
    const during = shellRect({ height: 328, offsetTop: 0 }, LAYOUT)
    const after = shellRect({ height: LAYOUT, offsetTop: 0 }, LAYOUT)
    expect(during.height).toBeLessThan(before.height)
    expect(after).toEqual(before)
  })

  it('honours a visual viewport WebKit has slid down the locked layout', () => {
    expect(shellRect({ height: 500, offsetTop: 47 }, LAYOUT)).toEqual({ top: 47, height: 500 })
  })

  it('a negative offset is 0 — the shell never floats above the screen', () => {
    expect(shellRect({ height: 500, offsetTop: -20 }, LAYOUT).top).toBe(0)
  })

  it('falls back to the layout viewport when there is no visual one', () => {
    // An engine with no `visualViewport`, or a server render. The old behaviour, unchanged.
    expect(shellRect(null, LAYOUT)).toEqual({ top: 0, height: LAYOUT })
    expect(shellRect(undefined, LAYOUT)).toEqual({ top: 0, height: LAYOUT })
  })

  it('an unusable measurement NEVER becomes NaN', () => {
    // A NaN height does not read as broken — it silently resolves to `auto`, and the flex
    // arithmetic under it stops clipping. That is the bug this shell exists to prevent.
    for (const r of [
      shellRect({ height: 0, offsetTop: 0 }, LAYOUT),
      shellRect({ height: Number.NaN, offsetTop: 0 }, LAYOUT),
      shellRect({ height: 500, offsetTop: Number.NaN }, LAYOUT),
      shellRect(null, Number.NaN),
      shellRect(null, 0),
    ]) {
      expect(Number.isFinite(r.height)).toBe(true)
      expect(Number.isFinite(r.top)).toBe(true)
    }
    expect(shellRect({ height: 0, offsetTop: 0 }, LAYOUT).height).toBe(LAYOUT)
    expect(shellRect(null, Number.NaN).height).toBe(0)
  })

  it('rounds — a fractional height leaves a subpixel seam under the composer', () => {
    expect(shellRect({ height: 663.5, offsetTop: 0.4 }, LAYOUT)).toEqual({ top: 0, height: 664 })
  })
})

describe('keyboardInset', () => {
  it('measures what is covering the layout viewport', () => {
    expect(keyboardInset(LAYOUT, 328)).toBe(336)
  })

  it('is never negative — the visual viewport is briefly TALLER as the URL bar collapses', () => {
    expect(keyboardInset(664, 700)).toBe(0)
  })

  it('is 0 when either side is unusable', () => {
    expect(keyboardInset(Number.NaN, 328)).toBe(0)
    expect(keyboardInset(LAYOUT, 0)).toBe(0)
  })
})

describe('keyboardOpen', () => {
  it('a real keyboard is open', () => {
    expect(keyboardOpen(LAYOUT, 328)).toBe(true)
  })

  it('the URL BAR is not a keyboard', () => {
    // Safari's chrome comes and goes by ~44-88px on scroll. Reading that as a keyboard would hide
    // the bottom nav every time the page moved.
    expect(keyboardOpen(844, 800)).toBe(false)
    expect(keyboardOpen(844, 756)).toBe(false)
    expect(KEYBOARD_MIN_PX).toBeGreaterThan(88)
    // ...and stays well under the shortest phone keyboard, so neither answer sits on the boundary.
    expect(KEYBOARD_MIN_PX).toBeLessThan(250)
  })

  it('is FALSE whenever it cannot be told, never a guess', () => {
    expect(keyboardOpen(0, 0)).toBe(false)
    expect(keyboardOpen(Number.NaN, 328)).toBe(false)
  })
})

describe('the INSTALLED-PWA case — why the baseline is remembered', () => {
  it('a window that shrinks WITH the keyboard hides it from a same-moment comparison', () => {
    // In a Safari tab the layout viewport holds still, so `innerHeight - visualViewport.height` IS
    // the keyboard. In an installed PWA — how this app is actually used on a phone — iOS resizes
    // the window too: both numbers shrink together, the difference stays near zero, and the
    // keyboard is never detected. No padding is reserved and the composer stays behind it.
    const layoutAfterResize = 508   // the window itself came down with the keyboard
    const visual = 508
    expect(keyboardOpen(layoutAfterResize, visual)).toBe(false)
    // Measured against the height the screen had while nothing covered it, the same moment reads
    // correctly — which is why `useVisualViewport` keeps that number rather than re-reading one.
    expect(keyboardOpen(844, visual)).toBe(true)
    expect(keyboardInset(844, visual)).toBe(336)
  })
})
