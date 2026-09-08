/**
 * keyboardProbe.ts — PURE: what one reading of the mobile viewport says, and how it is written down.
 *
 * ## Why this exists
 *
 * Seven attempts have been made at the iOS keyboard leaving the composer out of place, six of them
 * reverted, and every one of them was reasoned from the code rather than from a measurement — there
 * is no iOS device on the machine this is developed on, and the one browser that reproduces it is
 * the user's own phone. That is the whole reason the count got to seven: a fix is proposed, shipped,
 * looked at, and the only thing that comes back is "it still does not come back", which does not say
 * WHICH of the three quantities that can hold a displacement is holding it.
 *
 * There are exactly three, and the code that restores the position has only ever known about two:
 *
 * - `window.scrollY` — the DOCUMENT scroll. `scrollTo` undoes it.
 * - an inner scroller's `scrollTop` — undone by putting it back.
 * - `visualViewport.offsetTop` — the VISUAL viewport panned inside the layout viewport. Nothing in
 *   a page can write it. iOS holds it while a field is focused so the caret stays visible, and no
 *   amount of scroll restoring touches it.
 *
 * So this samples all three at once, plus the two boxes whose position is what actually gets
 * reported (`#root`, which is the containing block every `position: fixed` descendant answers to on
 * this layout, and the composer itself). One reading at rest and one after a dismissal names the
 * culprit in a single screenshot.
 *
 * It is OFF unless the page is opened with `?kbdebug=1`, so it costs a shipped build nothing.
 */

/** One reading. Every number is a pixel except `t`, which is ms since the probe started. */
export interface ProbeSample {
  t: number
  /** What produced this reading — `focusin`, `vv-resize`, `after-600`, … */
  label: string
  /** The document scroll. `window.scrollTo` is what undoes this one. */
  scrollY: number
  /** The visual viewport panned inside the layout viewport. NOTHING in the page can write this. */
  vvTop: number
  /** The visible band's height — how much the keyboard is taking. */
  vvH: number
  /** The layout viewport's height, for comparison with `vvH`. */
  innerH: number
  /** `#root`'s top edge. The containing block every fixed descendant here answers to. */
  rootTop: number
  /** The composer's top edge, or `null` when it is not on screen. */
  composerTop: number | null
  /** Whether an editable still holds the focus — the ✓ path's signature. */
  focused: boolean
}

/** How many readings are kept. Enough for one open-and-close, and it has to fit on a phone. */
export const PROBE_KEEP = 14

/**
 * A reading appended to the log, oldest dropped.
 *
 * A CONSECUTIVE DUPLICATE IS DROPPED rather than appended: `resize` and `scroll` fire in bursts on
 * iOS and fourteen identical rows would push the one interesting reading off the top. The label is
 * part of the comparison, so the same numbers under a different trigger still count as news.
 */
export function appendSample(log: readonly ProbeSample[], s: ProbeSample): ProbeSample[] {
  const last = log[log.length - 1]
  if (last && sameReading(last, s)) return [...log]
  return [...log, s].slice(-PROBE_KEEP)
}

function sameReading(a: ProbeSample, b: ProbeSample): boolean {
  return a.label === b.label && a.scrollY === b.scrollY && a.vvTop === b.vvTop
    && a.vvH === b.vvH && a.innerH === b.innerH && a.rootTop === b.rootTop
    && a.composerTop === b.composerTop && a.focused === b.focused
}

/**
 * One reading as a line, and the column order is the diagnosis.
 *
 * `scrollY` and `vvTop` lead because they are the two candidates the restore code can and cannot
 * touch; whichever of them is non-zero after the keyboard has gone is the answer. `focused` is last
 * and is the one that tells the ✓ path from the others.
 */
export function formatSample(s: ProbeSample): string {
  const n = (v: number | null): string => (v === null ? '—' : String(Math.round(v)))
  return [
    `${(s.t / 1000).toFixed(1)}s`,
    s.label,
    `sy=${n(s.scrollY)}`,
    `vvTop=${n(s.vvTop)}`,
    `vvH=${n(s.vvH)}`,
    `ih=${n(s.innerH)}`,
    `root=${n(s.rootTop)}`,
    `comp=${n(s.composerTop)}`,
    s.focused ? 'FOCUSED' : 'blurred',
  ].join(' ')
}

/** The whole log as text, for the copy button — one line per reading, newest last. */
export function formatLog(log: readonly ProbeSample[]): string {
  return log.map(formatSample).join('\n')
}

/**
 * WHAT THE LOG SAYS, in a sentence, once the keyboard has gone.
 *
 * Read off the LAST reading, and only offered when that reading says the keyboard is down
 * (`vvH >= innerH - 40`): while it is up, everything being displaced is correct and expected — that
 * displacement is what carries the composer above the keyboard.
 *
 * `null` means "nothing to say yet", never "everything is fine": a probe that guessed would be one
 * more confident answer in a place that has had six of them.
 */
export function diagnose(log: readonly ProbeSample[], pt: boolean): string | null {
  const s = log[log.length - 1]
  if (!s) return null
  if (s.vvH < s.innerH - 40) return null
  const off = Math.abs(s.rootTop) > 2 || s.scrollY > 2 || s.vvTop > 2
  if (!off) {
    return pt ? 'Teclado fechado e tudo em zero — voltou ao lugar.'
      : 'Keyboard down and everything at zero — it came back.'
  }
  if (s.vvTop > 2 && s.scrollY <= 2) {
    return pt
      ? `Deslocado por vvTop=${Math.round(s.vvTop)} com scrollY=0: é o VISUAL VIEWPORT, que nenhum scroll alcança.${s.focused ? ' O campo ainda está focado.' : ''}`
      : `Displaced by vvTop=${Math.round(s.vvTop)} with scrollY=0: it is the VISUAL VIEWPORT, which no scroll reaches.${s.focused ? ' The field is still focused.' : ''}`
  }
  if (s.scrollY > 2) {
    return pt
      ? `Deslocado por scrollY=${Math.round(s.scrollY)}: é scroll do documento, e o restore devia ter zerado.`
      : `Displaced by scrollY=${Math.round(s.scrollY)}: it is a document scroll, and the restore should have zeroed it.`
  }
  return pt
    ? `#root em ${Math.round(s.rootTop)} sem scrollY nem vvTop: é um scroller interno, ou o próprio box.`
    : `#root at ${Math.round(s.rootTop)} with neither scrollY nor vvTop: an inner scroller, or the box itself.`
}
