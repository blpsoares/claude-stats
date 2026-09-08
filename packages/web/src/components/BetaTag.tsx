/**
 * BetaTag — the one mark that says a feature is still being tried out.
 *
 * It is a component and not a string because the ALM board reaches SIX surfaces — its own page, the
 * nav on desktop and on mobile, the session's Task tab, the session menu's "file under a task", and
 * the right-click on a session card — and a caveat that appears on four of them is worse than none:
 * the reader concludes the two unmarked ones are the finished part.
 *
 * It is deliberately QUIET. A beta mark is a caveat, not an alarm: it must be readable and must not
 * compete with the status colours the board's whole legibility rests on, so it takes no accent
 * colour of its own. And it is never colour alone — the word is the signal, which is also what a
 * screen reader and a colour-blind reader get.
 */

import type { CSSProperties } from 'react'

export interface BetaTagProps {
  /** Where it sits, for the tooltip's sentence. */
  what?: string
  /** A dot instead of the word, for a place with no room for four characters (a nav rail). */
  compact?: boolean
  style?: CSSProperties
}

export function BetaTag({ what, compact, style }: BetaTagProps) {
  const title = what
    ? `${what} is in beta — it works, it is still being changed, and some of it will move.`
    : 'This is in beta — it works, it is still being changed, and some of it will move.'
  if (compact) {
    return (
      <span
        title={title}
        aria-label="beta"
        style={{
          width: 5, height: 5, borderRadius: 3, flexShrink: 0,
          background: 'var(--anthropic-orange)', ...style,
        }}
      />
    )
  }
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', flexShrink: 0,
        padding: '1px 5px', borderRadius: 4,
        fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em', lineHeight: 1.5,
        textTransform: 'uppercase',
        border: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-tertiary)',
        ...style,
      }}
    >beta</span>
  )
}
