/**
 * ViewportProbe — a live readout of the numbers the keyboard bug is made of.
 *
 * Mounted only for `?vpdebug=1`, and it exists because five attempts at that bug were correct in a
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
    scrollY: Math.round(window.scrollY),
    docTop: Math.round(document.documentElement.scrollTop),
    bodyTop: shell ? Math.round(shell.getBoundingClientRect().top) : -1,
    shellBottom: shell ? Math.round(shell.getBoundingClientRect().bottom) : -1,
    focus: el ? el.tagName.toLowerCase() : '-',
  }
}

export function ViewportProbe() {
  const [r, setR] = useState<Reading>(read)

  useEffect(() => {
    const update = () => setR(read())
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
        font: '600 11px/1.35 ui-monospace, monospace', padding: '4px 6px',
        pointerEvents: 'none', whiteSpace: 'pre-wrap',
      }}
    >
      {`win ${r.innerW}x${r.innerH}  vv ${r.vvH} @${r.vvTop}
scrollY ${r.scrollY}  docTop ${r.docTop}  focus ${r.focus}
shell top ${r.bodyTop} bottom ${r.shellBottom}`}
    </div>
  )
}
