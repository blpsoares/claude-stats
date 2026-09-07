/**
 * ViewportProbe — a live readout of the numbers the keyboard bug is made of.
 *
 * TEMPORARILY UNCONDITIONAL — asked for, because a Home Screen app launches from the manifest's
 * `start_url` and the `?vpdebug=1` on the shortcut never reaches the page. It goes back behind the
 * flag, and then away entirely, once the readings are in.
 *
 * It exists because five attempts at that bug were correct in a
 * headless emulation and wrong on the device. The measurements involved (`window.innerHeight`,
 * `visualViewport.height`, `visualViewport.offsetTop`, `scrollY`) do not mean the same thing in a
 * Safari tab, in a Safari-added web app and in a Chrome-added Home Screen shortcut — and nothing in
 * this repo can run in the last two. So rather than guess a sixth time, this puts the four numbers
 * on the screen where the person who HAS the device can read them.
 *
 * It is a diagnostic, not a feature: no styling budget, no i18n, and it must never render without
 * the flag. Delete it the day the bug is understood.
 */

import { useEffect, useState } from 'react'

interface Reading {
  innerH: number
  innerW: number
  vvH: number
  vvTop: number
  /** `visualViewport.pageTop` — where the visible band sits in the DOCUMENT. This is the one that
   *  separates the two candidate causes: `pageTop - scrollY` is the part of the offset that is the
   *  VISUAL viewport's and cannot be put back by scrolling. */
  vvPageTop: number
  scrollY: number
  docTop: number
  bodyTop: number
  shellBottom: number
  focus: string
}

const read = (): Reading => {
  const vv = window.visualViewport
  const shell = document.querySelector('#root > div')
  const el = document.activeElement as HTMLElement | null
  return {
    innerH: Math.round(window.innerHeight),
    innerW: Math.round(window.innerWidth),
    vvH: vv ? Math.round(vv.height) : -1,
    vvTop: vv ? Math.round(vv.offsetTop) : -1,
    vvPageTop: vv ? Math.round(vv.pageTop) : -1,
    scrollY: Math.round(window.scrollY),
    docTop: Math.round(document.documentElement.scrollTop),
    bodyTop: shell ? Math.round(shell.getBoundingClientRect().top) : -1,
    shellBottom: shell ? Math.round(shell.getBoundingClientRect().bottom) : -1,
    focus: el ? el.tagName.toLowerCase() : '-',
  }
}

const line = (tag: string, r: Reading | null): string =>
  r === null
    ? `${tag} —`
    : `${tag} win ${r.innerW}x${r.innerH} vv ${r.vvH} @${r.vvTop} page ${r.vvPageTop} `
      + `sY ${r.scrollY} dT ${r.docTop} shell ${r.bodyTop}..${r.shellBottom} ${r.focus}`

export function ViewportProbe() {
  const [r, setR] = useState<Reading>(read)
  // TWO FROZEN FRAMES, so ONE screenshot answers the question. The state that matters is a
  // transition, and a live readout only ever shows where it ended — which is why the first attempt
  // at this asked for two photographs taken seconds apart.
  const [openR, setOpenR] = useState<Reading | null>(null)   // last reading while a field had focus
  const [closedR, setClosedR] = useState<Reading | null>(null) // the reading 400ms after it lost it

  useEffect(() => {
    // THE TRIGGER IS THE VIEWPORT SHRINKING, not the focus. The first version keyed both frames on
    // an INPUT having focus, and a screenshot came back with both still empty — a phone can raise
    // and drop a keyboard without this page ever seeing a focus event it recognises (a field inside
    // a shadow root, a dictation panel, an autofill bar), and a diagnostic that needs the user to
    // hit an invisible condition is one more round trip, which is the thing it exists to remove.
    //
    // A drop of more than 120px in the visible band is a keyboard by any reading, and the growth
    // back is the dismissal. Both are recorded whatever had focus.
    const KEYBOARD_DROP = 120
    let tallest = read().vvH
    const onViewport = () => {
      const now = read()
      if (now.vvH <= 0) return
      if (tallest - now.vvH >= KEYBOARD_DROP) {
        setOpenR(now)
      } else if (now.vvH >= tallest) {
        tallest = now.vvH
        // 400ms after it comes back: iOS keeps adjusting the scroll across the dismissal animation,
        // so the reading that matters is the one AFTER it settles, not the first frame of it.
        window.setTimeout(() => setClosedR(read()), 400)
      }
    }
    const vv = window.visualViewport
    vv?.addEventListener('resize', onViewport)
    window.addEventListener('resize', onViewport)
    return () => {
      vv?.removeEventListener('resize', onViewport)
      window.removeEventListener('resize', onViewport)
    }
  }, [])

  useEffect(() => {
    const update = () => {
      const next = read()
      if (next.focus === 'input' || next.focus === 'textarea') setOpenR(next)
      setR(next)
    }
    const id = window.setInterval(update, 250)
    const vv = window.visualViewport
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, { passive: true })
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update)
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
    }
  }, [])

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
        background: 'rgba(0,0,0,0.86)', color: '#22c55e',
        font: '600 9.5px/1.3 ui-monospace, monospace', padding: '3px 5px',
        pointerEvents: 'none', whiteSpace: 'pre-wrap',
      }}
    >
      {[line('now ', r), line('open', openR), line('shut', closedR)].join('\n')}
    </div>
  )
}
