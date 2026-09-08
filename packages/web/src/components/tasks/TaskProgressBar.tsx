/**
 * TaskProgressBar — how much of a task its subtasks say is done.
 *
 * One component and one arithmetic (`taskProgress` in `@agentistics/core`), drawn on the card, in
 * the table, on the detail header and over the subtask grid. Four bars computing their own
 * percentage is four chances for the same task to read 66% in one place and 67% in another, which
 * is the kind of disagreement that makes a reader stop believing both.
 *
 * A task with NO subtasks draws nothing at all — not an empty bar. "Nobody broke this up" and
 * "nothing is done yet" are different facts, and a 0% bar on every unbroken task would make the bar
 * mean nothing anywhere.
 */

import { taskProgress } from '@agentistics/core'
import { microLabel } from './board'

export function TaskProgressBar({ done, total, showPercent = true, height = 4, label }: {
  done: number
  total: number
  /** The number beside the bar. Off in the tightest cells, where the bar alone is the signal. */
  showPercent?: boolean
  height?: number
  /** A word before the bar, when it is not obvious what is being counted. */
  label?: string
}) {
  const p = taskProgress(done, total)
  if (p.percent === null) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      {label && <span style={{ ...microLabel, fontSize: 9, flexShrink: 0 }}>{label}</span>}
      <div style={{
        flex: 1, minWidth: 24, height, borderRadius: height / 2,
        background: 'var(--bg-elevated)', overflow: 'hidden',
      }}>
        <div style={{
          width: `${p.percent}%`, height: '100%', borderRadius: height / 2,
          // Green only when it is ACTUALLY finished — the fill rounds down, so a bar that looks
          // full is full. An almost-done task stays orange, which is what "still open" looks like
          // everywhere else on this board.
          background: p.complete ? 'var(--accent-green)' : 'var(--anthropic-orange)',
          transition: 'width 0.2s',
        }} />
      </div>
      {showPercent && (
        <span style={{
          ...microLabel, fontSize: 10, flexShrink: 0, fontVariantNumeric: 'tabular-nums',
          color: p.complete ? 'var(--accent-green)' : 'var(--text-tertiary)',
        }}>
          {p.percent}% · {p.done}/{p.total}
        </span>
      )}
    </div>
  )
}
