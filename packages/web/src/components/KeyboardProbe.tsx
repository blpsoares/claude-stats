/**
 * KeyboardProbe — the on-screen readout behind `?kbdebug=1`.
 *
 * The rules and the arithmetic are the pure `lib/keyboardProbe.ts`; this is the listeners, the
 * overlay and the copy button. Three things about it are deliberate:
 *
 * 1. IT IS OFF UNLESS ASKED FOR. `?kbdebug=1` on the URL, nothing else — no preference, no build
 *    flag. It is a measuring instrument for one open question, and the day that question is
 *    answered it comes out.
 * 2. IT RENDERS INTO `document.body`, OUTSIDE `#root`. `#root` clips on a phone and WebKit anchors
 *    fixed descendants to it (App.tsx records the two bugs that measured this), so an overlay
 *    inside it would be carried along by the very displacement it is here to measure — and would
 *    read zero for it. Outside, it is a fixed reference the numbers can be trusted against.
 * 3. IT NEVER TOUCHES THE PAGE. No scroll, no focus, no style on anything but itself. An instrument
 *    that perturbs what it measures would put a seventh wrong answer on the pile.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  appendSample, diagnose, formatLog, formatSample, type ProbeSample,
} from '../lib/keyboardProbe'

/** `?kbdebug=1`. Read once — a query string does not change under the app. */
export function keyboardProbeOn(): boolean {
  if (typeof window === 'undefined') return false
  try { return new URLSearchParams(window.location.search).get('kbdebug') === '1' } catch { return false }
}

export function KeyboardProbe({ pt }: { pt: boolean }) {
  const [log, setLog] = useState<ProbeSample[]>([])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const t0 = performance.now()
    const vv = window.visualViewport
    const editable = (el: Element | null): boolean => {
      const e = el as HTMLElement | null
      return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable)
    }
    const read = (label: string): void => {
      const root = document.getElementById('root')
      const composer = document.querySelector('textarea')
      setLog(l => appendSample(l, {
        t: performance.now() - t0,
        label,
        scrollY: window.scrollY,
        vvTop: vv ? vv.offsetTop : 0,
        vvH: vv ? vv.height : window.innerHeight,
        innerH: window.innerHeight,
        rootTop: root ? root.getBoundingClientRect().top : 0,
        composerTop: composer ? composer.getBoundingClientRect().top : null,
        focused: editable(document.activeElement),
      }))
    }
    read('start')
    const onFocusIn = () => read('focusin')
    const onFocusOut = () => {
      read('focusout')
      // The tail matters more than the moment: iOS keeps adjusting through the dismissal animation,
      // and the reading that answers the question is the one AFTER it has settled.
      for (const ms of [300, 900]) window.setTimeout(() => read(`out+${ms}`), ms)
    }
    const onVv = () => {
      read('vv')
      for (const ms of [300, 900]) window.setTimeout(() => read(`vv+${ms}`), ms)
    }
    const onScroll = () => read('scroll')
    window.addEventListener('focusin', onFocusIn)
    window.addEventListener('focusout', onFocusOut)
    window.addEventListener('scroll', onScroll, { passive: true })
    vv?.addEventListener('resize', onVv)
    vv?.addEventListener('scroll', onVv)
    return () => {
      window.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('scroll', onScroll)
      vv?.removeEventListener('resize', onVv)
      vv?.removeEventListener('scroll', onVv)
    }
  }, [])

  const verdict = diagnose(log, pt)
  return createPortal(
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
      maxHeight: '42vh', overflowY: 'auto', pointerEvents: 'auto',
      background: 'rgba(0,0,0,0.86)', color: '#e5e7eb',
      font: '9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
      padding: '4px 6px', borderBottom: '1px solid #f59e0b',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <strong style={{ color: '#f59e0b' }}>kbdebug</strong>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(formatLog(log))
              .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) })
              .catch(() => setCopied(false))
          }}
          style={{
            marginLeft: 'auto', minHeight: 26, padding: '0 8px', borderRadius: 6,
            border: '1px solid #f59e0b', background: 'transparent', color: '#f59e0b',
            font: 'inherit', cursor: 'pointer',
          }}
        >{copied ? (pt ? 'copiado' : 'copied') : (pt ? 'copiar' : 'copy')}</button>
      </div>
      {verdict && (
        <p style={{ margin: '0 0 3px', color: '#fbbf24', lineHeight: 1.4 }}>{verdict}</p>
      )}
      {log.map((s, i) => (
        <div key={i} style={{ whiteSpace: 'pre', color: i === log.length - 1 ? '#fff' : '#9ca3af' }}>
          {formatSample(s)}
        </div>
      ))}
    </div>,
    document.body,
  )
}
