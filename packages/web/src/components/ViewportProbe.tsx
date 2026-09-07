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
    const editable = (el: EventTarget | null): boolean => {
      const e = el as HTMLElement | null
      return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable)
    }
    const onOut = (ev: FocusEvent) => {
      if (!editable(ev.target)) return
      window.setTimeout(() => setClosedR(read()), 400)
    }
    window.addEventListener('focusout', onOut)
    return () => window.removeEventListener('focusout', onOut)
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
